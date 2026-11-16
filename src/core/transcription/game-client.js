import { TranscriptionError } from "./errors.js";
import { encodeStatus, encodeResult } from "./protocol.js";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// Runs inside the owned worker. terminate() aborts its loopback request;
// the server observes disconnect and terminates the owned inference process.
export async function transcribeGame(
    start,
    {
        fetchImpl = (...args) => fetch(...args),
        postMessage = (message) => self.postMessage(message),
    } = {},
) {
    let response;
    try {
        response = await fetchImpl(
            new URL(
                `/api/transcription/game?language=${start.language}`,
                import.meta.url,
            ).href,
            {
                method: "POST",
                headers: { "Content-Type": "application/octet-stream" },
                body: start.samples,
            },
        );
    } catch (error) {
        throw new TranscriptionError(
            "unavailable",
            `Local GAME service: ${error.message}`,
            "initializing",
        );
    }
    if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new TranscriptionError(
            body?.error?.code ?? "unavailable",
            body?.error?.message ??
                `HTTP ${response.status}. Restart npm start.`,
            "initializing",
        );
    }
    if (
        !response.headers
            .get("content-type")
            ?.startsWith("application/x-ndjson")
    )
        throw new TranscriptionError(
            "protocol",
            "Expected a GAME event stream",
        );
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "",
        bytes = 0,
        terminal = false,
        result = null;
    const consume = (line) => {
        if (!line.trim()) return;
        if (terminal)
            throw new TranscriptionError(
                "protocol",
                "Event after terminal result",
            );
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            throw new TranscriptionError("protocol", "Malformed GAME JSON");
        }
        if (event.type === "status") {
            postMessage(encodeStatus({ ...event, jobId: start.jobId }));
        } else if (event.type === "result") {
            terminal = true;
            result = encodeResult({ jobId: start.jobId, notes: event.notes });
        } else if (event.type === "error") {
            throw new TranscriptionError(
                event.code,
                event.message,
                event.stage,
            );
        } else throw new TranscriptionError("protocol", "Unknown GAME event");
    };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES)
                throw new TranscriptionError(
                    "protocol",
                    "GAME response exceeds limit",
                );
            buffered += decoder.decode(value, { stream: true });
            let newline;
            while ((newline = buffered.indexOf("\n")) !== -1) {
                consume(buffered.slice(0, newline));
                buffered = buffered.slice(newline + 1);
            }
        }
        buffered += decoder.decode();
        if (buffered.trim()) consume(buffered);
        if (!terminal)
            throw new TranscriptionError(
                "protocol",
                "GAME stream ended without a result",
            );
        postMessage(result);
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
