import assert from "node:assert/strict";
import { test } from "node:test";
import {
    arrangeTranscription,
    transcriptionMidi,
} from "../../src/core/arrangement.js";
import { parseMidiFile } from "../../src/core/midi/midi-file.js";
import { createTeachingScore } from "../../src/core/teaching/score.js";

const note = (pitch, timeMs, durationMs = 500, velocity = 100) => ({
    note: pitch,
    timeMs,
    durationMs,
    velocity,
});

const arrange = (input, overrides = {}) =>
    arrangeTranscription(input, {
        level: "starter",
        bpm: 120,
        firstNote: 60,
        transpose: 0,
        originMs: 0,
        minPitch: 0,
        maxPitch: 127,
        ...overrides,
    });

const LEVELS = ["starter", "melody", "fuller", "original"];
const WHITE = new Set([0, 2, 4, 5, 7, 9, 11]);
const mod = (value, divisor) => ((value % divisor) + divisor) % divisor;

// Peak number of notes sounding at once; a note ending exactly when the next
// starts does not count as overlap (note-off precedes note-on).
function maxSimultaneous(notes) {
    const points = [];
    for (const n of notes) {
        points.push([n.timeMs, 1], [n.timeMs + n.durationMs, -1]);
    }
    points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let current = 0,
        peak = 0;
    for (const [, delta] of points) {
        current += delta;
        peak = Math.max(peak, current);
    }
    return peak;
}

test("arrangeTranscription never mutates the captured transcription", () => {
    const input = [
        note(60, 0, 500),
        note(64, 500, 500),
        note(67, 1000, 500),
        note(72, 1500, 250),
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    for (const level of LEVELS) {
        const result = arrange(input, { level });
        for (const output of result.notes)
            assert.ok(
                !input.includes(output),
                "output notes must be copies, not source objects",
            );
    }
    assert.deepEqual(input, snapshot);
});

test("grid snapping and BPM caps scale each level", () => {
    const input = [note(72, 560, 900)];
    const expected = {
        starter: 72,
        melody: 96,
        fuller: 112,
        original: 120,
    };
    for (const level of LEVELS) {
        const result = arrange(input, { level, bpm: 120 });
        assert.equal(result.sourceBpm, 120);
        assert.equal(result.bpm, expected[level]);
        assert.equal(result.notes.length, 1);
    }
    // The original level is a passthrough: exact source times and pitches.
    const original = arrange(input, { level: "original", bpm: 120 });
    assert.equal(original.notes[0].timeMs, 560);
    assert.equal(original.notes[0].durationMs, 900);
    assert.equal(original.notes[0].note, 72);
    // Starter snaps to a quarter-note grid at the capped 72 BPM: 560 ms rounds
    // down to the 500 ms grid line, then stretches by 120/72.
    const starter = arrange(input, { level: "starter", bpm: 120 });
    assert.ok(Math.abs(starter.notes[0].timeMs - (500 * 120) / 72) < 0.01);
    assert.ok(Math.abs(starter.notes[0].durationMs - (1000 * 120) / 72) < 0.01);
    // Melody keeps an eighth-note grid at 96 BPM.
    const melody = arrange(input, { level: "melody", bpm: 120 });
    assert.ok(Math.abs(melody.notes[0].timeMs - (500 * 120) / 96) < 0.01);
    // Fuller keeps a sixteenth-note grid at 112 BPM.
    const fuller = arrange(input, { level: "fuller", bpm: 120 });
    assert.ok(Math.abs(fuller.notes[0].timeMs - (500 * 120) / 112) < 0.5);
});

test("starter keeps only main keys relative to firstNote, all in the 25-key range", () => {
    const firstNote = 62;
    const input = [
        note(62, 0, 500),
        note(63, 500, 500),
        note(64, 1000, 500),
        note(80, 1500, 500),
        note(90, 2000, 500),
    ];
    for (const level of ["starter", "melody", "fuller"]) {
        const result = arrange(input, { level, firstNote, bpm: 120 });
        for (const output of result.notes) {
            assert.ok(output.note >= firstNote);
            assert.ok(output.note <= firstNote + 24);
            if (level === "starter")
                assert.ok(
                    WHITE.has(mod(output.note - firstNote, 12)),
                    `pitch ${output.note} is not a main key`,
                );
        }
        assert.equal(result.stats.outOfRange, 0);
    }
    const starter = arrange(input, { level: "starter", firstNote });
    assert.ok(starter.stats.omittedMainKeys >= 1);
    assert.ok(starter.notes.length < input.length);
    // The chromatic 63 (black key relative to firstNote) is omitted, not moved.
    assert.ok(
        starter.notes.every((output) => mod(output.note - firstNote, 12) !== 1),
    );
});

test("firstNote 62 maps the whole range into 62..86", () => {
    const input = [];
    for (let pitch = 40; pitch <= 100; pitch += 3)
        input.push(note(pitch, (pitch - 40) * 400, 600));
    for (const level of ["starter", "melody", "fuller"]) {
        const result = arrange(input, { level, firstNote: 62, bpm: 120 });
        assert.ok(result.notes.length > 0);
        for (const output of result.notes) {
            assert.ok(output.note >= 62 && output.note <= 86);
        }
        assert.equal(result.stats.outOfRange, 0);
    }
});

test("transpose shifts pitch class in simplified levels only; original is untouched", () => {
    const input = [note(60, 0, 1000), note(64, 500, 500), note(67, 1000, 500)];
    const originalPlain = arrange(input, { level: "original", transpose: 0 });
    const originalShifted = arrange(input, {
        level: "original",
        transpose: 2,
    });
    assert.deepEqual(originalShifted.notes, originalPlain.notes);
    const melodyPlain = arrange(input, { level: "melody", transpose: 0 });
    const melodyShifted = arrange(input, { level: "melody", transpose: 2 });
    assert.equal(melodyPlain.notes.length, melodyShifted.notes.length);
    for (const [plain, shifted] of melodyPlain.notes.map((plain, i) => [
        plain,
        melodyShifted.notes[i],
    ])) {
        assert.equal(shifted.timeMs, plain.timeMs);
        assert.equal(shifted.durationMs, plain.durationMs);
        assert.equal(mod(shifted.note - plain.note, 12), 2);
    }
});

test("empty and invalid input stays empty", () => {
    for (const level of LEVELS) {
        const result = arrange([], { level });
        assert.equal(result.notes.length, 0);
        assert.equal(result.stats.source, 0);
    }
    const dirty = [
        note(60, -5, 500),
        { note: 200, timeMs: 0, durationMs: 500, velocity: 100 },
        { note: 60, timeMs: 0, durationMs: -1, velocity: 100 },
        { note: 60.5, timeMs: 0, durationMs: 500, velocity: 100 },
        note(60, 0, 500),
    ];
    const result = arrange(dirty, { level: "melody" });
    assert.equal(result.stats.source, 1);
    assert.equal(result.notes.length, 1);
});

test("min/max pitch filter applies to simplified levels only", () => {
    const input = [note(48, 0, 500), note(72, 500, 500), note(96, 1000, 500)];
    const filtered = arrange(input, {
        level: "melody",
        minPitch: 60,
        maxPitch: 84,
    });
    assert.equal(filtered.stats.filtered, 2);
    assert.equal(filtered.notes.length, 1);
    const original = arrange(input, {
        level: "original",
        minPitch: 60,
        maxPitch: 84,
    });
    assert.equal(original.notes.length, 3);
    assert.equal(original.stats.filtered, 0);
});

test("short notes are omitted only according to each level's minimum", () => {
    const input = [note(72, 0, 100)]; // 100 ms at 120 BPM source
    const counts = {};
    for (const level of LEVELS) {
        const result = arrange(input, { level });
        counts[level] = result.notes.length;
    }
    assert.equal(counts.starter, 0); // needs >= 250 ms
    assert.equal(counts.melody, 0); // needs >= 125 ms
    assert.equal(counts.fuller, 1); // needs >= 62.5 ms
    assert.equal(counts.original, 1); // unfiltered
    assert.equal(arrange(input, { level: "melody" }).stats.filtered, 1);
});

test("polyphony caps hold at every timestamp, including sustained overlap", () => {
    const chord = [note(60, 0, 500), note(64, 0, 500), note(67, 0, 500)];
    const sustained = [note(72, 0, 2000), note(60, 500, 500)];
    for (const [level, cap] of [
        ["starter", 1],
        ["melody", 1],
        ["fuller", 2],
    ]) {
        for (const input of [chord, sustained]) {
            const result = arrange(input, { level });
            assert.ok(result.notes.length > 0);
            assert.ok(
                maxSimultaneous(result.notes) <= cap,
                `${level} exceeded ${cap} simultaneous notes`,
            );
        }
    }
    assert.equal(arrange(chord, { level: "starter" }).notes.length, 1);
    assert.equal(arrange(chord, { level: "melody" }).notes.length, 1);
    const fuller = arrange(chord, { level: "fuller" });
    assert.equal(fuller.notes.length, 2);
    assert.deepEqual(
        fuller.notes.map((n) => n.note).sort((a, b) => a - b),
        [64, 67],
    );
    assert.equal(arrange(chord, { level: "original" }).notes.length, 3);
    // A lower attack under a held upper note is suppressed in single-voice drafts.
    const solo = arrange(sustained, { level: "starter" });
    assert.equal(solo.notes.length, 1);
    assert.equal(solo.notes[0].note, 72);
    const duo = arrange(sustained, { level: "fuller" });
    assert.equal(duo.notes.length, 2);
    // Sustained notes are clipped at the next attack, so overlap stays within cap.
    assert.ok(maxSimultaneous(duo.notes) <= 2);
});

test("octave-folded duplicate chord tones are deduplicated", () => {
    // 59 and 83 share a pitch class; the global octave shift folds both to 71.
    const input = [note(59, 0, 500), note(83, 0, 500)];
    const result = arrange(input, { level: "fuller" });
    assert.equal(result.notes.length, 1);
    assert.equal(result.notes[0].note, 71);
    assert.equal(result.stats.reduced, 1);
    assert.equal(result.stats.octaveAdjusted, 1);
});

test("transcriptionMidi roundtrips through the existing parser and score", () => {
    const notes = [
        note(60, 0, 500, 100),
        note(64, 250, 500, 90),
        note(67, 500, 1000, 80),
    ];
    const bytes = transcriptionMidi(notes, { bpm: 90, name: "Roundtrip" });
    const song = parseMidiFile(bytes);
    assert.equal(song.format, 0);
    assert.equal(song.tracks.length, 1);
    assert.equal(song.tracks[0].noteCount, 3);
    assert.ok(Math.abs(song.initialBpm - 90) < 0.01);
    const ons = song.events.filter((event) => event.on);
    assert.equal(ons.length, 3);
    for (const source of notes) {
        const event = ons.find((candidate) => candidate.note === source.note);
        assert.ok(event, `missing note-on for ${source.note}`);
        assert.ok(
            Math.abs(event.timeMs - source.timeMs) < 3,
            `note ${source.note} at ${event.timeMs}ms, expected ~${source.timeMs}ms`,
        );
    }
    const score = createTeachingScore(song, [0], 90);
    assert.ok(score.barCount >= 1);
    assert.equal(score.notes.length, 3);
    for (let i = 1; i < score.notes.length; i++)
        assert.ok(score.notes[i].timeMs >= score.notes[i - 1].timeMs);
});

test("same-pitch retriggers emit note-off before the next note-on", () => {
    const notes = [note(60, 0, 500), note(60, 500, 500)];
    const song = parseMidiFile(
        transcriptionMidi(notes, { bpm: 120, name: "Retrigger" }),
    );
    const events = song.events.filter((event) => event.note === 60);
    assert.equal(events.length, 4);
    assert.equal(events[0].on, true);
    // At the shared 500 ms tick the first note's off is emitted before the
    // retrigger's on, so the device never sees overlapping same-pitch notes.
    assert.equal(events[1].on, false);
    assert.equal(events[2].on, true);
    assert.equal(events[3].on, false);
    assert.ok(Math.abs(events[1].timeMs - events[2].timeMs) < 1);
});

test("invalid arrangement settings are rejected", () => {
    const input = [note(60, 0, 500)];
    for (const overrides of [
        { bpm: 19 },
        { bpm: 241 },
        { bpm: Number.NaN },
        { firstNote: -1 },
        { firstNote: 104 },
        { firstNote: 60.5 },
        { transpose: -13 },
        { transpose: 13 },
        { transpose: 1.5 },
        { originMs: -1 },
        { originMs: 600001 },
        { minPitch: -1 },
        { minPitch: 100, maxPitch: 50 },
        { level: "bogus" },
    ])
        assert.throws(() => arrange(input, overrides), RangeError);
});

test("beat origin offset accepts 600000 ms, drops earlier notes, shifts later ones", () => {
    const input = [note(72, 100_000, 500), note(76, 200_000, 500)];
    const shifted = arrange(input, {
        level: "melody",
        bpm: 120,
        originMs: 150_000,
    });
    // The pre-offset note is filtered; the later note snaps to the melody
    // grid relative to the offset, then scales by the 120/96 tempo cap.
    assert.equal(shifted.stats.filtered, 1);
    assert.equal(shifted.notes.length, 1);
    const expected = (Math.round(50_000 / 250) * 250 * 120) / 96;
    assert.ok(Math.abs(shifted.notes[0].timeMs - expected) < 1);
    // Boundary values: 600000 accepted, 600001 rejected.
    assert.doesNotThrow(() =>
        arrange([note(72, 700_000, 500)], { originMs: 600_000 }),
    );
    assert.throws(
        () => arrange([note(72, 0, 500)], { originMs: 600_001 }),
        RangeError,
    );
});
