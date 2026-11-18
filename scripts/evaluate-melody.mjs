import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { createServer } from "../server.js";
import {
    GAME_LANGUAGES,
    TRANSCRIPTION_ENGINES,
} from "../src/core/transcription/config.js";
import {
    applyVocalBoundary,
    validateMelody,
} from "../src/core/transcription/melody-edit.js";
import { analyzeMelody } from "../src/core/transcription/musical-analysis.js";
import { openTestBrowser } from "../tests/e2e/browser.mjs";
import {
    evaluateNotes,
    evaluateAutoStarter,
    evaluateStarter,
    ONSET_TOLERANCE_MS,
} from "./melody-metrics.mjs";

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { engine: { type: "string" }, case: { type: "string" } },
});
const engines = values.engine
    ? [values.engine]
    : Object.keys(TRANSCRIPTION_ENGINES);
if (
    positionals.length !== 1 ||
    engines.some((engine) => !Object.hasOwn(TRANSCRIPTION_ENGINES, engine))
)
    throw new Error(
        "Usage: npm run evaluate:melody -- MANIFEST.json [--engine MODE] [--case ID]",
    );
const manifestPath = resolve(positionals[0]);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (
    manifest.schema !== "funcuby.melody-benchmark" ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.cases)
)
    throw new Error("Invalid melody benchmark manifest");
const cases = manifest.cases.filter(
    (item) => !values.case || values.case === item.id,
);
if (!cases.length) throw new Error("No matching benchmark cases");
for (const item of cases) {
    if (
        typeof item.id !== "string" ||
        typeof item.audio !== "string" ||
        !Number.isFinite(item.durationMs) ||
        item.durationMs <= 0 ||
        item.durationMs > 30000 ||
        !GAME_LANGUAGES.includes(item.language) ||
        !Array.isArray(item.references) ||
        !item.references.length
    )
        throw new Error(
            "Expected a named, annotated audio clip up to 30 seconds",
        );
    item.path = resolve(dirname(manifestPath), item.audio);
    const sha256 = createHash("sha256")
        .update(await readFile(item.path))
        .digest("hex");
    if (sha256 !== item.sha256)
        throw new Error(`Audio checksum mismatch: ${item.id}`);
    for (const reference of item.references) {
        if (!reference.label || !reference.provenance)
            throw new Error(
                `Reference label and provenance are required: ${item.id}`,
            );
        validateMelody(reference.notes, item.durationMs);
    }
}

const artifacts = resolve(".test-artifacts");
await mkdir(artifacts, { recursive: true });
const output = await mkdtemp(join(artifacts, "melody-report-"));
const reportPath = join(output, "report.json");
const report = {
    schema: "funcuby.melody-benchmark-report",
    version: 1,
    manifest: manifestPath,
    onsetToleranceMs: ONSET_TOLERANCE_MS,
    longNote:
        "Matched duration exceeds reference by more than max(150 ms, half reference duration)",
    createdAt: new Date().toISOString(),
    node: process.version,
    cases: [],
};
const server = createServer({ port: 0 });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
    browser = await openTestBrowser("edge-profile-melody-benchmark");
    report.browser = (await browser.send("Browser.getVersion")).product;
    if (engines.some((engine) => engine !== "basic-pitch")) {
        report.game = await (
            await fetch(base + "/api/transcription/game/status")
        ).json();
        if (
            !report.game.available ||
            (engines.includes("game-separated") &&
                !report.game.separationAvailable)
        )
            throw new Error(
                "Install the requested local GAME/UVR models, or select --engine basic-pitch",
            );
    }
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
            window.Worker = class extends window.Worker {
                constructor(...args) {
                    super(...args);
                    this.addEventListener("message", ({data}) => {
                        const run = window.__melodyBenchmark;
                        if (!run) return;
                        if (data.backend) run.backend = data.backend;
                        if (data.type === "result" || data.type === "error") {
                            run.terminal = data;
                            run.elapsedMs = performance.now() - run.start;
                        }
                    });
                }
            };
        `,
    });
    await browser.send("Page.navigate", { url: `${base}/#transcribe` });
    await browser.until(`
        document.querySelectorAll("#transcribe-levels .transcribe-level").length === 4 &&
        document.getElementById("transcribe-engine-status").dataset.i18n !== "transcribe.engineChecking" &&
        document.getElementById("transcribe-storage-status").dataset.i18n === "transcribe.storage.empty"
    `);
    const { root } = await browser.send("DOM.getDocument");
    const { nodeId } = await browser.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: "#transcribe-file",
    });
    const rows = [];
    for (const item of cases) {
        // One reference-derived grid and key mapping makes the starter
        // comparison consistent even when candidate tempo estimates differ.
        const fit = analyzeMelody(item.references[0].notes, {
            clipMs: item.durationMs,
            firstNote: 60,
        });
        const settings = {
            firstNote: 60,
            bpm: fit.confidence >= 0.2 ? fit.bpm : 120,
            originMs: fit.confidence >= 0.2 ? fit.originMs : 0,
            transpose: fit.whiteKeyTranspose,
        };
        const entry = {
            ...item,
            starterSettings: settings,
            candidates: {},
        };
        delete entry.path;
        report.cases.push(entry);
        const previousSource = await browser.evaluate(`(() => {
            document.getElementById("transcribe-file").value = "";
            return document.getElementById("transcribe-source").src;
        })()`);
        await browser.send("DOM.setFileInputFiles", {
            nodeId,
            files: [item.path],
        });
        await browser.until(`
            document.getElementById("transcribe-source-name").textContent === ${JSON.stringify(basename(item.path))} &&
            document.getElementById("transcribe-source").src !== ${JSON.stringify(previousSource)} &&
            !document.getElementById("transcribe-clip").hidden
        `);
        const decodedMs = await browser.evaluate(
            'Number(document.getElementById("transcribe-start").max) * 1000',
        );
        if (Math.abs(decodedMs - item.durationMs) > 1)
            throw new Error(
                `Decoded duration does not match manifest: ${item.id}`,
            );
        for (const engine of engines) {
            await browser.evaluate(`(() => {
                const language = document.getElementById("transcribe-language");
                language.value = ${JSON.stringify(item.language)};
                const picker = document.getElementById("transcribe-engine");
                picker.value = ${JSON.stringify(engine)};
                picker.dispatchEvent(new Event("change"));
            })()`);
            await browser.until(
                `!document.getElementById("transcribe-run").disabled`,
            );
            await browser.evaluate(`(() => {
                window.__melodyBenchmark = { start: performance.now(), terminal: null, backend: null };
                document.getElementById("transcribe-run").click();
            })()`);
            await browser.until(
                `window.__melodyBenchmark.terminal !== null ||
                (!document.getElementById("transcribe-run").disabled &&
                 !document.getElementById("transcribe-error").hidden)`,
                120000,
            );
            const { terminal, elapsedMs, backend } = await browser.evaluate(
                "window.__melodyBenchmark",
            );
            if (terminal?.type !== "result")
                throw new Error(
                    `${item.id}/${engine}: ${
                        terminal?.error?.message ??
                        (await browser.evaluate(
                            'document.getElementById("transcribe-error").textContent',
                        ))
                    }`,
                );
            const notes = terminal.notes;
            let autoSettings = null;
            if (notes.length) {
                await browser.until(
                    `!document.getElementById("transcribe-results").hidden && !document.getElementById("transcribe-run").disabled`,
                );
                autoSettings = await browser.evaluate(`(() => {
                    document.getElementById("transcribe-auto-fit").click();
                    const value = id => Number(document.getElementById("transcribe-" + id).value);
                    return { firstNote: 60, bpm: value("bpm"), originMs: value("origin"), transpose: value("transpose") };
                })()`);
            }
            const proposed = notes.flatMap(applyVocalBoundary);
            const references = item.references.map((reference) => ({
                label: reference.label,
                recognition: evaluateNotes(reference.notes, notes),
                withBoundarySuggestions: evaluateNotes(
                    reference.notes,
                    proposed,
                ),
                starter: evaluateStarter(reference.notes, notes, settings),
                automaticStarter:
                    autoSettings &&
                    evaluateAutoStarter(
                        reference.notes,
                        notes,
                        settings,
                        autoSettings,
                    ),
            }));
            entry.candidates[engine] = {
                backend,
                elapsedMs: Math.round(elapsedMs),
                notes,
                references,
            };
            for (const { label, recognition, starter } of references)
                rows.push({
                    clip: item.id,
                    engine,
                    ref: label,
                    f1: recognition.f1,
                    missed: recognition.missed,
                    long: recognition.longNotes,
                    octaves: recognition.octaveErrors,
                    starterF1: starter.notes.f1,
                    mainKeySolo: starter.playability.mainKeySolo,
                });
            console.log(
                `Scored ${item.id} · ${engine} · ${notes.length} notes`,
            );
        }
    }
    console.table(rows);
    report.complete = true;
} finally {
    if (browser) {
        await browser
            .send("Storage.clearDataForOrigin", {
                origin: base,
                storageTypes: "indexeddb,local_storage",
            })
            .catch(() => {});
        await browser.close();
    }
    await new Promise((done) => {
        server.close(done);
        server.closeAllConnections();
    });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.log(reportPath);
}
