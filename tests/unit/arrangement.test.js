import assert from "node:assert/strict";
import { test } from "node:test";
import {
    arrangeTranscription,
    extractLeadMelody,
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

test("starter selects beat anchors without flattening timing, melody keeps offbeats", () => {
    const input = [
        note(60, 90, 250),
        note(64, 465, 190),
        note(67, 642, 85),
        note(69, 1090, 330),
    ];
    for (const level of LEVELS)
        assert.equal(arrange(input, { level }).bpm, 120);
    const timing = (notes) => notes.map((n) => [n.timeMs, n.durationMs]);
    assert.deepEqual(timing(arrange(input, { level: "starter" }).notes), [
        [90, 250],
        [465, 190],
        [1090, 330],
    ]);
    assert.deepEqual(
        timing(arrange(input, { level: "melody" }).notes),
        timing(input).map(([t, d], i) => [t, i === 1 ? 177 : d]),
    );
    assert.equal(arrange(input, { level: "fuller" }).notes[0].timeMs, 125);
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
    assert.equal(counts.starter, 0); // needs >= 175 ms
    assert.equal(counts.melody, 1); // preserves short articulated notes
    assert.equal(counts.fuller, 1); // needs >= 62.5 ms
    assert.equal(counts.original, 1); // unfiltered
    assert.equal(arrange(input, { level: "melody" }).stats.filtered, 0);
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

test("detail reports played dyads and keeps separate attacks from becoming a chord", () => {
    const chord = arrange([note(60, 0), note(64, 0)], { level: "fuller" });
    assert.equal(chord.stats.dyads, 1);
    const sequential = arrange([note(60, 70, 70), note(64, 156, 80)], {
        level: "fuller",
    });
    assert.equal(sequential.stats.dyads, 0);
    assert.equal(
        new Set(sequential.notes.map((n) => n.timeMs)).size,
        sequential.notes.length,
    );
});

test("optional harmony adds a playable lower voice while preserving existing attacks and dyads", () => {
    const input = [
        note(72, 0, 500),
        note(76, 0, 500),
        note(74, 1000, 500),
        note(76, 2000, 500),
        note(79, 3000, 500),
    ];
    const plain = arrange(input, { level: "fuller" });
    const duet = arrange(input, { level: "fuller", autoHarmony: true });
    assert.ok(duet.stats.generatedHarmony > 0);
    assert.equal(
        duet.stats.dyads,
        plain.stats.dyads + duet.stats.generatedHarmony,
    );
    for (const n of plain.notes)
        assert.ok(
            duet.notes.some(
                (v) =>
                    v.note === n.note &&
                    v.timeMs === n.timeMs &&
                    v.durationMs === n.durationMs,
            ),
        );
    assert.equal(duet.notes.filter((n) => n.timeMs === 0).length, 2);
    assert.ok(maxSimultaneous(duet.notes) <= 2);
    assert.ok(duet.notes.every((n) => n.note >= 60 && n.note <= 84));
    for (const level of ["melody", "original"])
        assert.deepEqual(
            arrange(input, { level }),
            arrange(input, { level, autoHarmony: true }),
        );
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
    assert.equal(shifted.stats.filtered, 1);
    assert.equal(shifted.notes.length, 1);
    assert.equal(shifted.notes[0].timeMs, 50_000);
    // Boundary values: 600000 accepted, 600001 rejected.
    assert.doesNotThrow(() =>
        arrange([note(72, 700_000, 500)], { originMs: 600_000 }),
    );
    assert.throws(
        () => arrange([note(72, 0, 500)], { originMs: 600_001 }),
        RangeError,
    );
});

test("extractLeadMelody suppresses octave overtone ghosts and bass rumble in dense polyphony", () => {
    const melodyLine = [64, 67, 69, 67, 64, 67, 71, 72, 71, 69, 67, 64];
    const mixed = [];
    for (let i = 0; i < melodyLine.length; i++) {
        const at = i * 250;
        const leadPitch = melodyLine[i];
        // Deep bass + inner accompaniment + lead voice + quieter octave harmonic
        mixed.push(note(40, at, 220, 95));
        mixed.push(note(leadPitch - 5, at + 10, 200, 72));
        mixed.push(note(leadPitch, at, 230, 98));
        mixed.push(note(leadPitch + 12, at + 5, 160, 78));
    }
    const tracked = extractLeadMelody(mixed);
    assert.deepEqual(
        tracked.map((n) => n.note),
        melodyLine,
    );
    const arranged = arrange(mixed, { level: "melody", bpm: 120 });
    assert.deepEqual(
        arranged.notes.map((n) => n.note),
        melodyLine,
    );
});

test("starter prefers a main-key beat anchor over an unplayable chromatic grace note", () => {
    // Beat 0 contains a playable main-key E4 (64) on the beat and an off-beat F#4 (66)
    // that rounds to the same quarter-note grid slot.
    const input = [note(64, 0, 320, 90), note(66, 180, 200, 95)];
    const starter = arrange(input, {
        level: "starter",
        bpm: 120,
        firstNote: 60,
    });
    assert.equal(starter.notes.length, 1);
    assert.equal(starter.notes[0].note % 12, 4);
    assert.equal(starter.stats.omittedMainKeys, 0);
});
