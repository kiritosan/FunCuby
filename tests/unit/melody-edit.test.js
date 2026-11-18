import assert from "node:assert/strict";
import { test } from "node:test";
import {
    editMelody,
    phraseNotes,
    reviewFlags,
} from "../../src/core/transcription/melody-edit.js";
import { createPhrasePlayer } from "../../src/ui/transcribe/phrase-player.js";
import { decodeVocalPhrase } from "../../src/ui/transcribe/vocal-phrase.js";
import { phraseRanges } from "../../src/core/transcription/phrase-ranges.js";
import { encodeResult } from "../../src/core/transcription/protocol.js";

const note = (pitch, timeMs, durationMs) => ({
    note: pitch,
    timeMs,
    durationMs,
    velocity: 90,
});

test("practice phrases use rests shared by all voices and bounded continuous passages", () => {
    const notes = [
        note(60, 100, 2900),
        note(64, 400, 200),
        note(65, 2000, 400),
        note(62, 4100, 500),
    ];
    assert.deepEqual(phraseRanges(notes, 7000), [
        { start: 0, end: 3150 },
        { start: 3950, end: 4750 },
    ]);
    const long = phraseRanges([note(60, 0, 65000)], 65000);
    assert.equal(long[0].start, 0);
    assert.equal(long.at(-1).end, 65000);
    assert.ok(
        long.every(
            (r, i) =>
                r.end - r.start <= 30000 && (!i || r.start === long[i - 1].end),
        ),
    );
});

test("a reviewed vocal rest survives transport and stays attached only to its original note", () => {
    const event = {
        ...note(63, 100, 600),
        boundary: { releaseMs: 180, repeatMs: 330 },
    };
    const raw = encodeResult({ jobId: 1, notes: [event] }).notes;
    assert.deepEqual(raw, [event]);
    assert.deepEqual(editMelody(raw, { type: "boundary", index: 0 }, 1000), [
        note(63, 100, 180),
        note(63, 430, 270),
    ]);
    const manual = editMelody(
        raw,
        { type: "update", index: 0, note: { durationMs: 200 } },
        1000,
    );
    assert.equal(manual[0].boundary, undefined);
    assert.deepEqual(raw[0].boundary, event.boundary);
    for (const boundary of [
        { releaseMs: -2 },
        { releaseMs: 900 },
        { releaseMs: 180, repeatMs: 170 },
    ])
        assert.throws(() =>
            encodeResult({ jobId: 1, notes: [{ ...event, boundary }] }),
        );
});

test("melody editing preserves the recognizer snapshot and phrase timing", () => {
    const raw = Object.freeze([
        Object.freeze(note(60, 100, 600)),
        Object.freeze(note(64, 800, 150)),
    ]);
    const split = editMelody(raw, { type: "split", index: 0, atMs: 400 }, 1000);
    assert.deepEqual(
        split.map((n) => [n.note, n.timeMs, n.durationMs]),
        [
            [60, 100, 300],
            [60, 400, 300],
            [64, 800, 150],
        ],
    );
    assert.deepEqual(editMelody(split, { type: "merge", index: 0 }, 1000), raw);
    const changed = editMelody(
        split,
        {
            type: "update",
            index: 1,
            note: { note: 62, timeMs: 420, durationMs: 250 },
        },
        1000,
    );
    assert.equal(changed[1].note, 62);
    assert.equal(raw[0].durationMs, 600);
    assert.equal(Object.isFrozen(changed[1]), true);
    assert.throws(() => editMelody(changed, { type: "merge", index: 0 }, 1000));
    assert.throws(() =>
        editMelody(raw, { type: "split", index: 0, atMs: 105 }, 1000),
    );
    assert.throws(() =>
        editMelody(
            raw,
            { type: "update", index: 0, note: { timeMs: 900 } },
            1000,
        ),
    );
});

test("add/delete edits allow an intentionally empty melody and reject invalid notes", () => {
    const added = editMelody(
        [],
        { type: "add", note: note(65, 300, 200) },
        1000,
    );
    assert.deepEqual(editMelody(added, { type: "delete", index: 0 }, 1000), []);
    for (const invalid of [
        note(60.2, 0, 100),
        note(60, -1, 100),
        note(60, 0, 0),
        note(60, 900, 200),
    ])
        assert.throws(() =>
            editMelody([], { type: "add", note: invalid }, 1000),
        );
});

test("phrase selection clips sustains at both endpoints and preserves rests", () => {
    assert.deepEqual(
        phraseNotes([note(60, 100, 700), note(64, 950, 200)], 400, 1000),
        [note(60, 0, 400), note(64, 550, 50)],
    );
    assert.deepEqual(phraseNotes([note(60, 0, 100)], 200, 500), []);
    assert.deepEqual(reviewFlags([note(60, 0, 300), note(72, 100, 50)], 1), [
        "short",
        "leap",
        "overlap",
    ]);
});

function rig({ loadVocal } = {}) {
    const sources = [],
        clocks = new Set(),
        updates = [];
    const context = {
        currentTime: 5,
        state: "running",
        destination: {},
        createGain() {
            return { gain: { value: 0 }, connect() {}, disconnect() {} };
        },
        createBufferSource() {
            const source = {
                connect() {},
                disconnect() {
                    this.disconnected = true;
                },
                start(...args) {
                    this.args = args;
                },
                stop() {
                    this.stopped = true;
                },
            };
            sources.push(source);
            return source;
        },
    };
    const piano = {
        stopped: 0,
        stop() {
            this.stopped++;
        },
        async play(notes, options) {
            this.notes = notes;
            this.options = options;
            return { startAt: context.currentTime + 0.08 };
        },
    };
    const player = createPhrasePlayer(() => context, piano, {
        setTimer(fn) {
            clocks.add(fn);
            return fn;
        },
        clearTimer(fn) {
            clocks.delete(fn);
        },
        onUpdate(event) {
            updates.push(event);
        },
        loadVocal,
    });
    const input = {
        mode: "source",
        buffer: { duration: 20 },
        notes: [note(60, 200, 300)],
        clipStartMs: 10000,
        fromMs: 100,
        toMs: 900,
        loop: false,
    };
    return { player, sources, clocks, updates, context, piano, input };
}

test("source comparison adds the clip offset and stops exactly at the phrase endpoint", async () => {
    const r = rig();
    await r.player.play(r.input);
    assert.deepEqual(r.sources[0].args, [5.08, 10.1, 0.8]);
    assert.ok(r.piano.stopped > 0);
    r.context.currentTime = 6;
    for (const tick of r.clocks) tick();
    assert.equal(r.player.active, false);
    assert.equal(r.sources[0].stopped, true);
    assert.equal(r.sources[0].disconnected, true);
    assert.equal(r.clocks.size, 0);
});

test("source loop uses the same endpoints; A/B switch stops old audio", async () => {
    const r = rig();
    await r.player.play({ ...r.input, loop: true });
    assert.deepEqual(r.sources[0].args, [5.08, 10.1]);
    assert.equal(r.sources[0].loopEnd, 10.9);
    await r.player.play({ ...r.input, mode: "piano" });
    assert.equal(r.sources[0].stopped, true);
    assert.deepEqual(r.piano.notes, [note(60, 100, 300)]);
    assert.deepEqual(r.piano.options, { durationMs: 800, loop: false });
    r.player.stop();
    assert.equal(r.clocks.size, 0);
    await assert.rejects(r.player.play({ ...r.input, toMs: 100.001 }));
});

test("cancellation while resuming or loading cannot start late phrase playback", async () => {
    const r = rig();
    let resume;
    r.context.state = "suspended";
    r.context.resume = () =>
        new Promise((resolve) => {
            resume = resolve;
        });
    const first = r.player.play(r.input);
    r.player.stop();
    resume();
    await first;
    assert.equal(r.sources.length, 0);
    assert.equal(r.clocks.size, 0);
    r.context.state = "running";
    let complete;
    r.piano.play = () =>
        new Promise((resolve) => {
            complete = resolve;
        });
    const second = r.player.play({ ...r.input, mode: "piano" });
    r.player.stop();
    complete({ startAt: 5.08 });
    await second;
    assert.equal(r.clocks.size, 0);
    assert.equal(r.player.active, false);
});

test("one phrase plays original, isolated vocals and piano in order, then loops the sequence", async () => {
    const vocalStem = new Blob();
    const decoded = { duration: 0.8 };
    const r = rig({
        async loadVocal(context, stem, from, to) {
            assert.equal(context, r.context);
            assert.equal(stem, vocalStem);
            assert.deepEqual([from, to], [100, 900]);
            return decoded;
        },
    });
    const advance = async () => {
        r.context.currentTime += 1;
        for (const tick of [...r.clocks]) tick();
        await Promise.resolve();
    };
    await r.player.play({ ...r.input, mode: "compare", vocalStem, loop: true });
    assert.deepEqual(r.sources[0].args, [5.08, 10.1, 0.8]);
    await advance();
    assert.equal(r.sources[0].stopped, true);
    assert.equal(r.sources[1].buffer, decoded);
    assert.deepEqual(r.sources[1].args, [6.08, 0, 0.8]);
    assert.equal(r.sources[1].loop, false);
    await advance();
    assert.deepEqual(r.piano.notes, [note(60, 100, 300)]);
    assert.deepEqual(r.piano.options, { durationMs: 800, loop: false });
    await advance();
    assert.equal(r.sources[2].args[1], 10.1);
    assert.equal(r.updates.at(-1).mode, "source");
    r.player.stop();
    assert.equal(r.clocks.size, 0);
});

test("cancelled vocal decoding cannot schedule audio after switching tracks", async () => {
    let finishDecode;
    const r = rig({
        loadVocal: () =>
            new Promise((resolve) => {
                finishDecode = resolve;
            }),
    });
    const vocals = r.player.play({
        ...r.input,
        mode: "vocals",
        vocalStem: new Blob(),
    });
    await r.player.play(r.input);
    finishDecode({ duration: 0.8 });
    await vocals;
    assert.equal(r.sources.length, 1);
    assert.equal(r.updates.at(-1).mode, "source");
    r.player.stop();
});

test("vocal WAV phrase decoding keeps both channels and reads the selected frames", async () => {
    const wav = Buffer.alloc(44 + 32);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(44100, 24);
    wav.writeUInt16LE(4, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(32, 40);
    for (let frame = 0; frame < 8; frame++) {
        wav.writeInt16LE(frame * 1024, 44 + frame * 4);
        wav.writeInt16LE(-frame * 2048, 46 + frame * 4);
    }
    const context = {
        createBuffer(channels, frames, rate) {
            assert.deepEqual([channels, frames, rate], [2, 4, 44100]);
            const data = [new Float32Array(frames), new Float32Array(frames)];
            return { getChannelData: (channel) => data[channel] };
        },
    };
    const stem = new Blob([wav], { type: "audio/wav" });
    const phrase = await decodeVocalPhrase(context, stem, 2 / 44.1, 6 / 44.1);
    assert.deepEqual(
        [...phrase.getChannelData(0)],
        [2, 3, 4, 5].map((n) => n / 32),
    );
    assert.deepEqual(
        [...phrase.getChannelData(1)],
        [2, 3, 4, 5].map((n) => -n / 16),
    );
    await assert.rejects(decodeVocalPhrase(context, stem.slice(0, 40), 0, 10));
});
