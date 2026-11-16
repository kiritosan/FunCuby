import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "../../server.js";
import { parseMidiFile } from "../../src/core/midi/midi-file.js";
import { openTestBrowser } from "./browser.mjs";

const PORT = 18579,
    base = `http://127.0.0.1:${PORT}`;
const wav = Buffer.alloc(44 + 44100 * 4 * 2);
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
for (let i = 0; i < 44100 * 4; i++)
    wav.writeInt16LE(
        Math.round(Math.sin((i * 2 * Math.PI * 440) / 44100) * 6000),
        44 + i * 2,
    );
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
    await writeFile(path, wav);
    browser = await openTestBrowser("edge-profile-melody-editor");
    await browser.send("Storage.clearDataForOrigin", {
        origin: base,
        storageTypes: "indexeddb",
    });
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
        source: instrument,
    });
    await browser.send("Page.navigate", { url: `${base}/#transcribe` });
    await browser.until(
        `document.getElementById("transcribe-storage-status")?.dataset.i18n === "transcribe.storage.empty"`,
    );
    const { root } = await browser.send("DOM.getDocument");
    const { nodeId } = await browser.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: "#transcribe-file",
    });
    await browser.send("DOM.setFileInputFiles", { nodeId, files: [path] });
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
        `window.confirm = () => false; document.getElementById("transcribe-run").click()`,
    );
    assert.equal(await browser.evaluate(`window.__workers`), 0);
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
    await browser.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
    });
    assert.equal(
        await browser.evaluate(
            `document.documentElement.scrollWidth > innerWidth`,
        ),
        false,
    );
    assert.deepEqual(browser.errors, []);
    console.log(
        "PASS: editor fits mobile and has no browser runtime exceptions",
    );
} finally {
    if (browser) await browser.close();
    await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
    });
}
