import {
    arrangeTranscription,
    transcriptionMidi,
} from "../../core/arrangement.js";
import { AppError } from "../../core/message.js";
import { noteName } from "../../core/music.js";
import {
    assertNotAborted,
    TranscriptionError,
} from "../../core/transcription/errors.js";
import { TranscriptionJob } from "../../core/transcription/job.js";
import {
    MAX_AUDIO_SECONDS,
    MAX_FILE_BYTES,
    SAMPLE_RATE,
    TRANSCRIPTION_ENGINES,
} from "../../core/transcription/config.js";
import { numberedKey, numberedPitch } from "../../core/teaching/score.js";
import { t } from "../../i18n/i18n.js";
import { byId, download, el, reportErrors } from "../dom.js";
import { formatClock, formatDecimal } from "../format.js";
import { createAudition } from "./audition.js";
import { TranscriptionStore } from "../../core/storage/transcription-store.js";
import { workingNotes } from "../../core/transcription/melody-edit.js";
import { createMelodyEditor } from "./melody-editor.js";

const LEVELS = ["starter", "melody", "fuller", "original"];
const PREVIEW_NOTES = 64;
const FIRST_NOTE_MAX = 103;
const MAX_URL_LENGTH = 2048;
const SAVED_FIELDS = [
    "transcribe-start",
    "transcribe-length",
    "transcribe-engine",
    "transcribe-language",
    "transcribe-bpm",
    "transcribe-origin",
    "transcribe-transpose",
    "transcribe-min-pitch",
    "transcribe-max-pitch",
    "transcribe-audition-mode",
    "transcribe-audition-volume",
    "transcribe-url",
];

/**
 * Transcribe tab: local audio → Basic Pitch notes → draft arrangements for practice.
 * Recognizer notes stay immutable in captures. Working melody edits and
 * arrangement settings never rerun inference or overwrite the recognizer draft.
 */
export function initTranscribePage({ notice, getOffset, loadPracticeFile }) {
    let sourceUrl = null,
        decoded = null,
        sourceName = "",
        clipMs = 0,
        job = 0,
        phase = "idle",
        melodyNotes = null,
        level = "starter",
        arrangements = null,
        selected = null,
        context = null,
        importController = null,
        importSeq = 0,
        importing = false;
    const report = reportErrors((error) => notice(error, true));
    const captures = new Map();
    const storage = new TranscriptionStore();
    let sourceId = null,
        storageRevision = 0,
        restoreAllowed = true,
        pageGone = false;
    const task = new TranscriptionJob({
        // reportErrors defers the callback, so read the live snapshot here
        // instead of rendering a queued stale one. While a job is working,
        // render every update; otherwise only terminal snapshots may render
        // (they only hide/freeze) — a stale "running" state can never revive
        // status text or the diagnostic line after cancel/source change.
        onUpdate: report(() => {
            const snapshot = task.snapshot;
            if (phase === "working" || snapshot.status !== "running")
                renderJob(snapshot);
        }),
    });

    const audioContext = () => (context ??= new AudioContext());
    const audition = createAudition(audioContext, refreshAuditionButton);
    const currentCapture = () =>
        captures.get(
            captureKey(
                byId("transcribe-engine").value,
                byId("transcribe-language").value,
            ),
        );
    const editor = createMelodyEditor({
        host: byId("transcribe-editor"),
        getContext: audioContext,
        piano: audition,
        getBuffer: () => decoded,
        getVolume: () => Number(byId("transcribe-audition-volume").value) / 100,
        pauseSource,
        getName: () => baseName(),
        onError: (error) =>
            showError(
                error?.key ? t(error.key, error.params) : String(error.message),
            ),
        onChange: (notes) => {
            const capture = currentCapture();
            if (!capture || phase !== "idle") return;
            const next = { ...capture };
            if (notes === null) delete next.editedNotes;
            else next.editedNotes = notes;
            captures.set(
                captureKey(
                    byId("transcribe-engine").value,
                    byId("transcribe-language").value,
                ),
                next,
            );
            melodyNotes = workingNotes(next);
            showError("");
            renderResults();
            saveState();
        },
    });
    const firstNote = () => 60 + getOffset();

    function storageStatus(key) {
        if (pageGone) return;
        const node = byId("transcribe-storage-status");
        node.dataset.i18n = `transcribe.storage.${key}`;
        node.textContent = t(node.dataset.i18n);
        byId("transcribe-storage-clear").disabled =
            key === "restoring" || key === "clearing";
    }

    function savedState(id) {
        return {
            version: 1,
            sourceId: id,
            level,
            settings: Object.fromEntries(
                SAVED_FIELDS.map((key) => [key, byId(key).value]),
            ),
            captures: [...captures],
        };
    }

    function commitSave(operation, id) {
        const revision = ++storageRevision;
        storageStatus("saving");
        let promise;
        try {
            promise = operation();
        } catch {
            storageStatus("unavailable");
            return;
        }
        void promise
            .then((saved) => {
                if (sourceId !== id || revision !== storageRevision) return;
                if (saved === false) {
                    sourceId = null;
                    storageStatus("conflict");
                } else storageStatus("saved");
            })
            .catch(() => {
                if (sourceId === id && revision === storageRevision)
                    storageStatus("unavailable");
            });
    }

    function saveState() {
        if (!sourceId || pageGone) return;
        const id = sourceId,
            state = savedState(id);
        commitSave(() => storage.saveState(id, state), id);
    }

    function saveSource(file) {
        const id = crypto.randomUUID();
        sourceId = id;
        const source = { version: 1, id, name: file.name, blob: file };
        const state = savedState(id);
        commitSave(() => storage.replace(source, state), id);
    }

    function applySavedDraft(record) {
        for (const key of SAVED_FIELDS) {
            if (typeof record.state.settings[key] === "string")
                byId(key).value = record.state.settings[key];
        }
        if (LEVELS.includes(record.state.level)) level = record.state.level;
        for (const button of byId("transcribe-levels").querySelectorAll(
            ".transcribe-level",
        ))
            button.setAttribute(
                "aria-pressed",
                String(button.dataset.level === level),
            );
        for (const [key, capture] of record.state.captures)
            captures.set(key, {
                ...capture,
                clipStartMs:
                    capture.clipStartMs ??
                    Number(record.state.settings["transcribe-start"] || 0) *
                        1000,
                clipMs: capture.clipMs,
                notes: Object.freeze(
                    capture.notes.map((note) => Object.freeze({ ...note })),
                ),
            });
        sourceId = record.source.id;
        const capture = captures.get(
            captureKey(
                byId("transcribe-engine").value,
                byId("transcribe-language").value,
            ),
        );
        byId("transcribe-origin").max = String(
            Math.round(capture?.clipMs ?? 0),
        );
        const volume = Number(byId("transcribe-audition-volume").value);
        audition.setVolume(volume / 100);
        byId("transcribe-audition-volume-value").value = `${volume}%`;
        selectEngine(false);
        storageStatus("restored");
    }

    async function restoreDraft() {
        const request = job;
        storageStatus("restoring");
        try {
            const record = await storage.load();
            if (!restoreAllowed || pageGone || request !== job) return;
            if (!record) {
                storageStatus("empty");
                return;
            }
            const file = new File([record.source.blob], record.source.name, {
                type: record.source.blob.type,
            });
            if (
                !(await loadSource(file, { restored: record })) &&
                restoreAllowed &&
                !pageGone
            )
                storageStatus("unavailable");
        } catch {
            if (restoreAllowed && !pageGone && request === job)
                storageStatus("unavailable");
        }
    }

    async function clearSavedDraft() {
        if (!window.confirm(t("transcribe.storage.confirmClear"))) return;
        restoreAllowed = false;
        storageRevision++;
        sourceId = null;
        if (importController) cancelImport(true);
        invalidate();
        resetResults();
        releaseSource();
        decoded = null;
        sourceName = "";
        clipMs = 0;
        byId("transcribe-file").value = "";
        byId("transcribe-url").value = "";
        byId("transcribe-clip").hidden = true;
        controls();
        storageStatus("clearing");
        try {
            await storage.clear();
            storageStatus("empty");
        } catch {
            storageStatus("deleteFailed");
        }
    }

    function showError(text) {
        const node = byId("transcribe-error");
        node.textContent = text;
        node.hidden = !text;
    }

    function showWarning(text) {
        const node = byId("transcribe-warning");
        node.textContent = text;
        node.hidden = !text;
    }

    function hideDiagnostic() {
        byId("transcribe-diagnostic").hidden = true;
    }

    // New source, clip edit, cancel or page leave: stale jobs must never land.
    // The job controller owns the single 1 s clock; its onUpdate drives every
    // snapshot render, including the diagnostic line's elapsed/idle refresh.
    function invalidate() {
        job++;
        task.cancel();
        editor.stop();
        audition.stop();
        phase = "idle";
        byId("transcribe-cancel").hidden = true;
        byId("transcribe-status").textContent = "";
        hideDiagnostic();
        controls();
    }

    function resetResults(clearCaptures = true) {
        if (clearCaptures) captures.clear();
        melodyNotes = null;
        arrangements = null;
        selected = null;
        byId("transcribe-results").hidden = true;
        byId("transcribe-preview").replaceChildren();
        byId("transcribe-stats").textContent = "";
        showWarning("");
        editor.render(null);
    }

    function captureKey(engine, language) {
        return engine === "game" ? `${engine}:${language}` : "basic-pitch";
    }

    function selectEngine(persist = true) {
        invalidate();
        resetResults(false);
        showError("");
        const saved = captures.get(
            captureKey(
                byId("transcribe-engine").value,
                byId("transcribe-language").value,
            ),
        );
        if (saved) {
            melodyNotes = workingNotes(saved);
            clipMs = saved.clipMs;
            byId("transcribe-origin").max = String(Math.round(clipMs));
            byId("transcribe-results").hidden = false;
            byId("transcribe-status").textContent = t(
                "transcribe.status.done",
                { count: melodyNotes.length },
            );
            renderResults();
        }
        controls();
        if (persist) saveState();
    }

    function pauseSource() {
        try {
            byId("transcribe-source").pause();
        } catch {
            /* nothing playing */
        }
    }

    function releaseSource() {
        if (sourceUrl) URL.revokeObjectURL(sourceUrl);
        sourceUrl = null;
        const audio = byId("transcribe-source");
        try {
            audio.pause();
        } catch {
            /* nothing playing */
        }
        audio.removeAttribute("src");
        audio.hidden = true;
        byId("transcribe-source-name").textContent = "";
    }

    function controls() {
        byId("transcribe-engine").disabled = phase !== "idle" || importing;
        byId("transcribe-language").disabled =
            phase !== "idle" ||
            importing ||
            byId("transcribe-engine").value !== "game";
        byId("transcribe-run").disabled =
            !decoded || phase !== "idle" || importing;
        byId("transcribe-cancel").hidden = phase !== "working";
        for (const id of ["transcribe-start", "transcribe-length"])
            byId(id).disabled = !decoded || importing;
        byId("transcribe-fetch").disabled = importing;
        byId("transcribe-fetch-cancel").hidden = !importing;
        updateActions();
        editor.render(currentCapture(), phase !== "idle" || importing);
    }

    // ---- source -------------------------------------------------------------------------------

    async function loadSource(file, { restored = null } = {}) {
        if (!restored) restoreAllowed = false;
        sourceId = null;
        storageRevision++;
        storageStatus("unsaved");
        invalidate();
        const request = job;
        resetResults();
        releaseSource();
        showError("");
        decoded = null;
        clipMs = 0;
        byId("transcribe-clip").hidden = true;
        controls();
        if (file.size > MAX_FILE_BYTES) {
            showError(t("transcribe.errors.tooLarge", { limit: 50 }));
            return;
        }
        sourceName = file.name;
        byId("transcribe-source-name").textContent = file.name;
        const audio = byId("transcribe-source");
        sourceUrl = URL.createObjectURL(file);
        audio.src = sourceUrl;
        audio.hidden = false;
        phase = "decoding";
        byId("transcribe-status").textContent = t("transcribe.status.decoding");
        controls();
        const reject = (text) => {
            if (request !== job) return;
            decoded = null;
            byId("transcribe-clip").hidden = true;
            phase = "idle";
            byId("transcribe-status").textContent = "";
            showError(text);
            controls();
            return false;
        };
        try {
            if (typeof AudioContext === "undefined")
                throw new Error("no-web-audio");
            const buffer = await file.arrayBuffer();
            const decodedBuffer = await audioContext().decodeAudioData(buffer);
            if (request !== job) return;
            if (
                !Number.isFinite(decodedBuffer.duration) ||
                decodedBuffer.duration <= 0
            )
                return reject(t("transcribe.errors.decode"));
            if (decodedBuffer.duration > MAX_AUDIO_SECONDS)
                return reject(t("transcribe.errors.tooLong", { limit: 10 }));
            decoded = decodedBuffer;
            const start = byId("transcribe-start"),
                length = byId("transcribe-length");
            start.value = "0";
            start.max = String(decoded.duration);
            length.max = String(MAX_AUDIO_SECONDS);
            // Default to the whole source, rounded up to 0.1 s so the tail is
            // never clipped by the requested length.
            length.value = String(
                Math.min(
                    MAX_AUDIO_SECONDS,
                    Math.max(1, Math.ceil(decoded.duration * 10) / 10),
                ),
            );
            byId("transcribe-clip").hidden = false;
            phase = "idle";
            byId("transcribe-status").textContent = "";
            controls();
            if (restored) applySavedDraft(restored);
            else saveSource(file);
            return true;
        } catch (error) {
            return reject(
                t(
                    error.message === "no-web-audio"
                        ? "transcribe.errors.noAudio"
                        : "transcribe.errors.decode",
                ),
            );
        }
    }

    // ---- URL import ---------------------------------------------------------------------------

    const importError = (code, detail = "") => ({ code, detail });

    function importErrorText(error) {
        const code =
            error instanceof TypeError
                ? "server-missing"
                : (error?.code ?? "unknown");
        const detail = error?.detail
            ? ` (${String(error.detail).slice(0, 200)})`
            : "";
        const key = `transcribe.url.errors.${code}`;
        const text = t(key, { detail });
        return text === key
            ? t("transcribe.url.errors.unknown", { detail })
            : text;
    }

    function finishImport() {
        importing = false;
        importController = null;
        byId("transcribe-fetch-status").textContent = "";
        controls();
    }

    function cancelImport(quiet = false) {
        importSeq++;
        const hadImport = Boolean(importController);
        if (importController) {
            try {
                importController.abort();
            } catch {
                /* already aborted */
            }
            importController = null;
        }
        importing = false;
        if (hadImport) {
            // Kill any in-flight source decode and drop the canceled link's
            // preview so stale audio can never enable transcription.
            invalidate();
            decoded = null;
            sourceName = "";
            releaseSource();
            byId("transcribe-clip").hidden = true;
        }
        byId("transcribe-fetch-status").textContent = quiet
            ? ""
            : t("transcribe.url.status.cancelled");
        controls();
    }

    function importFileName(response) {
        let name;
        try {
            name = decodeURIComponent(
                response.headers.get("X-Audio-Name") || "",
            );
        } catch {
            name = response.headers.get("X-Audio-Name") || "";
        }
        name = name
            // eslint-disable-next-line no-control-regex -- strips control chars from the header name
            .replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);
        const extension = response.headers.get("content-type")?.includes("flac")
            ? ".flac"
            : ".wav";
        if (!name) name = `imported-audio${extension}`;
        if (!/\.(wav|flac)$/i.test(name)) name += extension;
        return name;
    }

    async function fetchAudio() {
        if (importing) return;
        const input = byId("transcribe-url"),
            url = input.value.trim();
        if (!url) {
            showError(t("transcribe.url.errors.empty"));
            input.focus();
            return;
        }
        if (url.length > MAX_URL_LENGTH) {
            showError(t("transcribe.url.errors.tooLongUrl"));
            return;
        }
        importSeq++;
        restoreAllowed = false;
        sourceId = null;
        storageRevision++;
        storageStatus("unsaved");
        const seq = importSeq;
        invalidate();
        resetResults();
        // A link import replaces the source immediately — a failed or canceled
        // fetch must not silently keep an unrelated older file playable.
        decoded = null;
        sourceName = "";
        releaseSource();
        byId("transcribe-clip").hidden = true;
        showError("");
        pauseSource();
        importing = true;
        importController = new AbortController();
        byId("transcribe-fetch").disabled = true;
        byId("transcribe-fetch-cancel").hidden = false;
        byId("transcribe-fetch-status").textContent = t(
            "transcribe.url.status.fetching",
        );
        controls();
        try {
            const status = await fetch("/api/audio-import/status", {
                signal: importController.signal,
            });
            if (seq !== importSeq) return;
            const statusType = status.headers.get("content-type") || "";
            if (!status.ok || !statusType.includes("json"))
                throw importError("server-missing");
            const info = await status.json();
            if (seq !== importSeq) return;
            if (info && info.ready === false)
                throw importError(
                    "unavailable",
                    (info.missing || []).join(", "),
                );
            const response = await fetch("/api/audio-import", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url }),
                signal: importController.signal,
            });
            if (seq !== importSeq) return;
            const contentType = response.headers.get("content-type") || "";
            if (!response.ok) {
                let data = null;
                if (contentType.includes("json"))
                    data = await response.json().catch(() => null);
                const code = data?.error?.code;
                throw importError(
                    typeof code === "string" && code ? code : "server-missing",
                    data?.error?.message,
                );
            }
            if (!/audio|wav|octet-stream/i.test(contentType))
                throw importError("server-missing");
            const blob = await response.blob();
            if (seq !== importSeq) return;
            if (!blob.size) throw importError("empty-result");
            if (blob.size > MAX_FILE_BYTES) throw importError("too-large");
            const file = new File([blob], importFileName(response), {
                type: contentType.includes("flac") ? "audio/flac" : "audio/wav",
            });
            await loadSource(file);
        } catch (error) {
            if (seq !== importSeq || error?.name === "AbortError") return;
            showError(importErrorText(error));
        } finally {
            if (seq === importSeq) finishImport();
        }
    }

    // ---- transcription ------------------------------------------------------------------------

    function jobStatusText({ stage, progress }) {
        switch (stage) {
            case "initializing":
                return t("transcribe.status.initializing");
            case "loading":
                return t("transcribe.status.loading");
            case "warming":
                return t("transcribe.status.warming");
            case "transcribing":
                return t("transcribe.status.working", {
                    percent: formatDecimal((progress ?? 0) * 100, 1),
                });
            case "extracting":
                return t("transcribe.status.extracting");
            default:
                return t("transcribe.status.clipping");
        }
    }

    function backendLabel(backend) {
        if (backend === "webgl") return t("transcribe.diag.backendWebgl");
        if (backend === "cpu") return t("transcribe.diag.backendCpu");
        if (backend) return String(backend).slice(0, 64);
        return t("transcribe.diag.backendPending");
    }

    function diagnosticText(snapshot) {
        const windows = snapshot.totalWindows
            ? t("transcribe.diag.windows", {
                  done: snapshot.completedWindows,
                  total: snapshot.totalWindows,
              })
            : t("transcribe.diag.windowsUnknown");
        let text = [
            t("transcribe.diag.backend", {
                backend: backendLabel(snapshot.backend),
            }),
            windows,
            t("transcribe.diag.elapsed", {
                time: formatClock(snapshot.elapsedMs),
            }),
            t("transcribe.diag.idle", {
                time: formatClock(snapshot.lastActivityAgeMs),
            }),
        ].join(" · ");
        if (snapshot.stalled) text += ` — ${t("transcribe.diag.stalled")}`;
        return text;
    }

    function renderJob(snapshot) {
        const status = byId("transcribe-status");
        if (snapshot.status === "running") {
            const text = jobStatusText(snapshot);
            if (status.textContent !== text) status.textContent = text;
        }
        const diagnostic = byId("transcribe-diagnostic");
        diagnostic.hidden = snapshot.status !== "running";
        if (snapshot.status === "running")
            diagnostic.textContent = diagnosticText(snapshot);
        byId("transcribe-diagnostics").disabled = !snapshot.jobId;
    }

    function transcriptionErrorText(error) {
        if (error instanceof AppError) {
            const text = t(error.key, error.params);
            if (text !== error.key) return text;
            // Unknown structured code: never leak the raw translation key —
            // fall back to the worker-style message with bounded detail.
            const reason = [error.code, error.detail]
                .filter(Boolean)
                .join(": ")
                .slice(0, 500);
            return t("transcribe.errors.worker", {
                reason: reason || error.key,
            });
        }
        return t("transcribe.errors.worker", {
            reason: String(error?.message ?? error).slice(0, 500),
        });
    }

    async function run() {
        if (!decoded || phase !== "idle") return;
        const startInput = byId("transcribe-start"),
            lengthInput = byId("transcribe-length"),
            start = Number(startInput.value),
            length = Number(lengthInput.value);
        if (
            startInput.value.trim() === "" ||
            lengthInput.value.trim() === "" ||
            !Number.isFinite(start) ||
            start < 0 ||
            start >= decoded.duration ||
            !Number.isFinite(length) ||
            length < 1 ||
            length > MAX_AUDIO_SECONDS
        ) {
            showError(t("transcribe.errors.invalidClip"));
            return;
        }
        const actualSeconds = Math.min(length, decoded.duration - start);
        const engine = byId("transcribe-engine").value;
        const language = byId("transcribe-language").value;
        const sampleRate =
            TRANSCRIPTION_ENGINES[engine]?.sampleRate ?? SAMPLE_RATE;
        if (
            currentCapture()?.editedNotes !== undefined &&
            !window.confirm(t("transcribe.editor.confirmRerun"))
        )
            return;
        // Capture the decoded buffer now: preparation is async and a later
        // source change must never swap the PCM under a running job.
        const audioBuffer = decoded;
        resetResults(false);
        invalidate();
        const request = job;
        showError("");
        pauseSource();
        phase = "working";
        clipMs = 0;
        byId("transcribe-status").textContent = t("transcribe.status.clipping");
        controls();
        try {
            const notes = await task.start(
                async (signal) => {
                    const offline = new OfflineAudioContext(
                        1,
                        Math.ceil(actualSeconds * sampleRate),
                        sampleRate,
                    );
                    const source = offline.createBufferSource();
                    source.buffer = audioBuffer;
                    source.connect(offline.destination);
                    source.start(0, start, actualSeconds);
                    const rendered = await offline.startRendering();
                    assertNotAborted(signal);
                    const samples = Float32Array.from(
                        rendered.getChannelData(0),
                    );
                    clipMs = (samples.length / sampleRate) * 1000;
                    if (samples.every((sample) => sample === 0))
                        throw new TranscriptionError("silence");
                    const origin = byId("transcribe-origin");
                    origin.max = String(Math.round(clipMs));
                    if (Number(origin.value) > clipMs) origin.value = "0";
                    if (engine === "game") return samples;
                    // Missing vendor files must fail loudly here, not hang inside the worker.
                    const runtimeUrl = new URL(
                        "../../../vendor/transcription-runtime.js",
                        import.meta.url,
                    ).href;
                    const modelUrl = new URL(
                        "../../../vendor/basic-pitch/model.json",
                        import.meta.url,
                    ).href;
                    const [runtimeOk, modelOk] = await Promise.all(
                        [runtimeUrl, modelUrl].map((url) =>
                            fetch(url, { method: "HEAD", signal })
                                .then((response) => response.ok)
                                .catch((error) => {
                                    if (error?.name === "AbortError")
                                        throw error;
                                    return false;
                                }),
                        ),
                    );
                    assertNotAborted(signal);
                    if (!runtimeOk || !modelOk)
                        throw new TranscriptionError("build");
                    return samples;
                },
                { engine, language },
            );
            if (request !== job) return;
            // A valid empty detection is not an empty draft card: surface the
            // translated guidance and keep results/actions hidden.
            if (!notes.length) throw new AppError("transcribe.errors.noNotes");
            melodyNotes = Object.freeze(
                notes.map((note) => Object.freeze({ ...note })),
            );
            captures.set(captureKey(engine, language), {
                notes: melodyNotes,
                clipMs,
                clipStartMs: start * 1000,
            });
            if (engine === "game")
                byId("transcribe-audition-mode").value = "original";
            phase = "idle";
            byId("transcribe-results").hidden = false;
            byId("transcribe-status").textContent = t(
                "transcribe.status.done",
                { count: melodyNotes.length },
            );
            hideDiagnostic();
            renderResults();
            controls();
            saveState();
        } catch (error) {
            if (request !== job || error?.name === "AbortError") return;
            phase = "idle";
            byId("transcribe-status").textContent = "";
            hideDiagnostic();
            showError(transcriptionErrorText(error));
            controls();
        }
    }

    function cancel() {
        invalidate();
        byId("transcribe-status").textContent = t(
            "transcribe.status.cancelled",
        );
    }

    // ---- arrangements -------------------------------------------------------------------------

    function readSettings() {
        const number = (id, min, max, integer = false) => {
            const input = byId(id),
                value = Number(input.value);
            return input.value !== "" &&
                Number.isFinite(value) &&
                value >= min &&
                value <= max &&
                (!integer || Number.isInteger(value))
                ? value
                : null;
        };
        const settings = {
            level,
            bpm: number("transcribe-bpm", 20, 240),
            firstNote: firstNote(),
            transpose: number("transcribe-transpose", -12, 12, true),
            originMs: number("transcribe-origin", 0, Math.round(clipMs)),
            minPitch: number("transcribe-min-pitch", 0, 127, true),
            maxPitch: number("transcribe-max-pitch", 0, 127, true),
        };
        if (
            settings.bpm === null ||
            settings.transpose === null ||
            settings.originMs === null ||
            settings.minPitch === null ||
            settings.maxPitch === null ||
            settings.maxPitch < settings.minPitch
        )
            return { error: t("transcribe.errors.settings") };
        if (
            !Number.isInteger(settings.firstNote) ||
            settings.firstNote < 0 ||
            settings.firstNote > FIRST_NOTE_MAX
        )
            return {
                error: t("transcribe.errors.firstNote", {
                    note: settings.firstNote,
                }),
            };
        return { settings };
    }

    function renderResults() {
        editor.stop();
        audition.stop();
        editor.render(currentCapture(), phase !== "idle" || importing);
        arrangements = null;
        selected = null;
        const { settings, error } = melodyNotes ? readSettings() : {};
        if (melodyNotes && !error) {
            try {
                arrangements = {};
                for (const key of LEVELS)
                    arrangements[key] = arrangeTranscription(melodyNotes, {
                        ...settings,
                        level: key,
                    });
                selected = arrangements[level];
            } catch {
                return renderResultsError(t("transcribe.errors.settings"));
            }
            const out = selected.stats.outOfRange;
            showWarning(
                out > 0 ? t("transcribe.outOfRange", { count: out }) : "",
            );
            renderLevelCounts();
            renderStats();
            renderPreview();
            updateActions();
            return;
        }
        if (error) return renderResultsError(error);
        updateActions();
    }

    function renderResultsError(error) {
        showWarning(error);
        renderLevelCounts();
        byId("transcribe-stats").textContent = "";
        byId("transcribe-preview").replaceChildren(
            el("p", t("transcribe.previewFix"), "muted"),
        );
        updateActions();
    }

    function renderLevelCounts() {
        for (const button of byId("transcribe-levels").querySelectorAll(
            ".transcribe-level",
        )) {
            const count = arrangements?.[button.dataset.level]?.notes.length;
            button.querySelector(".transcribe-level-count").textContent =
                count === undefined
                    ? ""
                    : t("transcribe.notesCount", { count });
        }
    }

    function renderStats() {
        if (!selected) return;
        const { stats, bpm, sourceBpm } = selected;
        byId("transcribe-stats").textContent = t("transcribe.stats", {
            source: stats.source,
            output: stats.output,
            filtered: stats.filtered,
            reduced: stats.reduced,
            omitted: stats.omittedMainKeys,
            octave: stats.octaveAdjusted,
            shift: stats.octaveShift,
            out: stats.outOfRange,
            bpm: formatDecimal(bpm, 2),
            assumption: formatDecimal(sourceBpm, 2),
        });
    }

    function renderPreview() {
        const box = byId("transcribe-preview");
        box.replaceChildren();
        const notes = selected?.notes ?? [];
        if (!selected) return;
        if (!notes.length) {
            box.append(el("p", t("transcribe.emptyVersion"), "muted"));
            return;
        }
        const key = numberedKey(); // fixed 1=C; no key detection happens here
        for (const note of notes.slice(0, PREVIEW_NOTES)) {
            const pitch = numberedPitch(note.note, key),
                token = el("span", "", "transcribe-note");
            token.title = `${noteName(note.note)} · ${formatDecimal(note.timeMs / 1000, 2)} s`;
            token.append(
                el(
                    "span",
                    pitch.octave > 0 ? "·".repeat(pitch.octave) : "",
                    "transcribe-note-dots",
                ),
                el("span", pitch.digit, "score-digit"),
                el(
                    "span",
                    pitch.octave < 0 ? "·".repeat(-pitch.octave) : "",
                    "transcribe-note-dots",
                ),
            );
            box.append(token);
        }
        if (notes.length > PREVIEW_NOTES)
            box.append(
                el(
                    "span",
                    t("transcribe.previewMore", {
                        count: notes.length - PREVIEW_NOTES,
                    }),
                    "muted",
                ),
            );
    }

    function updateActions() {
        const notes = selected?.notes ?? [];
        const playable = notes.length > 0;
        byId("transcribe-audition").disabled = !auditionNotes()?.length;
        byId("transcribe-audition-mode").disabled = !melodyNotes?.length;
        byId("transcribe-download").disabled = !playable;
        byId("transcribe-download-original").disabled =
            !arrangements?.original?.notes.length;
        byId("transcribe-practice").disabled =
            !playable || selected.stats.outOfRange > 0;
        byId("transcribe-download-raw").disabled =
            !currentCapture()?.notes.length;
        refreshAuditionButton();
    }

    // ---- outputs -------------------------------------------------------------------------------

    function baseName() {
        return sourceName.replace(/\.[^.]+$/, "") || "transcription";
    }

    function midiBytes(arranged, key) {
        return transcriptionMidi(arranged.notes, {
            bpm: arranged.bpm,
            name: `${baseName()} · ${key}`,
        });
    }

    function refreshAuditionButton() {
        byId("transcribe-audition").textContent = t(
            audition.loading
                ? "transcribe.auditionLoading"
                : audition.active
                  ? "transcribe.auditionStop"
                  : "transcribe.auditionPlay",
        );
    }

    function auditionNotes() {
        return byId("transcribe-audition-mode").value === "original"
            ? melodyNotes
            : selected?.notes;
    }

    // ---- wiring --------------------------------------------------------------------------------

    function renderLevelCards() {
        const group = byId("transcribe-levels");
        group.replaceChildren();
        for (const key of LEVELS) {
            const button = el("button", "", "transcribe-level");
            button.type = "button";
            button.dataset.level = key;
            button.setAttribute("aria-pressed", String(key === level));
            button.append(
                el(
                    "span",
                    t(`transcribe.level.${key}.name`),
                    "transcribe-level-name",
                ),
                el(
                    "span",
                    t(`transcribe.level.${key}.desc`),
                    "transcribe-level-desc",
                ),
                el("span", "", "transcribe-level-count muted"),
            );
            button.addEventListener("click", () => {
                if (level === key) return;
                level = key;
                for (const node of group.querySelectorAll(".transcribe-level"))
                    node.setAttribute("aria-pressed", String(node === button));
                renderResults();
                saveState();
            });
            group.append(button);
        }
    }

    renderLevelCards();
    byId("transcribe-engine").addEventListener("change", () => selectEngine());
    byId("transcribe-language").addEventListener("change", () =>
        selectEngine(),
    );
    byId("transcribe-source").addEventListener("play", () => {
        editor.stop();
        audition.stop();
    });
    byId("transcribe-storage-clear").addEventListener(
        "click",
        report(clearSavedDraft),
    );
    for (const event of ["input", "change", "click"])
        byId("panel-transcribe").addEventListener(
            event,
            () => {
                restoreAllowed = false;
                if (
                    byId("transcribe-storage-status").dataset.i18n ===
                    "transcribe.storage.restoring"
                )
                    storageStatus("deferred");
            },
            { capture: true },
        );
    void fetch("/api/transcription/game/status", {
        signal: AbortSignal.timeout(10000),
    })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null)
        .then((status) => {
            byId("transcribe-engine-game").disabled = !status?.available;
            const key = status?.available
                ? "transcribe.engineReady"
                : "transcribe.engineMissing";
            byId("transcribe-engine-status").dataset.i18n = key;
            byId("transcribe-engine-status").textContent = t(key);
        });
    byId("transcribe-file").addEventListener(
        "change",
        report(async () => {
            if (importController) cancelImport(true);
            const file = byId("transcribe-file").files[0];
            if (file) await loadSource(file);
        }),
    );
    byId("transcribe-url").addEventListener("input", () => {
        if (importController) cancelImport(true);
    });
    byId("transcribe-url").addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.isComposing) {
            event.preventDefault();
            report(fetchAudio)();
        }
    });
    byId("transcribe-fetch").addEventListener("click", report(fetchAudio));
    byId("transcribe-fetch-cancel").addEventListener("click", () => {
        cancelImport();
        invalidate();
        byId("transcribe-status").textContent = t(
            "transcribe.status.cancelled",
        );
    });
    byId("transcribe-run").addEventListener("click", report(run));
    byId("transcribe-cancel").addEventListener("click", cancel);
    byId("transcribe-diagnostics").addEventListener(
        "click",
        report(() => {
            const diagnostics = task.getDiagnostics();
            download(
                new Blob([JSON.stringify(diagnostics, null, 2)], {
                    type: "application/json",
                }),
                `${baseName()} · diagnostics.json`,
            );
        }),
    );
    function changeClip() {
        const edited = currentCapture()?.editedNotes !== undefined;
        if (edited && !window.confirm(t("transcribe.editor.confirmClip"))) {
            const capture = currentCapture();
            byId("transcribe-start").value = String(
                (capture.clipStartMs ?? 0) / 1000,
            );
            byId("transcribe-length").value = String(capture.clipMs / 1000);
            return;
        }
        invalidate();
        resetResults();
        saveState();
    }
    // Handle input immediately so in-flight inference cannot land on a new clip.
    for (const id of ["transcribe-start", "transcribe-length"])
        for (const event of ["input", "change"])
            byId(id).addEventListener(event, changeClip);
    for (const id of [
        "transcribe-bpm",
        "transcribe-origin",
        "transcribe-transpose",
        "transcribe-min-pitch",
        "transcribe-max-pitch",
    ])
        byId(id).addEventListener("change", () => {
            renderResults();
            saveState();
        });
    for (const id of SAVED_FIELDS.filter(
        (id) =>
            ![
                "transcribe-start",
                "transcribe-length",
                "transcribe-audition-volume",
                "transcribe-audition-mode",
            ].includes(id),
    ))
        byId(id).addEventListener("input", saveState);
    byId("transcribe-audition").addEventListener(
        "click",
        report(async () => {
            if (audition.active) {
                editor.stop();
                audition.stop();
                return;
            }
            const notes = auditionNotes();
            if (notes?.length) {
                editor.stop();
                pauseSource();
                await audition.play(notes);
            }
        }),
    );
    byId("transcribe-audition-mode").addEventListener("change", () => {
        editor.stop();
        audition.stop();
        updateActions();
        saveState();
    });
    byId("transcribe-audition-volume").addEventListener("input", (event) => {
        editor.stop();
        const value = Number(event.target.value);
        audition.setVolume(value / 100);
        byId("transcribe-audition-volume-value").value = `${value}%`;
        saveState();
    });
    byId("transcribe-download").addEventListener(
        "click",
        report(() => {
            if (selected?.notes.length)
                download(
                    new Blob([midiBytes(selected, level)], {
                        type: "audio/midi",
                    }),
                    `${baseName()} · ${level}.mid`,
                );
        }),
    );
    byId("transcribe-download-original").addEventListener(
        "click",
        report(() => {
            const original = arrangements?.original;
            if (original?.notes.length)
                download(
                    new Blob([midiBytes(original, "original")], {
                        type: "audio/midi",
                    }),
                    `${baseName()} · original.mid`,
                );
        }),
    );
    byId("transcribe-download-raw").addEventListener(
        "click",
        report(() => {
            const capture = currentCapture();
            if (!capture?.notes.length) return;
            const original = arrangeTranscription(capture.notes, {
                level: "original",
            });
            download(
                new Blob([midiBytes(original, "original")], {
                    type: "audio/midi",
                }),
                `${baseName()} · recognizer-raw.mid`,
            );
        }),
    );
    byId("transcribe-practice").addEventListener(
        "click",
        report(async () => {
            if (!selected?.notes.length || selected.stats.outOfRange > 0)
                return;
            editor.stop();
            audition.stop();
            pauseSource();
            const file = new File(
                [midiBytes(selected, level)],
                `${baseName()} · ${level}.mid`,
                {
                    type: "audio/midi",
                },
            );
            if (await loadPracticeFile(file)) location.hash = "teach";
        }),
    );
    window.addEventListener("pagehide", (event) => {
        pageGone = true;
        restoreAllowed = false;
        sourceId = null;
        storageRevision++;
        importSeq++;
        try {
            importController?.abort();
        } catch {
            /* already gone */
        }
        importController = null;
        importing = false;
        // BFCache entry (persisted) keeps the job client reusable for
        // pageshow/back; a real unload disposes it so no worker can outlive
        // the page. Either way the decoded PCM is released — a cached page
        // must not pin the audio buffer.
        invalidate();
        resetResults();
        releaseSource();
        decoded = null;
        sourceName = "";
        clipMs = 0;
        byId("transcribe-clip").hidden = true;
        byId("transcribe-file").value = "";
        if (context) {
            context.close().catch(() => {});
            context = null;
        }
        controls();
        if (!event.persisted) task.dispose();
    });
    window.addEventListener("pageshow", (event) => {
        if (!event.persisted) return;
        pageGone = false;
        restoreAllowed = true;
        void restoreDraft();
    });
    controls();
    void restoreDraft();
    return {
        mappingChanged: () => {
            if (melodyNotes) renderResults();
        },
        leave: () => {
            editor.stop();
            audition.stop();
            pauseSource();
        },
    };
}
