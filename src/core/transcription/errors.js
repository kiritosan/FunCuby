import { AppError } from "../message.js";

export class TranscriptionError extends AppError {
    constructor(code, detail = "", stage = null, options) {
        super(`transcribe.errors.${code}`, { reason: detail }, options);
        this.name = "TranscriptionError";
        this.code = code;
        this.detail = detail;
        this.stage = stage;
    }
}

export function assertNotAborted(signal) {
    if (signal?.aborted)
        throw new DOMException("Transcription cancelled", "AbortError");
}
