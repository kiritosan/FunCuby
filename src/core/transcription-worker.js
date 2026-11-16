import { transcribeSamples } from "./transcription/basic-pitch.js";
import {
    decodeStart,
    encodeError,
    encodeResult,
    encodeStatus,
} from "./transcription/protocol.js";
import { TranscriptionError } from "./transcription/errors.js";
import { transcribeGame } from "./transcription/game-client.js";

// Thin job entry: validate the versioned start request before the heavy
// runtime import, forward adapter status over the envelope, and serialize
// terminal outcomes. One handled start per worker — the job controller owns
// worker lifecycle and hard cancellation via terminate().
let handled = false;

self.addEventListener("message", (event) => {
    if (handled) return;
    handled = true;
    void runJob(event.data);
});

const errorInfo = (error) => {
    if (error instanceof TranscriptionError)
        return {
            code: error.code,
            message: error.detail || error.message,
            stage: error.stage ?? null,
        };
    return {
        code: "inference",
        message: String(error?.message ?? error),
        stage: null,
    };
};

async function runJob(data) {
    // Best-effort id so a malformed start can still be answered; the client
    // ignores envelopes whose job id does not match its active job.
    const replyId =
        Number.isSafeInteger(data?.jobId) && data.jobId > 0 ? data.jobId : null;
    try {
        const start = decodeStart(data);
        const jobId = start.jobId;
        self.postMessage(encodeStatus({ jobId, stage: "initializing" }));
        if (start.engine === "game") {
            await transcribeGame(start);
            return;
        }
        let runtime;
        try {
            runtime = await import("../../vendor/transcription-runtime.js");
        } catch (error) {
            throw new TranscriptionError(
                "runtime",
                String(error?.message ?? error),
                "initializing",
            );
        }
        const notes = await transcribeSamples({
            samples: start.samples,
            runtime,
            modelUrl: new URL(
                "../../vendor/basic-pitch/model.json",
                import.meta.url,
            ).href,
            // Status encoding/posting errors propagate into the adapter's
            // catch and become a structured terminal error — never swallowed.
            onStatus: (update) => {
                self.postMessage(encodeStatus({ jobId, ...update }));
            },
        });
        let tensorCount;
        try {
            tensorCount = runtime.tf.memory().numTensors;
        } catch {
            tensorCount = undefined;
        }
        self.postMessage(encodeResult({ jobId, notes, tensorCount }));
    } catch (error) {
        try {
            const info = errorInfo(error);
            if (replyId !== null)
                self.postMessage(encodeError({ jobId: replyId, ...info }));
        } catch {
            // Even error serialization must not escape the handler: answer
            // with a guaranteed-valid envelope or stay silent — the client
            // treats a dead worker via its own error/terminate paths.
            if (replyId !== null)
                try {
                    self.postMessage(
                        encodeError({
                            jobId: replyId,
                            code: "inference",
                            message: "Transcription failed",
                            stage: null,
                        }),
                    );
                } catch {
                    /* nothing more we can do */
                }
        }
    }
}
