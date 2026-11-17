import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createGameTranscription } from "../../server/game-transcription.js";
import { transcribeGame } from "../../src/core/transcription/game-client.js";
import {
    encodeStart,
    decodeStart,
} from "../../src/core/transcription/protocol.js";
import { TranscriptionJob } from "../../src/core/transcription/job.js";

const notes = [{ note: 64, timeMs: 0, durationMs: 250, velocity: 96 }];
const start = () =>
    encodeStart({
        jobId: 1,
        engine: "game",
        sampleRate: 44100,
        language: "zh",
        samples: new Float32Array(44100),
    });

test("GAME start is explicit and rate-validated without weakening Basic Pitch", () => {
    assert.equal(decodeStart(start()).sampleRate, 44100);
    assert.throws(() =>
        encodeStart({
            jobId: 1,
            samples: new Float32Array(10),
            sampleRate: 44100,
        }),
    );
    assert.throws(() => decodeStart({ ...start(), sampleRate: undefined }));
    assert.throws(() => decodeStart({ ...start(), language: "shell" }));
    assert.throws(() => decodeStart({ ...start(), engine: "__proto__" }));
});

test("job duration and transferred rate follow the selected engine", async () => {
    const worker = {
        terminate() {},
        postMessage(message) {
            assert.equal(message.sampleRate, 44100);
            assert.equal(message.engine, "game");
            queueMicrotask(() =>
                worker.onmessage({
                    data: {
                        version: message.version,
                        type: "result",
                        jobId: message.jobId,
                        notes,
                    },
                }),
            );
        },
    };
    const job = new TranscriptionJob({ createWorker: () => worker });
    await job.start(() => new Float32Array(44100), {
        engine: "game",
        language: "zh",
    });
    assert.equal(job.snapshot.audioSeconds, 1);
    assert.equal(job.snapshot.engine, "game");
    job.dispose();
});

test("GAME stream handles fragmented JSON and only settles after a valid EOF", async () => {
    const messages = [],
        bytes = new TextEncoder().encode(
            JSON.stringify({
                type: "status",
                stage: "warming",
                backend: "cpu",
            }) +
                "\n" +
                JSON.stringify({ type: "result", notes }) +
                "\n",
        );
    let sent = 0;
    const stream = new ReadableStream({
        pull(controller) {
            if (sent === bytes.length) {
                controller.close();
                return;
            }
            controller.enqueue(bytes.slice(sent, sent + 7));
            sent = Math.min(bytes.length, sent + 7);
        },
    });
    await transcribeGame(start(), {
        fetchImpl: async () =>
            new Response(stream, {
                headers: { "Content-Type": "application/x-ndjson" },
            }),
        postMessage: (event) => messages.push(event),
    });
    assert.deepEqual(
        messages.map((m) => m.type),
        ["status", "result"],
    );
    assert.deepEqual(messages[1].notes, notes);
    const trailing = [];
    await assert.rejects(
        transcribeGame(start(), {
            fetchImpl: async () =>
                new Response(
                    JSON.stringify({ type: "result", notes }) + "\n{}\n",
                    { headers: { "Content-Type": "application/x-ndjson" } },
                ),
            postMessage: (event) => trailing.push(event),
        }),
        (error) => error.code === "protocol",
    );
    assert.equal(
        trailing.length,
        0,
        "invalid trailing events must not yield a successful result",
    );
});

async function service(t, { hold = false } = {}) {
    const children = [];
    const spawnImpl = (_command, args) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.exitCode = null;
        child.signalCode = null;
        child.kills = 0;
        child.finish = (event) => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            child.stdout.end(JSON.stringify(event) + "\n");
            child.exitCode = 0;
            child.emit("close", 0);
        };
        child.kill = () => {
            child.kills++;
            child.signalCode = "SIGTERM";
            child.stdout.end();
            child.stderr.end();
            setImmediate(() => child.emit("close", null));
            return true;
        };
        children.push(child);
        setImmediate(() => {
            if (args.includes("--check")) child.finish({ available: true });
            else {
                child.stdout.write(
                    JSON.stringify({
                        type: "status",
                        stage: "warming",
                        backend: "cpu",
                    }) + "\n",
                );
                if (!hold) child.finish({ type: "result", notes });
            }
        });
        return child;
    };
    const handler = createGameTranscription({
        root: "C:/unused",
        port: 0,
        spawnImpl,
        jobTimeout: 3000,
    });
    const server = http.createServer((req, res) => {
        void handler.handle(req, res).then((handled) => {
            if (!handled) {
                res.writeHead(404);
                res.end();
            }
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (overrides = {}) =>
        fetch(base + "/api/transcription/game?language=zh", {
            method: "POST",
            body: new Float32Array([0.1, 0.2]),
            ...overrides,
            headers: {
                Origin: base,
                "Content-Type": "application/octet-stream",
                ...overrides.headers,
            },
        });
    return { base, request, children };
}

test("local GAME endpoint rejects foreign origins, hosts, types and languages", async (t) => {
    const s = await service(t);
    for (const [headers, expected] of [
        [{ Origin: "https://foreign.example" }, 403],
        [{ Host: "foreign.example" }, 403],
        [{ "Content-Type": "text/plain" }, 415],
        [{ "Sec-Fetch-Site": "cross-site" }, 403],
    ]) {
        const response = await new Promise((resolve, reject) => {
            const request = http.request(
                s.base + "/api/transcription/game?language=zh",
                {
                    method: "POST",
                    headers: {
                        Origin: s.base,
                        "Content-Type": "application/octet-stream",
                        ...headers,
                    },
                },
                (reply) => {
                    reply.resume();
                    reply.once("end", () => resolve(reply.statusCode));
                },
            );
            request.once("error", reject);
            request.end(Buffer.from(new Float32Array([0.1]).buffer));
        });
        assert.equal(response, expected, JSON.stringify(headers));
    }
    const bad = await fetch(
        s.base + "/api/transcription/game?language=../../file",
        {
            method: "POST",
            headers: {
                Origin: s.base,
                "Content-Type": "application/octet-stream",
            },
            body: new Float32Array([1]),
        },
    );
    assert.equal(bad.status, 400);
    assert.equal(s.children.length, 0, "invalid requests cannot start Python");
});

test("local GAME endpoint streams one result and recovers for another job", async (t) => {
    const s = await service(t);
    for (let i = 0; i < 2; i++) {
        const response = await s.request();
        assert.equal(response.status, 200);
        const events = (await response.text())
            .trim()
            .split("\n")
            .map(JSON.parse);
        assert.equal(events.at(-1).type, "result");
        await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(s.children.length, 2);
});

test("disconnect cancels only the owned inference and frees the busy slot", async (t) => {
    const s = await service(t, { hold: true });
    const abort = new AbortController();
    const first = await s.request({ signal: abort.signal });
    const reader = first.body.getReader();
    await reader.read();
    const busy = await s.request();
    assert.equal(busy.status, 409);
    await busy.text();
    abort.abort();
    await reader.cancel().catch(() => {});
    for (let i = 0; i < 40 && !s.children[0].kills; i++)
        await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(s.children[0].kills, 1);
    await new Promise((resolve) => setTimeout(resolve, 75));
    const next = await s.request();
    assert.equal(next.status, 200);
    const nextReader = next.body.getReader();
    await nextReader.read();
    s.children.at(-1).finish({ type: "result", notes });
    await next.text().catch(() => {});
    await nextReader.cancel().catch(() => {});
});

test("game-separated validates stereo frame alignment and forwards separating progress", async (t) => {
    const separatedStart = encodeStart({
        jobId: 7,
        engine: "game-separated",
        sampleRate: 44100,
        language: "zh",
        samples: new Float32Array(44100 * 2),
    });
    assert.equal(decodeStart(separatedStart).engine, "game-separated");
    assert.throws(() =>
        encodeStart({
            jobId: 7,
            engine: "game-separated",
            sampleRate: 44100,
            language: "zh",
            samples: new Float32Array(44101),
        }),
    );

    const worker = {
        terminate() {},
        postMessage(message) {
            assert.equal(message.engine, "game-separated");
            assert.equal(message.samples.length, 88200);
            queueMicrotask(() => {
                worker.onmessage({
                    data: {
                        version: message.version,
                        type: "status",
                        jobId: message.jobId,
                        stage: "separating",
                        backend: "cpu",
                        completedWindows: 1,
                        totalWindows: 4,
                        progress: 0.25,
                    },
                });
                worker.onmessage({
                    data: {
                        version: message.version,
                        type: "status",
                        jobId: message.jobId,
                        stage: "transcribing",
                        backend: "cpu",
                        completedWindows: 4,
                        totalWindows: 4,
                        progress: 1,
                    },
                });
                worker.onmessage({
                    data: {
                        version: message.version,
                        type: "result",
                        jobId: message.jobId,
                        notes,
                    },
                });
            });
        },
    };
    const job = new TranscriptionJob({ createWorker: () => worker });
    const stages = [];
    const jobWithUpdates = new TranscriptionJob({
        createWorker: () => worker,
        onUpdate: () => stages.push(jobWithUpdates.snapshot.stage),
    });
    job.dispose();
    await jobWithUpdates.start(() => new Float32Array(88200), {
        engine: "game-separated",
        language: "zh",
    });
    assert.equal(jobWithUpdates.snapshot.audioSeconds, 1);
    assert.ok(stages.includes("separating"));
    jobWithUpdates.dispose();

    const s = await service(t);
    const oddStereo = await fetch(
        s.base + "/api/transcription/game?language=zh&separate=1",
        {
            method: "POST",
            headers: {
                Origin: s.base,
                "Content-Type": "application/octet-stream",
            },
            body: new Float32Array([0.1]),
        },
    );
    assert.equal(oddStereo.status, 413);
    const validStereo = await fetch(
        s.base + "/api/transcription/game?language=zh&separate=1",
        {
            method: "POST",
            headers: {
                Origin: s.base,
                "Content-Type": "application/octet-stream",
            },
            body: new Float32Array([0.1, 0.2]),
        },
    );
    assert.equal(validStereo.status, 200);
    const events = (await validStereo.text())
        .trim()
        .split("\n")
        .map(JSON.parse);
    assert.equal(events.at(-1).type, "result");
});
