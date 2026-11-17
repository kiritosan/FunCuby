import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

// Engineering acceptance check, not an accuracy/performance benchmark.
// Observe the actual UI/worker path through a complete 219-second transcription.
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:5173";
const BROWSER =
    process.env.BROWSER ||
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const RUN_TIMEOUT_MS = 12 * 60 * 1000;
const gpuEnabled = process.argv.includes("--gpu-enabled");
const separated = process.argv.includes("--game-separated");
const game = separated || process.argv.includes("--game");
const engine = separated ? "game-separated" : game ? "game" : "basic-pitch";
const customClip = process.argv
    .find((arg) => arg.startsWith("--clip="))
    ?.slice(7);
const seconds = Number(
    process.argv.find((arg) => arg.startsWith("--seconds="))?.slice(10) || 219,
);
assert.ok(seconds > 0 && seconds <= 600);
const sampleRate = game ? 44100 : 22050;
const artifacts = resolve(".test-artifacts");
const artifactBase = separated
    ? "transcription-game-separated"
    : game
      ? "transcription-game-quality"
      : customClip
        ? "transcription-basic-quality"
        : gpuEnabled
          ? "transcription-gpu-enabled-cpu-default"
          : "transcription-long-run";
const artifactName =
    seconds === 219 ? artifactBase : `${artifactBase}-${seconds}s`;
const reportPath = resolve(artifacts, `${artifactName}.json`);
const fixture = customClip
    ? resolve(customClip)
    : resolve(artifacts, "clip219.wav");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = {
    schema: "funcuby-transcription-long-run-v1",
    baseUrl: BASE_URL,
    fixture: customClip || "clip219.wav",
    seconds,
    engine,
    browserFlags: ["--headless=new", ...(gpuEnabled ? [] : ["--disable-gpu"])],
    events: [],
    errors: [],
    passed: false,
};
let browser, socket, send;

await stat(fixture);
await mkdir(artifacts, { recursive: true });
assert.ok((await fetch(BASE_URL)).ok, "Start the local FunCuby server first");
try {
    browser = spawn(
        BROWSER,
        [
            ...report.browserFlags,
            "--no-first-run",
            "--no-default-browser-check",
            "--remote-debugging-port=0",
            "--lang=zh-CN",
            "--autoplay-policy=no-user-gesture-required",
            `--user-data-dir=${resolve(artifacts, `${artifactName}-profile`)}`,
            "about:blank",
        ],
        { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    const debuggerUrl = await new Promise((resolve, reject) => {
        let output = "";
        const timer = setTimeout(
            () => reject(new Error("Browser debugger startup timed out")),
            20000,
        );
        browser.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        browser.stderr.on("data", (data) => {
            output += data;
            const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
            if (match) {
                clearTimeout(timer);
                resolve(match[1]);
            }
        });
    });
    const port = new URL(debuggerUrl).port;
    const tabs = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
    const page = tabs.find((tab) => tab.type === "page");
    assert.ok(page, "No diagnostic browser page was created");
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
    });
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener("message", ({ data }) => {
        const event = JSON.parse(data);
        if (event.id) {
            const promise = pending.get(event.id);
            if (!promise) return;
            pending.delete(event.id);
            event.error
                ? promise.reject(new Error(JSON.stringify(event.error)))
                : promise.resolve(event.result);
        } else if (event.method === "Runtime.exceptionThrown") {
            report.errors.push(event.params.exceptionDetails);
        } else if (
            event.method === "Runtime.consoleAPICalled" &&
            event.params.type === "error"
        ) {
            report.errors.push({
                consoleError: event.params.args
                    .map((arg) => arg.value ?? arg.description ?? "")
                    .join(" "),
            });
        }
    });
    send = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const id = ++sequence;
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`CDP ${method} timed out`));
            }, 30000);
            pending.set(id, {
                resolve: (result) => {
                    clearTimeout(timer);
                    resolve(result);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });
            socket.send(JSON.stringify({ id, method, params }));
        });
    const evaluate = async (expression) => {
        const result = await send("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });
        if (result.exceptionDetails)
            throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    const until = async (expression, timeoutMs = 20000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (await evaluate(expression)) return true;
            await wait(100);
        }
        return false;
    };
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Page.navigate", {
        url: new URL("/#transcribe", BASE_URL).href,
    });
    assert.ok(
        await until(
            "document.querySelectorAll('#transcribe-levels .transcribe-level').length === 4",
        ),
        "Transcription page did not initialize",
    );
    if (gpuEnabled) {
        report.gpuProbe = await evaluate(`new Promise((resolve) => {
            const worker = new Worker("/tests/e2e/backend-probe-worker.js", {
                type: "module",
            });
            const timer = setTimeout(() => {
                worker.terminate();
                resolve({ webglReady: false, timedOut: true });
            }, 20000);
            worker.onmessage = ({data}) => {
                clearTimeout(timer);
                worker.terminate();
                resolve(data);
            };
            worker.onerror = (event) => {
                clearTimeout(timer);
                worker.terminate();
                resolve({ webglReady: false, error: event.message });
            };
            worker.postMessage({});
        })`);
        console.log("GPU capability:", JSON.stringify(report.gpuProbe));
        assert.equal(
            report.gpuProbe.webglReady,
            true,
            "This acceptance variant needs a WebGL-capable worker",
        );
    }
    if (game) {
        assert.ok(
            await until(
                `!document.getElementById('transcribe-engine-${engine}').disabled`,
            ),
            "Local GAME environment is unavailable",
        );
    }
    await evaluate(`(() => {
        const engine = document.getElementById("transcribe-engine");
        engine.value = ${JSON.stringify(engine)};
        engine.dispatchEvent(new Event("change"));
        if (${game}) {
            const language = document.getElementById("transcribe-language");
            language.value = "zh";
            language.dispatchEvent(new Event("change"));
        }
    })()`);
    await evaluate(`(() => {
        const NativeWorker = window.Worker;
        window.__longRunEvents = [];
        window.__longRunSamples = [];
        window.__longRunStart = performance.now();
        window.Worker = class extends NativeWorker {
            constructor(...args) {
                super(...args);
                this.addEventListener("message", ({data}) => {
                    if (data?.type === "result") window.__qualityNotes = data.notes;
                    window.__longRunEvents.push({
                        elapsedMs: performance.now() - window.__longRunStart,
                        version: data?.version,
                        jobId: data?.jobId,
                        type: data?.type,
                        stage: data?.stage,
                        backend: data?.backend,
                        progress: data?.progress,
                        completedWindows: data?.completedWindows,
                        totalWindows: data?.totalWindows,
                        separationWindows: data?.separationWindows,
                        vocalBytes: data?.blob?.size,
                        tensorCount: data?.tensorCount,
                        noteCount: Array.isArray(data?.notes)
                            ? data.notes.length
                            : undefined,
                        error: data?.error,
                    });
                    if (data?.type === "result" ||
                        (data?.type === "status" &&
                         (data.completedWindows === 1 ||
                          (data.completedWindows > 0 &&
                           data.completedWindows % 20 === 0))))
                        console.log("inference-observed", JSON.stringify({
                            backend: data.backend,
                            completed: data.completedWindows,
                            total: data.totalWindows,
                            type: data.type,
                        }));
                });
            }
            postMessage(message, transfer) {
                if (message?.samples)
                    window.__longRunSamples.push(message.samples.length);
                return super.postMessage(message, transfer);
            }
        };
    })()`);
    const { root } = await send("DOM.getDocument");
    const { nodeId } = await send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: "#transcribe-file",
    });
    await send("DOM.setFileInputFiles", { nodeId, files: [fixture] });
    assert.ok(
        await until("!document.getElementById('transcribe-clip').hidden"),
        "Long audio did not decode",
    );
    await evaluate(`(() => {
        const length = document.getElementById("transcribe-length");
        length.value = "${seconds}";
        length.dispatchEvent(new Event("change"));
        window.__longRunStart = performance.now();
        document.getElementById("transcribe-run").click();
    })()`);
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    while (Date.now() < deadline) {
        report.events = await evaluate("window.__longRunEvents");
        report.ui = await evaluate(`({
            status: document.getElementById("transcribe-status").textContent,
            error: document.getElementById("transcribe-error").hidden
                ? ""
                : document.getElementById("transcribe-error").textContent,
            resultsHidden: document.getElementById("transcribe-results").hidden,
            runDisabled: document.getElementById("transcribe-run").disabled,
        })`);
        if (
            report.events.some(
                (event) =>
                    event.type === "status" &&
                    event.stage === "transcribing" &&
                    event.completedWindows > 0,
            ) &&
            !report.firstWindowObserved
        ) {
            report.firstWindowObserved = true;
            console.log(
                "First completed CPU window:",
                JSON.stringify(
                    report.events.find(
                        (event) =>
                            event.stage === "transcribing" &&
                            event.completedWindows > 0,
                    ),
                ),
            );
        }
        if (
            report.ui.error ||
            report.events.some(
                (event) => event.type === "result" || event.type === "error",
            )
        )
            break;
        await wait(1000);
    }
    report.postedSamples = await evaluate("window.__longRunSamples");
    const completed = report.events.filter(
        (event) =>
            event.type === "status" &&
            ["separating", "transcribing"].includes(event.stage) &&
            event.completedWindows > 0,
    );
    const terminal = report.events.find((event) => event.type === "result");
    assert.equal(report.ui.error, "", "Transcription UI reported an error");
    assert.ok(
        terminal,
        "Long transcription did not complete within the test budget",
    );
    assert.ok(
        completed.length > 1,
        "No sustained window progress was observed",
    );
    assert.equal(completed.length, completed.at(-1).totalWindows);
    completed.forEach((event, index) => {
        assert.equal(event.backend, "cpu", "Unvalidated GPU was auto-selected");
        assert.equal(event.completedWindows, index + 1);
        assert.equal(event.progress, (index + 1) / event.totalWindows);
    });
    assert.equal(completed.at(-1).progress, 1);
    if (separated) {
        const firstGameWindow = completed.findIndex(
            (event) => event.stage === "transcribing",
        );
        assert.ok(
            firstGameWindow > 0,
            "Separation did not advance before GAME",
        );
        assert.ok(
            completed
                .slice(firstGameWindow)
                .every((event) => event.stage === "transcribing"),
        );
        assert.ok(completed[0].separationWindows > 0);
        const vocalEvent = report.events.find(
            (event) => event.type === "vocal-stem",
        );
        assert.equal(vocalEvent?.vocalBytes, seconds * sampleRate * 4 + 44);
        assert.ok(
            report.events.indexOf(vocalEvent) < report.events.indexOf(terminal),
        );
        assert.ok(
            await until(`(() => {
            const audio = document.getElementById("transcribe-vocals-audio");
            return !document.getElementById("transcribe-vocals-actions").hidden &&
                audio.src.startsWith("blob:");
        })()`),
            "Isolated audio controls were not shown",
        );
        report.vocals = await evaluate(`(async () => {
            const audio = document.getElementById("transcribe-vocals-audio");
            const link = document.getElementById("transcribe-vocals-download");
            try {
                await Promise.race([
                    audio.play(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Playback timed out")), 8000)),
                ]);
            } catch (error) {
                return { error: error.message, mediaError: audio.error?.message,
                    readyState: audio.readyState, networkState: audio.networkState };
            }
            const end = Date.now() + 2500;
            while (audio.currentTime === 0 && Date.now() < end)
                await new Promise(resolve => setTimeout(resolve, 50));
            audio.pause();
            return { duration: audio.duration, played: audio.currentTime > 0, link: link.download };
        })()`);
        assert.equal(
            report.vocals.error,
            undefined,
            JSON.stringify(report.vocals),
        );
        assert.equal(report.vocals.duration, seconds);
        assert.equal(report.vocals.played, true);
        assert.match(report.vocals.link, /vocals\.wav$/);
        report.phraseSequence = await evaluate(`(async () => {
            const editor = document.getElementById("transcribe-editor");
            const get = (key) => editor.querySelector('[data-field="' + key + '"]');
            get("from").value = "0.2";
            get("to").value = "0.65";
            get("to").dispatchEvent(new Event("change"));
            get("loop").checked = true;
            editor.querySelector('[data-action="compare"]').click();
            const tracks = [], deadline = Date.now() + 10000;
            while (tracks.length < 4 && Date.now() < deadline) {
                const track = editor.dataset.playing;
                if (track && track !== tracks.at(-1) && editor.textContent.includes("短句播放中"))
                    tracks.push(track);
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            editor.querySelector('[data-action="stop"]').click();
            return tracks;
        })()`);
        assert.deepEqual(report.phraseSequence, [
            "source",
            "vocals",
            "piano",
            "source",
        ]);
    }
    assert.deepEqual(
        await evaluate(`[...document.querySelectorAll("#transcribe-pipeline-steps li")].map(
            node => [node.dataset.step, node.dataset.state]
        )`),
        [
            "prepare",
            "load",
            ...(separated ? ["separate"] : []),
            game ? "game" : "browser",
            "finish",
        ].map((step) => [step, "done"]),
    );
    const inferenceWindows = completed.filter(
        (event) => event.stage === "transcribing",
    ).length;
    assert.deepEqual(
        await evaluate(`[...document.querySelectorAll("#transcribe-pipeline-steps progress:not([hidden])")].map(
            node => [node.value, node.max]
        )`),
        [
            ...(separated
                ? [Array(2).fill(completed[0].separationWindows)]
                : []),
            [inferenceWindows, inferenceWindows],
        ],
    );
    if (!game)
        assert.equal(
            new Set(completed.map((event) => event.tensorCount)).size,
            1,
            "Live tensor count grew across model windows",
        );
    if (!game)
        assert.ok(
            completed.every((event) => Number.isSafeInteger(event.tensorCount)),
            "Window tensor telemetry was missing",
        );
    if (!game)
        assert.equal(
            terminal.tensorCount,
            0,
            "Completed worker retained tensors",
        );
    assert.ok(terminal.noteCount > 0, "Input produced no notes");
    assert.equal(report.ui.resultsHidden, false);
    assert.equal(report.ui.runDisabled, false);
    assert.deepEqual(report.postedSamples, [
        seconds * sampleRate * (separated ? 2 : 1),
    ]);
    assert.deepEqual(report.errors, []);
    report.inferencePassed = true;
    report.tensorCountKind = game
        ? "Not applicable to ONNX CPU"
        : "Logical TensorFlow tensors, not physical RAM";
    if (customClip) {
        await writeFile(
            resolve(artifacts, `${artifactName}-notes.json`),
            JSON.stringify(await evaluate("window.__qualityNotes"), null, 2),
        );
    }
    if (separated) {
        await send("Emulation.setDeviceMetricsOverride", {
            width: 390,
            height: 844,
            deviceScaleFactor: 1,
            mobile: true,
        });
        assert.ok(
            await evaluate(
                `document.documentElement.scrollWidth <= innerWidth`,
            ),
        );
    }
    try {
        await writeFile(
            resolve(artifacts, `${artifactName}.png`),
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
    } catch (error) {
        report.screenshotFailure = String(error?.message ?? error);
        console.warn(
            "Screenshot artifact unavailable:",
            report.screenshotFailure,
        );
    }
    if (game) {
        const before = report.events.length;
        const hiddenWhileInBasicPitch = await evaluate(`(() => {
            const engine = document.getElementById("transcribe-engine");
            engine.value = "basic-pitch"; engine.dispatchEvent(new Event("change"));
            const hidden = document.getElementById("transcribe-vocals").hidden;
            engine.value = ${JSON.stringify(engine)}; engine.dispatchEvent(new Event("change"));
            return hidden;
        })()`);
        assert.equal(hiddenWhileInBasicPitch, true);
        assert.equal(await evaluate("window.__longRunEvents.length"), before);
        assert.equal(
            await evaluate(
                "document.getElementById('transcribe-results').hidden",
            ),
            false,
        );
    }
    if (separated) {
        assert.equal(
            await evaluate(
                'document.getElementById("transcribe-vocals-actions").hidden',
            ),
            false,
        );
        report.analysis = await evaluate(`(async () => {
            const { analyzeMelody } = await import("/src/core/transcription/musical-analysis.js");
            const read = (id) => document.getElementById("transcribe-" + id);
            const values = () => ["bpm", "origin", "transpose"].map(id => Number(read(id).value));
            const change = (id, value) => {
                read(id).value = String(value);
                read(id).dispatchEvent(new Event("change", { bubbles: true }));
            };
            const expected = analyzeMelody(window.__qualityNotes, { clipMs: ${seconds * 1000} });
            const initial = values();
            change("bpm", 101);
            change("origin", 12);
            change("transpose", 4);
            read("original-key").click();
            const originalKey = values();
            read("auto-fit").click();
            return { expected, initial, originalKey, fitted: values() };
        })()`);
        const { expected, initial, originalKey, fitted } = report.analysis;
        assert.equal(initial[2], expected.whiteKeyTranspose);
        assert.deepEqual(originalKey, [101, 12, 0]);
        assert.deepEqual(fitted, [
            ...(expected.confidence >= 0.2
                ? [expected.bpm, expected.originMs]
                : [101, 12]),
            expected.whiteKeyTranspose,
        ]);
        assert.ok(
            await until(
                'document.getElementById("transcribe-storage-status").dataset.i18n === "transcribe.storage.saved"',
            ),
        );
        await send("Page.reload", { ignoreCache: true });
        assert.ok(
            await until(
                'document.getElementById("transcribe-storage-status")?.dataset.i18n === "transcribe.storage.restored"',
            ),
        );
        assert.equal(
            await evaluate(
                'document.getElementById("transcribe-engine").value',
            ),
            engine,
        );
        assert.equal(
            await evaluate(
                'document.getElementById("transcribe-results").hidden',
            ),
            false,
        );
        assert.equal(
            await evaluate(
                'document.getElementById("transcribe-vocals").hidden',
            ),
            true,
        );
        assert.equal(
            await evaluate(
                "document.querySelector('#transcribe-editor [data-action=\"vocals\"]').disabled",
            ),
            true,
        );
        assert.deepEqual(
            await evaluate(`["bpm", "origin", "transpose"].map(
            id => Number(document.getElementById("transcribe-" + id).value)
        )`),
            fitted,
        );
    }
    report.passed = true;
    console.log(
        `PASS: complete ${seconds} s ${report.engine} UI-to-model-to-score transcription`,
    );
    console.log("PASS: every model window advanced actual progress");
    console.log(
        game
            ? "PASS: mode switch restores the saved capture without inference"
            : "PASS: stable live tensors per window; zero at terminal disposal",
    );
} catch (error) {
    report.failure = String(error?.stack ?? error);
    throw error;
} finally {
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    if (socket?.readyState === WebSocket.OPEN && send)
        await Promise.race([send("Browser.close").catch(() => {}), wait(3000)]);
    socket?.close();
    if (browser && browser.exitCode === null) browser.kill();
}
