import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "../../server.js";
import { openTestBrowser } from "./browser.mjs";

const PORT = 18578,
    base = `http://127.0.0.1:${PORT}`;
const wav = Buffer.alloc(44 + 22050 * 2);
wav.write("RIFF");
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(22050, 24);
wav.writeUInt32LE(44100, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < 22050; i++)
    wav.writeInt16LE(
        Math.round(Math.sin((i * 2 * Math.PI * 440) / 22050) * 6000),
        44 + i * 2,
    );
const sourceHash = createHash("sha256").update(wav).digest("hex");
const fakeService = {
    async handle(req, res) {
        if (
            req.url === "/api/audio-import/status" ||
            req.url === "/api/transcription/game/status"
        ) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ready: true, available: true }));
            return true;
        }
        if (req.url === "/api/audio-import" && req.method === "POST") {
            req.resume();
            await once(req, "end");
            res.writeHead(200, {
                "Content-Type": "audio/wav",
                "X-Audio-Name": encodeURIComponent("saved-song.wav"),
            });
            res.end(wav);
            return true;
        }
        return false;
    },
};
const startServer = () => {
    const instance = createServer({
        port: PORT,
        audioImport: fakeService,
        gameTranscription: fakeService,
    });
    return new Promise((resolve) =>
        instance.listen(PORT, "127.0.0.1", () => resolve(instance)),
    );
};
const stopServer = (instance) =>
    new Promise((resolve) => {
        instance.close(resolve);
        instance.closeAllConnections();
    });
const instrument = `
    window.__workerStarts = 0; window.__audioFetches = 0;
    const realFetch = window.fetch;
    window.fetch = (...args) => {
        if (String(args[0]).includes("/api/audio-import") && args[1]?.method === "POST")
            window.__audioFetches++;
        return realFetch(...args);
    };
    window.Worker = class {
        postMessage(start) {
            window.__workerStarts++;
            setTimeout(() => {
                if (this.stopped) return;
                this.onmessage?.({ data: { version: start.version, jobId: start.jobId,
                    type: "result", notes: (start.engine === "game" ? [62, 65] : [60, 64, 67])
                        .map((note, i) => ({ note, timeMs: i * 250, durationMs: 200, velocity: 80 })) } });
            }, 20);
        }
        terminate() { this.stopped = true; }
    };
    if (sessionStorage.getItem("holdDecode")) {
        const decode = AudioContext.prototype.decodeAudioData;
        let first = true;
        AudioContext.prototype.decodeAudioData = function (data) {
            if (!first) return decode.call(this, data);
            first = false;
            return new Promise((resolve, reject) => {
                window.__releaseDecode = () => decode.call(this, data).then(resolve, reject);
            });
        };
    }
`;
let server, browser;
await mkdir(".test-artifacts", { recursive: true });
const attach = async () => {
    const opened = await openTestBrowser("edge-profile-storage");
    await opened.send("Page.addScriptToEvaluateOnNewDocument", {
        source: instrument,
    });
    return opened;
};
const restored = () =>
    browser.until(
        `document.getElementById("transcribe-storage-status")?.dataset.i18n === "transcribe.storage.restored"`,
    );
const saved = () =>
    browser.until(
        `document.getElementById("transcribe-storage-status")?.dataset.i18n === "transcribe.storage.saved"`,
    );
const reload = async () => {
    await browser.send("Page.reload", { ignoreCache: true });
    await restored();
};
const readDraft = () =>
    browser.evaluate(`(async () => {
    const { TranscriptionStore } = await import("/src/core/storage/transcription-store.js");
    const draft = await new TranscriptionStore().load();
    if (!draft) return null;
    const hash = await crypto.subtle.digest("SHA-256", await draft.source.blob.arrayBuffer());
    return { name: draft.source.name, hash: [...new Uint8Array(hash)].map(v => v.toString(16).padStart(2,"0")).join(""),
        state: draft.state, sourceId: draft.source.id };
})()`);
try {
    server = await startServer();
    browser = await attach();
    // This dedicated profile/port contains test data only, never the user's 5173 data.
    await browser.send("Storage.clearDataForOrigin", {
        origin: base,
        storageTypes: "indexeddb",
    });
    await browser.send("Page.navigate", { url: `${base}/#transcribe` });
    await browser.until(
        `document.getElementById("transcribe-storage-status")?.dataset.i18n === "transcribe.storage.empty"`,
    );
    await browser.evaluate(`(() => {
        document.getElementById("transcribe-url").value = "https://www.bilibili.com/video/BVtest";
        document.getElementById("transcribe-fetch").click();
    })()`);
    await saved();
    assert.equal((await readDraft()).name, "saved-song.wav");
    assert.equal((await readDraft()).hash, sourceHash);
    await browser.evaluate(`document.getElementById("transcribe-run").click()`);
    await browser.until(
        `!document.getElementById("transcribe-results").hidden`,
    );
    await saved();
    await browser.until(
        `!document.getElementById("transcribe-engine-game").disabled`,
    );
    await browser.evaluate(`(() => {
        const change = (id, value) => { const n = document.getElementById(id); n.value = value; n.dispatchEvent(new Event("change", {bubbles:true})); };
        change("transcribe-language", "zh"); change("transcribe-engine", "game");
        document.getElementById("transcribe-run").click();
    })()`);
    await browser.until(
        `!document.getElementById("transcribe-results").hidden`,
    );
    await saved();
    await browser.evaluate(`(() => {
        document.querySelector('.transcribe-level[data-level="melody"]').click();
        for (const [id, value] of Object.entries({"transcribe-bpm":"90", "transcribe-transpose":"2",
            "transcribe-audition-volume":"42", "transcribe-audition-mode":"original"})) {
            const n = document.getElementById(id); n.value = value;
            n.dispatchEvent(new Event("input", {bubbles:true}));
            n.dispatchEvent(new Event("change", {bubbles:true}));
        }
    })()`);
    await saved();
    const original = await readDraft();
    assert.equal(original.state.captures.length, 2);
    await reload();
    const checkRestored = async () => {
        assert.equal((await readDraft()).hash, sourceHash);
        assert.equal(await browser.evaluate("window.__audioFetches"), 0);
        assert.equal(await browser.evaluate("window.__workerStarts"), 0);
        assert.equal(
            await browser.evaluate(
                `document.getElementById("transcribe-engine").value`,
            ),
            "game",
        );
        assert.equal(
            await browser.evaluate(
                `document.getElementById("transcribe-bpm").value`,
            ),
            "90",
        );
        assert.equal(
            await browser.evaluate(
                `document.getElementById("transcribe-audition-volume").value`,
            ),
            "42",
        );
        assert.equal(
            await browser.evaluate(
                `document.getElementById("transcribe-results").hidden`,
            ),
            false,
        );
        assert.equal(
            await browser.evaluate(
                `document.getElementById("transcribe-source").paused`,
            ),
            true,
        );
        assert.equal(
            await browser.evaluate(
                `document.getElementById("transcribe-download-original").disabled`,
            ),
            false,
        );
        assert.equal(
            await browser.evaluate(
                `document.getElementById("transcribe-transpose").value`,
            ),
            "2",
        );
        assert.equal(
            await browser.evaluate(
                `document.querySelector('.transcribe-level[data-level="melody"]').getAttribute("aria-pressed")`,
            ),
            "true",
        );
        await browser.evaluate(`(() => {
            const mode = document.getElementById("transcribe-engine");
            mode.value = "basic-pitch"; mode.dispatchEvent(new Event("change"));
        })()`);
        assert.match(
            await browser.evaluate(
                `document.getElementById("transcribe-status").textContent`,
            ),
            /3/,
        );
        assert.equal(
            await browser.evaluate(
                `document.getElementById("transcribe-origin").max`,
            ),
            "1000",
        );
        await browser.evaluate(`(() => {
            const mode = document.getElementById("transcribe-engine");
            mode.value = "game"; mode.dispatchEvent(new Event("change"));
        })()`);
        assert.match(
            await browser.evaluate(
                `document.getElementById("transcribe-status").textContent`,
            ),
            /2/,
        );
        assert.equal(await browser.evaluate("window.__workerStarts"), 0);
        await saved();
    };
    await checkRestored();
    console.log(
        "PASS: refresh restores exact audio bytes, both captures and settings without fetch, inference or autoplay",
    );
    assert.deepEqual(browser.errors, []);
    await browser.close();
    browser = null;
    await stopServer(server);
    server = await startServer();
    browser = await attach();
    await browser.send("Page.navigate", { url: `${base}/#transcribe` });
    await restored();
    await checkRestored();
    console.log("PASS: browser and server restart retain the workbench");

    await browser.evaluate(`(() => {
        window.__put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function(...args) {
            if (this.name === "workbench") throw new DOMException("quota", "QuotaExceededError");
            return window.__put.apply(this, args);
        };
        const n = document.getElementById("transcribe-bpm"); n.value = "91"; n.dispatchEvent(new Event("change"));
    })()`);
    await browser.until(
        `document.getElementById("transcribe-storage-status").dataset.i18n === "transcribe.storage.unavailable"`,
    );
    assert.equal(
        await browser.evaluate(
            `document.getElementById("transcribe-results").hidden`,
        ),
        false,
    );
    await reload();
    await checkRestored();
    console.log(
        "PASS: failed write is reported and preserves the last committed work",
    );

    const storageChecks = await browser.evaluate(`(async () => {
        const {TranscriptionStore} = await import("/src/core/storage/transcription-store.js");
        const a = new TranscriptionStore({name:"storage-concurrency-test"});
        const b = new TranscriptionStore({name:"storage-concurrency-test"});
        const source = (id) => ({version:1,id,name:id,blob:new Blob(["audio"])});
        const state = (id) => ({version:1,sourceId:id,settings:{},captures:[]});
        await a.replace(source("A"), state("A")); await b.replace(source("B"), state("B"));
        const stale = await a.saveState("A", state("A"));
        const name = (await b.load()).source.name;
        const get = IDBObjectStore.prototype.get;
        let interrupted = false, rejected = false;
        IDBObjectStore.prototype.get = function(...args) {
            const result = get.apply(this, args);
            if (!interrupted && this.transaction.db.name === "storage-concurrency-test") {
                interrupted = true;
                const tx = this.transaction;
                queueMicrotask(() => tx.abort());
            }
            return result;
        };
        try { await a.load(); }
        catch { rejected = true; }
        finally { IDBObjectStore.prototype.get = get; }
        if (!rejected || (await b.load()).source.name !== "B")
            throw new Error("Aborted read did not preserve committed work");
        await b.clear(); const revive = await a.saveState("B", state("B"));
        await Promise.all([a.replace(source("A"),state("A")),a.saveState("A",state("A")),a.clear()]);
        return {stale,name,revive,empty:await a.load()};
    })()`);
    assert.deepEqual(storageChecks, {
        stale: false,
        name: "B",
        revive: false,
        empty: null,
    });
    console.log(
        "PASS: stale tabs and queued writes cannot replace or resurrect deleted audio",
    );

    await browser.evaluate(`sessionStorage.setItem("holdDecode", "1")`);
    await browser.send("Page.reload");
    await browser.until(`typeof window.__releaseDecode === "function"`);
    await writeFile(resolve(".test-artifacts/replacement.wav"), wav);
    const { root } = await browser.send("DOM.getDocument");
    const { nodeId } = await browser.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: "#transcribe-file",
    });
    await browser.send("DOM.setFileInputFiles", {
        nodeId,
        files: [resolve(".test-artifacts/replacement.wav")],
    });
    await saved();
    await browser.evaluate(
        `window.__releaseDecode(); sessionStorage.removeItem("holdDecode")`,
    );
    assert.equal((await readDraft()).name, "replacement.wav");
    assert.equal((await readDraft()).state.captures.length, 0);
    console.log(
        "PASS: a late restored decode cannot overwrite a newly imported song",
    );

    await browser.evaluate(
        `window.confirm = () => false; document.getElementById("transcribe-storage-clear").click()`,
    );
    assert.notEqual(await readDraft(), null);
    await browser.evaluate(
        `window.confirm = () => true; document.getElementById("transcribe-storage-clear").click()`,
    );
    await browser.until(
        `document.getElementById("transcribe-storage-status").dataset.i18n === "transcribe.storage.empty"`,
    );
    assert.equal(await readDraft(), null);
    await browser.send("Page.reload");
    await browser.until(
        `document.getElementById("transcribe-storage-status")?.dataset.i18n === "transcribe.storage.empty"`,
    );
    assert.equal(
        await browser.evaluate(
            `document.getElementById("transcribe-clip").hidden`,
        ),
        true,
    );
    assert.deepEqual(browser.errors, []);
    console.log(
        "PASS: confirmed deletion survives reload; cancelled confirmation preserves data",
    );
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
        const open = IDBFactory.prototype.open;
        IDBFactory.prototype.open = function(name, ...args) {
            if (name === "funcuby-transcription") throw new DOMException("denied", "SecurityError");
            return open.call(this, name, ...args);
        };
    `,
    });
    await browser.send("Page.reload");
    await browser.until(
        `document.getElementById("transcribe-storage-status")?.dataset.i18n === "transcribe.storage.unavailable"`,
    );
    const document = await browser.send("DOM.getDocument");
    const fileInput = await browser.send("DOM.querySelector", {
        nodeId: document.root.nodeId,
        selector: "#transcribe-file",
    });
    await browser.send("DOM.setFileInputFiles", {
        nodeId: fileInput.nodeId,
        files: [resolve(".test-artifacts/replacement.wav")],
    });
    await browser.until(
        `document.getElementById("transcribe-source-name").textContent === "replacement.wav" && !document.getElementById("transcribe-run").disabled`,
    );
    await browser.evaluate(`document.getElementById("transcribe-run").click()`);
    await browser.until(
        `!document.getElementById("transcribe-results").hidden && document.getElementById("transcribe-storage-status").dataset.i18n === "transcribe.storage.unavailable"`,
    );
    assert.deepEqual(browser.errors, []);
    console.log(
        "PASS: denied storage never claims success and does not disable audio or transcription",
    );
} finally {
    if (browser) await browser.close();
    if (server) await stopServer(server);
}
