import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
    GAME_LANGUAGES,
    MAX_AUDIO_SECONDS,
} from "../src/core/transcription/config.js";
import { isAllowedHost } from "./audio-import.js";

const MAX_MONO_BYTES = 44100 * MAX_AUDIO_SECONDS * 4;
const MAX_STEREO_BYTES = MAX_MONO_BYTES * 2;
const MAX_STDOUT = 8 * 1024 * 1024;
const JOB_TIMEOUT = 25 * 60 * 1000;
const STEM_TTL = 60_000;

class RequestError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function json(res, status, body) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        Connection: "close",
    });
    res.end(JSON.stringify(body));
}

// Only a direct owned Python process is launched. ONNX inference uses native
// threads, not subprocesses, so cancellation never signals a guessed PID/tree.
export function createGameTranscription({
    port,
    root,
    spawnImpl = spawn,
    python = process.env.FUNCUBY_GAME_PYTHON || "python",
    jobTimeout = JOB_TIMEOUT,
} = {}) {
    let active = null,
        retainedStem = null,
        probe = null,
        probedAt = 0;
    const removeDirectory = (path) =>
        rm(path, { recursive: true, force: true }).catch(() => {});
    function expireStem(stem) {
        if (retainedStem === stem) retainedStem = null;
        clearTimeout(stem.expiry);
        // A streaming response may still hold the file open on Windows.
        stem.expired = true;
        if (!stem.readers) void removeDirectory(stem.directory);
    }
    const launch = (args) =>
        spawnImpl(
            python,
            [join(root, "scripts", "game-transcribe.py"), ...args],
            {
                cwd: root,
                windowsHide: true,
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );

    function readiness() {
        if (probe && Date.now() - probedAt < 10000) return probe;
        probedAt = Date.now();
        probe = new Promise((resolve) => {
            let child,
                output = "",
                finished = false;
            const done = (value) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                resolve(value);
            };
            const timer = setTimeout(() => {
                child?.kill();
                done({
                    available: false,
                    reason: "Environment check timed out",
                });
            }, 10000);
            try {
                child = launch(["--check"]);
                child.stdout.on("data", (chunk) => {
                    output += chunk.toString();
                    if (output.length > 8192) {
                        child.kill();
                        done({
                            available: false,
                            reason: "Invalid environment response",
                        });
                    }
                });
                child.stderr.on("data", () => {});
                child.once("error", () =>
                    done({ available: false, reason: "Python is unavailable" }),
                );
                child.once("close", (code) => {
                    try {
                        const result = JSON.parse(output.trim());
                        done(
                            code === 0 && result.available
                                ? result
                                : {
                                      available: false,
                                      reason:
                                          result.message ||
                                          "Run npm run setup:game",
                                  },
                        );
                    } catch {
                        done({
                            available: false,
                            reason: "Install numpy/onnxruntime and run npm run setup:game",
                        });
                    }
                });
            } catch {
                done({ available: false, reason: "Python is unavailable" });
            }
        });
        return probe;
    }

    async function handle(req, res) {
        const url = new URL(req.url, "http://localhost");
        if (
            ![
                "/api/transcription/game",
                "/api/transcription/game/status",
                "/api/transcription/game/vocals",
            ].includes(url.pathname)
        )
            return false;
        let directory = null,
            token = null,
            child = null,
            timeout = null;
        let disconnected = false;
        const disconnect = () => {
            if (!res.writableEnded) {
                disconnected = true;
                child?.kill();
                if (!req.complete) req.destroy();
            }
        };
        try {
            if (
                !isAllowedHost(
                    req.headers.host,
                    port || req.socket.localPort,
                ) ||
                !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
                    req.socket.remoteAddress,
                ) ||
                req.headers["sec-fetch-site"] === "cross-site"
            )
                throw new RequestError(403, "forbidden", "Local requests only");
            if (url.pathname.endsWith("/status")) {
                if (!["GET", "HEAD"].includes(req.method))
                    throw new RequestError(405, "method", "Expected GET");
                json(res, 200, await readiness());
                return true;
            }
            if (url.pathname.endsWith("/vocals")) {
                if (req.method !== "GET")
                    throw new RequestError(405, "method", "Expected GET");
                const id = url.searchParams.get("id");
                const stem = [active, retainedStem].find(
                    (candidate) =>
                        candidate?.ready &&
                        !candidate.delivered &&
                        !candidate.readers &&
                        candidate.id === id,
                );
                if (!stem)
                    throw new RequestError(
                        404,
                        "unavailable",
                        "Vocal stem unavailable",
                    );
                stem.readers++;
                try {
                    const vocal = await open(stem.path, "r");
                    try {
                        const { size } = await vocal.stat();
                        if (size <= 44 || size > MAX_STEREO_BYTES / 2 + 44)
                            throw new Error("Invalid vocal stem size");
                        res.writeHead(200, {
                            "Content-Type": "audio/wav",
                            "Content-Length": size,
                            "Cache-Control": "no-store",
                            "X-Content-Type-Options": "nosniff",
                        });
                        await pipeline(vocal.createReadStream(), res);
                        stem.delivered = true;
                        if (retainedStem === stem) expireStem(stem);
                    } finally {
                        await vocal.close();
                    }
                } finally {
                    stem.readers--;
                    if (stem.expired && !stem.readers)
                        void removeDirectory(stem.directory);
                }
                return true;
            }
            if (req.method !== "POST")
                throw new RequestError(405, "method", "Expected POST");
            if (req.headers.origin !== `http://${req.headers.host}`)
                throw new RequestError(403, "forbidden", "Unexpected origin");
            if (req.headers["content-type"] !== "application/octet-stream")
                throw new RequestError(
                    415,
                    "bad-request",
                    "Expected float32 audio",
                );
            const language = url.searchParams.get("language") || "auto";
            if (!GAME_LANGUAGES.includes(language))
                throw new RequestError(
                    400,
                    "bad-request",
                    "Unsupported language",
                );
            const separateParam = url.searchParams.get("separate");
            if (
                separateParam !== null &&
                separateParam !== "0" &&
                separateParam !== "1"
            )
                throw new RequestError(
                    400,
                    "bad-request",
                    "Unsupported separation flag",
                );
            const separate = separateParam === "1";
            const frameAlign = separate ? 8 : 4;
            const maxBytes = separate ? MAX_STEREO_BYTES : MAX_MONO_BYTES;
            const length = req.headers["content-length"];
            if (
                length !== undefined &&
                (!/^\d+$/.test(length) ||
                    Number(length) > maxBytes ||
                    Number(length) < frameAlign ||
                    Number(length) % frameAlign)
            )
                throw new RequestError(413, "too-large", "Invalid audio size");
            if (active)
                throw new RequestError(
                    409,
                    "busy",
                    "A GAME transcription is already running",
                );
            token = {};
            active = token;
            req.once("aborted", disconnect);
            res.once("close", disconnect);
            directory = await mkdtemp(join(tmpdir(), "funcuby-game-"));
            const input = join(directory, "input.f32");
            if (separate)
                Object.assign(token, {
                    id: randomUUID(),
                    directory,
                    path: join(directory, "vocals.wav"),
                    readers: 0,
                });
            const file = await open(input, "wx");
            let bytes = 0;
            const uploadTimer = setTimeout(
                () => req.destroy(new Error("Upload timed out")),
                90000,
            );
            try {
                for await (const chunk of req.iterator({
                    destroyOnReturn: false,
                })) {
                    bytes += chunk.length;
                    if (bytes > maxBytes)
                        throw new RequestError(
                            413,
                            "too-large",
                            "Audio exceeds 600 seconds",
                        );
                    await file.writeFile(chunk);
                }
            } finally {
                clearTimeout(uploadTimer);
                await file.close();
            }
            if (!bytes || bytes % frameAlign)
                throw new RequestError(
                    400,
                    "bad-request",
                    "Incomplete float32 audio",
                );
            if (disconnected) return true;
            res.writeHead(200, {
                "Content-Type": "application/x-ndjson; charset=utf-8",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            });
            res.flushHeaders();
            await new Promise((resolve, reject) => {
                let outputBytes = 0,
                    terminal = false,
                    buffered = "",
                    settled = false;
                const fail = (error) => {
                    if (settled) return;
                    settled = true;
                    child?.kill();
                    reject(error);
                };
                try {
                    child = launch([
                        "--input",
                        input,
                        "--raw-f32",
                        "--language",
                        language,
                        ...(separate
                            ? ["--separate", "--vocal-output", token.path]
                            : []),
                    ]);
                    timeout = setTimeout(
                        () =>
                            fail(
                                new RequestError(
                                    504,
                                    "timeout",
                                    "GAME job exceeded its time budget",
                                ),
                            ),
                        jobTimeout,
                    );
                    child.stdout.on("data", (chunk) => {
                        if (settled) return;
                        try {
                            outputBytes += chunk.length;
                            if (outputBytes > MAX_STDOUT)
                                throw new Error("GAME response exceeds limit");
                            buffered += chunk.toString();
                            let at;
                            while ((at = buffered.indexOf("\n")) >= 0) {
                                const line = buffered.slice(0, at);
                                buffered = buffered.slice(at + 1);
                                if (!line.trim()) continue;
                                if (terminal)
                                    throw new Error(
                                        "Unexpected trailing GAME event",
                                    );
                                const event = JSON.parse(line);
                                if (event.type === "vocal-stem" && separate) {
                                    token.ready = event.available === true;
                                    if (!res.destroyed && !res.writableEnded)
                                        res.write(
                                            JSON.stringify({
                                                type: "vocal-stem",
                                                id: token.ready
                                                    ? token.id
                                                    : null,
                                            }) + "\n",
                                        );
                                    continue;
                                }
                                if (
                                    !["status", "result", "error"].includes(
                                        event.type,
                                    )
                                )
                                    throw new Error("Invalid GAME event");
                                terminal =
                                    event.type === "result" ||
                                    event.type === "error";
                                if (!res.destroyed && !res.writableEnded)
                                    res.write(JSON.stringify(event) + "\n");
                            }
                        } catch (error) {
                            fail(error);
                        }
                    });
                    child.stderr.on("data", () => {});
                    child.once("error", () =>
                        fail(
                            new RequestError(
                                503,
                                "unavailable",
                                "Python is unavailable; check FUNCUBY_GAME_PYTHON",
                            ),
                        ),
                    );
                    child.once("close", () => {
                        if (settled) return;
                        settled = true;
                        if (disconnected || terminal) resolve();
                        else
                            reject(
                                new Error(
                                    "GAME process exited without a result",
                                ),
                            );
                    });
                } catch (error) {
                    fail(error);
                }
            });
            if (!res.destroyed) res.end();
        } catch (error) {
            if (!disconnected && !res.destroyed) {
                const body = {
                    code: error.code || "inference",
                    message:
                        error instanceof RequestError
                            ? error.message
                            : "Local GAME inference failed",
                };
                if (res.headersSent)
                    res.end(
                        JSON.stringify({
                            type: "error",
                            stage: "initializing",
                            ...body,
                        }) + "\n",
                    );
                else json(res, error.status || 500, { error: body });
            }
        } finally {
            clearTimeout(timeout);
            req.removeListener("aborted", disconnect);
            res.removeListener("close", disconnect);
            if (child && child.exitCode === null && child.signalCode === null) {
                child.kill();
                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, 5000);
                    child.once("close", () => {
                        clearTimeout(timer);
                        resolve();
                    });
                });
            }
            // The child and upload are closed. Disk cleanup in this job's
            // private directory must not hold up a retry.
            if (active === token) active = null;
            if (token?.ready && !token.delivered && !disconnected) {
                if (retainedStem) expireStem(retainedStem);
                retainedStem = token;
                token.expiry = setTimeout(() => expireStem(token), STEM_TTL);
                token.expiry.unref();
                await rm(join(directory, "input.f32"), { force: true }).catch(
                    () => {},
                );
            } else if (directory && token?.readers) {
                token.ready = false;
                token.expired = true;
            } else if (directory) {
                token.ready = false;
                await removeDirectory(directory);
            }
        }
        return true;
    }
    return { handle };
}
