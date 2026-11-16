import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
    AudioUrlError,
    canonicalizeAudioUrl,
    resolveShortlink,
} from "./audio-url.js";
import {
    MAX_AUDIO_SECONDS,
    MAX_FILE_BYTES,
} from "../src/core/transcription/config.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

const MAX_BODY_BYTES = 4096;
const BODY_TIMEOUT_MS = 10000;
const JOB_TIMEOUT_MS = 180000;
const METADATA_STDOUT_MAX = 1024 * 1024;
const STDERR_MAX = 8 * 1024;
const MAX_DURATION_SECONDS = MAX_AUDIO_SECONDS;
const MAX_SOURCE_BYTES = MAX_FILE_BYTES;
const MAX_CONVERTED_BYTES = MAX_FILE_BYTES;
const JOB_DIR_LIMIT_BYTES = 110 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 8000;
const CHILD_KILL_WAIT_MS = 5000;
const TASKKILL_WAIT_MS = 3000;
const TITLE_MAX = 120;

const EXTRACTORS = "youtube,BiliBili";
const EXTRACTOR_KEYS = new Set([
    "youtube",
    "BiliBili",
    "YoutubeYtBe",
    "YoutubeLivestreamEmbed",
]);
const VERSION_FLAG = {
    ytdlp: "--version",
    ffmpeg: "-version",
    ffprobe: "-version",
};

const HTTP_STATUS = {
    "bad-request": 400,
    "unsupported-media-type": 415,
    "invalid-url": 400,
    "unsupported-url": 400,
    "unsupported-shortlink": 400,
    "too-long": 422,
    forbidden: 403,
    busy: 409,
    unavailable: 503,
    "too-large": 413,
    timeout: 504,
    metadata: 502,
    download: 502,
    convert: 502,
    tool: 502,
    internal: 500,
};

class ServiceError extends Error {
    constructor(code, detail = "") {
        super(detail || code);
        this.name = "ServiceError";
        this.code = code;
    }
}

const isFile = (path) => {
    try {
        return existsSync(path) && statSync(path).isFile();
    } catch {
        return false;
    }
};

function pathDirs(env) {
    return String(env.PATH ?? env.Path ?? "")
        .split(delimiter)
        .filter(Boolean);
}

function findOnPath(name, env, platform) {
    const extensions =
        platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
    for (const dir of pathDirs(env))
        for (const ext of extensions) {
            const candidate = join(dir, name + ext);
            if (isFile(candidate)) return candidate;
        }
    return null;
}

const sibling = (file, name) => (file ? join(dirname(file), name) : null);

/**
 * Resolves the external tools. Order: FUNCUBY_* env override (single
 * executable path), project-local .tools, then PATH. Never returns command
 * strings — callers always spawn argv arrays with shell:false.
 */
export function resolveTools({
    env = process.env,
    root = rootDir,
    platform = process.platform,
} = {}) {
    const exe = platform === "win32" ? ".exe" : "";
    const localBin = join(root, ".tools", "ffmpeg", "bin");
    const pick = (envVar, candidates) => {
        const override = env[envVar];
        if (override && isFile(override)) return override;
        for (const candidate of candidates)
            if (candidate && isFile(candidate)) return candidate;
        return null;
    };
    const ffmpeg = pick("FUNCUBY_FFMPEG", [
        join(localBin, `ffmpeg${exe}`),
        findOnPath("ffmpeg", env, platform),
    ]);
    const ffprobe = pick("FUNCUBY_FFPROBE", [
        sibling(ffmpeg, `ffprobe${exe}`),
        findOnPath("ffprobe", env, platform),
    ]);
    return {
        ytdlp: pick("FUNCUBY_YTDLP", [findOnPath("yt-dlp", env, platform)]),
        ffmpeg,
        ffprobe,
    };
}

export function isAllowedHost(hostHeader, port) {
    if (!hostHeader) return false;
    const host = hostHeader.trim().toLowerCase();
    let hostname, hostPort;
    if (host.startsWith("[")) {
        const end = host.indexOf("]");
        if (end === -1) return false;
        hostname = host.slice(1, end);
        const rest = host.slice(end + 1);
        if (rest && !rest.startsWith(":")) return false;
        hostPort = rest.startsWith(":") ? rest.slice(1) : "";
    } else {
        const at = host.lastIndexOf(":");
        if (at === -1) {
            hostname = host;
            hostPort = "";
        } else {
            hostname = host.slice(0, at);
            hostPort = host.slice(at + 1);
        }
    }
    if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) return false;
    if (hostPort && !/^\d+$/.test(hostPort)) return false;
    return Number(hostPort || "80") === port;
}

function sendJson(res, status, body, close = false) {
    if (res.writableEnded || res.destroyed) return;
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(close ? { Connection: "close" } : {}),
    });
    res.end(payload);
}

const sendError = (res, code, detail = "") =>
    sendJson(
        res,
        HTTP_STATUS[code] ?? 500,
        { error: { code, message: detail || code } },
        code === "too-large" || code === "bad-request",
    );

/**
 * Reads at most `limit` bytes. On overflow it pauses the stream (no unbounded
 * drain) and rejects; the caller answers 413 with Connection: close.
 */
function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0,
            settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            req.pause();
            error ? reject(error) : resolve(value);
        };
        const timer = setTimeout(
            () =>
                finish(new ServiceError("bad-request", "body read timed out")),
            BODY_TIMEOUT_MS,
        );
        req.on("data", (chunk) => {
            if (settled) return;
            size += chunk.length;
            if (size > limit) {
                finish(new ServiceError("too-large", "request body too large"));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => finish(null, Buffer.concat(chunks)));
        req.on("error", (error) =>
            finish(
                error instanceof Error
                    ? error
                    : new ServiceError("bad-request", String(error)),
            ),
        );
        req.on("aborted", () =>
            finish(new ServiceError("bad-request", "request aborted")),
        );
    });
}

/** Kills only the process tree we spawned; resolves when termination is done. */
function terminate(child, platform) {
    if (!child || child.exitCode !== null || child.killed)
        return Promise.resolve();
    if (platform === "win32") {
        return new Promise((resolve) => {
            let killer;
            try {
                killer = spawn(
                    "taskkill",
                    ["/PID", String(child.pid), "/T", "/F"],
                    {
                        shell: false,
                        windowsHide: true,
                        stdio: "ignore",
                    },
                );
            } catch {
                resolve();
                return;
            }
            const timer = setTimeout(resolve, TASKKILL_WAIT_MS);
            killer.on("error", () => {
                clearTimeout(timer);
                resolve();
            });
            killer.on("close", () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
    try {
        process.kill(-child.pid, "SIGKILL");
    } catch {
        try {
            child.kill("SIGKILL");
        } catch {
            /* already gone */
        }
    }
    return Promise.resolve();
}

/**
 * Spawns one tool with a fixed argv array (shell:false) and bounded output.
 * On abort it kills the owned process tree, awaits termination (bounded) and
 * only then rejects — callers may safely clean up job directories afterwards.
 */
function runChild(
    cmd,
    args,
    {
        spawnImpl,
        signal,
        platform,
        maxStdout,
        failCode = "tool",
        terminateImpl = terminate,
    },
) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new ServiceError("aborted", "cancelled"));
            return;
        }
        let child;
        try {
            child = spawnImpl(cmd, args, {
                shell: false,
                windowsHide: true,
                detached: platform !== "win32",
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (error) {
            reject(
                new ServiceError(
                    "unavailable",
                    `cannot start tool: ${error?.message ?? error}`,
                ),
            );
            return;
        }
        let stdout = "",
            stderr = "",
            settled = false,
            closed = false,
            forcedError = null;
        const closeWaiters = [];
        const onClosed = () => {
            closed = true;
            for (const waiter of closeWaiters.splice(0)) waiter();
        };
        const waitClosed = () =>
            closed
                ? Promise.resolve()
                : new Promise((r) => {
                      closeWaiters.push(r);
                      setTimeout(r, CHILD_KILL_WAIT_MS);
                  });
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            error ? reject(error) : resolve(value);
        };
        const onAbort = () => {
            terminateImpl(child, platform).then(() =>
                waitClosed().then(() =>
                    finish(new ServiceError("aborted", "cancelled")),
                ),
            );
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", (chunk) => {
            if (settled) return;
            if (stdout.length + chunk.length > maxStdout) {
                forcedError = new ServiceError(
                    "too-large",
                    "tool output exceeded limit",
                );
                terminateImpl(child, platform).then(() =>
                    waitClosed().then(() => finish(forcedError)),
                );
                return;
            }
            stdout += chunk;
        });
        child.stderr?.on("data", (chunk) => {
            // Keep the tail so the terminal error survives long logs.
            stderr = (stderr + chunk).slice(-STDERR_MAX);
        });
        child.on("error", (error) => {
            onClosed();
            finish(
                signal?.aborted
                    ? new ServiceError("aborted", "cancelled")
                    : new ServiceError(
                          "unavailable",
                          `cannot start tool: ${error?.message ?? error}`,
                      ),
            );
        });
        child.on("close", (code) => {
            onClosed();
            // An aborted job owns the outcome: a killed child closes with a
            // non-zero/null code but must surface as "aborted", not "tool".
            // Same for a child we killed on the output limit — "too-large".
            if (signal?.aborted) {
                finish(new ServiceError("aborted", "cancelled"));
            } else if (forcedError) finish(forcedError);
            else if (code === 0) finish(null, { stdout, stderr });
            else
                finish(
                    new ServiceError(
                        failCode,
                        `tool exited with code ${code}: ${
                            stderr.trim().split("\n").pop()?.slice(0, 200) ?? ""
                        }`,
                    ),
                );
        });
    });
}

async function dirSize(path, depth = 0) {
    let total = 0;
    let entries;
    try {
        entries = await readdir(path, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const entry of entries) {
        const full = join(path, entry.name);
        if (entry.isFile()) {
            try {
                total += (await stat(full)).size;
            } catch {
                /* vanished */
            }
        } else if (entry.isDirectory() && depth < 2)
            total += await dirSize(full, depth + 1);
    }
    return total;
}

function sanitizeDetail(text) {
    return (
        String(text ?? "")
            // eslint-disable-next-line no-control-regex -- strips control chars from tool output
            .replace(/[\x00-\x1f\x7f]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200)
    );
}

function safeTitle(raw, fallback) {
    const clean = String(raw ?? "")
        // eslint-disable-next-line no-control-regex -- strips control chars from titles
        .replace(/[\x00-\x1f\x7f/\\:*?"<>|]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, TITLE_MAX);
    let name = clean || fallback || "imported-audio";
    return `${name.slice(0, TITLE_MAX - 5)}.flac`;
}

/**
 * Creates the /api/audio-import handler. All tool invocations go through
 * `spawnImpl` with fixed argv arrays and shell:false; tests may inject a fake
 * runner — never HTTP-selected commands.
 */
export function createAudioImport({
    spawnImpl = spawn,
    terminateImpl = terminate,
    env = process.env,
    fetchImpl = fetch,
    root = rootDir,
    platform = process.platform,
    port = Number(env.PORT || 5173),
    jobTimeoutMs = JOB_TIMEOUT_MS,
} = {}) {
    const tools = resolveTools({ env, root, platform });
    // Dependency seam for tests only — never reachable from HTTP or env.
    const run = (cmd, args, options) =>
        runChild(cmd, args, { ...options, terminateImpl });
    const probes = new Map();
    let activeJob = null;
    let jsRuntimeProbe = null;

    const probe = (key, path, signal) => {
        if (!probes.has(path)) {
            const combined = signal
                ? AbortSignal.any([
                      signal,
                      AbortSignal.timeout(PROBE_TIMEOUT_MS),
                  ])
                : AbortSignal.timeout(PROBE_TIMEOUT_MS);
            const pending = run(path, [VERSION_FLAG[key]], {
                spawnImpl,
                signal: combined,
                platform,
                maxStdout: 64 * 1024,
            })
                .then(() => true)
                .catch(() => false);
            probes.set(path, pending);
            // Cache successes only — a failed probe may be retried later.
            pending.then((ok) => {
                if (!ok && probes.get(path) === pending) probes.delete(path);
            });
        }
        return probes.get(path);
    };

    async function readiness(signal) {
        const missing = [];
        for (const [key, path] of Object.entries(tools))
            if (!path || !(await probe(key, path, signal))) missing.push(key);
        return { ready: missing.length === 0, missing };
    }

    // yt-dlp gained --js-runtimes in 2025.x; detect once so older installs
    // still work. The probe shares the caller's abort signal and is not cached
    // on failure so a cancelled probe can be retried.
    function supportsJsRuntimes(signal) {
        if (!tools.ytdlp) return Promise.resolve(false);
        if (!jsRuntimeProbe) {
            jsRuntimeProbe = run(tools.ytdlp, ["--help"], {
                spawnImpl,
                signal,
                platform,
                maxStdout: METADATA_STDOUT_MAX,
            }).then(({ stdout }) => stdout.includes("--js-runtimes"));
            jsRuntimeProbe.catch(() => {
                jsRuntimeProbe = null;
            });
        }
        return jsRuntimeProbe;
    }

    async function ytdlpBaseArgs(withJsRuntime) {
        const args = [
            "--ignore-config",
            "--no-plugin-dirs",
            "--no-cache-dir",
            "--no-playlist",
            "--no-progress",
            "--socket-timeout",
            "15",
            "--retries",
            "1",
            "--extractor-retries",
            "1",
            "--use-extractors",
            EXTRACTORS,
        ];
        if (withJsRuntime)
            args.push(
                "--no-js-runtimes",
                "--js-runtimes",
                `node:${process.execPath}`,
            );
        return args;
    }

    async function requireTools(signal) {
        const { ready, missing } = await readiness(signal);
        if (!ready)
            throw new ServiceError(
                "unavailable",
                `missing tools: ${missing.join(", ")}`,
            );
    }

    async function fetchMetadata(url, signal) {
        const args = [
            ...(await ytdlpBaseArgs(await supportsJsRuntimes(signal))),
            "--skip-download",
            "--dump-single-json",
            "--",
            url,
        ];
        const { stdout } = await run(tools.ytdlp, args, {
            spawnImpl,
            signal,
            platform,
            maxStdout: METADATA_STDOUT_MAX,
        });
        let meta;
        try {
            meta = JSON.parse(stdout);
        } catch {
            throw new ServiceError("metadata", "unparseable metadata");
        }
        if (
            !meta ||
            typeof meta !== "object" ||
            meta._type !== "video" ||
            Array.isArray(meta.entries) ||
            !EXTRACTOR_KEYS.has(meta.extractor_key)
        )
            throw new ServiceError(
                "metadata",
                "unexpected playlist or extractor result",
            );
        const duration = Number(meta.duration);
        if (!Number.isFinite(duration) || duration <= 0)
            throw new ServiceError("metadata", "missing duration");
        if (duration > MAX_DURATION_SECONDS)
            throw new ServiceError(
                "too-long",
                `duration ${Math.round(duration)}s exceeds ${MAX_DURATION_SECONDS}s`,
            );
        return {
            duration,
            title: typeof meta.title === "string" ? meta.title : "",
        };
    }

    async function downloadSource(url, dir, signal) {
        const args = [
            ...(await ytdlpBaseArgs(await supportsJsRuntimes(signal))),
            "--ffmpeg-location",
            tools.ffmpeg,
            "-f",
            "bestaudio[ext=m4a]/bestaudio/best[height<=360]",
            "--max-filesize",
            "50M",
            "-o",
            join(dir, "source.%(ext)s"),
            "--",
            url,
        ];
        await run(tools.ytdlp, args, {
            spawnImpl,
            signal,
            platform,
            maxStdout: STDERR_MAX * 4,
            failCode: "download",
        });
        const entries = await readdir(dir).catch(() => []);
        const source = entries
            .filter(
                (name) =>
                    name.startsWith("source.") &&
                    !name.endsWith(".part") &&
                    !name.endsWith(".ytdl"),
            )
            .sort()[0];
        if (!source)
            throw new ServiceError("download", "no audio file produced");
        const path = join(dir, source);
        const info = await stat(path).catch(() => null);
        if (!info?.isFile())
            throw new ServiceError("download", "no audio file produced");
        if (info.size > MAX_SOURCE_BYTES)
            throw new ServiceError("too-large", "source exceeds 50 MiB");
        return path;
    }

    async function probeDuration(path, signal) {
        const { stdout } = await run(
            tools.ffprobe,
            [
                "-protocol_whitelist",
                "file,pipe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                path,
            ],
            {
                spawnImpl,
                signal,
                platform,
                maxStdout: 4096,
                failCode: "metadata",
            },
        );
        const duration = Number.parseFloat(stdout.trim());
        if (!Number.isFinite(duration) || duration <= 0)
            throw new ServiceError("metadata", "unreadable duration");
        if (duration > MAX_DURATION_SECONDS)
            throw new ServiceError(
                "too-long",
                `duration ${Math.round(duration)}s exceeds ${MAX_DURATION_SECONDS}s`,
            );
    }

    async function convertToFlac(sourcePath, outputPath, signal) {
        await run(
            tools.ffmpeg,
            [
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-i",
                sourcePath,
                "-vn",
                "-ac",
                "2",
                "-ar",
                "44100",
                "-c:a",
                "flac",
                "-sample_fmt",
                "s16",
                "-fs",
                String(MAX_CONVERTED_BYTES + 1),
                outputPath,
            ],
            {
                spawnImpl,
                signal,
                platform,
                maxStdout: STDERR_MAX * 4,
                failCode: "convert",
            },
        );
        const info = await stat(outputPath).catch(() => null);
        if (!info?.isFile() || info.size <= 44)
            throw new ServiceError("convert", "empty output");
        if (info.size > MAX_CONVERTED_BYTES)
            throw new ServiceError("too-large", "FLAC exceeds 50 MiB");
        const head = await readFile(outputPath).catch(() => null);
        if (
            !head ||
            head.length < 12 ||
            head.toString("ascii", 0, 4) !== "fLaC"
        )
            throw new ServiceError("convert", "output is not a FLAC file");
        return head;
    }

    async function runJob(url, res, job) {
        const { controller } = job;
        const timer = setTimeout(() => controller.abort(), jobTimeoutMs);
        let dir = null;
        const watcher = { timer: null };
        res.on("close", () => {
            if (!res.writableEnded) controller.abort();
        });
        try {
            if (res.destroyed) {
                controller.abort();
                return;
            }
            let parsed = canonicalizeAudioUrl(url);
            if (parsed.kind === "shortlink") {
                const resolved = await resolveShortlink(parsed.url, {
                    fetchImpl,
                    signal: controller.signal,
                });
                parsed = canonicalizeAudioUrl(resolved);
                if (parsed.kind === "shortlink")
                    throw new AudioUrlError("unsupported-shortlink");
            }
            await requireTools(controller.signal);
            dir = await mkdtemp(join(tmpdir(), "funcuby-audio-"));
            job.dir = dir;
            watcher.timer = setInterval(() => {
                dirSize(dir)
                    .then((size) => {
                        if (
                            size > JOB_DIR_LIMIT_BYTES &&
                            !controller.signal.aborted
                        )
                            controller.abort(
                                new ServiceError(
                                    "too-large",
                                    "job directory exceeded 110 MiB",
                                ),
                            );
                    })
                    .catch(() => {});
            }, 250);
            const meta = await fetchMetadata(parsed.url, controller.signal);
            const sourcePath = await downloadSource(
                parsed.url,
                dir,
                controller.signal,
            );
            await probeDuration(sourcePath, controller.signal);
            const audio = await convertToFlac(
                sourcePath,
                join(dir, "audio.flac"),
                controller.signal,
            );
            if (res.destroyed || res.writableEnded) return;
            res.writeHead(200, {
                "Content-Type": "audio/flac",
                "Content-Length": audio.length,
                "X-Audio-Name": encodeURIComponent(
                    safeTitle(meta.title, `${parsed.kind}-audio`),
                ),
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            });
            res.end(audio);
        } catch (error) {
            if (res.destroyed || res.writableEnded) return;
            const reason = controller.signal.reason;
            if (reason instanceof ServiceError) {
                sendError(
                    res,
                    HTTP_STATUS[reason.code] ? reason.code : "internal",
                    sanitizeDetail(reason.message),
                );
                return;
            }
            if (error instanceof AudioUrlError)
                sendError(res, error.code, sanitizeDetail(error.message));
            else if (error instanceof ServiceError) {
                if (error.code === "aborted") {
                    sendError(res, "timeout", "import timed out");
                    return;
                }
                sendError(
                    res,
                    HTTP_STATUS[error.code] ? error.code : "internal",
                    sanitizeDetail(error.message),
                );
            } else sendError(res, "internal", "unexpected failure");
        } finally {
            clearTimeout(timer);
            clearInterval(watcher.timer);
            if (dir)
                await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }

    async function handle(req, res) {
        let path;
        try {
            path = new URL(req.url, "http://localhost").pathname;
        } catch {
            return false;
        }
        if (path !== "/api/audio-import" && path !== "/api/audio-import/status")
            return false;
        try {
            if (!isAllowedHost(req.headers.host, port)) {
                sendError(res, "forbidden", "unexpected host");
                return true;
            }
            if (req.headers["sec-fetch-site"] === "cross-site") {
                sendError(res, "forbidden", "cross-site request");
                return true;
            }
            if (path === "/api/audio-import/status") {
                if (req.method !== "GET" && req.method !== "HEAD") {
                    sendJson(res, 405, {
                        error: { code: "forbidden", message: "method" },
                    });
                    return true;
                }
                const { ready, missing } = await readiness();
                sendJson(res, 200, { ready, missing });
                return true;
            }
            if (req.method !== "POST") {
                sendJson(res, 405, {
                    error: { code: "forbidden", message: "method" },
                });
                return true;
            }
            const origin = req.headers.origin;
            if (origin !== `http://${req.headers.host}`) {
                sendError(res, "forbidden", "bad origin");
                return true;
            }
            const contentType = req.headers["content-type"] || "";
            if (!/^application\/json\b/i.test(contentType)) {
                sendError(
                    res,
                    "unsupported-media-type",
                    "expected application/json",
                );
                return true;
            }
            if (activeJob) {
                sendError(res, "busy", "an import is already running");
                return true;
            }
            const body = await readBody(req, MAX_BODY_BYTES);
            let payload;
            try {
                payload = JSON.parse(body.toString("utf8"));
            } catch {
                sendError(res, "bad-request", "invalid JSON body");
                return true;
            }
            const url = payload?.url;
            if (typeof url !== "string" || !url.trim()) {
                sendError(res, "invalid-url", "missing url");
                return true;
            }
            // Re-check and reserve synchronously — two bodies finishing
            // together must yield exactly one job and one 409.
            if (activeJob) {
                sendError(res, "busy", "an import is already running");
                return true;
            }
            const job = { controller: new AbortController(), dir: null };
            activeJob = job;
            try {
                await runJob(url.trim(), res, job);
            } finally {
                if (activeJob === job) activeJob = null;
            }
            return true;
        } catch (error) {
            if (!res.writableEnded && !res.destroyed)
                sendError(
                    res,
                    error instanceof ServiceError && HTTP_STATUS[error.code]
                        ? error.code
                        : "internal",
                    sanitizeDetail(error?.message),
                );
            return true;
        }
    }

    return { handle, readiness };
}
