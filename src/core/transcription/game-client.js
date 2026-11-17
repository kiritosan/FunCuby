import { TranscriptionError } from "./errors.js";
import {
    encodeStatus,
    encodeResult,
    encodeVocalStem,
    MAX_VOCAL_BYTES,
} from "./protocol.js";

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
    const separateQuery =
        start.engine === "game-separated" ? "&separate=1" : "";
    try {
        response = await fetchImpl(
            new URL(
                `/api/transcription/game?language=${start.language}${separateQuery}`,
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
        stemTransfer,
        result = null;
    async function downloadStem(id) {
        let blob = null;
        if (typeof id === "string" && /^[0-9a-f-]{36}$/.test(id)) {
            try {
                const url = new URL(
                    "/api/transcription/game/vocals",
                    import.meta.url,
                );
                url.searchParams.set("id", id);
                const response = await fetchImpl(url.href, {
                    signal: AbortSignal.timeout(60_000),
                });
                const size = Number(response.headers.get("content-length"));
                if (
                    response.ok &&
                    size > 44 &&
                    size <= MAX_VOCAL_BYTES &&
                    response.headers.get("content-type") === "audio/wav"
                ) {
                    const audio = await response.blob();
                    if (audio.size === size && audio.type === "audio/wav")
                        blob = audio;
                } else {
                    await response.body?.cancel();
                }
            } catch {
                // Preview availability is independent of transcription.
            }
        }
        postMessage(encodeVocalStem({ jobId: start.jobId, blob }));
    }
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
            const normalized =
                event.completedWindows !== undefined &&
                event.totalWindows !== undefined
                    ? {
                          ...event,
                          progress: event.completedWindows / event.totalWindows,
                      }
                    : event;
            postMessage(encodeStatus({ ...normalized, jobId: start.jobId }));
        } else if (
            event.type === "vocal-stem" &&
            start.engine === "game-separated" &&
            !stemTransfer
        ) {
            stemTransfer = downloadStem(event.id);
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
        await stemTransfer;
        postMessage(result);
    } catch (error) {
        await stemTransfer;
        throw error;
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
