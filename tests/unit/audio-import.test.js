import assert from "node:assert/strict";
import { execFile, spawn as realSpawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
    AudioUrlError,
    MAX_URL_LENGTH,
    canonicalizeAudioUrl,
    resolveShortlink,
} from "../../server/audio-url.js";
import { createAudioImport } from "../../server/audio-import.js";

// ---------- pure URL validation ----------

const YT = "dQw4w9WgXcQ";

test("canonicalizes supported YouTube and Bilibili URLs", () => {
    for (const input of [
        `https://www.youtube.com/watch?v=${YT}`,
        `https://youtube.com/watch?v=${YT}&list=PL123&feature=share`,
        `https://m.youtube.com/watch?v=${YT}`,
        `https://music.youtube.com/watch?v=${YT}`,
        `https://www.youtube.com/shorts/${YT}`,
        `https://www.youtube.com/embed/${YT}`,
        `https://youtu.be/${YT}`,
        `https://youtu.be/${YT}?t=42`,
        `http://www.youtube.com/watch?v=${YT}`,
    ]) {
        const out = canonicalizeAudioUrl(input);
        assert.equal(out.kind, "youtube", input);
        assert.equal(out.url, `https://www.youtube.com/watch?v=${YT}`);
    }
    assert.deepEqual(canonicalizeAudioUrl("https://b23.tv/abcDEF123"), {
        url: "https://b23.tv/abcDEF123",
        kind: "shortlink",
    });
});

test("canonicalizes Bilibili video URLs with explicit page selection", () => {
    assert.deepEqual(
        canonicalizeAudioUrl("https://www.bilibili.com/video/BV1Ca411g7Tq/"),
        {
            url: "https://www.bilibili.com/video/BV1Ca411g7Tq?p=1",
            kind: "bilibili",
        },
    );
    assert.equal(
        canonicalizeAudioUrl(
            "https://m.bilibili.com/video/BV1Ca411g7Tq?p=3&vd_source=abc",
        ).url,
        "https://www.bilibili.com/video/BV1Ca411g7Tq?p=3",
    );
    assert.equal(
        canonicalizeAudioUrl("https://bilibili.com/video/av170001?p=2").url,
        "https://www.bilibili.com/video/av170001?p=2",
    );
    // Invalid/absent page falls back to part 1.
    assert.equal(
        canonicalizeAudioUrl("https://www.bilibili.com/video/BV1Ca411g7Tq?p=0")
            .url,
        "https://www.bilibili.com/video/BV1Ca411g7Tq?p=1",
    );
});

test("rejects malicious or unsupported URLs", () => {
    const bad = [
        "",
        "   ",
        "not a url",
        "javascript:alert(1)",
        "ftp://www.youtube.com/watch?v=" + YT,
        "file:///etc/passwd",
        "https://youtube.com.evil.com/watch?v=" + YT,
        "https://www.youtube.com.evil.com/watch?v=" + YT,
        "https://youtube.com@evil.com/watch?v=" + YT,
        "https://user:pass@youtube.com/watch?v=" + YT,
        "https://www.youtube.com:444/watch?v=" + YT,
        "https://127.0.0.1/watch?v=" + YT,
        "https://localhost/watch?v=" + YT,
        "https://[::1]/watch?v=" + YT,
        "https://www.youtube.com/watch?v=short",
        "https://www.youtube.com/watch?v=" + YT + "extra",
        "https://www.youtube.com/watch",
        "https://www.youtube.com/playlist?list=PL123",
        "https://www.youtube.com/live/" + YT,
        "https://www.youtube.com/channel/UC123",
        "https://www.bilibili.com/video/list/123",
        "https://www.bilibili.com/c/channel",
        "https://www.bilibili.com/live/123",
        "https://search.bilibili.com/all?keyword=x",
        "https://v.bilibili.com/123",
        "https://example.com/watch?v=" + YT,
        "https://youtu.be/",
        "https://youtu.be/short",
        "x".repeat(MAX_URL_LENGTH + 1),
    ];
    for (const input of bad) {
        assert.throws(() => canonicalizeAudioUrl(input), AudioUrlError, input);
    }
});

test("resolves b23.tv shortlinks only through validated redirects", async () => {
    const fetchFor = (map) => async (url) => {
        const hit = map[url];
        if (!hit) throw new Error(`unexpected fetch ${url}`);
        return {
            status: hit.status ?? 200,
            headers: { get: (k) => hit.headers?.[k.toLowerCase()] ?? null },
            body: { cancel: async () => {} },
        };
    };
    const start = "https://b23.tv/xyz";
    const finalVideo = "https://www.bilibili.com/video/BV1Ca411g7Tq";
    const final = await resolveShortlink(start, {
        fetchImpl: fetchFor({
            [start]: {
                status: 302,
                headers: { location: finalVideo },
            },
            [finalVideo]: { status: 200 },
        }),
    });
    assert.equal(final, finalVideo);

    // Chained shortlink then video page.
    const chained = await resolveShortlink(start, {
        fetchImpl: fetchFor({
            [start]: {
                status: 302,
                headers: { location: "https://b23.tv/abc" },
            },
            "https://b23.tv/abc": {
                status: 302,
                headers: { location: `https://youtu.be/${YT}` },
            },
            [`https://youtu.be/${YT}`]: { status: 200 },
        }),
    });
    assert.equal(chained, `https://youtu.be/${YT}`);

    // Redirect to a disallowed host must fail.
    await assert.rejects(
        resolveShortlink(start, {
            fetchImpl: fetchFor({
                [start]: {
                    status: 302,
                    headers: { location: "https://evil.example.com/x" },
                },
            }),
        }),
        (e) => e.code === "unsupported-shortlink",
    );
    // http downgrade and credentials are rejected too.
    for (const location of [
        "http://www.bilibili.com/video/BV1Ca411g7Tq",
        "https://user@www.bilibili.com/video/BV1Ca411g7Tq",
        "https://www.bilibili.com:8443/video/BV1Ca411g7Tq",
    ]) {
        await assert.rejects(
            resolveShortlink(start, {
                fetchImpl: fetchFor({
                    [start]: { status: 302, headers: { location } },
                }),
            }),
            (e) => e.code === "unsupported-shortlink",
        );
    }
    // Redirect loops are bounded.
    await assert.rejects(
        resolveShortlink(start, {
            fetchImpl: fetchFor({
                [start]: {
                    status: 302,
                    headers: { location: start },
                },
                "https://b23.tv/abc": {
                    status: 302,
                    headers: { location: "https://b23.tv/def" },
                },
                "https://b23.tv/def": {
                    status: 302,
                    headers: { location: "https://b23.tv/ghi" },
                },
                "https://b23.tv/ghi": {
                    status: 302,
                    headers: { location: "https://b23.tv/jkl" },
                },
            }),
        }),
        (e) => e.code === "unsupported-shortlink",
    );
    // A non-redirect response ends resolution at that URL.
    assert.equal(
        await resolveShortlink(start, {
            fetchImpl: fetchFor({ [start]: { status: 200 } }),
        }),
        start,
    );
});

// ---------- HTTP/service tests with a fake tool runner ----------

const META = {
    _type: "video",
    id: "BV1Ca411g7Tq_p1",
    duration: 103.21,
    title: "测试 视频 <b>/\\",
    extractor_key: "BiliBili",
    entries: null,
};

function tinyWav() {
    const rate = 22050,
        total = rate / 2,
        buffer = Buffer.alloc(44 + total * 2);
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + total * 2, 4);
    buffer.write("WAVEfmt ", 8);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(rate, 24);
    buffer.writeUInt32LE(rate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write("data", 36);
    buffer.writeUInt32LE(total * 2, 40);
    for (let i = 0; i < total; i++)
        buffer.writeInt16LE(
            Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000),
            44 + i * 2,
        );
    return buffer;
}

const SOURCE_WAV = tinyWav();

function fakeChild({ stdout = "", stderr = "", code = 0, hang = false }) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // Fixed invalid sentinel — fake children must never carry a real PID, so
    // even a mistaken OS-level kill cannot hit an unrelated process.
    child.pid = -1;
    child.exitCode = null;
    child.killed = false;
    child.kill = () => {
        child.killed = true;
        queueMicrotask(() => child.emit("close", null));
        return true;
    };
    if (!hang)
        queueMicrotask(() => {
            if (stdout) child.stdout.emit("data", Buffer.from(stdout));
            if (stderr) child.stderr.emit("data", Buffer.from(stderr));
            child.exitCode = code;
            child.emit("close", code);
        });
    return child;
}

/**
 * Fake yt-dlp/ffprobe/ffmpeg runner. Records every call in `calls`.
 * ffmpegMode "copy" fakes conversion, "real" delegates ffmpeg/ffprobe to the
 * real binaries, "fail" makes ffmpeg exit non-zero. `hang` makes the yt-dlp
 * download child never exit.
 */
function makeSpawn({
    meta = META,
    metaRaw,
    metaCode = 0,
    sourceBytes = SOURCE_WAV,
    ffmpegMode = "copy",
    ffprobeReal = false,
    hang = false,
    calls = [],
} = {}) {
    return (cmd, args, opts) => {
        calls.push({ cmd, args: [...args], opts: { ...opts } });
        const flag = args[0];
        if (flag === "--version" || flag === "-version")
            return fakeChild({ code: 0 });
        if (flag === "--help")
            return fakeChild({
                stdout: "usage: yt-dlp [--js-runtimes RUNTIME]\n",
            });
        if (args.includes("--dump-single-json")) {
            if (metaCode !== 0)
                return fakeChild({
                    stderr: "ERROR: unsupported URL or network down",
                    code: metaCode,
                });
            return fakeChild({
                stdout: metaRaw ?? JSON.stringify(meta),
            });
        }
        if (cmd.includes("ffprobe"))
            return ffprobeReal
                ? realSpawn(cmd, args, { ...opts, shell: false })
                : fakeChild({ stdout: "103.210000\n" });
        if (cmd.includes("ffmpeg")) {
            if (ffmpegMode === "real")
                return realSpawn(cmd, args, { ...opts, shell: false });
            if (ffmpegMode === "fail")
                return fakeChild({ stderr: "Conversion failed!", code: 1 });
            const out = args.at(-1);
            const input = args[args.indexOf("-i") + 1];
            try {
                const data = readFileSync(input);
                // Only the real integration case exercises audio conversion.
                // This marker stands in for a FLAC container in service tests.
                writeFileSync(
                    out,
                    data.toString("ascii", 0, 4) === "RIFF"
                        ? Buffer.concat([Buffer.from("fLaC"), data])
                        : data,
                );
            } catch {
                /* ignore */
            }
            return fakeChild({ code: 0 });
        }
        // yt-dlp download
        if (hang) return fakeChild({ hang: true });
        const oi = args.indexOf("-o");
        if (oi !== -1) {
            const out = args[oi + 1].replace("%(ext)s", "wav");
            mkdirSync(join(out, ".."), { recursive: true });
            writeFileSync(out, sourceBytes);
        }
        return fakeChild({ code: 0 });
    };
}

async function fixtureDirs() {
    const dir = await mkdtemp(join(tmpdir(), "funcuby-test-"));
    const tools = join(dir, "tools");
    await mkdir(tools, { recursive: true });
    for (const name of ["yt-dlp", "ffmpeg", "ffprobe"])
        await writeFile(join(tools, name), "");
    return { dir, tools };
}

function testEnv(tools) {
    return {
        PATH: "/nonexistent",
        FUNCUBY_YTDLP: join(tools, "yt-dlp"),
        FUNCUBY_FFMPEG: join(tools, "ffmpeg"),
        FUNCUBY_FFPROBE: join(tools, "ffprobe"),
    };
}

async function startServer(options) {
    const holder = {};
    const server = http.createServer((req, res) => {
        holder.importer
            .handle(req, res)
            .then((handled) => {
                if (!handled) {
                    res.writeHead(404);
                    res.end("not found");
                }
            })
            .catch(() => {
                if (!res.writableEnded) {
                    res.writeHead(500);
                    res.end();
                }
            });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    // Safe terminator for the whole harness: fake children only emit a fake
    // close; real children (ffmpeg integration test) get a plain child.kill —
    // never taskkill/process.kill on an injected or fake PID.
    const terminated = [];
    holder.importer = createAudioImport({
        platform: "linux",
        terminateImpl: async (child) => {
            terminated.push(child.pid);
            try {
                child.kill("SIGKILL");
            } catch {
                /* already gone */
            }
        },
        ...options,
        port,
    });
    return { server, port, importer: holder.importer, terminated };
}

const stop = (server) => new Promise((resolve) => server.close(resolve));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Raw HTTP request — undici silently drops forbidden headers like Host. */
function rawPost(port, headers, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: "127.0.0.1",
                port,
                path: "/api/audio-import",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...headers,
                },
            },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () =>
                    resolve({
                        status: res.statusCode,
                        body: Buffer.concat(chunks),
                    }),
                );
            },
        );
        req.on("error", reject);
        req.end(typeof body === "string" ? body : JSON.stringify(body));
    });
}

function post(port, body, headers = {}, signal) {
    return fetch(`http://127.0.0.1:${port}/api/audio-import`, {
        method: "POST",
        headers: {
            Origin: `http://127.0.0.1:${port}`,
            "Content-Type": "application/json",
            ...headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
        signal,
    });
}

const VALID_URL = "https://www.bilibili.com/video/BV1Ca411g7Tq";

test("POST returns high-quality FLAC with safe headers and argv contract", async () => {
    const { dir, tools } = await fixtureDirs();
    const calls = [];
    const { server, port } = await startServer({
        spawnImpl: makeSpawn({ calls }),
        env: testEnv(tools),
        root: dir,
        fetchImpl: async () => {
            throw new Error("no shortlink expected");
        },
    });
    try {
        const res = await post(port, { url: VALID_URL });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type"), /audio\/flac/);
        const name = decodeURIComponent(res.headers.get("x-audio-name") ?? "");
        assert.ok(name.endsWith(".flac"));
        // eslint-disable-next-line no-control-regex -- verifying control chars are stripped
        assert.ok(!/[/\\:\x00-\x1f]/.test(name));
        const wav = Buffer.from(await res.arrayBuffer());
        assert.equal(wav.toString("ascii", 0, 4), "fLaC");
        // argv contract: shell:false, -- delimiter, restricted extractors,
        // node JS runtime, no cookie/auth flags.
        const ytdlpCalls = calls.filter((c) => c.cmd.includes("yt-dlp"));
        assert.ok(ytdlpCalls.length >= 4); // probe + help + metadata + download
        const workCalls = ytdlpCalls.filter(
            (c) => c.args[0] !== "--version" && c.args[0] !== "--help",
        );
        for (const call of ytdlpCalls) assert.equal(call.opts.shell, false);
        for (const call of workCalls) {
            const text = call.args.join(" ");
            assert.ok(text.includes("--use-extractors youtube,BiliBili"));
            assert.ok(text.includes("--no-playlist"));
            assert.ok(
                !/cookies|password|username|no-check-certificates/.test(text),
            );
        }
        const metaCall = ytdlpCalls.find((c) =>
            c.args.includes("--dump-single-json"),
        );
        assert.ok(metaCall.args.includes("--"));
        assert.ok(metaCall.args.at(-1).includes("?p=1"));
        const dlCall = ytdlpCalls.find((c) => c.args.includes("-o"));
        assert.ok(dlCall.args.includes("--ffmpeg-location"));
        assert.ok(dlCall.args.includes("--max-filesize"));
        assert.ok(
            dlCall.args.includes(
                "bestaudio[ext=m4a]/bestaudio/best[height<=360]",
            ),
        );
        const ffmpegCall = calls.find(
            (c) => c.cmd.includes("ffmpeg") && c.args.includes("-nostdin"),
        );
        assert.ok(ffmpegCall.args.includes("-protocol_whitelist"));
        assert.ok(ffmpegCall.args.includes("-fs"));
        assert.ok(ffmpegCall.args.includes("44100"));
        assert.equal(ffmpegCall.args[ffmpegCall.args.indexOf("-ac") + 1], "2");
        assert.equal(
            ffmpegCall.args[ffmpegCall.args.indexOf("-c:a") + 1],
            "flac",
        );
        const ffprobeCall = calls.find(
            (c) =>
                c.cmd.includes("ffprobe") && c.args.includes("-show_entries"),
        );
        assert.ok(ffprobeCall.args.includes("-protocol_whitelist"));
        // temp dir cleanup races the response flush — poll briefly
        let leftovers = ["funcuby-audio-x"];
        for (let i = 0; i < 30 && leftovers.length; i++) {
            leftovers = (await readdir(tmpdir())).filter((n) =>
                n.startsWith("funcuby-audio-"),
            );
            if (leftovers.length) await sleep(100);
        }
        assert.deepEqual(leftovers, []);
    } finally {
        await stop(server);
        await rm(dir, { recursive: true, force: true });
    }
});

test("status endpoint reports readiness without paths", async () => {
    const { dir, tools } = await fixtureDirs();
    const { server, port } = await startServer({
        spawnImpl: makeSpawn({}),
        env: testEnv(tools),
        root: dir,
    });
    try {
        const res = await fetch(
            `http://127.0.0.1:${port}/api/audio-import/status`,
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ready, true);
        assert.deepEqual(body.missing, []);
        assert.ok(!JSON.stringify(body).includes(tools));
    } finally {
        await stop(server);
        await rm(dir, { recursive: true, force: true });
    }
});

test("rejects bad origin, host, content type, oversized and invalid bodies", async () => {
    const { dir, tools } = await fixtureDirs();
    const { server, port } = await startServer({
        spawnImpl: makeSpawn({}),
        env: testEnv(tools),
        root: dir,
    });
    const base = `http://127.0.0.1:${port}/api/audio-import`;
    const good = {
        Origin: `http://127.0.0.1:${port}`,
        "Content-Type": "application/json",
    };
    try {
        let res = await fetch(base, {
            method: "POST",
            headers: { ...good, Origin: "http://evil.example.com" },
            body: JSON.stringify({ url: VALID_URL }),
        });
        assert.equal(res.status, 403);
        res = await fetch(base, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: VALID_URL }),
        });
        assert.equal(res.status, 403);
        res = await fetch(base, {
            method: "POST",
            headers: { ...good, "Content-Type": "text/plain" },
            body: JSON.stringify({ url: VALID_URL }),
        });
        assert.equal(res.status, 415);
        res = await fetch(base, {
            method: "POST",
            headers: good,
            body: JSON.stringify({ url: VALID_URL, pad: "x".repeat(5000) }),
        });
        assert.equal(res.status, 413);
        res = await post(port, "{not json");
        assert.equal(res.status, 400);
        res = await post(port, {});
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error.code, "invalid-url");
        res = await post(port, { url: "https://example.com/x" });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error.code, "unsupported-url");
        // Host/Sec-Fetch-Site need raw requests — undici drops them.
        let raw = await rawPost(
            port,
            {
                Host: "evil.example.com",
                Origin: `http://127.0.0.1:${port}`,
            },
            { url: VALID_URL },
        );
        assert.equal(raw.status, 403);
        raw = await rawPost(
            port,
            {
                Host: `127.0.0.1:${port}`,
                Origin: `http://127.0.0.1:${port}`,
                "Sec-Fetch-Site": "cross-site",
            },
            { url: VALID_URL },
        );
        assert.equal(raw.status, 403);
        res = await fetch(base, { headers: good });
        assert.equal(res.status, 405);
    } finally {
        await stop(server);
        await rm(dir, { recursive: true, force: true });
    }
});

test("metadata playlist, long duration and tool failures map to errors", async () => {
    const { dir, tools } = await fixtureDirs();
    const cases = [
        {
            name: "playlist metadata rejected",
            options: { meta: { ...META, _type: "playlist", entries: [{}] } },
            status: 502,
            code: "metadata",
        },
        {
            name: "duration over 600s rejected",
            options: { meta: { ...META, duration: 601 } },
            status: 422,
            code: "too-long",
        },
        {
            name: "yt-dlp nonzero exit",
            options: { metaCode: 1 },
            status: 502,
            code: "tool",
        },
        {
            name: "ffmpeg failure",
            options: { ffmpegMode: "fail" },
            status: 502,
            code: "convert",
        },
    ];
    for (const c of cases) {
        const { server, port } = await startServer({
            spawnImpl: makeSpawn(c.options),
            env: testEnv(tools),
            root: dir,
        });
        try {
            const res = await post(port, { url: VALID_URL });
            assert.equal(res.status, c.status, c.name);
            const body = await res.json();
            assert.equal(body.error.code, c.code, c.name);
        } finally {
            await stop(server);
        }
    }
    // missing tools -> 503 unavailable
    const { server, port } = await startServer({
        spawnImpl: makeSpawn({}),
        env: { PATH: "/nonexistent" },
        root: dir,
    });
    try {
        const res = await post(port, { url: VALID_URL });
        assert.equal(res.status, 503);
        assert.equal((await res.json()).error.code, "unavailable");
    } finally {
        await stop(server);
        await rm(dir, { recursive: true, force: true });
    }
});

/**
 * With a hanging spawn, an accepted POST stays pending at the download step
 * while a busy one answers 409 immediately. Poll until a request is accepted.
 */
async function waitForSlotFree(port) {
    for (let i = 0; i < 30; i++) {
        const controller = new AbortController();
        const pending = post(port, { url: VALID_URL }, {}, controller.signal)
            .then((r) => r.status)
            .catch(() => "error");
        const outcome = await Promise.race([
            pending,
            sleep(400).then(() => null),
        ]);
        if (outcome === null || outcome !== 409) {
            controller.abort();
            await pending.catch(() => {});
            return true;
        }
        await sleep(100);
    }
    return false;
}

test("tool stdout overflow returns 413 too-large", async () => {
    const { dir, tools } = await fixtureDirs();
    const { server, port } = await startServer({
        spawnImpl: makeSpawn({ metaRaw: "x".repeat(1200 * 1024) }),
        env: testEnv(tools),
        root: dir,
    });
    try {
        const res = await post(port, { url: VALID_URL });
        assert.equal(res.status, 413);
        assert.equal((await res.json()).error.code, "too-large");
    } finally {
        await stop(server);
        await rm(dir, { recursive: true, force: true });
    }
});

test("concurrent bodies yield one job, one 409, then the slot frees", async () => {
    const { dir, tools } = await fixtureDirs();
    const { server, port } = await startServer({
        spawnImpl: makeSpawn({ hang: true }),
        env: testEnv(tools),
        root: dir,
        jobTimeoutMs: 30000,
    });
    const controllers = [new AbortController(), new AbortController()];
    try {
        const attempts = controllers.map((c) =>
            post(port, { url: VALID_URL }, {}, c.signal)
                .then((r) => r.status)
                .catch(() => "error"),
        );
        const outcomes = await Promise.all(
            attempts.map((p) =>
                Promise.race([p, sleep(600).then(() => "pending")]),
            ),
        );
        assert.equal(outcomes.filter((o) => o === 409).length, 1);
        assert.equal(outcomes.filter((o) => o === "pending").length, 1);
        // a third request while the winner hangs must also 409
        const third = await post(port, { url: VALID_URL });
        assert.equal(third.status, 409);
        controllers.forEach((c) => c.abort());
        await Promise.allSettled(attempts);
        assert.ok(await waitForSlotFree(port));
    } finally {
        await stop(server);
        await rm(dir, { recursive: true, force: true });
    }
});

test("client disconnect kills the job and releases the slot", async () => {
    const { dir, tools } = await fixtureDirs();
    const { server, port, terminated } = await startServer({
        spawnImpl: makeSpawn({ hang: true }),
        env: testEnv(tools),
        root: dir,
        jobTimeoutMs: 60000,
    });
    try {
        const controller = new AbortController();
        const pending = post(
            port,
            { url: VALID_URL },
            {},
            controller.signal,
        ).catch((e) => e);
        await sleep(400);
        controller.abort();
        await pending;
        assert.ok(await waitForSlotFree(port));
        // the injected terminator must have been used for the hung child
        assert.ok(terminated.length >= 1);
    } finally {
        await stop(server);
        await rm(dir, { recursive: true, force: true });
    }
});

test("job timeout returns 504", async () => {
    const { dir, tools } = await fixtureDirs();
    const { server, port } = await startServer({
        spawnImpl: makeSpawn({ hang: true }),
        env: testEnv(tools),
        root: dir,
        jobTimeoutMs: 400,
    });
    try {
        const res = await post(port, { url: VALID_URL });
        assert.equal(res.status, 504);
        assert.equal((await res.json()).error.code, "timeout");
    } finally {
        await stop(server);
        await rm(dir, { recursive: true, force: true });
    }
});

test("real ffmpeg+ffprobe retain 44100 Hz stereo audio losslessly in FLAC", async (t) => {
    const { dir } = await fixtureDirs();
    const ffmpegBin = join(
        process.cwd(),
        ".tools",
        "ffmpeg",
        "bin",
        process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    );
    const ffprobeBin = ffmpegBin.replace(/ffmpeg(\.exe)?$/, (m) =>
        m.includes(".") ? "ffprobe.exe" : "ffprobe",
    );
    // External integration case: skipped on clean checkouts without the
    // gitignored .tools binaries; all pure/mock tests stay mandatory.
    if (!existsSync(ffmpegBin) || !existsSync(ffprobeBin)) {
        t.skip("project-local .tools ffmpeg/ffprobe not installed");
        return;
    }
    const toolsDir = join(dir, "realtools");
    await mkdir(toolsDir, { recursive: true });
    const env = {
        PATH: "/nonexistent",
        FUNCUBY_YTDLP: join(toolsDir, "yt-dlp"),
        FUNCUBY_FFMPEG: ffmpegBin,
        FUNCUBY_FFPROBE: ffprobeBin,
    };
    await writeFile(env.FUNCUBY_YTDLP, "");
    // 44100 Hz stereo source WAV
    const rate = 44100,
        total = rate,
        src = Buffer.alloc(44 + total * 4);
    src.write("RIFF", 0);
    src.writeUInt32LE(36 + total * 4, 4);
    src.write("WAVEfmt ", 8);
    src.writeUInt32LE(16, 16);
    src.writeUInt16LE(1, 20);
    src.writeUInt16LE(2, 22);
    src.writeUInt32LE(rate, 24);
    src.writeUInt32LE(rate * 4, 28);
    src.writeUInt16LE(4, 32);
    src.writeUInt16LE(16, 34);
    src.write("data", 36);
    src.writeUInt32LE(total * 4, 40);
    for (let i = 0; i < total * 2; i++)
        src.writeInt16LE(Math.round(Math.sin(i / 10) * 9000), 44 + i * 2);
    const { server, port } = await startServer({
        spawnImpl: makeSpawn({
            sourceBytes: src,
            ffmpegMode: "real",
            ffprobeReal: true,
        }),
        env,
        root: dir,
    });
    try {
        const res = await post(port, { url: VALID_URL });
        assert.equal(
            res.status,
            200,
            await res
                .clone()
                .text()
                .catch(() => ""),
        );
        const flac = Buffer.from(await res.arrayBuffer());
        assert.equal(flac.toString("ascii", 0, 4), "fLaC");
        const output = join(dir, "returned.flac");
        await writeFile(output, flac);
        const run = promisify(execFile);
        const { stdout: metadata } = await run(ffprobeBin, [
            "-v",
            "error",
            "-show_entries",
            "stream=sample_rate,channels",
            "-of",
            "json",
            output,
        ]);
        const stream = JSON.parse(metadata).streams[0];
        assert.equal(Number(stream.sample_rate), 44100);
        assert.equal(stream.channels, 2);
        const { stdout: pcm } = await run(
            ffmpegBin,
            ["-v", "error", "-i", output, "-f", "s16le", "pipe:1"],
            { encoding: "buffer" },
        );
        assert.deepEqual(
            pcm,
            src.subarray(44),
            "stereo channels and PCM samples changed",
        );
    } finally {
        await stop(server);
        await rm(dir, { recursive: true, force: true });
    }
});
