import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { parseMidiFile } from "../../src/core/midi/midi-file.js";
import { twoNotes } from "../unit/fixtures.js";

// A short piano-like clip (C5 E5 G5 arpeggio, harmonic stacks with decay) for
// the real local Basic Pitch inference path in the Transcribe tab.
function synthWav() {
    const rate = 44100,
        seconds = 9.5,
        notes = [
            [72, 0.0, 1.2],
            [76, 1.4, 1.2],
            [79, 2.8, 1.6],
            [72, 4.6, 1.2],
            [76, 6.0, 1.2],
            [79, 7.4, 2.0],
        ];
    const total = Math.floor(rate * seconds),
        data = new Float32Array(total);
    for (const [pitch, start, length] of notes) {
        const f0 = 440 * 2 ** ((pitch - 69) / 12),
            i0 = Math.floor(start * rate),
            i1 = Math.min(total, Math.floor((start + length) * rate));
        for (let i = i0; i < i1; i++) {
            const t = (i - i0) / rate,
                env = Math.min(1, t / 0.008) * Math.exp(-t / 1.2);
            let sample = 0;
            for (const [harmonic, gain] of [
                [1, 1],
                [2, 0.4],
                [3, 0.2],
                [4, 0.1],
            ])
                sample +=
                    gain *
                    Math.sin(2 * Math.PI * f0 * harmonic * t + harmonic * 0.3);
            data[i] += sample * env * 0.22;
        }
    }
    return wavBuffer(data, rate);
}

// 16-bit mono PCM WAV wrapper shared by the synthetic clips.
function wavBuffer(data, rate) {
    const total = data.length,
        buffer = new ArrayBuffer(44 + total * 2),
        view = new DataView(buffer);
    const tag = (offset, text) => {
        for (let i = 0; i < text.length; i++)
            view.setUint8(offset + i, text.charCodeAt(i));
    };
    tag(0, "RIFF");
    view.setUint32(4, 36 + total * 2, true);
    tag(8, "WAVE");
    tag(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    tag(36, "data");
    view.setUint32(40, total * 2, true);
    for (let i = 0; i < total; i++)
        view.setInt16(
            44 + i * 2,
            Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767))),
            true,
        );
    return Buffer.from(buffer);
}

// 219 s of sparse decaying tones at the model's native rate — long enough to
// prove the raised clip limit reaches the worker, cancelled before inference.
function longWav(seconds = 219) {
    const rate = 22050,
        total = Math.floor(rate * seconds),
        data = new Float32Array(total);
    for (let start = 0; start + rate <= total; start += rate * 20) {
        const end = Math.min(total, start + rate);
        for (let i = start; i < end; i++) {
            const t = (i - start) / rate;
            data[i] +=
                Math.sin(2 * Math.PI * 261.63 * t) * Math.exp(-t / 0.3) * 0.2;
        }
    }
    return wavBuffer(data, rate);
}

// Headless Chromium smoke test: page boots, keyboards render and mapping stays in sync.
const BROWSER =
    process.env.BROWSER ||
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const server = spawn(process.execPath, ["server.js"], {
    env: {
        ...process.env,
        PORT: "18573",
        FUNCUBY_LIBRARY_DIR: resolve(
            ".test-artifacts",
            "library-smoke-" + crypto.randomUUID(),
        ),
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
});
let browser, socket;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch("http://127.0.0.1:18573")).ok) break;
        } catch {
            /* Server not listening yet. */
        }
        await wait(100);
    }
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
            `--user-data-dir=${resolve(".test-artifacts/edge-profile")}`,
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
    const pending = new Map(),
        errors = [];
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
            }, 90000);
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
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 1080,
        deviceScaleFactor: 1,
        mobile: false,
    });
    await send("Storage.clearDataForOrigin", {
        origin: "http://127.0.0.1:18573",
        storageTypes: "indexeddb",
    });
    await send("Page.navigate", { url: "http://127.0.0.1:18573" });
    for (let i = 0; i < 60; i++) {
        if (
            await evaluate(
                'document.querySelectorAll("#teach-keyboard .note").length === 15',
            )
        )
            break;
        await wait(100);
    }
    const inspect = () =>
        evaluate(`(() => {
    const labels = id => [...document.querySelectorAll('#' + id + ' .note')].map(n => n.textContent);
    return { device: labels('keyboard'), teaching: labels('teach-keyboard'), keys: ['keyboard', 'teach-keyboard'].map(id => document.querySelectorAll('#' + id + ' .sharp-key').length), sharpLabels: document.querySelectorAll('.sharp-key .note, .sharp-key[title]').length, banners: document.querySelectorAll('.eyebrow').length, wakeUI: document.querySelectorAll('.wake-lock-controls, #wake-lock-status, #wake-lock-retry').length, notice: document.getElementById('notice').textContent };
  })()`);
    const state = await inspect();
    assert.equal(state.device.length, 15);
    assert.deepEqual(state.device, state.teaching);
    assert.deepEqual(state.keys, [10, 10]);
    assert.equal(state.sharpLabels, 0);
    assert.equal(state.banners, 0);
    assert.equal(state.wakeUI, 0);
    assert.equal(state.device[0], "C4");
    assert.equal(state.device.at(-1), "C6");
    assert(!state.notice.includes("初始化失败"));
    console.log(
        "PASS: initial keyboard labels, 15 main keys, 10 unlabelled small keys, no banners or wake-lock UI",
    );
    const firstKeyAfter = async (script) => {
        await evaluate(script);
        await wait(50);
        const { device, teaching } = await inspect();
        assert.deepEqual(device, teaching);
        return device[0];
    };
    for (const [offset, first] of [
        [1, "C♯4"],
        [-12, "C3"],
        [12, "C5"],
    ]) {
        assert.equal(
            await firstKeyAfter(
                `document.getElementById('offset').value = ${offset}; document.getElementById('apply-offset').click()`,
            ),
            first,
        );
    }
    assert.equal(
        await firstKeyAfter(
            `document.getElementById('teach-first-note').value = 62; document.getElementById('teach-apply-map').click()`,
        ),
        "D4",
    );
    assert.equal(
        await firstKeyAfter(`document.getElementById('reset-offset').click()`),
        "C4",
    );
    console.log(
        "PASS: device/teaching mapping changes synchronize in both directions and reset",
    );
    await mkdir(".test-artifacts", { recursive: true });
    await writeFile(
        ".test-artifacts/device.png",
        Buffer.from(
            (await send("Page.captureScreenshot", { format: "png" })).data,
            "base64",
        ),
    );
    await evaluate(`location.hash = 'teach'`);
    await wait(150);
    assert.equal(
        await evaluate(`document.getElementById('panel-teach').hidden`),
        false,
    );
    await writeFile(
        ".test-artifacts/teaching.png",
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
    const midiPath = resolve(".test-artifacts/two-notes.mid");
    await writeFile(midiPath, twoNotes());
    const { root } = await send("DOM.getDocument");
    for (const id of ["midi-file", "teach-file"]) {
        const { nodeId } = await send("DOM.querySelector", {
            nodeId: root.nodeId,
            selector: `#${id}`,
        });
        await send("DOM.setFileInputFiles", { nodeId, files: [midiPath] });
    }
    const loadedExpression = `document.querySelectorAll('#midi-tracks tr').length > 0 && document.querySelectorAll('.score-beat').length > 0`;
    for (let i = 0; i < 40 && !(await evaluate(loadedExpression)); i++)
        await wait(50);
    const loaded = await evaluate(`({
        track: [...document.querySelector('#midi-tracks tr').cells].map(cell => cell.querySelector('select, input:not([type=checkbox])')?.value ?? cell.textContent),
        tempo: document.getElementById('tempo-info').textContent,
        beats: document.querySelectorAll('.score-beat').length,
        digits: [...document.querySelectorAll('.score-digit')].map(node => node.textContent),
        teachTracks: document.querySelectorAll('#teach-tracks input:checked').length,
    })`);
    assert.deepEqual(loaded.track, [
        "",
        "1. Lead",
        "2",
        "16",
        "5",
        "timestamp",
        "press-only",
        "0",
        "101",
    ]);
    assert.equal(loaded.tempo, "原曲 120 BPM · 最短音 500 ms");
    assert.equal(loaded.beats, 3);
    assert.deepEqual(loaded.digits, ["1", "2"]);
    assert.equal(loaded.teachTracks, 1);
    console.log(
        "PASS: MIDI upload renders the play track table and the numbered score",
    );

    // ---- Transcribe tab: real local inference, arrangements, practice handoff ----
    await evaluate(`location.hash = 'transcribe'`);
    await wait(150);
    assert.equal(
        await evaluate(`document.getElementById('panel-transcribe').hidden`),
        false,
    );
    assert.equal(
        await evaluate(
            `document.querySelectorAll('#transcribe-levels .transcribe-level').length`,
        ),
        4,
    );
    assert.deepEqual(
        await evaluate(`[...document.querySelectorAll('.transcribe-engine-guide dd')]
            .map((node) => Boolean(node.textContent.trim()))`),
        [true, true, true],
    );
    await evaluate(`(() => {
        const engine = document.getElementById("transcribe-engine");
        engine.value = "basic-pitch";
        engine.dispatchEvent(new Event("change"));
        window.__workerCount = 0;
        window.__workerPosts = [];
        window.__workerMessages = [];
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
            constructor(...args) {
                window.__workerCount++;
                super(...args);
                // Passive observer only: the app's own onmessage still runs.
                this.addEventListener("message", (event) => {
                    const d = event.data || {};
                    window.__workerMessages.push({
                        type: d.type,
                        stage: d.stage,
                        progress: d.progress,
                        completedWindows: d.completedWindows,
                        totalWindows: d.totalWindows,
                        backend: d.backend,
                        tensorCount: d.tensorCount,
                        error: d.error ? d.error.code : undefined,
                        notes: d.notes ? d.notes.length : undefined,
                    });
                });
            }
            postMessage(message, transfer) {
                if (message && message.samples)
                    window.__workerPosts.push(message.samples.length);
                return super.postMessage(message, transfer);
            }
        };
        window.__blobs = [];
        const original = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => {
            window.__blobs.push(blob);
            return original(blob);
        };
    })()`);
    const setFile = async (id, path) => {
        const { nodeId } = await send("DOM.querySelector", {
            nodeId: root.nodeId,
            selector: `#${id}`,
        });
        await send("DOM.setFileInputFiles", { nodeId, files: [path] });
    };
    const badPath = resolve(".test-artifacts/bad.wav");
    await writeFile(badPath, Buffer.from("this is not a wav file"));
    const wavPath = resolve(".test-artifacts/clip.wav");
    await writeFile(wavPath, synthWav());
    await setFile("transcribe-file", badPath);
    for (
        let i = 0;
        i < 60 &&
        (await evaluate(`document.getElementById('transcribe-error').hidden`));
        i++
    )
        await wait(100);
    assert.ok(
        (await evaluate(
            `document.getElementById('transcribe-error').textContent.length`,
        )) > 0,
    );
    assert.equal(
        await evaluate(`document.getElementById('transcribe-clip').hidden`),
        true,
    );
    console.log(
        "PASS: invalid audio shows a decode error and stays recoverable",
    );
    await setFile("transcribe-file", wavPath);
    for (
        let i = 0;
        i < 100 &&
        (await evaluate(`document.getElementById('transcribe-clip').hidden`));
        i++
    )
        await wait(100);
    assert.equal(
        await evaluate(`document.getElementById('transcribe-clip').hidden`),
        false,
    );
    assert.ok(
        await evaluate(
            `document.getElementById('transcribe-source-name').textContent.includes('clip.wav')`,
        ),
    );
    // Start transcription, wait until the worker actually exists, then cancel
    // for real (worker termination), and run again to completion.
    await evaluate(`document.getElementById('transcribe-run').click()`);
    for (
        let i = 0;
        i < 600 && (await evaluate(`window.__workerCount`)) < 1;
        i++
    )
        await wait(50);
    assert.equal(
        (await evaluate(`window.__workerCount`)) >= 1,
        true,
        "transcription worker was never created",
    );
    await evaluate(`document.getElementById('transcribe-cancel').click()`);
    await wait(150);
    assert.match(
        await evaluate(
            `document.getElementById('transcribe-status').textContent`,
        ),
        /Cancel|取消/,
    );
    assert.equal(
        await evaluate(`document.getElementById('transcribe-run').disabled`),
        false,
    );
    console.log(
        "PASS: live transcription worker is terminated by cancel and recovers",
    );
    await evaluate(`document.getElementById('transcribe-run').click()`);
    for (
        let i = 0;
        i < 1200 &&
        (await evaluate(
            `document.getElementById('transcribe-results').hidden`,
        ));
        i++
    )
        await wait(100);
    if (
        await evaluate(`document.getElementById('transcribe-results').hidden`)
    ) {
        console.log(
            "DEBUG transcribe state:",
            await evaluate(`JSON.stringify({
                error: document.getElementById('transcribe-error').textContent,
                status: document.getElementById('transcribe-status').textContent,
                workers: window.__workerCount,
            })`),
        );
    }
    assert.equal(
        await evaluate(`document.getElementById('transcribe-results').hidden`),
        false,
        "transcription results did not arrive",
    );
    assert.equal(
        await evaluate(`window.__workerCount`),
        2,
        "expected exactly one cancelled + one completed worker",
    );
    const workerBaseline = await evaluate(`window.__workerCount`);
    assert.ok(
        (await evaluate(
            `document.querySelectorAll('#transcribe-preview .transcribe-note').length`,
        )) > 0,
    );
    assert.ok(
        (await evaluate(
            `document.getElementById('transcribe-stats').textContent.length`,
        )) > 10,
    );
    console.log(
        "PASS: real local model inference produced arranged, previewed notes",
    );
    // Card and setting edits only re-arrange the captured notes — never re-run the model.
    const previewBefore = await evaluate(
        `[...document.querySelectorAll('#transcribe-preview .transcribe-note')].map(n => n.title).join('|')`,
    );
    for (const level of ["melody", "fuller", "original", "starter"])
        await evaluate(
            `document.querySelector('.transcribe-level[data-level="${level}"]').click()`,
        );
    await evaluate(`(() => {
        const bpm = document.getElementById('transcribe-bpm');
        bpm.value = '100';
        bpm.dispatchEvent(new Event('change'));
    })()`);
    await wait(100);
    assert.equal(await evaluate(`window.__workerCount`), workerBaseline);
    const previewAfter = await evaluate(
        `[...document.querySelectorAll('#transcribe-preview .transcribe-note')].map(n => n.title).join('|')`,
    );
    assert.notEqual(previewBefore, previewAfter);
    console.log(
        "PASS: arrangement cards and BPM re-render from the capture without inference",
    );
    // Real local piano samples, no Bluetooth or network sample CDN.
    await evaluate(
        `document.querySelector('.transcribe-level[data-level="starter"]').click()`,
    );
    await evaluate(`document.getElementById('transcribe-audition').click()`);
    for (let i = 0; i < 60; i++) {
        if (
            (await evaluate(
                `document.getElementById('transcribe-audition').textContent`,
            )) === "停止"
        )
            break;
        await wait(100);
    }
    assert.equal(
        await evaluate(
            `document.getElementById('transcribe-audition').textContent`,
        ),
        "停止",
    );
    await evaluate(`document.getElementById('transcribe-audition').click()`);
    await wait(100);
    assert.equal(
        await evaluate(
            `document.getElementById('transcribe-audition').textContent`,
        ),
        "试听入门主键骨干",
    );
    console.log("PASS: built-in audition plays and stops without Bluetooth");
    const pianoLevels = await evaluate(`(async () => {
        const { measurePiano } = await import("/tests/e2e/piano-render.js");
        return {
            quiet: await measurePiano([60], 1),
            chord: await measurePiano([48, 52, 55, 60, 64, 67, 72, 76], 127),
        };
    })()`);
    assert.ok(
        pianoLevels.quiet.peak > 0.08,
        "weak detections must remain audible",
    );
    assert.ok(pianoLevels.quiet.rms > 0.01, "piano decayed into near silence");
    assert.ok(pianoLevels.chord.peak < 0.99, "piano chord clipped");
    await writeFile(
        ".test-artifacts/piano-render-levels.json",
        JSON.stringify(pianoLevels, null, 2),
    );
    console.log(
        "PASS: real piano rendering is audible with chord headroom",
        JSON.stringify(pianoLevels),
    );
    await evaluate(`(() => {
        document.getElementById("transcribe-compare-working").click();
        const volume = document.getElementById("transcribe-audition-volume");
        volume.value = "50";
        volume.dispatchEvent(new Event("input"));
    })()`);
    assert.equal(
        await evaluate(
            `document.getElementById("transcribe-audition-volume-value").value`,
        ),
        "50%",
    );
    assert.equal(await evaluate("window.__workerCount"), workerBaseline);
    await evaluate(`(() => {
        document.getElementById("transcribe-compare-working").click();
    })()`);
    // MIDI downloads roundtrip through the real parser.
    const downloadMidi = async (buttonId) => {
        await evaluate(`window.__midiBlobs = window.__blobs.length`);
        await evaluate(`document.getElementById('${buttonId}').click()`);
        await wait(100);
        return evaluate(`(async () => {
            const blob = window.__blobs.slice(window.__midiBlobs)
                .find(candidate => candidate.type === 'audio/midi');
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let binary = '';
            for (const byte of bytes) binary += String.fromCharCode(byte);
            return btoa(binary);
        })()`);
    };
    const arrangedBytes = Buffer.from(
        await downloadMidi("transcribe-download"),
        "base64",
    );
    const originalBytes = Buffer.from(
        await downloadMidi("transcribe-download-original"),
        "base64",
    );
    await writeFile(".test-artifacts/transcribe-starter.mid", arrangedBytes);
    await writeFile(".test-artifacts/transcribe-original.mid", originalBytes);
    const arrangedMidi = parseMidiFile(new Uint8Array(arrangedBytes));
    assert.ok(arrangedMidi.tracks[0].noteCount > 0);
    const originalMidi = parseMidiFile(new Uint8Array(originalBytes));
    assert.ok(originalMidi.tracks[0].noteCount > 0);
    // The synthesized clip plays C5/E5/G5 — the detected pitch classes must
    // reflect them (transcription may add harmonics, so allow extras).
    const pitchClasses = new Set(
        originalMidi.events
            .filter((event) => event.on)
            .map((event) => event.note % 12),
    );
    const expected = [0, 4, 7].filter((pc) => pitchClasses.has(pc));
    assert.ok(
        expected.length >= 2,
        `expected C/E/G pitch classes in transcription, got ${[...pitchClasses].sort((a, b) => a - b)}`,
    );
    console.log(
        `PASS: MIDI downloads roundtrip; detected pitch classes ${[...pitchClasses].sort((a, b) => a - b)}`,
    );
    await writeFile(
        ".test-artifacts/transcribe-result.png",
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
    // Practice handoff: follow mode, rendered score, no device, no auto-start.
    await evaluate(`document.getElementById('transcribe-practice').click()`);
    for (
        let i = 0;
        i < 60 && (await evaluate(`location.hash`)) !== "#teach";
        i++
    )
        await wait(100);
    assert.equal(await evaluate(`location.hash`), "#teach");
    await wait(200);
    assert.equal(
        await evaluate(`document.getElementById('teach-mode').value`),
        "follow",
    );
    assert.ok(
        (await evaluate(`document.querySelectorAll('.score-beat').length`)) > 0,
    );
    assert.equal(
        await evaluate(`document.getElementById('teach-start').disabled`),
        true,
        "practice must stay disabled without a connected device",
    );
    assert.equal(await evaluate(`window.__workerCount`), workerBaseline);
    console.log(
        "PASS: practice handoff sets follow mode and renders the score without a device",
    );
    await writeFile(
        ".test-artifacts/transcribe-teach.png",
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
    // Mapping changes re-arrange without inference; extreme first note warns on original.
    await evaluate(`location.hash = 'transcribe'`);
    await wait(150);
    const titlesBefore = await evaluate(
        `[...document.querySelectorAll('#transcribe-preview .transcribe-note')].map(n => n.title).join('|')`,
    );
    await evaluate(`(() => {
        document.getElementById('teach-first-note').value = '103';
        document.getElementById('teach-apply-map').click();
    })()`);
    await wait(250);
    assert.equal(await evaluate(`window.__workerCount`), workerBaseline);
    const titlesAfter = await evaluate(
        `[...document.querySelectorAll('#transcribe-preview .transcribe-note')].map(n => n.title).join('|')`,
    );
    assert.notEqual(titlesBefore, titlesAfter);
    await evaluate(
        `document.querySelector('.transcribe-level[data-level="original"]').click()`,
    );
    await wait(150);
    assert.equal(
        await evaluate(`document.getElementById('transcribe-warning').hidden`),
        false,
    );
    assert.equal(
        await evaluate(
            `document.getElementById('transcribe-practice').disabled`,
        ),
        true,
    );
    assert.equal(
        await evaluate(
            `document.getElementById('transcribe-download').disabled`,
        ),
        false,
    );
    assert.equal(
        await evaluate(
            `document.getElementById('transcribe-download-original').disabled`,
        ),
        false,
    );
    assert.equal(
        await evaluate(
            `document.getElementById('transcribe-audition').disabled`,
        ),
        false,
    );
    console.log(
        "PASS: mapping refresh re-arranges without inference; out-of-range original disables practice only",
    );
    await evaluate(`(() => {
        document.getElementById('teach-first-note').value = '60';
        document.getElementById('teach-apply-map').click();
    })()`);
    await wait(200);
    for (const width of [320, 390]) {
        await send("Emulation.setDeviceMetricsOverride", {
            width,
            height: 844,
            deviceScaleFactor: 1,
            mobile: true,
        });
        assert.equal(
            await evaluate(`document.documentElement.scrollWidth > innerWidth`),
            false,
        );
        assert.ok(
            await evaluate(`(() => {
            const rect = (id) => document.getElementById("transcribe-" + id).getBoundingClientRect();
            const origin = rect("origin"), fit = rect("auto-fit"), reset = rect("original-key");
            const separate = (a, b) => b.left - a.right >= 8 || b.top - a.bottom >= 8;
            return separate(origin, fit) && separate(fit, reset) &&
                [origin, fit, reset, rect("run"), rect("fetch")].every(bounds =>
                    bounds.left >= 0 && bounds.right <= innerWidth && bounds.height >= 40);
        })()`),
            `Transcription buttons fit and keep their gaps at ${width}px`,
        );
    }
    await writeFile(
        ".test-artifacts/transcribe-mobile.png",
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
    console.log("PASS: transcribe tab fits a mobile viewport");
    // Editing the clip invalidates the stale result.
    await evaluate(`(() => {
        const length = document.getElementById('transcribe-length');
        length.value = '10';
        length.dispatchEvent(new Event('change'));
    })()`);
    await wait(150);
    assert.equal(
        await evaluate(`document.getElementById('transcribe-results').hidden`),
        true,
    );
    console.log("PASS: clip edits clear stale transcription results");
    // ---- Raised clip limit: whole-source default + long worker input ----
    const longPath = resolve(".test-artifacts/clip219.wav");
    await writeFile(longPath, longWav());
    await setFile("transcribe-file", longPath);
    for (
        let i = 0;
        i < 600 &&
        (await evaluate(
            `document.getElementById('transcribe-source-name').textContent !== 'clip219.wav'`,
        ));
        i++
    )
        await wait(100);
    assert.equal(
        await evaluate(`document.getElementById('transcribe-clip').hidden`),
        false,
        "219 s source did not decode",
    );
    const sourceSeconds = await evaluate(
        `parseFloat(document.getElementById('transcribe-start').max)`,
    );
    assert.ok(
        Math.abs(sourceSeconds - 219) < 0.05,
        `unexpected source duration ${sourceSeconds}`,
    );
    assert.equal(
        await evaluate(`document.getElementById('transcribe-start').value`),
        "0",
    );
    assert.equal(
        await evaluate(`document.getElementById('transcribe-length').max`),
        "600",
    );
    const defaultSeconds = await evaluate(
        `parseFloat(document.getElementById('transcribe-length').value)`,
    );
    // Whole source by default, rounded up to 0.1 s — not the old 30/120 cap.
    assert.ok(
        Math.abs(
            defaultSeconds - Math.min(600, Math.ceil(sourceSeconds * 10) / 10),
        ) < 1e-9,
        `default clip ${defaultSeconds} for ${sourceSeconds} s source`,
    );
    assert.ok(defaultSeconds >= 219, `default clip ${defaultSeconds}`);
    assert.equal(
        await evaluate(`document.getElementById('transcribe-error').hidden`),
        true,
        "old clip validation rejected a 219 s source",
    );
    // Pin the length so the rendered buffer is exactly 219 * 22050 samples.
    await evaluate(`(() => {
        window.__workerPosts = [];
        window.__workerMessages = [];
        const length = document.getElementById('transcribe-length');
        length.value = '219';
        length.dispatchEvent(new Event('change'));
        document.getElementById('transcribe-run').click();
    })()`);
    for (
        let i = 0;
        i < 1200 && !(await evaluate(`window.__workerPosts.length`));
        i++
    )
        await wait(100);
    assert.deepEqual(
        await evaluate(`window.__workerPosts`),
        [219 * 22050],
        "worker did not receive the full 219 s buffer",
    );
    // First completed inference window proves the long buffer passed
    // validation and real model work began; cancel there instead of waiting
    // for full inference.
    const reachedWindows = `window.__workerMessages.some(
        (m) => m.type === 'status' && m.completedWindows > 0,
    )`;
    for (let i = 0; i < 3600 && !(await evaluate(reachedWindows)); i++)
        await wait(100);
    assert.ok(
        await evaluate(reachedWindows),
        "219 s input never completed an inference window",
    );
    const firstWindow = await evaluate(
        `JSON.stringify(window.__workerMessages.find(
            (m) => m.type === 'status' && m.completedWindows > 0,
        ))`,
    );
    console.log(`first completed window: ${firstWindow}`);
    await writeFile(
        ".test-artifacts/clip219-progress.png",
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
    await evaluate(`document.getElementById('transcribe-cancel').click()`);
    await wait(300);
    assert.match(
        await evaluate(
            `document.getElementById('transcribe-status').textContent`,
        ),
        /Cancel|取消/,
    );
    assert.equal(
        await evaluate(`document.getElementById('transcribe-run').disabled`),
        false,
    );
    assert.equal(
        await evaluate(`document.getElementById('transcribe-results').hidden`),
        true,
    );
    await wait(1500);
    assert.equal(
        await evaluate(`document.getElementById('transcribe-results').hidden`),
        true,
        "a late result landed after cancel",
    );
    assert.equal(
        await evaluate(
            `window.__workerMessages.some((m) => m.type === 'result')`,
        ),
        false,
        "worker emitted a result after cancel",
    );
    assert.equal(
        await evaluate(
            `document.getElementById('transcribe-diagnostic').hidden`,
        ),
        true,
        "diagnostic line stayed visible after cancel",
    );
    await wait(1100);
    assert.match(
        await evaluate(
            `document.getElementById('transcribe-status').textContent`,
        ),
        /Cancel|取消/,
        "cancelled status was revived by a late tick",
    );
    assert.equal(
        await evaluate(
            `document.getElementById('transcribe-diagnostic').hidden`,
        ),
        true,
        "diagnostic line revived after cancel",
    );
    console.log(
        "PASS: 219 s clip reaches real window progress and cancels cleanly",
    );
    // Lengths above the cap are rejected before any worker is launched.
    const postsBeforeReject = await evaluate(`window.__workerPosts.length`);
    const workersBeforeReject = await evaluate(`window.__workerCount`);
    await evaluate(`(() => {
        const length = document.getElementById('transcribe-length');
        length.value = '601';
        length.dispatchEvent(new Event('change'));
        document.getElementById('transcribe-run').click();
    })()`);
    await wait(200);
    assert.match(
        await evaluate(
            `document.getElementById('transcribe-error').textContent`,
        ),
        /600/,
    );
    assert.equal(
        await evaluate(`window.__workerPosts.length`),
        postsBeforeReject,
    );
    assert.equal(await evaluate(`window.__workerCount`), workersBeforeReject);
    console.log("PASS: clip length above 600 s is rejected without a worker");
    // A shorter file resets start and defaults the length to its own duration.
    await setFile("transcribe-file", wavPath);
    for (
        let i = 0;
        i < 600 &&
        (await evaluate(
            `document.getElementById('transcribe-source-name').textContent !== 'clip.wav'`,
        ));
        i++
    )
        await wait(100);
    assert.equal(
        await evaluate(`document.getElementById('transcribe-clip').hidden`),
        false,
        "short clip did not reload",
    );
    assert.equal(
        await evaluate(`document.getElementById('transcribe-start').value`),
        "0",
    );
    const shortSeconds = await evaluate(
        `parseFloat(document.getElementById('transcribe-length').value)`,
    );
    assert.ok(
        Math.abs(shortSeconds - 9.5) < 0.15,
        `short clip default ${shortSeconds}`,
    );
    console.log(
        "PASS: loading a shorter file resets start and whole-source length",
    );
    // Worker-level guard: MAX_SAMPLES + 1 is rejected before model load.
    const oversized = await evaluate(`new Promise((resolve) => {
        const worker = new window.Worker(
            '/src/core/transcription-worker.js',
            { type: 'module' },
        );
        const timer = setTimeout(() => {
            worker.terminate();
            resolve('timeout');
        }, 30000);
        worker.onmessage = (event) => {
            clearTimeout(timer);
            worker.terminate();
            const data = event.data || {};
            resolve(
                data.type === "error"
                    ? "rejected:" + (data.error && data.error.code)
                    : "unexpected",
            );
        };
        worker.onerror = () => {
            clearTimeout(timer);
            worker.terminate();
            resolve("worker-error");
        };
        worker.postMessage({
            version: 1,
            jobId: 1,
            type: "start",
            sampleRate: 22050,
            samples: new Float32Array(${600 * 22050 + 1}),
        });
    })`);
    assert.equal(
        oversized,
        "rejected:protocol",
        "worker accepted >600 s of samples",
    );
    console.log("PASS: worker rejects a buffer above 600 s before model load");
    // Test-only fake Worker + clock: stage texts, decimal progress, stall
    // warning, persisted-pagehide reuse, error and retry — no real inference.
    await evaluate(`(() => {
        window.__savedWorker = window.Worker;
        window.__savedNow = performance.now;
        window.__fakeNow = performance.now();
        performance.now = () => window.__fakeNow;
        window.__fakeWorkers = [];
        window.Worker = class {
            constructor() {
                this.onmessage = null;
                this.onerror = null;
                this.onmessageerror = null;
                this.posted = [];
                this.terminated = 0;
                window.__fakeWorkers.push(this);
            }
            postMessage(message) {
                this.posted.push(message);
            }
            terminate() {
                this.terminated++;
            }
            emitStatus(fields) {
                this.onmessage({
                    data: {
                        version: 1,
                        jobId: this.posted[0].jobId,
                        type: 'status',
                        ...fields,
                    },
                });
            }
            emitResult(notes) {
                this.onmessage({
                    data: {
                        version: 1,
                        jobId: this.posted[0].jobId,
                        type: 'result',
                        notes,
                    },
                });
            }
            emitError(code, message) {
                this.onmessage({
                    data: {
                        version: 1,
                        jobId: this.posted[0].jobId,
                        type: 'error',
                        error: { code, message, stage: null },
                    },
                });
            }
        };
    })()`);
    const statusText = `document.getElementById('transcribe-status').textContent`;
    const diagText = `document.getElementById('transcribe-diagnostic').textContent`;
    const diagHidden = `document.getElementById('transcribe-diagnostic').hidden`;
    const fakeCount = `window.__fakeWorkers.length`;
    const NOTE = `{ note: 60, timeMs: 0, durationMs: 500, velocity: 100 }`;
    const oldSourceUrl = await evaluate(
        'document.getElementById("transcribe-source").src',
    );
    await setFile("transcribe-file", wavPath);
    for (
        let i = 0;
        i < 600 &&
        (await evaluate(
            `document.getElementById("transcribe-run").disabled || document.getElementById("transcribe-source").src===${JSON.stringify(oldSourceUrl)}`,
        ));
        i++
    )
        await wait(100);
    await evaluate(`document.getElementById('transcribe-run').click()`);
    for (let i = 0; i < 600 && !(await evaluate(`${fakeCount} >= 1`)); i++)
        await wait(50);
    assert.equal(await evaluate(fakeCount), 1, "fake worker not created");
    const fw = `window.__fakeWorkers[0]`;
    await evaluate(`${fw}.emitStatus({ stage: 'initializing' })`);
    assert.match(await evaluate(statusText), /初始化计算后端/);
    await evaluate(`${fw}.emitStatus({ stage: 'loading', backend: 'cpu' })`);
    assert.match(await evaluate(statusText), /加载模型/);
    await evaluate(`${fw}.emitStatus({ stage: 'warming', progress: 0 })`);
    const warming = await evaluate(statusText);
    assert.match(warming, /首次计算/);
    assert.equal(warming.includes("%"), false, "warming showed a percent");
    await evaluate(
        `${fw}.emitStatus({ stage: 'transcribing', progress: 0.0075, backend: 'cpu', completedWindows: 3, totalWindows: 400 })`,
    );
    assert.match(await evaluate(statusText), /0\.8%/);
    assert.match(await evaluate(diagText), /CPU/);
    // Jump the injected clock 61 s without new progress: stall warning appears,
    // percent stays put.
    await evaluate(`window.__fakeNow += 61000`);
    for (
        let i = 0;
        i < 40 &&
        !(await evaluate(
            `document.getElementById('transcribe-diagnostic').textContent.includes('长时间未收到')`,
        ));
        i++
    )
        await wait(100);
    assert.match(await evaluate(diagText), /长时间未收到/);
    assert.match(await evaluate(statusText), /0\.8%/, "percent moved on idle");
    // Persisted pagehide (BFCache): job cancelled + worker terminated, client kept.
    await evaluate(
        `window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))`,
    );
    assert.equal(
        await evaluate(`window.__fakeWorkers[0].terminated`),
        1,
        "persisted pagehide did not terminate the worker",
    );
    assert.equal(await evaluate(diagHidden), true);
    // The cached page releases the decoded PCM and clip UI entirely.
    assert.equal(
        await evaluate(
            `document.getElementById('transcribe-source-name').textContent`,
        ),
        "",
        "source name survived pagehide",
    );
    assert.equal(
        await evaluate(`document.getElementById('transcribe-clip').hidden`),
        true,
        "clip controls survived pagehide",
    );
    assert.equal(
        await evaluate(`document.getElementById('transcribe-run').disabled`),
        true,
        "run stayed enabled after pagehide",
    );
    // Back from BFCache: the same client must run again (not disposed).
    await setFile("transcribe-file", wavPath);
    for (
        let i = 0;
        i < 600 &&
        (await evaluate(`document.getElementById('transcribe-clip').hidden`));
        i++
    )
        await wait(100);
    await evaluate(`document.getElementById('transcribe-run').click()`);
    for (let i = 0; i < 600 && !(await evaluate(`${fakeCount} >= 2`)); i++)
        await wait(50);
    assert.equal(await evaluate(fakeCount), 2, "job client was disposed");
    await evaluate(`window.__fakeWorkers[1].emitResult([${NOTE}])`);
    for (
        let i = 0;
        i < 200 &&
        (await evaluate(
            `document.getElementById('transcribe-results').hidden`,
        ));
        i++
    )
        await wait(50);
    assert.equal(
        await evaluate(`document.getElementById('transcribe-results').hidden`),
        false,
        "run after persisted pagehide produced no results",
    );
    // Worker error then explicit retry on the same decoded source.
    await evaluate(`document.getElementById('transcribe-run').click()`);
    for (let i = 0; i < 600 && !(await evaluate(`${fakeCount} >= 3`)); i++)
        await wait(50);
    await evaluate(
        `window.__fakeWorkers[2].emitError('inference', 'boom', 'transcribing')`,
    );
    await wait(100);
    assert.match(
        await evaluate(
            `document.getElementById('transcribe-error').textContent`,
        ),
        /boom/,
    );
    assert.equal(
        await evaluate(`document.getElementById('transcribe-run').disabled`),
        false,
        "run stayed disabled after worker error",
    );
    await evaluate(`document.getElementById('transcribe-run').click()`);
    for (let i = 0; i < 600 && !(await evaluate(`${fakeCount} >= 4`)); i++)
        await wait(50);
    await evaluate(`window.__fakeWorkers[3].emitResult([${NOTE}])`);
    for (
        let i = 0;
        i < 200 &&
        (await evaluate(
            `document.getElementById('transcribe-results').hidden`,
        ));
        i++
    )
        await wait(50);
    assert.equal(
        await evaluate(`document.getElementById('transcribe-results').hidden`),
        false,
        "retry after worker error produced no results",
    );
    // A valid empty detection shows the translated no-notes guidance instead
    // of an empty draft card, and the controls recover for another try.
    await evaluate(`document.getElementById('transcribe-run').click()`);
    for (let i = 0; i < 600 && !(await evaluate(`${fakeCount} >= 5`)); i++)
        await wait(50);
    await evaluate(`window.__fakeWorkers[4].emitResult([])`);
    await wait(150);
    assert.match(
        await evaluate(
            `document.getElementById('transcribe-error').textContent`,
        ),
        /音符|notes/i,
        "empty result did not show the no-notes guidance",
    );
    assert.equal(
        await evaluate(`document.getElementById('transcribe-results').hidden`),
        true,
        "empty result revealed a draft card",
    );
    assert.equal(
        await evaluate(`document.getElementById('transcribe-run').disabled`),
        false,
        "run stayed disabled after empty result",
    );
    await evaluate(`document.getElementById('transcribe-run').click()`);
    for (let i = 0; i < 600 && !(await evaluate(`${fakeCount} >= 6`)); i++)
        await wait(50);
    await evaluate(`window.__fakeWorkers[5].emitResult([${NOTE}])`);
    for (
        let i = 0;
        i < 200 &&
        (await evaluate(
            `document.getElementById('transcribe-results').hidden`,
        ));
        i++
    )
        await wait(50);
    assert.equal(
        await evaluate(`document.getElementById('transcribe-results').hidden`),
        false,
        "run after empty result produced no results",
    );
    await evaluate(`(() => {
        window.Worker = window.__savedWorker;
        performance.now = window.__savedNow;
    })()`);
    console.log(
        "PASS: stage/decimal/stall diagnostics, persisted pagehide reuse, error retry, empty result",
    );
    await evaluate(`location.hash = 'teach'`);
    await wait(150);
    assert.equal(
        await evaluate(`document.documentElement.scrollWidth > innerWidth`),
        false,
    );
    await mkdir(".test-artifacts", { recursive: true });
    await writeFile(
        ".test-artifacts/e2e-errors.json",
        JSON.stringify(errors, null, 2),
    );
    assert.deepEqual(errors, []);
    console.log(
        "PASS: teaching navigation, mobile page width, no browser runtime exceptions",
    );
} finally {
    if (socket) socket.close();
    if (browser) browser.kill();
    server.kill();
}
