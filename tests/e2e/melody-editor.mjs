import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "../../server.js";
import { parseMidiFile } from "../../src/core/midi/midi-file.js";
import { openTestBrowser } from "./browser.mjs";

const PORT = 18579,
    base = `http://127.0.0.1:${PORT}`;
function testWav(seconds) {
    const frames = 44100 * seconds;
    const wav = Buffer.alloc(44 + frames * 2);
    wav.write("RIFF");
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(44100, 24);
    wav.writeUInt32LE(88200, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(wav.length - 44, 40);
    for (let i = 0; i < frames; i++)
        wav.writeInt16LE(
            Math.round(Math.sin((i * 2 * Math.PI * 440) / 44100) * 6000),
            44 + i * 2,
        );
    return wav;
}
const note = (note, timeMs, durationMs) => ({
    note,
    timeMs,
    durationMs,
    velocity: 90,
});
const notes = [note(60, 100, 600), note(60, 800, 400), note(72, 1500, 60)];
const instrument = `
    window.__workers = 0; window.__starts = []; window.__blobs = [];
    const createURL = URL.createObjectURL;
    URL.createObjectURL = (blob) => { window.__blobs.push(blob); return createURL(blob); };
    const createSource = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function() {
        const source = createSource.call(this), start = source.start;
        source.start = function(...args) {
            window.__starts.push({args, loop:this.loop, loopStart:this.loopStart,
                loopEnd:this.loopEnd, duration:this.buffer.duration});
            return start.apply(this, args);
        };
        return source;
    };
    window.Worker = class {
        postMessage(start) {
            window.__workers++;
            setTimeout(() => {
                if (!this.stopped) this.onmessage?.({data:{
                    version:start.version,jobId:start.jobId,type:"result",
                    notes:${JSON.stringify(notes)}
                }});
            }, 20);
        }
        terminate() { this.stopped = true; }
    };
`;
const noService = {
    async handle(req, res) {
        if (req.url.endsWith("/status")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end('{"available":false,"ready":false}');
            return true;
        }
        return false;
    },
};
const server = createServer({
    port: PORT,
    audioImport: noService,
    gameTranscription: noService,
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
let browser;
try {
    await mkdir(".test-artifacts", { recursive: true });
    const path = resolve(".test-artifacts/editor-source.wav");
    await writeFile(path, testWav(4));
    browser = await openTestBrowser("edge-profile-melody-editor");
    await browser.send("Storage.clearDataForOrigin", {
        origin: base,
        storageTypes: "indexeddb,local_storage",
    });
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
        source: instrument,
    });
    await browser.send("Page.navigate", { url: `${base}/#transcribe` });
    await browser.until(
        `document.getElementById("transcribe-storage-status")?.dataset.i18n === "transcribe.storage.empty"`,
    );
    await browser.until(
        `document.getElementById("transcribe-engine-status").dataset.i18n === "transcribe.engineMissing"`,
    );
    assert.equal(
        await browser.evaluate(
            'document.getElementById("transcribe-engine").value',
        ),
        "basic-pitch",
    );
    const setFile = async (file) => {
        const { root } = await browser.send("DOM.getDocument");
        const { nodeId } = await browser.send("DOM.querySelector", {
            nodeId: root.nodeId,
            selector: "#transcribe-file",
        });
        await browser.send("DOM.setFileInputFiles", { nodeId, files: [file] });
    };
    await setFile(path);
    await browser.until(`!document.getElementById("transcribe-run").disabled`);
    await browser.evaluate(`(() => {
        for (const [id,value] of [["transcribe-start","0.5"],["transcribe-length","3"]]) {
            const n=document.getElementById(id); n.value=value; n.dispatchEvent(new Event("change"));
        }
        document.getElementById("transcribe-run").click();
    })()`);
    const saved = () =>
        browser.until(
            `document.getElementById("transcribe-storage-status").dataset.i18n === "transcribe.storage.saved"`,
        );
    await browser.until(
        `document.querySelectorAll("#transcribe-editor .melody-editor-list button").length === 3`,
    );
    await saved();
    const capture = () =>
        browser.evaluate(`(async () => {
        const {TranscriptionStore}=await import("/src/core/storage/transcription-store.js");
        return (await new TranscriptionStore().load()).state.captures[0][1];
    })()`);
    const click = (action) =>
        browser.evaluate(
            `document.querySelector('#transcribe-editor [data-action="${action}"]').click()`,
        );
    const fields = (values) =>
        browser.evaluate(`(() => {
        for (const [key,value] of Object.entries(${JSON.stringify(values)})) {
            const n=document.querySelector('#transcribe-editor [data-field="'+key+'"]');
            n.value=value; n.dispatchEvent(new Event("change"));
        }
    })()`);
    await fields({ from: "0.2", to: "1.2" });
    await click("source");
    await browser.until(
        `document.getElementById("transcribe-editor").dataset.playing === "source"`,
    );
    const started = await browser.evaluate(`window.__starts.at(-1)`);
    assert.ok(
        Math.abs(started.args[1] - 0.7) < 0.00001,
        "source missed the nonzero transcription clip offset",
    );
    assert.equal(started.args[2], 1);
    await click("piano");
    await browser.until(
        `document.getElementById("transcribe-editor").dataset.playing === "piano" && document.getElementById("transcribe-editor").textContent.includes("短句播放中")`,
    );
    await click("stop");
    assert.equal(
        await browser.evaluate(
            `document.getElementById("transcribe-editor").dataset.playing`,
        ),
        "",
    );
    await browser.evaluate(
        `document.querySelector('#transcribe-editor [data-field="loop"]').checked = true`,
    );
    await click("source");
    await browser.until(
        `document.getElementById("transcribe-editor").dataset.playing === "source"`,
    );
    const looping = await browser.evaluate(`window.__starts.at(-1)`);
    assert.equal(looping.loop, true);
    assert.ok(Math.abs(looping.loopEnd - 1.7) < 0.00001);
    await click("stop");
    console.log(
        "PASS: real source/piano phrase A/B uses the clip offset, exact endpoints and cancellable loops",
    );
    await fields({ from: "0", to: "3" });
    await browser.evaluate(
        `document.querySelector('#transcribe-editor .melody-editor-list button[data-index="0"]').click()`,
    );
    await fields({ pitch: "62" });
    await click("apply");
    await saved();
    let result = await capture();
    assert.equal(result.notes[0].note, 60);
    assert.equal(result.editedNotes[0].note, 62);
    assert.equal(result.clipStartMs, 500);
    const midi = async (id) => {
        await browser.evaluate(`document.getElementById("${id}").click()`);
        const bytes = await browser.evaluate(`(async () => {
            const blob=window.__blobs.filter(b=>b.type==="audio/midi").at(-1);
            return [...new Uint8Array(await blob.arrayBuffer())];
        })()`);
        return parseMidiFile(Uint8Array.from(bytes))
            .events.filter((n) => n.on)
            .map((n) => n.note);
    };
    assert.deepEqual(await midi("transcribe-download-raw"), [60, 60, 72]);
    assert.deepEqual(await midi("transcribe-download-original"), [62, 60, 72]);
    assert.ok(
        (await midi("transcribe-download")).some((pitch) => pitch % 12 === 2),
        "arrangement did not consume the edited melody",
    );
    console.log(
        "PASS: edits update arrangement and MIDI without overwriting recognizer notes",
    );
    await fields({ splitAt: "0.4" });
    await click("split");
    await saved();
    assert.equal((await capture()).editedNotes.length, 4);
    await click("merge");
    await saved();
    assert.equal((await capture()).editedNotes.length, 3);
    await click("undo");
    await saved();
    assert.equal((await capture()).editedNotes.length, 4);
    await click("undo");
    await saved();
    assert.equal((await capture()).editedNotes.length, 3);
    await fields({ pitch: "65", start: "2", duration: "0.25" });
    await click("add");
    await saved();
    assert.equal((await capture()).editedNotes.length, 4);
    await browser.evaluate(
        `document.querySelector('#transcribe-editor .melody-editor-list button[data-index="3"]').click()`,
    );
    await click("delete");
    await saved();
    assert.equal((await capture()).editedNotes.length, 3);
    await fields({ start: "-1" });
    await click("apply");
    await browser.until(`!document.getElementById("transcribe-error").hidden`);
    assert.equal((await capture()).editedNotes.length, 3);
    await click("export");
    const exported = await browser.evaluate(
        `(async () => JSON.parse(await window.__blobs.filter(b=>b.type==="application/json").at(-1).text()))()`,
    );
    assert.equal(exported.referenceStatus, "unverified-draft");
    assert.equal(exported.recognizerNotes[0].note, 60);
    assert.equal(exported.workingNotes[0].note, 62);
    await browser.send("Page.reload");
    await browser.until(
        `document.getElementById("transcribe-storage-status")?.dataset.i18n === "transcribe.storage.restored"`,
    );
    result = await capture();
    assert.equal(result.editedNotes[0].note, 62);
    assert.equal(result.notes[0].note, 60);
    assert.equal(await browser.evaluate(`window.__workers`), 0);
    await browser.evaluate(
        `(() => {
            window.confirm = () => false;
            for (const id of ["run", "trial", "whole"])
                document.getElementById("transcribe-" + id).click();
        })()`,
    );
    assert.equal(await browser.evaluate(`window.__workers`), 0);
    assert.equal(
        await browser.evaluate(
            `document.getElementById("transcribe-length").value`,
        ),
        "3",
    );
    await browser.evaluate(`(() => {
        const start=document.getElementById("transcribe-start");
        start.value="1"; start.dispatchEvent(new Event("input"));
    })()`);
    assert.equal(
        await browser.evaluate(
            `document.getElementById("transcribe-start").value`,
        ),
        "0.5",
    );
    assert.equal((await capture()).editedNotes[0].note, 62);
    await browser.evaluate(`window.confirm = () => true`);
    await click("reset");
    await saved();
    assert.equal((await capture()).editedNotes, undefined);
    await click("undo");
    await saved();
    assert.equal((await capture()).editedNotes[0].note, 62);
    console.log(
        "PASS: split/merge/add/delete, bounded undo, raw reset and persisted edits work without reinference",
    );
    const checkLayout = async (width) => {
        await browser.send("Emulation.setDeviceMetricsOverride", {
            width,
            height: 844,
            deviceScaleFactor: 1,
            mobile: width < 700,
        });
        assert.ok(
            await browser.evaluate(`(() => {
            const editor = document.getElementById("transcribe-editor");
            const rect = (selector) => editor.querySelector(selector).getBoundingClientRect();
            const clipEnd = rect('[data-field="to"]');
            const source = rect('[data-action="source"]');
            const stop = rect('[data-action="stop"]');
            const previous = rect('[data-action="previous"]');
            const loop = rect('[data-field="loop"]');
            const split = rect('[data-field="splitAt"]');
            const apply = rect('[data-action="apply"]');
            return document.documentElement.scrollWidth <= innerWidth &&
                source.top - clipEnd.bottom >= 8 && previous.top - stop.bottom >= 8 &&
                apply.top - split.bottom >= 8 && loop.width <= 20 &&
                [...document.querySelectorAll(".transcribe-engine-guide dd")].every(node =>
                    node.textContent.trim() && node.scrollWidth <= node.clientWidth);
        })()`),
            `Transcription and editor controls should fit with consistent gaps at ${width}px`,
        );
    };
    await checkLayout(390);
    await browser.evaluate(`(() => {
        const locale = document.getElementById("locale");
        locale.value = "en";
        locale.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await browser.until(`document.documentElement.lang === "en" &&
        document.getElementById("transcribe-storage-status").dataset.i18n === "transcribe.storage.restored"`);
    await checkLayout(320);
    await checkLayout(1440);
    await browser.evaluate(`(() => {
        window.confirm = () => true;
        document.getElementById("transcribe-trial").click();
    })()`);
    await browser.until(
        `window.__workers === 1 && !document.getElementById("transcribe-run").disabled`,
    );
    await saved();
    assert.equal((await capture()).clipMs, 3500);

    const longPath = resolve(".test-artifacts/editor-trial-source.wav");
    await writeFile(longPath, testWav(34));
    await setFile(longPath);
    await browser.until(`document.getElementById("transcribe-length").value === "34" &&
        !document.getElementById("transcribe-run").disabled`);
    await browser.evaluate(`(() => {
        const start = document.getElementById("transcribe-start");
        start.value = "4";
        start.dispatchEvent(new Event("input"));
        document.getElementById("transcribe-trial").click();
    })()`);
    await browser.until(
        `window.__workers === 2 && !document.getElementById("transcribe-run").disabled`,
    );
    await saved();
    result = await capture();
    assert.equal(result.clipMs, 25000);
    assert.equal(result.clipStartMs, 4000);
    await browser.evaluate(
        `document.getElementById("transcribe-whole").click()`,
    );
    await browser.until(
        `window.__workers === 3 && !document.getElementById("transcribe-run").disabled`,
    );
    await saved();
    result = await capture();
    assert.equal(result.clipMs, 34000);
    assert.equal(result.clipStartMs, 0);
    console.log(
        "PASS: 25-second trial is capped at the source end, honors the clip start, and can expand to the whole track",
    );
    assert.deepEqual(browser.errors, []);
    console.log(
        "PASS: Chinese and English guides and editor controls fit 320–1440 px without runtime exceptions",
    );
} finally {
    if (browser) await browser.close();
    await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
    });
}
