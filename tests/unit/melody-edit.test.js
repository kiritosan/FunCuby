import assert from "node:assert/strict";
import { test } from "node:test";
import {
    editMelody,
    phraseNotes,
    reviewFlags,
} from "../../src/core/transcription/melody-edit.js";
import { createPhrasePlayer } from "../../src/ui/transcribe/phrase-player.js";

const note = (pitch, timeMs, durationMs) => ({
    note: pitch,
    timeMs,
    durationMs,
    velocity: 90,
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

function rig() {
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
            return { startAt: 5.08 };
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
