import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { createServer } from "../../server.js";

// Deterministic URL-import e2e: the real static app is served by createServer
// with a fake audioImport handler injected at construction — no yt-dlp, no
// network, no production backdoor. The fake keys behaviour off the posted URL.

const PORT = 18574;
const BROWSER =
    process.env.BROWSER ||
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function toneWav() {
    const rate = 22050,
        total = rate,
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
            Math.round(Math.sin((2 * Math.PI * 523 * i) / rate) * 6000),
            44 + i * 2,
        );
    return buffer;
}
const WAV = toneWav();

const fakeImport = {
    async handle(req, res) {
        const path = new URL(req.url, "http://localhost").pathname;
        const json = (status, body) => {
            const payload = JSON.stringify(body);
            res.writeHead(status, {
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": Buffer.byteLength(payload),
            });
            res.end(payload);
        };
        if (path === "/api/audio-import/status" && req.method === "GET") {
            json(200, { ready: true, missing: [] });
            return true;
        }
        if (path !== "/api/audio-import" || req.method !== "POST") return false;
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let url = "";
        try {
            url = JSON.parse(Buffer.concat(chunks).toString("utf8")).url || "";
        } catch {
            /* fall through */
        }
        if (url.includes("down")) {
            req.socket.destroy();
            return true;
        }
        if (url.includes("failmeta")) {
            json(502, {
                error: { code: "metadata", message: "fake metadata failure" },
            });
            return true;
        }
        const slow = url.includes("slow");
        const name = url.includes("fast")
            ? "fast-import.wav"
            : slow
              ? "slow-import.wav"
              : "url-import.wav";
        const sendWav = () => {
            if (res.writableEnded || res.destroyed) return;
            res.writeHead(200, {
                "Content-Type": "audio/wav",
                "Content-Length": WAV.length,
                "X-Audio-Name": encodeURIComponent(`测试 ${name}`),
                "Cache-Control": "no-store",
            });
            res.end(WAV);
        };
        if (slow) {
            const timer = setTimeout(sendWav, 2500);
            res.on("close", () => clearTimeout(timer));
            return true;
        }
        sendWav();
        return true;
    },
};

const server = createServer({
    libraryDirectory: resolve(
        ".test-artifacts",
        "library-url-import-" + crypto.randomUUID(),
    ),
    port: PORT,
    audioImport: fakeImport,
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

let browser, socket;
const errors = [];
try {
    browser = spawn(
        BROWSER,
        [
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--remote-debugging-port=0",
            "--lang=zh-CN",
            "--autoplay-policy=no-user-gesture-required",
            `--user-data-dir=${resolve(".test-artifacts/edge-profile-url")}`,
            "about:blank",
        ],
        { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    const debuggerUrl = await new Promise((res, rej) => {
        let output = "";
        const timer = setTimeout(
            () => rej(Error("Browser debugger startup timed out")),
            20000,
        );
        browser.stderr.on("data", (bytes) => {
            output += bytes;
            const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
            if (match) {
                clearTimeout(timer);
                res(match[1]);
            }
        });
        browser.on("error", rej);
    });
    const port = new URL(debuggerUrl).port;
    const tabs = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
    socket = new WebSocket(
        tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl,
    );
    await new Promise((res, rej) => {
        socket.addEventListener("open", res, { once: true });
        socket.addEventListener("error", rej, { once: true });
    });
    let seq = 0;
    const pending = new Map();
    socket.addEventListener("message", ({ data }) => {
        const msg = JSON.parse(data);
        if (msg.id) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error
                ? p.reject(Error(JSON.stringify(msg.error)))
                : p.resolve(msg.result);
        } else if (msg.method === "Runtime.exceptionThrown")
            errors.push(msg.params.exceptionDetails);
        else if (
            msg.method === "Runtime.consoleAPICalled" &&
            msg.params.type === "error"
        )
            errors.push({
                consoleError: msg.params.args
                    .map((arg) => arg.value ?? arg.description ?? "")
                    .join(" "),
            });
    });
    const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const id = ++seq;
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(Error(`CDP ${method} timed out`));
            }, 30000);
            pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });
            socket.send(JSON.stringify({ id, method, params }));
        });
    const evaluate = async (expression) => {
        const r = await send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
        });
        if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
        return r.result.value;
    };
    const until = async (expression, timeoutMs = 15000) => {
        for (let i = 0; i < timeoutMs / 100; i++) {
            if (await evaluate(expression)) return true;
            await wait(100);
        }
        return evaluate(expression);
    };
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 1080,
        deviceScaleFactor: 1,
        mobile: false,
    });
    await send("Storage.clearDataForOrigin", {
        origin: `http://127.0.0.1:${PORT}`,
        storageTypes: "indexeddb",
    });
    await send("Page.navigate", {
        url: `http://127.0.0.1:${PORT}/#transcribe`,
    });
    assert.ok(
        await until(
            `document.querySelectorAll('#transcribe-levels .transcribe-level').length === 4`,
        ),
        "transcribe tab did not render",
    );
    const setUrl = (value) =>
        evaluate(`(() => {
            const input = document.getElementById('transcribe-url');
            input.value = ${JSON.stringify(value)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return input.value;
        })()`);
    const fetchStatus = () =>
        evaluate(
            `document.getElementById('transcribe-fetch-status').textContent`,
        );
    const sourceName = () =>
        evaluate(
            `document.getElementById('transcribe-source-name').textContent`,
        );
    const clipHidden = () =>
        evaluate(`document.getElementById('transcribe-clip').hidden`);
    const errorText = () =>
        evaluate(`document.getElementById('transcribe-error').textContent`);

    // 1. Server-side failure surfaces a translated error and recovers.
    await setUrl("https://www.bilibili.com/video/BVfailmeta0001");
    await evaluate(`document.getElementById('transcribe-fetch').click()`);
    assert.ok(
        await until(`!document.getElementById('transcribe-error').hidden`),
        "metadata error was not shown",
    );
    assert.match(await errorText(), /无法读取视频信息|Could not read/);
    assert.equal(await clipHidden(), true);
    console.log("PASS: importer error maps to a translated message");

    // 2. Cancel during a slow download aborts and frees the controls.
    await setUrl("https://www.bilibili.com/video/BVslow0000001");
    await evaluate(`document.getElementById('transcribe-fetch').click()`);
    await until(
        `document.getElementById('transcribe-fetch-cancel').hidden === false`,
    );
    await evaluate(
        `document.getElementById('transcribe-fetch-cancel').click()`,
    );
    await until(
        `document.getElementById('transcribe-fetch-cancel').hidden === true`,
    );
    assert.equal(
        await evaluate(`document.getElementById('transcribe-fetch').disabled`),
        false,
    );
    console.log("PASS: cancel aborts a running URL import");

    // 3. Successful import loads the WAV through the normal source path.
    await setUrl("https://www.bilibili.com/video/BV1xx411c7Tq");
    await evaluate(`document.getElementById('transcribe-fetch').click()`);
    assert.ok(
        await until(
            `document.getElementById('transcribe-source-name').textContent.includes('url-import.wav') &&
             !document.getElementById('transcribe-run').disabled &&
             document.getElementById('transcribe-fetch-cancel').hidden`,
            20000,
        ),
        "imported source did not decode",
    );
    assert.match(await sourceName(), /url-import\.wav/);
    assert.equal(
        await evaluate(
            `document.getElementById('transcribe-source').src.startsWith('blob:')`,
        ),
        true,
    );
    assert.equal(
        await evaluate(`document.getElementById('transcribe-run').disabled`),
        false,
    );
    assert.equal(await fetchStatus(), "");
    console.log("PASS: URL import decodes into the existing source pipeline");

    // 4. Editing the link mid-flight aborts the stale response; the newer
    //    import wins and the old one can never overwrite it.
    await setUrl("https://www.bilibili.com/video/BVslow0000002");
    await evaluate(`document.getElementById('transcribe-fetch').click()`);
    await until(
        `document.getElementById('transcribe-fetch-cancel').hidden === false`,
    );
    await setUrl("https://www.bilibili.com/video/BVfast0000001");
    await evaluate(`document.getElementById('transcribe-fetch').click()`);
    assert.ok(
        await until(
            `document.getElementById('transcribe-source-name').textContent.includes('fast-import.wav')`,
            20000,
        ),
        "fast import did not land",
    );
    assert.match(await sourceName(), /fast-import\.wav/);
    await wait(2800); // the aborted slow response must never land
    assert.match(await sourceName(), /fast-import\.wav/);
    console.log("PASS: stale import response cannot replace a newer source");

    // 5. A destroyed connection surfaces the network/server-missing message.
    await setUrl("https://www.bilibili.com/video/BVdown00000001");
    await evaluate(`document.getElementById('transcribe-fetch').click()`);
    assert.ok(
        await until(`!document.getElementById('transcribe-error').hidden`),
        "network error was not shown",
    );
    assert.match(await errorText(), /npm start|服务器|server/i);
    console.log("PASS: network failure shows the local-server guidance");

    // 6. A source decode held past a URL edit can never land — the stale job
    //    token discards it even after the deferred decodeAudioData resolves.
    await evaluate(`(() => {
        window.__decodePending = [];
        window.__decodeCalls = 0;
        window.__origDecode = AudioContext.prototype.decodeAudioData;
        AudioContext.prototype.decodeAudioData = function (audioData) {
            window.__decodeCalls++;
            return new Promise((resolve, reject) => {
                window.__decodePending.push({
                    ctx: this,
                    audioData,
                    resolve,
                    reject,
                });
            });
        };
    })()`);
    await setUrl("https://www.bilibili.com/video/BVdecode000001");
    await evaluate(`document.getElementById('transcribe-fetch').click()`);
    assert.ok(
        await until(`window.__decodeCalls >= 1`, 20000),
        "source decode was never reached",
    );
    assert.equal(
        await evaluate(`document.getElementById('transcribe-run').disabled`),
        true,
    );
    // Editing the link mid-decode cancels the import and kills the decode job.
    await setUrl("https://www.bilibili.com/video/BVother00000001");
    await evaluate(`(async () => {
        const pending = window.__decodePending.splice(0);
        for (const item of pending) {
            try {
                const buffer = await window.__origDecode.call(
                    item.ctx,
                    item.audioData,
                );
                item.resolve(buffer);
            } catch (error) {
                item.reject(error);
            }
        }
    })()`);
    await wait(300);
    assert.equal(
        await evaluate(`document.getElementById('transcribe-run').disabled`),
        false,
        "previous successful import should remain playable",
    );
    assert.equal(await clipHidden(), false);
    assert.match(await sourceName(), /fast-import/);
    assert.equal(await fetchStatus(), "");
    assert.equal(
        await evaluate(
            `document.getElementById('transcribe-status').textContent`,
        ),
        "",
    );
    await evaluate(`(() => {
        AudioContext.prototype.decodeAudioData = window.__origDecode;
        window.__decodePending = [];
    })()`);
    console.log(
        "PASS: decode held past a URL edit is discarded; controls stay idle",
    );

    // 7. Local file import still works after URL flows.
    const { root } = await send("DOM.getDocument");
    const { nodeId } = await send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: "#transcribe-file",
    });
    await writeFile(resolve(".test-artifacts/url-import-local.wav"), WAV);
    await send("DOM.setFileInputFiles", {
        nodeId,
        files: [resolve(".test-artifacts/url-import-local.wav")],
    });
    assert.ok(
        await until(
            `document.getElementById('transcribe-source-name').textContent.includes('url-import-local.wav')`,
            20000,
        ),
        "local file did not decode after URL imports",
    );
    assert.match(await sourceName(), /url-import-local\.wav/);
    console.log("PASS: manual file upload still works");

    // 8. Mobile viewport: the URL row must not overflow.
    await send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
    });
    await wait(150);
    assert.equal(
        await evaluate(`document.documentElement.scrollWidth > innerWidth`),
        false,
    );
    await mkdir(".test-artifacts", { recursive: true });
    await writeFile(
        ".test-artifacts/url-import-mobile.png",
        Buffer.from(
            (
                await send("Page.captureScreenshot", {
                    format: "png",
                    captureBeyondViewport: true,
                })
            ).data,
            "base64",
        ),
    );
    await send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 1080,
        deviceScaleFactor: 1,
        mobile: false,
    });
    await setUrl("https://www.bilibili.com/video/BV1xx411c7Tq");
    await evaluate(`document.getElementById('transcribe-fetch').click()`);
    assert.ok(
        await until(
            `document.getElementById('transcribe-source-name').textContent.includes('url-import.wav')`,
            20000,
        ),
    );
    await writeFile(
        ".test-artifacts/url-import-result.png",
        Buffer.from(
            (
                await send("Page.captureScreenshot", {
                    format: "png",
                    captureBeyondViewport: true,
                })
            ).data,
            "base64",
        ),
    );
    await writeFile(
        ".test-artifacts/url-import-errors.json",
        JSON.stringify(errors, null, 2),
    );
    assert.deepEqual(errors, []);
    console.log(
        "PASS: mobile layout fits, screenshots saved, no JS exceptions",
    );
} finally {
    if (socket) socket.close();
    if (browser) browser.kill();
    server.close();
}
console.log("URL-IMPORT E2E: all checks passed");
