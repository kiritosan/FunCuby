import assert from "node:assert/strict";
import { test } from "node:test";
import {
    MAX_SAMPLES,
    PROTOCOL_VERSION,
    SAMPLE_RATE,
    STALL_WARNING_MS,
} from "../../src/core/transcription/config.js";
import { TranscriptionError } from "../../src/core/transcription/errors.js";
import { TranscriptionJob } from "../../src/core/transcription/job.js";
import {
    decodeEvent,
    decodeStart,
    encodeError,
    encodeResult,
    encodeStart,
    encodeStatus,
} from "../../src/core/transcription/protocol.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const samples = (length = 22050) => new Float32Array(length);
const NOTE = { note: 60, timeMs: 0, durationMs: 500, velocity: 100 };

// ---- protocol ----------------------------------------------------------------

test("protocol start envelope round-trips and validates", () => {
    const audio = samples();
    const start = encodeStart({ jobId: 42, samples: audio });
    assert.equal(start.version, PROTOCOL_VERSION);
    assert.equal(start.jobId, 42);
    assert.equal(start.type, "start");
    assert.equal(start.sampleRate, SAMPLE_RATE);
    assert.equal(start.samples, audio);
    const decoded = decodeStart(start);
    assert.equal(decoded.jobId, 42);
    assert.equal(decoded.samples.length, 22050);
    for (const bad of [
        null,
        [],
        {
            version: 2,
            jobId: 1,
            type: "start",
            sampleRate: 22050,
            samples: audio,
        },
        {
            version: 1,
            jobId: 0,
            type: "start",
            sampleRate: 22050,
            samples: audio,
        },
        {
            version: 1,
            jobId: 1.5,
            type: "start",
            sampleRate: 22050,
            samples: audio,
        },
        {
            version: 1,
            jobId: 1,
            type: "status",
            sampleRate: 22050,
            samples: audio,
        },
        {
            version: 1,
            jobId: 1,
            type: "start",
            sampleRate: 44100,
            samples: audio,
        },
        {
            version: 1,
            jobId: 1,
            type: "start",
            sampleRate: 22050,
            samples: new Float32Array(0),
        },
        {
            version: 1,
            jobId: 1,
            type: "start",
            sampleRate: 22050,
            samples: new Float32Array(MAX_SAMPLES + 1),
        },
        {
            version: 1,
            jobId: 1,
            type: "start",
            sampleRate: 22050,
            samples: [1, 2, 3],
        },
    ])
        assert.throws(() => decodeStart(bad), TranscriptionError);
    assert.throws(
        () =>
            encodeStart({
                jobId: 1,
                samples: new Float32Array(MAX_SAMPLES + 1),
            }),
        TranscriptionError,
    );
});

test("protocol status/result/error validation", () => {
    const status = encodeStatus({
        jobId: 7,
        stage: "transcribing",
        backend: "webgl",
        completedWindows: 3,
        totalWindows: 10,
        progress: 0.3,
        tensorCount: 12,
    });
    const decodedStatus = decodeEvent(status, 7);
    assert.equal(decodedStatus.type, "status");
    assert.equal(decodedStatus.stage, "transcribing");
    assert.equal(decodedStatus.progress, 0.3);
    assert.equal(decodedStatus.tensorCount, 12);
    // A different VALID job id is ignored; malformed envelopes fail loudly.
    assert.equal(decodeEvent(status, 8), null);
    for (const junk of [
        null,
        "junk",
        42,
        {},
        { version: 1, type: "status", stage: "loading" }, // no job id
        { version: 1, jobId: 0, type: "status", stage: "loading" },
        { version: 1, jobId: "x", type: "status", stage: "loading" },
        { version: 1, jobId: -3, type: "status", stage: "loading" },
        { type: "progress", progress: 0 }, // legacy unversioned payload
    ])
        assert.throws(() => decodeEvent(junk, 7), TranscriptionError);

    const result = encodeResult({
        jobId: 7,
        notes: [NOTE, { ...NOTE, extra: 1 }],
        tensorCount: 0,
    });
    const decodedResult = decodeEvent(result, 7);
    assert.equal(decodedResult.type, "result");
    assert.equal(decodedResult.notes.length, 2);
    assert.deepEqual(decodedResult.notes[0], NOTE); // extra fields stripped
    assert.deepEqual(
        decodeEvent(encodeResult({ jobId: 7, notes: [] }), 7).notes,
        [],
    );

    const wireError = encodeError({
        jobId: 7,
        code: "inference",
        message: "boom",
        stage: "transcribing",
    });
    const decodedError = decodeEvent(wireError, 7);
    assert.equal(decodedError.type, "error");
    assert.equal(decodedError.error.code, "inference");
    assert.equal(decodedError.error.stage, "transcribing");
    // Long messages are bounded on encode.
    assert.ok(
        decodeEvent(
            encodeError({
                jobId: 7,
                code: "inference",
                message: "x".repeat(900),
            }),
            7,
        ).error.message.length <= 500,
    );
});

test("protocol rejects malformed status/result/error payloads", () => {
    const wrap = (type, fields) => ({ version: 1, jobId: 7, type, ...fields });
    for (const bad of [
        { version: 2, jobId: 7, type: "status", stage: "loading" },
        wrap("status", { stage: "bogus" }),
        wrap("status", { stage: "loading", progress: 1.5 }),
        wrap("status", { stage: "loading", progress: -0.1 }),
        wrap("status", { stage: "loading", progress: Number.NaN }),
        wrap("status", { stage: "loading", totalWindows: 0 }),
        wrap("status", { stage: "loading", totalWindows: 1.5 }),
        wrap("status", { stage: "loading", completedWindows: -1 }),
        wrap("status", { stage: "loading", completedWindows: 1.5 }),
        wrap("status", {
            stage: "loading",
            completedWindows: 5,
            totalWindows: 4,
        }),
        wrap("status", { stage: "loading", tensorCount: -1 }),
        wrap("status", { stage: "loading", tensorCount: 1.5 }),
        wrap("status", {}),
        wrap("start", { sampleRate: 22050 }),
        wrap("result", { notes: "nope" }),
        wrap("result", { notes: [{ ...NOTE, note: 128 }] }),
        wrap("result", { notes: [{ ...NOTE, note: -1 }] }),
        wrap("result", { notes: [{ ...NOTE, timeMs: -1 }] }),
        wrap("result", { notes: [{ ...NOTE, durationMs: 0 }] }),
        wrap("result", { notes: [{ ...NOTE, velocity: 0 }] }),
        wrap("result", { notes: [{ ...NOTE, velocity: 200 }] }),
        wrap("error", {
            error: { code: "BAD CODE!", message: "x", stage: null },
        }),
        wrap("error", {
            error: { code: "inference", message: 42, stage: null },
        }),
        wrap("error", {
            error: { code: "inference", message: "x".repeat(501), stage: null },
        }),
        wrap("error", {
            error: { code: "inference", message: "x", stage: "bogus" },
        }),
        wrap("error", {}),
        wrap("mystery", {}),
    ])
        assert.throws(
            () => decodeEvent(bad, 7),
            TranscriptionError,
            JSON.stringify(bad).slice(0, 120),
        );
});

// ---- job controller ------------------------------------------------------------

class FakeWorker {
    static instances = [];
    constructor() {
        this.onmessage = null;
        this.onerror = null;
        this.onmessageerror = null;
        this.posted = [];
        this.terminated = 0;
        FakeWorker.instances.push(this);
    }
    postMessage(message) {
        this.posted.push(message);
    }
    terminate() {
        this.terminated++;
    }
    emit(data) {
        this.onmessage?.({ data });
    }
    emitStatus(fields) {
        this.emit({
            version: PROTOCOL_VERSION,
            jobId: this.posted[0].jobId,
            type: "status",
            ...fields,
        });
    }
    emitResult(notes = [NOTE], extra = {}) {
        this.emit({
            version: PROTOCOL_VERSION,
            jobId: this.posted[0].jobId,
            type: "result",
            notes,
            ...extra,
        });
    }
    emitError(code = "inference", message = "boom", stage = null) {
        this.emit({
            version: PROTOCOL_VERSION,
            jobId: this.posted[0].jobId,
            type: "error",
            error: { code, message, stage },
        });
    }
    nativeError(message = "script error") {
        this.onerror?.({ message });
    }
}

function makeClock() {
    let now = 0;
    const timers = new Set();
    return {
        now: () => now,
        advance: (ms) => {
            now += ms;
        },
        setIntervalFn: (cb) => {
            const id = { cb };
            timers.add(id);
            return id;
        },
        clearIntervalFn: (id) => timers.delete(id),
        tick: () => {
            for (const timer of [...timers]) timer.cb();
        },
        timerCount: () => timers.size,
    };
}

function makeJob(overrides = {}) {
    const clock = makeClock();
    FakeWorker.instances = [];
    const updates = [];
    const job = new TranscriptionJob({
        createWorker: () => new FakeWorker(),
        onUpdate: (snapshot) => updates.push(snapshot),
        now: clock.now,
        setIntervalFn: clock.setIntervalFn,
        clearIntervalFn: clock.clearIntervalFn,
        ...overrides,
    });
    return { job, clock, updates };
}

const lastUpdate = (updates) => updates.at(-1);

test("job runs prepare -> versioned worker -> result, then cleans up once", async () => {
    const { job, clock, updates } = makeJob();
    const promise = job.start(() => samples());
    await flush();
    assert.equal(FakeWorker.instances.length, 1);
    const worker = FakeWorker.instances[0];
    const start = worker.posted[0];
    assert.equal(start.version, PROTOCOL_VERSION);
    assert.equal(start.type, "start");
    assert.equal(start.sampleRate, SAMPLE_RATE);
    assert.ok(start.jobId > 0);
    assert.equal(start.samples.length, 22050);
    assert.equal(job.snapshot.status, "running");
    assert.equal(job.snapshot.stage, "preparing");
    assert.equal(job.snapshot.audioSeconds, 1);
    assert.equal(clock.timerCount(), 1);

    worker.emitStatus({ stage: "initializing" });
    worker.emitStatus({ stage: "loading", backend: "webgl" });
    worker.emitStatus({ stage: "warming", progress: 0, completedWindows: 0 });
    worker.emitStatus({
        stage: "transcribing",
        backend: "webgl",
        progress: 0.5,
        completedWindows: 67,
        totalWindows: 134,
        tensorCount: 245,
    });
    worker.emitResult([NOTE], { tensorCount: 0 });
    const notes = await promise;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].note, 60);

    const snap = job.snapshot;
    assert.equal(snap.status, "completed");
    assert.equal(snap.backend, "webgl");
    assert.equal(snap.progress, 0.5);
    assert.equal(snap.completedWindows, 67);
    assert.equal(snap.totalWindows, 134);
    assert.equal(snap.tensorCount, 0);
    assert.equal(snap.error, null);
    assert.equal(worker.terminated, 1);
    assert.equal(clock.timerCount(), 0);

    const diag = job.getDiagnostics();
    assert.equal(diag.schema, "funcuby.transcription.diagnostics");
    assert.equal(diag.version, PROTOCOL_VERSION);
    assert.equal(diag.snapshot.status, "completed");
    assert.ok(diag.events.length >= 5);
    assert.ok(
        diag.events.some(
            (e) => e.type === "status" && e.stage === "transcribing",
        ),
    );
    assert.ok(diag.events.some((e) => e.type === "result"));
    // Diagnostics carry no audio, source names or note contents.
    const serialized = JSON.stringify(diag);
    assert.equal(serialized.includes("samples"), false);
    assert.equal(serialized.includes("timeMs"), false);
    assert.equal(serialized.includes("sourceName"), false);
    // Frozen snapshot/diagnostics.
    assert.throws(() => {
        snap.status = "failed";
    }, TypeError);
    assert.throws(() => {
        diag.events.push({});
    }, TypeError);
    // Terminal time is frozen: advancing the clock changes nothing.
    const elapsed = snap.elapsedMs;
    clock.advance(999999);
    assert.equal(job.snapshot.elapsedMs, elapsed);
    assert.equal(lastUpdate(updates).status, "completed");
});

test("cancel during pending prepare rejects promptly and never spawns a worker", async () => {
    const { job } = makeJob();
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const promise = job.start(() => gate);
    const rejected = assert.rejects(
        promise,
        (error) => error.name === "AbortError",
    );
    await flush();
    assert.equal(job.cancel(), true);
    await rejected;
    assert.equal(FakeWorker.instances.length, 0);
    assert.equal(job.snapshot.status, "cancelled");
    release(samples());
    await flush();
    await flush();
    assert.equal(FakeWorker.instances.length, 0);
    assert.equal(job.snapshot.status, "cancelled");
});

test("second start while running rejects busy; idle cancel returns false", async () => {
    const { job } = makeJob();
    assert.equal(job.cancel(), false);
    const first = job.start(() => samples());
    await flush();
    await assert.rejects(
        job.start(() => samples()),
        (error) => error instanceof TranscriptionError && error.code === "busy",
    );
    job.cancel();
    await assert.rejects(first, (error) => error.name === "AbortError");
    assert.equal(job.snapshot.status, "cancelled");
});

test("messages for a foreign job id are ignored", async () => {
    const { job } = makeJob();
    const promise = job.start(() => samples());
    await flush();
    const worker = FakeWorker.instances[0];
    const jobId = worker.posted[0].jobId;
    worker.emit({
        version: PROTOCOL_VERSION,
        jobId: jobId + 1,
        type: "status",
        stage: "extracting",
        progress: 1,
    });
    assert.equal(job.snapshot.stage, "preparing");
    worker.emitStatus({ stage: "extracting", progress: 1 });
    worker.emitResult([]);
    await promise;
    assert.equal(job.snapshot.status, "completed");
});

test("wrong version or malformed message fails the job as protocol error", async () => {
    const { job } = makeJob();
    const promise = job.start(() => samples());
    const rejected = assert.rejects(
        promise,
        (error) =>
            error instanceof TranscriptionError && error.code === "protocol",
    );
    await flush();
    const worker = FakeWorker.instances[0];
    worker.emit({
        version: 99,
        jobId: worker.posted[0].jobId,
        type: "status",
        stage: "loading",
    });
    await rejected;
    assert.equal(job.snapshot.status, "failed");
    assert.equal(job.snapshot.error.code, "protocol");
    assert.equal(worker.terminated, 1);
});

test("worker error envelope, native error and messageerror all fail once", async () => {
    for (const mode of ["envelope", "native", "messageerror"]) {
        const { job } = makeJob();
        const promise = job.start(() => samples());
        const rejected = assert.rejects(promise);
        await flush();
        const worker = FakeWorker.instances[0];
        if (mode === "envelope")
            worker.emitError("model", "weights missing", "loading");
        else if (mode === "native") worker.nativeError("script died");
        else worker.onmessageerror?.({});
        await rejected;
        assert.equal(job.snapshot.status, "failed");
        assert.equal(worker.terminated, 1);
        assert.equal(
            job.snapshot.error.code,
            mode === "envelope" ? "model" : "worker",
        );
    }
});

test("prepareSamples throw fails with its own code and spawns no worker", async () => {
    const { job } = makeJob();
    await assert.rejects(
        job.start(() => {
            throw new TranscriptionError("silence");
        }),
        (error) => error.code === "silence",
    );
    assert.equal(job.snapshot.status, "failed");
    assert.equal(job.snapshot.error.code, "silence");
    assert.equal(FakeWorker.instances.length, 0);
});

test("invalid prepared samples are rejected before any worker", async () => {
    const { job } = makeJob();
    for (const bad of [
        null,
        {},
        new Float32Array(0),
        new Float32Array(MAX_SAMPLES + 1),
        [1, 2],
    ]) {
        await assert.rejects(
            job.start(() => bad),
            (error) =>
                error instanceof TranscriptionError &&
                error.code === "invalid-input",
        );
        assert.equal(job.snapshot.status, "failed");
        assert.equal(job.snapshot.error.code, "invalid-input");
    }
    assert.equal(FakeWorker.instances.length, 0);
});

test("stale statuses are ignored whole; stall needs real inactivity", async () => {
    const { job, clock } = makeJob();
    const promise = job.start(() => samples());
    await flush();
    const worker = FakeWorker.instances[0];
    worker.emitStatus({
        stage: "transcribing",
        progress: 0.5,
        completedWindows: 50,
        totalWindows: 100,
        backend: "webgl",
    });
    const traceBefore = job.getDiagnostics().events.length;
    // Older stage + lower counts + lower progress + different backend/total:
    // the entire delayed message is dropped — nothing applies, nothing records.
    worker.emitStatus({
        stage: "loading",
        progress: 0.4,
        completedWindows: 30,
        totalWindows: 200,
        backend: "cpu",
    });
    // Progress-only and completion-only regressions are stale too.
    worker.emitStatus({ stage: "transcribing", progress: 0.4 });
    worker.emitStatus({
        stage: "transcribing",
        progress: 0.5,
        completedWindows: 40,
    });
    const snap = job.snapshot;
    assert.equal(snap.stage, "transcribing");
    assert.equal(snap.progress, 0.5);
    assert.equal(snap.completedWindows, 50);
    assert.equal(snap.totalWindows, 100);
    assert.equal(snap.backend, "webgl");
    assert.equal(
        job.getDiagnostics().events.length,
        traceBefore,
        "stale status was recorded",
    );
    assert.equal(snap.stalled, false);
    clock.advance(STALL_WARNING_MS);
    assert.equal(job.snapshot.stalled, true);
    assert.equal(job.snapshot.progress, 0.5); // clock never advances progress
    worker.emitStatus({
        stage: "transcribing",
        progress: 0.6,
        completedWindows: 60,
        totalWindows: 100,
    });
    assert.equal(job.snapshot.stalled, false);
    assert.equal(job.snapshot.progress, 0.6);
    worker.emitResult([NOTE]);
    await promise;
});

test("invariant-violating statuses fail the job as protocol errors", async () => {
    const seed = {
        stage: "transcribing",
        progress: 0.5,
        completedWindows: 50,
        totalWindows: 100,
    };
    const cases = [
        [
            "window total changed",
            {
                stage: "transcribing",
                progress: 0.6,
                completedWindows: 60,
                totalWindows: 200,
            },
        ],
        [
            "completed exceeds known total",
            { stage: "transcribing", progress: 0.9, completedWindows: 150 },
        ],
        [
            "progress does not match counts",
            {
                stage: "transcribing",
                progress: 0.7,
                completedWindows: 60,
                totalWindows: 100,
            },
        ],
        [
            "partial progress inconsistent with known counts",
            { stage: "transcribing", progress: 0.9 },
        ],
    ];
    for (const [name, bad] of cases) {
        const { job } = makeJob();
        const promise = job.start(() => samples());
        const rejected = assert.rejects(
            promise,
            (error) =>
                error instanceof TranscriptionError &&
                error.code === "protocol",
            name,
        );
        await flush();
        const worker = FakeWorker.instances[0];
        worker.emitStatus(seed);
        worker.emitStatus(bad);
        await rejected;
        assert.equal(job.snapshot.status, "failed", name);
        assert.equal(job.snapshot.error.code, "protocol", name);
        assert.equal(worker.terminated, 1, name);
    }
});

test("completed then restarted job uses a fresh worker and job id", async () => {
    const { job } = makeJob();
    const first = job.start(() => samples());
    await flush();
    const workerA = FakeWorker.instances[0];
    const jobIdA = workerA.posted[0].jobId;
    workerA.emitResult([NOTE]);
    await first;
    const second = job.start(() => samples());
    await flush();
    assert.equal(FakeWorker.instances.length, 2);
    const workerB = FakeWorker.instances[1];
    assert.notEqual(workerB.posted[0].jobId, jobIdA);
    workerB.emitResult([NOTE]);
    await second;
    assert.equal(job.snapshot.status, "completed");
});

test("dispose cancels active work, blocks new starts and clears the clock", async () => {
    const { job, clock } = makeJob();
    const promise = job.start(() => samples());
    const rejected = assert.rejects(
        promise,
        (error) => error.name === "AbortError",
    );
    await flush();
    job.dispose();
    await rejected;
    assert.equal(job.snapshot.status, "cancelled");
    assert.equal(FakeWorker.instances[0].terminated, 1);
    assert.equal(clock.timerCount(), 0);
    await assert.rejects(
        job.start(() => samples()),
        (error) => error instanceof TranscriptionError && error.code === "busy",
    );
    job.dispose(); // idempotent
});

test("cancelled snapshots carry no fake error and trace the reason", async () => {
    // Cancel while preparation is still pending.
    const pending = makeJob();
    const pendingPromise = pending.job.start(() => new Promise(() => {}));
    await flush();
    pending.job.cancel("user");
    await assert.rejects(pendingPromise, (e) => e.name === "AbortError");
    assert.equal(pending.job.snapshot.status, "cancelled");
    assert.equal(pending.job.snapshot.error, null);
    const pendingEvent = pending.job.getDiagnostics().events.at(-1);
    assert.equal(pendingEvent.type, "cancelled");
    assert.equal(pendingEvent.reason, "user");
    // Cancel while the worker is running.
    const active = makeJob();
    const activePromise = active.job.start(() => samples());
    await flush();
    active.job.cancel();
    await assert.rejects(activePromise, (e) => e.name === "AbortError");
    assert.equal(active.job.snapshot.error, null);
    assert.equal(active.job.getDiagnostics().events.at(-1).type, "cancelled");
});

test("raw prepare errors normalize to one typed clip error", async () => {
    for (const prepare of [
        () => {
            throw new Error("sync boom");
        },
        () => Promise.reject(new Error("async boom")),
    ]) {
        const { job } = makeJob();
        const promise = job.start(prepare);
        const rejected = assert.rejects(
            promise,
            (error) =>
                error instanceof TranscriptionError && error.code === "clip",
        );
        await rejected;
        assert.equal(job.snapshot.status, "failed");
        assert.equal(job.snapshot.error.code, "clip");
        assert.equal(job.snapshot.error.stage, "preparing");
        assert.equal(FakeWorker.instances.length, 0);
        // Explicit retry on the same instance still works.
        const retry = job.start(() => samples());
        await flush();
        FakeWorker.instances.at(-1).emitResult([NOTE]);
        await retry;
        assert.equal(job.snapshot.status, "completed");
    }
});

test("cancel inside the worker factory orphans nothing", async () => {
    const clock = makeClock();
    FakeWorker.instances = [];
    let job,
        creations = 0;
    job = new TranscriptionJob({
        createWorker: () => {
            const worker = new FakeWorker();
            // Reentrant cancel while run.worker is still null — first job only.
            if (++creations === 1) job.cancel();
            return worker;
        },
        now: clock.now,
        setIntervalFn: clock.setIntervalFn,
        clearIntervalFn: clock.clearIntervalFn,
    });
    const promise = job.start(() => samples());
    await assert.rejects(promise, (e) => e.name === "AbortError");
    const worker = FakeWorker.instances[0];
    assert.equal(worker.terminated, 1);
    assert.equal(worker.posted.length, 0);
    assert.equal(clock.timerCount(), 0);
    assert.equal(job.snapshot.status, "cancelled");
    assert.equal(job.snapshot.error, null);
    // The instance remains reusable for an explicit retry.
    const retry = job.start(() => samples());
    await flush();
    assert.equal(FakeWorker.instances.length, 2);
    FakeWorker.instances[1].emitResult([NOTE]);
    await retry;
    assert.equal(job.snapshot.status, "completed");
});

test("start emits a running/preparing snapshot synchronously with one clock", async () => {
    const { job, clock, updates } = makeJob();
    const promise = job.start(() => samples());
    // #begin emitted before the first await — no flush needed.
    assert.equal(updates.length >= 1, true);
    assert.equal(updates[0].status, "running");
    assert.equal(updates[0].stage, "preparing");
    assert.equal(updates[0].jobId > 0, true);
    await flush();
    assert.equal(clock.timerCount(), 1);
    const worker = FakeWorker.instances[0];
    worker.emitResult([NOTE]);
    await promise;
    assert.equal(clock.timerCount(), 0);
    // Diagnostics include the earliest stage from the beginning.
    assert.equal(job.getDiagnostics().events[0].stage, "preparing");
});

test("clock initialization failure fails cleanly and retry works", async () => {
    const clock = makeClock();
    FakeWorker.instances = [];
    let timerCalls = 0;
    const job = new TranscriptionJob({
        createWorker: () => new FakeWorker(),
        now: clock.now,
        setIntervalFn: (cb, ms) => {
            if (++timerCalls === 1) throw new Error("timer boom");
            return clock.setIntervalFn(cb, ms);
        },
        clearIntervalFn: clock.clearIntervalFn,
    });
    await assert.rejects(
        job.start(() => samples()),
        (error) => error instanceof TranscriptionError && error.code === "clip",
    );
    assert.equal(job.snapshot.status, "failed");
    assert.equal(job.snapshot.error.code, "clip");
    assert.equal(FakeWorker.instances.length, 0);
    assert.equal(clock.timerCount(), 0);
    // A fresh start arms a working clock and a fresh worker.
    const retry = job.start(() => samples());
    await flush();
    assert.equal(FakeWorker.instances.length, 1);
    FakeWorker.instances[0].emitResult([NOTE]);
    await retry;
    assert.equal(job.snapshot.status, "completed");
    assert.equal(clock.timerCount(), 0);
});

test("partial status derives real progress from known window counts", async () => {
    const { job, clock } = makeJob();
    const promise = job.start(() => samples());
    await flush();
    const worker = FakeWorker.instances[0];
    worker.emitStatus({
        stage: "transcribing",
        progress: 0.5,
        completedWindows: 50,
        totalWindows: 100,
    });
    clock.advance(1000);
    const idleBefore = job.snapshot.lastActivityAgeMs;
    // Counts-only update: progress is derived, health refreshes, ticks idle.
    worker.emitStatus({ stage: "transcribing", completedWindows: 60 });
    const snap = job.snapshot;
    assert.equal(snap.progress, 0.6);
    assert.equal(snap.completedWindows, 60);
    assert.equal(snap.totalWindows, 100);
    assert.ok(snap.lastActivityAgeMs < idleBefore);
    clock.tick();
    assert.equal(job.snapshot.progress, 0.6); // clock never advances progress
    worker.emitResult([NOTE]);
    await promise;
});

test("diagnostics trace stays bounded at 64 events", async () => {
    const { job } = makeJob();
    const promise = job.start(() => samples());
    await flush();
    const worker = FakeWorker.instances[0];
    for (let i = 1; i <= 80; i++)
        worker.emitStatus({
            stage: "transcribing",
            progress: i / 100,
            completedWindows: i,
            totalWindows: 100,
        });
    worker.emitResult([NOTE]);
    await promise;
    const diag = job.getDiagnostics();
    assert.ok(diag.events.length <= 64);
    assert.ok(diag.events.length > 0);
});
