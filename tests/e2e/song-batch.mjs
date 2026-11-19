import assert from "node:assert/strict";
import { once } from "node:events";
import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "../../server.js";
import {
    arrangeTranscription,
    transcriptionMidi,
} from "../../src/core/arrangement.js";
import { openTestBrowser } from "./browser.mjs";

const fixture = process.argv[2];
if (!fixture)
    throw new Error("Pass a short local vocal recording as the first argument");
await mkdir(".test-artifacts", { recursive: true });
const dir = await mkdtemp(resolve(".test-artifacts", "batch-"));
const library = join(dir, "library");
const files = [
    join(dir, "verse-a.flac"),
    join(dir, "verse-b.flac"),
    join(dir, "invalid.wav"),
];
await Promise.all([
    copyFile(fixture, files[0]),
    copyFile(process.argv[3] ?? fixture, files[1]),
    writeFile(files[2], "invalid"),
]);
const port = 18583,
    base = "http://127.0.0.1:" + port;
const server = createServer({ port, libraryDirectory: library });
server.listen(port, "127.0.0.1");
await once(server, "listening");
let browser;
try {
    browser = await openTestBrowser("edge-profile-disk-batch");
    await browser.send("Page.navigate", { url: base + "/#transcribe" });
    const mode = 'document.getElementById("transcribe-batch-mode")';
    await browser.until(
        mode +
            "?.querySelector('option[value=\"game-separated\"]:not(:disabled)')",
    );
    await browser.evaluate(
        `document.getElementById("transcribe-batch").open=true; ${mode}.value="game-separated"; ${mode}.dispatchEvent(new Event("change"))`,
    );
    const { root } = await browser.send("DOM.getDocument");
    const { nodeId } = await browser.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: "#transcribe-file",
    });
    await browser.send("DOM.setFileInputFiles", { nodeId, files });
    await browser.until(
        '!document.getElementById("transcribe-batch-discard").hidden',
    );
    assert.equal(
        await browser.evaluate(
            'document.querySelectorAll("#transcribe-batch-list li").length',
        ),
        0,
    );
    await browser.evaluate(
        'document.getElementById("transcribe-batch-add").click()',
    );
    await browser.until(
        'document.querySelectorAll("#transcribe-batch-list [data-state=running]").length===2',
    );
    await browser.until(
        'document.querySelectorAll("#transcribe-batch-list [data-state=done],#transcribe-batch-list [data-state=failed]").length===3',
        240000,
    );
    const results = await browser.evaluate(
        'Array.from(document.querySelectorAll("#transcribe-batch-list li"),row=>[row.dataset.state,row.textContent])',
    );
    assert.deepEqual(
        results.map((row) => row[0]),
        ["done", "done", "failed"],
        JSON.stringify(results),
    );
    const { songs } = await (await fetch(base + "/api/library")).json();
    const complete = songs.filter((s) => s.name.startsWith("verse"));
    assert.equal(complete.length, 2);
    for (const song of complete) {
        const folder = join(library, song.id);
        const source = await readFile(join(folder, song.audio));
        assert.deepEqual(source, await readFile(join(dir, song.name)));
        const wav = (await readdir(folder)).find((name) =>
            name.startsWith("vocals-"),
        );
        assert.equal(
            (await readFile(join(folder, wav))).toString("ascii", 0, 4),
            "RIFF",
        );
        const snapshot = join(folder, song.revision);
        const draft = JSON.parse(await readFile(join(snapshot, "draft.json")));
        const [engine, capture] = draft.captures[0];
        assert.match(engine, /^game-separated:/);
        assert.ok(capture.notes.length > 0);
        const midi = join(
            snapshot,
            "0-" + Math.round(capture.clipMs) + "ms",
            engine.replace(":", "-"),
        );
        for (const name of ["recognition", "melody", "fuller", "original"])
            assert.equal(
                (await readFile(join(midi, name + ".mid"))).toString(
                    "ascii",
                    0,
                    4,
                ),
                "MThd",
            );
    }
    await browser.send("Storage.clearDataForOrigin", {
        origin: base,
        storageTypes: "all",
    });
    await browser.send("Page.reload", { ignoreCache: true });
    await browser.until(
        'document.querySelectorAll("#transcribe-library option").length===3',
    );
    const id = complete[0].id;
    await browser.evaluate(
        `const sel=document.getElementById("transcribe-library");sel.value=${JSON.stringify(id)};sel.dispatchEvent(new Event("change"))`,
    );
    await browser.until(
        '!document.getElementById("transcribe-results").hidden && !!document.getElementById("transcribe-vocals-audio").src',
    );
    await browser.until(
        'document.querySelector("#transcribe-editor [data-action=vocals]")?.disabled === false',
    );
    await browser.evaluate(`document.querySelector('.transcribe-level[data-level="fuller"]').click();
        const choice=document.querySelector("#transcribe-harmony"); choice.value="auto"; choice.dispatchEvent(new Event("change"));`);
    await browser.until(
        'document.querySelector("#transcribe-storage-status").dataset.i18n === "transcribe.storage.saved"',
    );
    const saved = await (await fetch(base + "/api/library/" + id)).json();
    assert.equal(saved.state.settings["transcribe-harmony"], "auto");
    const [engine, capture] = saved.state.captures[0];
    const fields = saved.state.settings;
    const expected = arrangeTranscription(
        capture.editedNotes ?? capture.notes,
        {
            level: "fuller",
            autoHarmony: true,
            bpm: Number(fields["transcribe-bpm"]),
            originMs: Number(fields["transcribe-origin"]),
            firstNote: saved.state.firstNote,
            transpose: Number(fields["transcribe-transpose"]),
        },
    );
    const path = join(
        library,
        id,
        saved.meta.revision,
        "0-" + Math.round(capture.clipMs) + "ms",
        engine.replace(":", "-"),
    );
    assert.deepEqual(
        await readFile(join(path, "fuller.mid")),
        Buffer.from(
            transcriptionMidi(expected.notes, {
                name: saved.meta.name,
                bpm: expected.bpm,
            }),
        ),
    );
    assert.ok(!(await readdir(path)).includes("starter.mid"));
    await browser.send("Page.reload", { ignoreCache: true });
    await browser.until(
        'document.querySelector("#transcribe-harmony").value==="auto" && !document.querySelector("#transcribe-harmony-field").hidden && document.querySelector("#transcribe-editor [data-action=vocals]")?.disabled === false',
    );
    await browser.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
    });
    assert.ok(
        await browser.evaluate(
            "document.documentElement.scrollWidth <= innerWidth",
        ),
    );
    await browser.until(
        'document.querySelector("[data-tab=transcribe]").classList.contains("selected") && !document.querySelector("#panel-transcribe").hidden',
    );
    await browser.send("Page.bringToFront");
    await browser.evaluate("window.scrollTo(0,0)");
    const shot = await browser.send("Page.captureScreenshot", {
        format: "png",
    });
    await writeFile(
        resolve(".test-artifacts/disk-batch-mobile.png"),
        Buffer.from(shot.data, "base64"),
    );
    assert.deepEqual(browser.errors, []);
    console.log(
        "PASS: two simultaneous UVR + GAME songs, independent failure, source/WAV/MIDI on disk, restore after clearing site data, mobile layout",
    );
} catch (error) {
    if (browser)
        console.error(
            await browser
                .evaluate(
                    'Array.from(document.querySelectorAll("#transcribe-batch-list li"),row=>[row.dataset.state,row.textContent])',
                )
                .catch(() => []),
        );
    throw error;
} finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
}
