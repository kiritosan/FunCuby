import {
    GAME_LANGUAGES,
    MAX_AUDIO_SECONDS,
    PROTOCOL_VERSION,
    SAMPLE_RATE,
    TRANSCRIPTION_ENGINES,
} from "./config.js";
import { TranscriptionError } from "./errors.js";

// Versioned worker <-> page envelope. The client ignores messages for other
// job ids; a wrong version or malformed payload for the current job is a
// protocol failure, never silently tolerated.
const STAGES = new Set([
    "initializing",
    "loading",
    "warming",
    "transcribing",
    "extracting",
]);
const ERROR_CODE = /^[a-z0-9-]{1,64}$/;
const MAX_ERROR_MESSAGE = 500;
const MAX_BACKEND_LENGTH = 128;

const protocolError = (detail) => new TranscriptionError("protocol", detail);
const isObject = (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value);
const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const isNonNegativeInteger = (value) =>
    Number.isSafeInteger(value) && value >= 0;

const checkStage = (stage) => {
    if (typeof stage !== "string" || !STAGES.has(stage))
        throw protocolError(`Unknown stage ${String(stage)}`);
    return stage;
};

const checkBackend = (backend) => {
    if (
        typeof backend !== "string" ||
        !backend ||
        backend.length > MAX_BACKEND_LENGTH
    )
        throw protocolError("Invalid backend name");
    return backend;
};

const checkProgress = (progress) => {
    if (
        typeof progress !== "number" ||
        !Number.isFinite(progress) ||
        progress < 0 ||
        progress > 1
    )
        throw protocolError("Invalid progress value");
    return progress;
};

const checkTotalWindows = (total) => {
    if (!isPositiveInteger(total)) throw protocolError("Invalid window total");
    return total;
};

const checkCompletedWindows = (completed, total) => {
    if (!isNonNegativeInteger(completed))
        throw protocolError("Invalid completed window count");
    if (total !== undefined && completed > total)
        throw protocolError("Completed windows exceed total");
    return completed;
};

const checkTensorCount = (count) => {
    if (!isNonNegativeInteger(count))
        throw protocolError("Invalid tensor count");
    return count;
};

const checkNote = (note) => {
    if (!isObject(note)) throw protocolError("Invalid note entry");
    if (!Number.isInteger(note.note) || note.note < 0 || note.note > 127)
        throw protocolError("Invalid MIDI note");
    if (
        typeof note.timeMs !== "number" ||
        !Number.isFinite(note.timeMs) ||
        note.timeMs < 0
    )
        throw protocolError("Invalid note time");
    if (
        typeof note.durationMs !== "number" ||
        !Number.isFinite(note.durationMs) ||
        note.durationMs <= 0
    )
        throw protocolError("Invalid note duration");
    if (
        typeof note.velocity !== "number" ||
        !Number.isFinite(note.velocity) ||
        note.velocity < 1 ||
        note.velocity > 127
    )
        throw protocolError("Invalid note velocity");
    return {
        note: note.note,
        timeMs: note.timeMs,
        durationMs: note.durationMs,
        velocity: note.velocity,
    };
};

const checkNotes = (notes) => {
    if (!Array.isArray(notes)) throw protocolError("Notes must be an array");
    return notes.map(checkNote);
};

const checkErrorCode = (code) => {
    if (typeof code !== "string" || !ERROR_CODE.test(code))
        throw protocolError("Invalid error code");
    return code;
};

const checkErrorMessage = (message) => {
    if (typeof message !== "string")
        throw protocolError("Invalid error message");
    if (message.length > MAX_ERROR_MESSAGE)
        throw protocolError("Error message too long");
    return message;
};

const checkErrorStage = (stage) =>
    stage === null || stage === undefined ? null : checkStage(stage);

function envelope(jobId, type, fields = {}) {
    if (!isPositiveInteger(jobId)) throw protocolError("Invalid job id");
    return { version: PROTOCOL_VERSION, jobId, type, ...fields };
}

export function encodeStart({
    jobId,
    sampleRate = SAMPLE_RATE,
    samples,
    engine = "basic-pitch",
    language = "auto",
}) {
    if (
        typeof engine !== "string" ||
        !Object.hasOwn(TRANSCRIPTION_ENGINES, engine)
    )
        throw protocolError("Unsupported transcription engine");
    if (sampleRate !== TRANSCRIPTION_ENGINES[engine].sampleRate)
        throw protocolError("Unsupported sample rate");
    if (engine === "game" && !GAME_LANGUAGES.includes(language))
        throw protocolError("Unsupported language");
    if (
        !(samples instanceof Float32Array) ||
        !samples.length ||
        samples.length > sampleRate * MAX_AUDIO_SECONDS
    )
        throw protocolError("Invalid sample buffer");
    return envelope(jobId, "start", {
        sampleRate,
        samples,
        ...(engine === "game" ? { engine, language } : {}),
    });
}

export function encodeStatus({
    jobId,
    stage,
    backend,
    completedWindows,
    totalWindows,
    progress,
    tensorCount,
}) {
    const fields = { stage: checkStage(stage) };
    if (backend !== undefined) fields.backend = checkBackend(backend);
    if (totalWindows !== undefined)
        fields.totalWindows = checkTotalWindows(totalWindows);
    if (completedWindows !== undefined)
        fields.completedWindows = checkCompletedWindows(
            completedWindows,
            fields.totalWindows,
        );
    if (progress !== undefined) fields.progress = checkProgress(progress);
    if (tensorCount !== undefined)
        fields.tensorCount = checkTensorCount(tensorCount);
    return envelope(jobId, "status", fields);
}

export function encodeResult({ jobId, notes, tensorCount }) {
    const fields = { notes: checkNotes(notes) };
    if (tensorCount !== undefined)
        fields.tensorCount = checkTensorCount(tensorCount);
    return envelope(jobId, "result", fields);
}

export function encodeError({ jobId, code, message, stage = null }) {
    return envelope(jobId, "error", {
        error: {
            code: checkErrorCode(code),
            message: String(message ?? "").slice(0, MAX_ERROR_MESSAGE),
            stage: checkErrorStage(stage),
        },
    });
}

/** Worker side: validate the single start request before heavy imports. */
export function decodeStart(data) {
    if (!isObject(data)) throw protocolError("Start message is not an object");
    if (data.version !== PROTOCOL_VERSION)
        throw protocolError(`Unsupported protocol version`);
    if (!isPositiveInteger(data.jobId)) throw protocolError("Invalid job id");
    if (data.type !== "start") throw protocolError("Expected a start message");
    if (typeof data.sampleRate !== "number")
        throw protocolError("Missing sample rate");
    const validated = encodeStart(data);
    return {
        jobId: data.jobId,
        sampleRate: data.sampleRate,
        samples: data.samples,
        ...(validated.engine
            ? { engine: validated.engine, language: validated.language }
            : {}),
    };
}

function statusFields(data) {
    const fields = { stage: checkStage(data.stage) };
    if (data.backend !== undefined) fields.backend = checkBackend(data.backend);
    if (data.totalWindows !== undefined)
        fields.totalWindows = checkTotalWindows(data.totalWindows);
    if (data.completedWindows !== undefined)
        fields.completedWindows = checkCompletedWindows(
            data.completedWindows,
            fields.totalWindows,
        );
    if (data.progress !== undefined)
        fields.progress = checkProgress(data.progress);
    if (data.tensorCount !== undefined)
        fields.tensorCount = checkTensorCount(data.tensorCount);
    return fields;
}

/**
 * Client side: returns the normalized worker->client message, or null when the
 * envelope carries a different VALID job id (a stale worker's output). A
 * non-object payload, a missing/invalid job id, a wrong version or a
 * malformed payload addressed to this job throws TranscriptionError —
 * malformed input must fail loudly, never hang the job.
 */
export function decodeEvent(data, jobId) {
    if (!isObject(data)) throw protocolError("Message is not an object");
    if (!isPositiveInteger(data.jobId)) throw protocolError("Invalid job id");
    if (data.jobId !== jobId) return null;
    if (data.version !== PROTOCOL_VERSION)
        throw protocolError(`Unsupported protocol version`);
    if (data.type === "status")
        return { type: "status", ...statusFields(data) };
    if (data.type === "result") {
        const fields = { notes: checkNotes(data.notes) };
        if (data.tensorCount !== undefined)
            fields.tensorCount = checkTensorCount(data.tensorCount);
        return { type: "result", ...fields };
    }
    if (data.type === "error") {
        if (!isObject(data.error)) throw protocolError("Invalid error payload");
        return {
            type: "error",
            error: {
                code: checkErrorCode(data.error.code),
                message: checkErrorMessage(data.error.message),
                stage: checkErrorStage(data.error.stage),
            },
        };
    }
    throw protocolError(`Unexpected message type ${String(data.type)}`);
}
