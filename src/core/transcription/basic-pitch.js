// Framing/tail trimming adapted from @spotify/basic-pitch 1.0.1 (Apache-2.0).
// Modified to scope tensor lifetimes and report completed inference windows.
import {
    BASIC_PITCH,
    MAX_SAMPLES,
    SAMPLE_RATE,
    TRANSCRIPTION_BACKEND,
} from "./config.js";
import { assertNotAborted, TranscriptionError } from "./errors.js";

export function validateSamples(samples) {
    if (
        !(samples instanceof Float32Array) ||
        !samples.length ||
        samples.length > MAX_SAMPLES ||
        samples.some((sample) => !Number.isFinite(sample))
    )
        throw new TranscriptionError(
            "invalid-input",
            "Expected finite mono audio at 22050 Hz, up to 600 seconds",
            "initializing",
        );
}

function tensorCount(tf) {
    try {
        const count = tf.memory().numTensors;
        return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Preserve BasicPitch.evaluateModel's framing and tail trimming, but give each
 * input/window tensor an explicit lifetime. Scopes may cross await here because
 * a transcription worker exclusively owns its TensorFlow engine for one job.
 * Contours are disposed, not downloaded: this app does not extract pitch bends.
 */
export async function evaluateBasicPitchFrames({
    tf,
    pitch,
    samples,
    onWindow = () => {},
    signal,
}) {
    const frames = [],
        onsets = [],
        engine = tf.engine();
    engine.startScope("transcription-input");
    try {
        assertNotAborted(signal);
        let prepared;
        engine.startScope("transcription-prepare");
        try {
            prepared = await pitch.prepareData(samples);
        } finally {
            // Keep only the framed input, not the temporary padded audio/slices.
            engine.endScope(prepared?.[0]);
        }
        const [input, originalLength] = prepared;
        const total = input.shape[0];
        if (
            originalLength !== samples.length ||
            !Number.isSafeInteger(total) ||
            total < 1
        )
            throw new Error("Unexpected Basic Pitch input shape");
        const frameLimit = Math.floor(
            originalLength *
                (Math.floor(SAMPLE_RATE / BASIC_PITCH.fftHop) / SAMPLE_RATE),
        );
        let calculatedFrames = 0;
        onWindow({
            completedWindows: 0,
            totalWindows: total,
            progress: 0,
            tensorCount: tensorCount(tf),
        });
        for (let index = 0; index < total; index++) {
            assertNotAborted(signal);
            engine.startScope("transcription-window");
            try {
                const results = await pitch.evaluateSingleFrame(input, index);
                let frameTensor = pitch.unwrapOutput(results[0]),
                    onsetTensor = pitch.unwrapOutput(results[1]);
                if (
                    frameTensor.shape.length !== 2 ||
                    onsetTensor.shape.length !== 2 ||
                    frameTensor.shape[1] !== BASIC_PITCH.pitches ||
                    onsetTensor.shape[1] !== BASIC_PITCH.pitches ||
                    frameTensor.shape[0] !== onsetTensor.shape[0]
                )
                    throw new Error("Unexpected Basic Pitch output shape");
                const available = frameTensor.shape[0];
                if (calculatedFrames < frameLimit) {
                    if (calculatedFrames + available >= frameLimit) {
                        const remaining = frameLimit - calculatedFrames;
                        frameTensor = frameTensor.slice(
                            [0, 0],
                            [remaining, -1],
                        );
                        onsetTensor = onsetTensor.slice(
                            [0, 0],
                            [remaining, -1],
                        );
                    }
                    calculatedFrames += available;
                    frames.push(...(await frameTensor.array()));
                    onsets.push(...(await onsetTensor.array()));
                }
            } finally {
                engine.endScope();
            }
            // Only completed inference + readback advances the real progress.
            onWindow({
                completedWindows: index + 1,
                totalWindows: total,
                progress: (index + 1) / total,
                tensorCount: tensorCount(tf),
            });
        }
        return { frames, onsets };
    } finally {
        engine.endScope();
    }
}

export function normalizeNotes(notes, durationMs) {
    return notes
        .map((note) => {
            const start = Math.max(0, note.startTimeSeconds * 1000);
            const end = Math.min(
                durationMs,
                (note.startTimeSeconds + note.durationSeconds) * 1000,
            );
            return {
                note: note.pitchMidi,
                timeMs: start,
                durationMs: end - start,
                velocity: Math.max(
                    1,
                    Math.min(127, Math.round(note.amplitude * 127)),
                ),
            };
        })
        .filter(
            (note) =>
                Number.isInteger(note.note) &&
                note.note >= 0 &&
                note.note <= 127 &&
                Number.isFinite(note.timeMs) &&
                note.timeMs >= 0 &&
                Number.isFinite(note.durationMs) &&
                note.durationMs > 0 &&
                Number.isFinite(note.velocity),
        )
        .sort((a, b) => a.timeMs - b.timeMs || b.note - a.note);
}

/**
 * Model adapter; DOM, worker transport, job timing and UI translations belong
 * to callers. Loading weights outside tensor scopes keeps them alive across
 * windows; the model itself is disposed on every terminal path.
 */
export async function transcribeSamples({
    samples,
    runtime,
    modelUrl,
    onStatus = () => {},
    signal,
}) {
    validateSamples(samples);
    assertNotAborted(signal);
    const { tf, BasicPitch, outputToNotesPoly, noteFramesToTime } = runtime;
    let stage = "initializing",
        model = null,
        frames = [],
        onsets = [];
    try {
        onStatus({ stage });
        if (!(await tf.setBackend(TRANSCRIPTION_BACKEND)))
            throw new TranscriptionError(
                "backend",
                `Could not initialize the ${TRANSCRIPTION_BACKEND} backend`,
                stage,
            );
        await tf.ready();
        assertNotAborted(signal);
        const backend = tf.getBackend();
        if (backend !== TRANSCRIPTION_BACKEND)
            throw new TranscriptionError(
                "backend",
                `Expected ${TRANSCRIPTION_BACKEND}, received ${backend}`,
                stage,
            );
        const emit = (update) => onStatus({ backend, ...update });
        stage = "loading";
        emit({ stage });
        const pitch = new BasicPitch(modelUrl);
        model = await pitch.model;
        assertNotAborted(signal);
        stage = "warming";
        emit({ stage, progress: 0, completedWindows: 0 });
        ({ frames, onsets } = await evaluateBasicPitchFrames({
            tf,
            pitch,
            samples,
            signal,
            onWindow: (update) => {
                stage =
                    update.completedWindows === 0 ? "warming" : "transcribing";
                emit({ stage, ...update });
            },
        }));
        assertNotAborted(signal);
        stage = "extracting";
        emit({ stage, progress: 1, tensorCount: tensorCount(tf) });
        if (!frames.length) return [];
        return normalizeNotes(
            noteFramesToTime(
                outputToNotesPoly(
                    frames,
                    onsets,
                    BASIC_PITCH.onsetThreshold,
                    BASIC_PITCH.frameThreshold,
                    BASIC_PITCH.minNoteLength,
                ),
            ),
            (samples.length / SAMPLE_RATE) * 1000,
        );
    } catch (error) {
        if (error?.name === "AbortError" || error instanceof TranscriptionError)
            throw error;
        const code =
            stage === "initializing"
                ? "backend"
                : stage === "loading"
                  ? "model"
                  : stage === "extracting"
                    ? "postprocess"
                    : "inference";
        throw new TranscriptionError(
            code,
            String(error?.message ?? error),
            stage,
            { cause: error },
        );
    } finally {
        frames.length = 0;
        onsets.length = 0;
        model?.dispose();
    }
}
