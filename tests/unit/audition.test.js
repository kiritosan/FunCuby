import assert from "node:assert/strict";
import { test } from "node:test";
import {
    createAudition,
    pianoVelocity,
    phrasePreviewIndex,
} from "../../src/ui/transcribe/audition.js";
import {
    createPianoBank,
    pianoSample,
} from "../../src/ui/transcribe/piano-bank.js";

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};
const note = (timeMs = 0) => ({
    note: 60,
    timeMs,
    durationMs: 300,
    velocity: 30,
});

function rig({ load } = {}) {
    const sources = [],
        gains = [],
        clocks = new Set(),
        frames = new Set();
    const parameter = () => ({
        value: 0,
        values: [],
        setValueAtTime(value, at) {
            this.values.push({ value, at });
        },
        linearRampToValueAtTime(value, at) {
            this.values.push({ value, at });
        },
        setTargetAtTime(value, at) {
            this.values.push({ value, at });
        },
    });
    const node = () => ({
        disconnected: false,
        connect() {},
        disconnect() {
            this.disconnected = true;
        },
    });
    const context = {
        currentTime: 0,
        state: "running",
        destination: {},
        createGain() {
            const gain = { ...node(), gain: parameter() };
            gains.push(gain);
            return gain;
        },
        createDynamicsCompressor() {
            return {
                ...node(),
                threshold: parameter(),
                knee: parameter(),
                ratio: parameter(),
                attack: parameter(),
                release: parameter(),
            };
        },
        createBufferSource() {
            const source = {
                ...node(),
                playbackRate: parameter(),
                starts: [],
                stops: [],
                start(at) {
                    this.starts.push(at);
                },
                stop(at) {
                    this.stops.push(at);
                },
            };
            sources.push(source);
            return source;
        },
    };
    const bank = {
        load:
            load ??
            (async (_context, notes) =>
                new Map(
                    notes.map((n) => [
                        pianoSample(n.note).midi,
                        { buffer: {}, normalization: 1 },
                    ]),
                )),
    };
    const player = createAudition(
        () => context,
        () => {},
        {
            bank,
            requestFrame(fn) {
                frames.add(fn);
                return fn;
            },
            cancelFrame(fn) {
                frames.delete(fn);
            },
            setTimer(fn) {
                clocks.add(fn);
                return fn;
            },
            clearTimer(fn) {
                clocks.delete(fn);
            },
        },
    );
    return { player, context, sources, gains, clocks, frames };
}

test("score preview skips a silent intro while keeping later rests and source timestamps", async () => {
    const r = rig();
    const notes = [note(15000), note(16000)];
    const { startAt } = await r.player.play(notes, { skipIntro: true });
    assert.deepEqual(
        r.sources.map((s) => s.starts),
        [[startAt]],
    );
    r.context.currentTime = startAt + 0.8;
    for (const tick of r.clocks) tick();
    assert.deepEqual(r.sources[1].starts, [startAt + 1]);
    assert.equal(notes[0].timeMs, 15000);
    r.player.stop();
});

test("phrase preview bypasses an isolated opening and slows playback with original indices", async () => {
    const r = rig(),
        updates = [];
    const notes = [8000, 23070, 23220, 23500, 42000].map((t) => note(t));
    const { startAt } = await r.player.play(notes, {
        skipIntro: "phrase",
        speed: 0.5,
        onSounding: (voices) =>
            updates.push(voices?.map((v) => v.displayIndex)),
    });
    assert.deepEqual(
        r.sources.map((s) => s.starts[0]),
        [startAt, startAt + 0.3],
    );
    r.context.currentTime = startAt + 0.01;
    for (const tick of [...r.frames]) tick();
    assert.deepEqual(updates.at(-1), [1]);
    assert.deepEqual(
        notes.map((n) => n.timeMs),
        [8000, 23070, 23220, 23500, 42000],
    );
    r.player.stop();
});

test("phrase preview keeps sustained openings, sparse pieces and later rests", () => {
    const starts = (times) => times.map((t) => note(t));
    assert.equal(phrasePreviewIndex(starts([0, 10000, 10000, 10010])), 0);
    assert.equal(phrasePreviewIndex(starts([0, 10000, 14000])), 0);
    assert.equal(
        phrasePreviewIndex([
            { ...note(0), durationMs: 9000 },
            ...starts([10000, 10300, 10600]),
        ]),
        0,
    );
    assert.equal(
        phrasePreviewIndex(starts([0, 300, 600, 12000, 12300, 12600])),
        0,
    );
    assert.equal(phrasePreviewIndex(starts([0, 300, 11000, 11300, 11600])), 2);
});

test("piano highlights follow sounding voices across chords, rest and loop, independent of lookahead", async () => {
    const r = rig(),
        updates = [];
    const { startAt } = await r.player.play(
        [note(), { ...note(100), note: 64 }],
        {
            durationMs: 500,
            loop: true,
            onSounding: (voices) =>
                updates.push(voices?.map((v) => v.note) ?? null),
        },
    );
    const at = (ms) => {
        r.context.currentTime = startAt + ms / 1000;
        for (const fn of r.clocks) fn();
        for (const fn of [...r.frames]) {
            r.frames.delete(fn);
            fn();
        }
    };
    assert.deepEqual(updates, []);
    for (const ms of [1, 110, 310, 420, 505]) at(ms);
    r.player.stop();
    assert.deepEqual(updates, [[60], [60, 64], [64], [], [60], null]);
    assert.equal(r.frames.size, 0);
});

test("stopping during context resume cannot start late notes", async () => {
    const resume = deferred();
    let loaded = false;
    const r = rig({
        load: async () => {
            loaded = true;
        },
    });
    r.context.state = "suspended";
    r.context.resume = () => resume.promise;
    const playing = r.player.play([note()]);
    assert.equal(r.player.active, true);
    r.player.stop();
    resume.resolve();
    await playing;
    assert.equal(loaded, false);
    assert.equal(r.player.active, false);
    assert.equal(r.sources.length, 0);
});

test("stop aborts sample loading and ignores a late decoder result", async () => {
    const pending = deferred();
    let signal;
    const r = rig({
        load: (_context, _notes, abortSignal) => {
            signal = abortSignal;
            return pending.promise;
        },
    });
    const playing = r.player.play([note()]);
    r.player.stop();
    assert.equal(signal.aborted, true);
    pending.resolve(new Map([[60, { buffer: {}, normalization: 1 }]]));
    await playing;
    assert.equal(r.sources.length, 0);
    assert.equal(r.player.active, false);
    assert.equal(r.clocks.size, 0);
});

test("sample failure recovers for an explicit retry", async () => {
    let fail = true;
    const r = rig({
        load: async () => {
            if (fail) throw new Error("missing sample");
            return new Map([[60, { buffer: {}, normalization: 1 }]]);
        },
    });
    await assert.rejects(
        r.player.play([note()]),
        (e) => e.key === "transcribe.errors.piano",
    );
    assert.equal(r.player.active, false);
    fail = false;
    await r.player.play([note()]);
    assert.equal(r.sources.length, 1);
    r.player.stop();
    assert.equal(r.clocks.size, 0);
    assert.ok(r.sources.every((s) => s.disconnected));
    assert.ok(r.gains.every((s) => s.disconnected));
});

test("ten-minute playback schedules a short horizon and never mutates notes", async () => {
    const input = Object.freeze(
        Array.from({ length: 600 }, (_, i) => Object.freeze(note(i * 1000))),
    );
    const r = rig();
    await r.player.play(input);
    assert.equal(r.sources.length, 1);
    assert.equal(r.player.loading, false);
    r.context.currentTime = 100;
    for (const clock of r.clocks) clock();
    assert.ok(r.sources.length <= 3, "missed notes must not all start at once");
    assert.equal(input[0].velocity, 30);
    r.player.setVolume(0);
    assert.equal(r.gains[0].gain.values.at(-1).value, 0);
    r.player.stop();
    assert.equal(r.clocks.size, 0);
});

test("dense raw transcription cannot retain unbounded live voices", async () => {
    const r = rig();
    await r.player.play(Array.from({ length: 100 }, () => note()));
    assert.equal(r.sources.filter((source) => !source.disconnected).length, 48);
    r.player.stop();
    assert.ok(r.sources.every((source) => source.disconnected));
});

test("phrase piano loops preserve leading rests and remain cancellable", async () => {
    const r = rig();
    const timing = await r.player.play([note(200)], {
        durationMs: 1000,
        loop: true,
    });
    assert.equal(timing.startAt, 0.08);
    assert.equal(r.sources[0].starts[0], 0.28);
    r.context.currentTime = 1;
    for (const clock of r.clocks) clock();
    assert.equal(r.sources[1].starts[0], 1.28);
    r.context.currentTime = 100;
    for (const clock of r.clocks) clock();
    assert.ok(
        r.sources.length <= 4,
        "loop must not replay every missed cycle after suspension",
    );
    r.player.stop();
    assert.equal(r.clocks.size, 0);
});

test("silent phrases retain their duration, and tiny loops are rejected", async () => {
    const r = rig();
    await r.player.play([], { durationMs: 1000 });
    assert.equal(r.player.active, true);
    r.context.currentTime = 1.2;
    for (const clock of r.clocks) clock();
    assert.equal(r.player.active, false);
    await assert.rejects(
        r.player.play([note()], { durationMs: 0.01, loop: true }),
    );
});

test("piano samples are cached per context and weak model activations remain audible", async () => {
    let requests = 0,
        decodes = 0;
    const bank = createPianoBank({
        fetchImpl: async () => {
            requests++;
            return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) };
        },
    });
    const context = {
        async decodeAudioData() {
            decodes++;
            return {
                numberOfChannels: 1,
                getChannelData: () => new Float32Array([0.45, -0.9]),
            };
        },
    };
    const signal = new AbortController().signal;
    await bank.load(context, [note(), { ...note(), note: 61 }], signal);
    await bank.load(context, [note()], signal);
    assert.equal(requests, 1);
    assert.equal(decodes, 1);
    await bank.load({ ...context }, [note()], signal);
    assert.equal(requests, 2);
    assert.ok(pianoVelocity(1) >= 0.65);
    assert.equal(pianoSample(62).file, "Ds4.mp3");
});
