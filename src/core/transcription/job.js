import {
    GAME_LANGUAGES,
    MAX_AUDIO_SECONDS,
    PROTOCOL_VERSION,
    TRANSCRIPTION_ENGINES,
    STALL_WARNING_MS,
} from "./config.js";
import { TranscriptionError } from "./errors.js";
import { decodeEvent, encodeStart } from "./protocol.js";

// Local preparation is not a worker stage; worker stages arrive over the wire.
const STAGE_RANK = new Map(
    [
        "preparing",
        "initializing",
        "loading",
        "warming",
        "separating",
        "transcribing",
        "extracting",
    ].map((stage, index) => [stage, index]),
);
const TRACE_LIMIT = 64;
const TICK_MS = 1000;
const MAX_TEXT = 500;

const isAbort = (error) => error?.name === "AbortError";
const abortError = () =>
    new DOMException("Transcription cancelled", "AbortError");
const clip = (text) => String(text ?? "").slice(0, MAX_TEXT);

function randomJobId() {
    try {
        const bytes = new Uint32Array(2);
        crypto.getRandomValues(bytes);
        return bytes[0] * 1048576 + (bytes[1] % 1048576) + 1;
    } catch {
        return Math.floor(Math.random() * 1048576) + 1;
    }
}

const freeze = (value) => Object.freeze(value);

/**
 * One active transcription job per instance: prepare samples on the main
 * thread, run Basic Pitch in a dedicated worker over the versioned protocol,
 * and expose a frozen snapshot plus a bounded event trace for diagnostics.
 * Cancellation is a hard worker.terminate() — the worker isolate is destroyed,
 * so its finally blocks are not guaranteed to run; tensor/model cleanup on
 * that path relies on isolate teardown, not graceful disposal.
 */
export class TranscriptionJob {
    #createWorker;
    #onUpdate;
    #now;
    #setIntervalFn;
    #clearIntervalFn;
    #disposed = false;
    #run = null;
    #jobId = 0;
    #status = "idle";
    #stage = null;
    #backend = null;
    #progress = null;
    #completedWindows = 0;
    #totalWindows = null;
    #audioSeconds = null;
    #tensorCount = null;
    #startedAt = null;
    #lastActivity = null;
    #endedAt = null;
    #error = null;
    #trace = [];
    #timer = null;

    constructor({
        createWorker = () =>
            new Worker(new URL("../transcription-worker.js", import.meta.url), {
                type: "module",
            }),
        onUpdate = () => {},
        now = () => performance.now(),
        // Wrapped: calling the bare natives with the job as receiver throws
        // "Illegal invocation" in the browser.
        setIntervalFn = (callback, ms) => setInterval(callback, ms),
        clearIntervalFn = (id) => clearInterval(id),
    } = {}) {
        this.#createWorker = createWorker;
        this.#onUpdate = onUpdate;
        this.#now = now;
        this.#setIntervalFn = setIntervalFn;
        this.#clearIntervalFn = clearIntervalFn;
    }

    get snapshot() {
        const ended = this.#endedAt ?? this.#now();
        const running = this.#status === "running";
        return freeze({
            jobId: this.#jobId,
            engine: this.#run?.engine ?? null,
            status: this.#status,
            stage: this.#stage,
            backend: this.#backend,
            progress: this.#progress,
            completedWindows: this.#completedWindows,
            totalWindows: this.#totalWindows,
            audioSeconds: this.#audioSeconds,
            elapsedMs: this.#startedAt === null ? 0 : ended - this.#startedAt,
            lastActivityAgeMs:
                this.#lastActivity === null ? 0 : ended - this.#lastActivity,
            stalled:
                running && this.#now() - this.#lastActivity >= STALL_WARNING_MS,
            tensorCount: this.#tensorCount,
            error: this.#error ? freeze({ ...this.#error }) : null,
        });
    }

    /** Plain serializable diagnostics: schema + snapshot + last events. */
    getDiagnostics() {
        return freeze({
            schema: "funcuby.transcription.diagnostics",
            version: PROTOCOL_VERSION,
            snapshot: this.snapshot,
            events: freeze(this.#trace.slice()),
        });
    }

    async start(
        prepareSamples,
        { engine = "basic-pitch", language = "auto" } = {},
    ) {
        if (this.#disposed)
            throw new TranscriptionError(
                "busy",
                "Transcription job is disposed",
            );
        if (this.#status === "running")
            throw new TranscriptionError(
                "busy",
                "A transcription is already running",
            );
        if (typeof prepareSamples !== "function")
            throw new TranscriptionError(
                "protocol",
                "prepareSamples must be a function",
            );
        if (
            !Object.hasOwn(TRANSCRIPTION_ENGINES, engine) ||
            !GAME_LANGUAGES.includes(language)
        )
            throw new TranscriptionError(
                "protocol",
                "Unsupported engine or language",
            );
        const run = this.#begin(engine, language);
        try {
            // Clock + first emit live inside the error boundary: a throwing
            // timer/observer must fail the job cleanly, not strand "running".
            this.#armClock();
            this.#emit();
            const samples = await this.#prepare(run, prepareSamples);
            const notes = await this.#transcribe(run, samples);
            return notes;
        } catch (error) {
            if (!run.finished) {
                const abort = isAbort(error);
                // One normalized error feeds both the rejected promise and the
                // diagnostics snapshot; typed errors and aborts pass through.
                const normalized =
                    abort || error instanceof TranscriptionError
                        ? error
                        : new TranscriptionError(
                              "clip",
                              clip(error?.message ?? error),
                              "preparing",
                          );
                this.#finish(run, {
                    status: abort ? "cancelled" : "failed",
                    error: normalized,
                    reason: abort
                        ? clip(error?.message ?? "cancelled")
                        : undefined,
                });
                throw normalized;
            }
            throw error;
        }
    }

    cancel(reason = "user") {
        const run = this.#run;
        if (
            this.#disposed ||
            !run ||
            run.finished ||
            this.#status !== "running"
        )
            return false;
        run.controller.abort(reason);
        this.#finish(run, { status: "cancelled", reason: clip(reason) });
        return true;
    }

    dispose() {
        if (this.#disposed) return;
        this.#disposed = true;
        const run = this.#run;
        if (run && !run.finished) {
            run.controller.abort("dispose");
            this.#finish(run, { status: "cancelled", reason: "dispose" });
        }
        this.#stopClock();
    }

    // ---- run lifecycle -------------------------------------------------------

    #begin(engine, language) {
        const spec = TRANSCRIPTION_ENGINES[engine];
        const run = {
            engine,
            language,
            sampleRate: spec.sampleRate,
            channels: spec.channels,
            jobId: randomJobId(),
            controller: new AbortController(),
            worker: null,
            settle: null,
            finished: false,
        };
        this.#run = run;
        this.#jobId = run.jobId;
        this.#status = "running";
        this.#stage = "preparing";
        this.#backend = null;
        this.#progress = null;
        this.#completedWindows = 0;
        this.#totalWindows = null;
        this.#audioSeconds = null;
        this.#tensorCount = null;
        this.#error = null;
        this.#trace = [];
        this.#startedAt = this.#now();
        this.#lastActivity = this.#startedAt;
        this.#endedAt = null;
        // State allocation only — arming the clock and emitting happen inside
        // start()'s try so initialization failures use the normal catch path.
        this.#trace.push(
            freeze({
                type: "status",
                at: this.#elapsed(),
                stage: "preparing",
                backend: null,
                progress: null,
                completedWindows: null,
                totalWindows: null,
                tensorCount: null,
            }),
        );
        this.#trimTrace();
        return run;
    }

    async #prepare(run, prepareSamples) {
        const signal = run.controller.signal;
        // A synchronous observer (onUpdate) may already have cancelled us.
        if (run.finished || signal.aborted) throw abortError();
        const produced = prepareSamples(signal);
        let onAbort;
        const aborted = new Promise((_, reject) => {
            onAbort = () => reject(abortError());
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
        });
        let samples;
        try {
            samples = await Promise.race([Promise.resolve(produced), aborted]);
        } finally {
            signal.removeEventListener("abort", onAbort);
        }
        if (run.finished || signal.aborted) throw abortError();
        if (
            !(samples instanceof Float32Array) ||
            !samples.length ||
            samples.length % run.channels !== 0 ||
            samples.length > run.sampleRate * run.channels * MAX_AUDIO_SECONDS
        )
            throw new TranscriptionError(
                "invalid-input",
                `Expected ${run.channels}-channel Float32 audio at ${run.sampleRate} Hz, up to 600 seconds`,
                "preparing",
            );
        this.#audioSeconds = samples.length / (run.sampleRate * run.channels);
        return samples;
    }

    #transcribe(run, samples) {
        return new Promise((resolve, reject) => {
            run.settle = { resolve, reject };
            if (
                run.finished ||
                this.#run !== run ||
                run.controller.signal.aborted
            ) {
                reject(abortError());
                return;
            }
            let worker;
            try {
                worker = this.#createWorker();
            } catch (error) {
                this.#finish(run, {
                    status: "failed",
                    error: new TranscriptionError(
                        "worker",
                        clip(error?.message ?? error),
                    ),
                });
                return;
            }
            run.worker = worker;
            if (
                run.finished ||
                this.#run !== run ||
                run.controller.signal.aborted
            ) {
                // cancel() ran inside the factory while run.worker was still
                // null, so it could not see this worker: terminate it here,
                // exactly once, and never post the start message.
                this.#terminateWorker(run);
                return;
            }
            try {
                worker.onmessage = (event) => this.#onMessage(run, event);
                worker.onerror = (event) => this.#onWorkerError(run, event);
                worker.onmessageerror = (event) =>
                    this.#onWorkerError(run, event);
                worker.postMessage(
                    encodeStart({
                        jobId: run.jobId,
                        sampleRate: run.sampleRate,
                        engine: run.engine,
                        language: run.language,
                        samples,
                    }),
                    [samples.buffer],
                );
            } catch (error) {
                this.#finish(run, {
                    status: "failed",
                    error: new TranscriptionError(
                        "worker",
                        clip(error?.message ?? error),
                    ),
                });
            }
        });
    }

    // ---- worker events ---------------------------------------------------------

    #onMessage(run, event) {
        if (run.finished || this.#run !== run) return;
        let message;
        try {
            message = decodeEvent(event.data, run.jobId);
        } catch (error) {
            this.#finish(run, { status: "failed", error });
            return;
        }
        if (message === null) return; // stale job id — not ours
        if (message.type === "status") {
            // A counts-only update still represents real completed work:
            // derive progress from the merged window counts before the
            // stale/invariant checks so it flows through the same rules.
            if (message.progress === undefined) {
                const total = message.totalWindows ?? this.#totalWindows;
                if (total !== null) {
                    const completed =
                        message.completedWindows ?? this.#completedWindows;
                    message = { ...message, progress: completed / total };
                }
            }
            // A delayed/out-of-order status is dropped whole: no state, no
            // activity refresh, no trace entry.
            if (this.#isStaleStatus(message)) return;
            const problem = this.#statusInvariantError(message);
            if (problem) {
                this.#finish(run, {
                    status: "failed",
                    error: new TranscriptionError("protocol", problem),
                });
                return;
            }
            this.#record(message);
            this.#applyStatus(message);
            return;
        }
        this.#record(message);
        if (message.type === "result")
            this.#finish(run, {
                status: "completed",
                notes: message.notes,
                tensorCount: message.tensorCount,
            });
        else
            this.#finish(run, {
                status: "failed",
                error: new TranscriptionError(
                    message.error.code,
                    message.error.message,
                    message.error.stage,
                ),
            });
    }

    #onWorkerError(run, event) {
        if (run.finished || this.#run !== run) return;
        this.#finish(run, {
            status: "failed",
            error: new TranscriptionError(
                "worker",
                clip(event?.message || "Worker error"),
            ),
        });
    }

    // A status is stale when any dimension it carries moved backwards:
    // older stage, fewer completed windows, or lower progress. Stale messages
    // are ignored entirely — they must not refresh backend, totals or idle.
    #isStaleStatus(message) {
        const rank = STAGE_RANK.get(message.stage) ?? -1,
            current = STAGE_RANK.get(this.#stage) ?? -1;
        if (rank >= 0 && current >= 0 && rank < current) return true;
        if (
            message.completedWindows !== undefined &&
            message.completedWindows < this.#completedWindows
        )
            return true;
        if (
            message.progress !== undefined &&
            this.#progress !== null &&
            message.progress < this.#progress
        )
            return true;
        return false;
    }

    // Cross-message invariants for a non-stale status. The window total is
    // fixed once known; completed windows can never exceed the known total;
    // when progress is reported together with knowable counts it must equal
    // completedWindows / totalWindows exactly (same JS producer).
    #statusInvariantError(message) {
        if (
            this.#totalWindows !== null &&
            message.totalWindows !== undefined &&
            message.totalWindows !== this.#totalWindows
        )
            return "Window total changed during a job";
        const completed = message.completedWindows ?? this.#completedWindows,
            total = message.totalWindows ?? this.#totalWindows;
        if (total !== null && completed > total)
            return "Completed windows exceed the total";
        if (message.progress !== undefined && total !== null) {
            const expected = completed / total;
            if (message.progress !== expected)
                return "Progress does not match completed windows";
        }
        return null;
    }

    #applyStatus(message) {
        const rank = STAGE_RANK.get(message.stage) ?? -1,
            current = STAGE_RANK.get(this.#stage) ?? -1;
        if (rank > current) this.#lastActivity = this.#now();
        this.#stage = message.stage;
        if (
            message.backend !== undefined &&
            message.backend !== this.#backend
        ) {
            this.#backend = message.backend;
            this.#lastActivity = this.#now();
        }
        if (message.progress !== undefined) {
            if (this.#progress === null || message.progress > this.#progress)
                this.#lastActivity = this.#now();
            this.#progress = message.progress;
        }
        if (message.completedWindows !== undefined) {
            if (message.completedWindows > this.#completedWindows)
                this.#lastActivity = this.#now();
            this.#completedWindows = message.completedWindows;
        }
        if (message.totalWindows !== undefined) {
            if (this.#totalWindows === null) this.#lastActivity = this.#now();
            this.#totalWindows = message.totalWindows;
        }
        if (message.tensorCount !== undefined)
            this.#tensorCount = message.tensorCount;
        this.#emit();
    }

    // ---- terminal paths ---------------------------------------------------------

    #finish(run, outcome) {
        if (run.finished) return;
        run.finished = true;
        this.#terminateWorker(run);
        this.#stopClock();
        if (this.#run === run) {
            this.#status = outcome.status;
            if (outcome.status === "completed") {
                if (outcome.tensorCount !== undefined)
                    this.#tensorCount = outcome.tensorCount;
                this.#trace.push(
                    freeze({
                        type: "result",
                        at: this.#elapsed(),
                        notes: outcome.notes.length,
                        tensorCount: outcome.tensorCount ?? null,
                    }),
                );
            } else {
                // Cancellation is not a failure: no fake worker error object.
                this.#error =
                    outcome.status === "cancelled"
                        ? null
                        : this.#errorInfo(outcome.error);
                this.#trace.push(
                    freeze({
                        type: outcome.status,
                        at: this.#elapsed(),
                        ...(outcome.status === "cancelled"
                            ? {
                                  reason: clip(
                                      outcome.reason ??
                                          outcome.error?.message ??
                                          "cancelled",
                                  ),
                              }
                            : { code: this.#error?.code ?? null }),
                    }),
                );
            }
            this.#trimTrace();
            this.#endedAt = this.#now();
            this.#emit();
        }
        if (outcome.status === "completed")
            run.settle?.resolve(
                freeze(outcome.notes.map((note) => freeze({ ...note }))),
            );
        else
            run.settle?.reject(
                outcome.status === "cancelled"
                    ? abortError()
                    : (outcome.error ?? abortError()),
            );
    }

    #errorInfo(error) {
        if (error instanceof TranscriptionError)
            return freeze({
                code: error.code,
                message: clip(error.detail || error.message),
                stage: error.stage ?? null,
            });
        return freeze({
            code: "worker",
            message: clip(error?.message ?? error),
            stage: null,
        });
    }

    #terminateWorker(run) {
        const worker = run.worker;
        run.worker = null;
        if (!worker) return;
        try {
            worker.onmessage = null;
            worker.onerror = null;
            worker.onmessageerror = null;
        } catch {
            /* already detached */
        }
        try {
            worker.terminate();
        } catch {
            /* already gone */
        }
    }

    // ---- clock + trace -----------------------------------------------------------

    #armClock() {
        this.#stopClock();
        this.#timer = this.#setIntervalFn(() => this.#tick(), TICK_MS);
    }

    #stopClock() {
        if (this.#timer !== null) {
            this.#clearIntervalFn(this.#timer);
            this.#timer = null;
        }
    }

    #tick() {
        if (this.#status !== "running") {
            this.#stopClock();
            return;
        }
        this.#emit();
    }

    #elapsed() {
        return this.#startedAt === null ? 0 : this.#now() - this.#startedAt;
    }

    #record(message) {
        const at = this.#elapsed();
        if (message.type === "status")
            this.#trace.push(
                freeze({
                    type: "status",
                    at,
                    stage: message.stage,
                    backend: message.backend ?? null,
                    progress: message.progress ?? null,
                    completedWindows: message.completedWindows ?? null,
                    totalWindows: message.totalWindows ?? null,
                    tensorCount: message.tensorCount ?? null,
                }),
            );
        else if (message.type === "error")
            this.#trace.push(
                freeze({
                    type: "error",
                    at,
                    code: message.error.code,
                    stage: message.error.stage,
                    message: clip(message.error.message),
                }),
            );
        this.#trimTrace();
    }

    #trimTrace() {
        if (this.#trace.length > TRACE_LIMIT)
            this.#trace.splice(0, this.#trace.length - TRACE_LIMIT);
    }

    #emit() {
        this.#onUpdate(this.snapshot);
    }
}
