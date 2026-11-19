import {
    arrangeTranscription,
    PLAYABLE_VERSIONS as LEVELS,
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
    TRANSCRIPTION_ENGINES,
} from "../../core/transcription/config.js";
import { numberedKey, numberedPitch } from "../../core/teaching/score.js";
import { t } from "../../i18n/i18n.js";
import { byId, download, el, reportErrors } from "../dom.js";
import { formatClock, formatDecimal } from "../format.js";
import { createAudition, phrasePreviewIndex } from "./audition.js";
import { phraseRanges } from "../../core/transcription/phrase-ranges.js";
import { markSoundingNotes } from "./sounding-notes.js";
import { DiskLibrary, vocalKey } from "../../core/storage/disk-library.js";
import { prepareAudio } from "./prepare-audio.js";
import { createSongBatch } from "./song-batch.js";
import { workingNotes } from "../../core/transcription/melody-edit.js";
import { analyzeMelody } from "../../core/transcription/musical-analysis.js";
import { createMelodyEditor } from "./melody-editor.js";
import { createPipelineView, pipelineWindows } from "./pipeline-view.js";

const PREVIEW_NOTES = 64;
const FIRST_NOTE_MAX = 103;
const MAX_URL_LENGTH = 2048;
const ENGINE_PREFERENCE = "transcribe:engine";
const TRIAL_SECONDS = 25;
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
    "transcribe-audition-volume",
    "transcribe-harmony",
    "transcribe-url",
];

/**
 * Transcribe tab: local audio → Basic Pitch notes → draft arrangements for practice.
 * Recognizer notes stay immutable in captures. Working melody edits and
 * arrangement settings never rerun inference or overwrite the recognizer draft.
 */
export function initTranscribePage({
    notice,
    getOffset,
    loadPracticeFile,
    preferences,
}) {
    const enginePicker = byId("transcribe-engine");
    const startInput = byId("transcribe-start");
    const lengthInput = byId("transcribe-length");
    const clipFields = () => [startInput.value, lengthInput.value];
    let appliedClip = clipFields();
    let sourceUrl = null,
        decoded = null,
        sourceName = "",
        clipMs = 0,
        job = 0,
        phase = "idle",
        melodyNotes = null,
        level = "melody",
        arrangements = null,
        selected = null,
        context = null,
        importController = null,
        importSeq = 0,
        importing = false;
    let showPipeline = false,
        vocalBlob = null,
        vocalUrl = null,
        vocalRange = null,
        vocalUnavailable = false;
    const vocalAudio = byId("transcribe-vocals-audio");
    const pipeline = createPipelineView(
        byId("transcribe-pipeline"),
        byId("transcribe-pipeline-steps"),
    );
    const report = reportErrors((error) => notice(error, true));
    const captures = new Map();
    const clipVersions = new Map();
    const storage = new DiskLibrary();
    let sourceId = null,
        storageRevision = 0,
        restoreAllowed = true,
        pageGone = false,
        engineChosen = false,
        userEditedArrangement = false;
    const task = new TranscriptionJob({
        onVocalStem: (blob) => {
            if (!showPipeline || pageGone || !vocalRange) return;
            vocalUnavailable = blob === null;
            if (blob) {
                presentVocal(blob);
                const id = sourceId;
                if (id)
                    storage
                        .saveStem(
                            id,
                            vocalKey(
                                vocalRange.start,
                                vocalRange.end - vocalRange.start,
                            ),
                            blob,
                        )
                        .catch(() => {
                            if (id === sourceId)
                                showError(t("transcribe.disk.stemFailed"));
                        });
            }
            renderVocal();
            if (currentCapture())
                editor.render(currentCapture(), phase !== "idle");
        },
        // reportErrors defers the callback, so read the live snapshot here
        // instead of rendering a queued stale one. While a job is working,
        // render every update; otherwise only terminal snapshots may render
        // to freeze the progress display. A stale "running" state cannot
        // revive the status text after a cancellation or source change.
        onUpdate: report(() => {
            const snapshot = task.snapshot;
            if (phase === "working" || snapshot.status !== "running")
                renderJob(snapshot);
        }),
    });

    const audioContext = () => (context ??= new AudioContext());
    let scorePlayback = null;
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
        getBeat: () => ({
            bpm: byId("transcribe-bpm").valueAsNumber,
            originMs: byId("transcribe-origin").valueAsNumber,
        }),
        getBuffer: () => decoded,
        vocalHintKey: () =>
            vocalUnavailable && enginePicker.value === "game-separated"
                ? "vocalMissing"
                : "vocalHint",
        getVocalStem: (capture) => {
            if (!vocalBlob) return null;
            const start = capture.clipStartMs ?? 0;
            return Math.abs(vocalRange.start - start) <= 1 &&
                Math.abs(vocalRange.end - start - capture.clipMs) <= 1
                ? vocalBlob
                : null;
        },
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

    const batch = createSongBatch({
        storage,
        audioContext,
        getFields: () => savedState(null),
        foregroundBusy: () => phase === "working",
        firstNote,
        onChange: refreshLibrary,
        openSong,
        describe: jobStatusText,
        fetchSong: async (url, signal) => {
            try {
                return await fetchAudioFile(url, signal);
            } catch (e) {
                if (signal.aborted) throw e;
                throw new Error(importErrorText(e), { cause: e });
            }
        },
        errorText: transcriptionErrorText,
    });
    const panel = byId("panel-transcribe");
    function switchView(view) {
        if (
            view === "library" &&
            byId("transcribe-show-library").getClientRects().length
        ) {
            editor.stop();
            audition.stop();
            pauseSource();
        }
        panel.dataset.view = view;
        for (const key of ["work", "library"])
            byId("transcribe-show-" + key).setAttribute(
                "aria-pressed",
                String(view === key),
            );
    }
    for (const view of ["work", "library"])
        byId("transcribe-show-" + view).addEventListener("click", () =>
            switchView(view),
        );
    byId("transcribe-edit-source").addEventListener("click", () => {
        byId("transcribe-setup").open = true;
        byId("transcribe-pick-file").focus();
    });
    function storageStatus(key) {
        if (pageGone) return;
        const node = byId("transcribe-storage-status");
        node.dataset.i18n = `transcribe.storage.${key}`;
        node.textContent = t(node.dataset.i18n);
        byId("transcribe-storage-clear").disabled =
            !sourceId || key === "restoring" || key === "clearing";
    }

    function savedState(id) {
        return {
            version: 1,
            sourceId: id,
            level,
            firstNote: firstNote(),
            settings: Object.fromEntries(
                SAVED_FIELDS.map((key) => [key, byId(key).value]),
            ),
            captures: [...captures],
            clipVersions: [...clipVersions],
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

    let libraryRead = 0;
    async function refreshLibrary() {
        const revision = ++libraryRead;
        const songs = await storage.listSongs().catch(() => null);
        if (revision !== libraryRead || pageGone) return;
        const picker = byId("transcribe-library");
        byId("transcribe-library-empty").hidden =
            songs === null || songs.length > 0;
        if (!songs) return;
        byId("transcribe-library-choice").hidden = !songs.length;
        picker.replaceChildren(new Option(t("transcribe.openSong"), ""));
        for (const song of songs) {
            const option = new Option(song.name, song.id);
            option.disabled = batch.isActive(song.id);
            picker.add(option);
        }
        picker.value = sourceId ?? "";
        byId("transcribe-disk-path").textContent = sourceId
            ? [storage.directory, sourceId].join(
                  storage.directory.includes("\\") ? "\\" : "/",
              )
            : storage.directory;
        picker.disabled = !songs.length || phase !== "idle" || importing;
    }
    async function openSong(id) {
        if (!id || batch.isActive(id) || phase !== "idle" || importing) return;
        invalidate();
        const request = job;
        const record = await storage.loadSong(id);
        if (!record || request !== job) return;
        await loadSource(
            new File([record.source.blob], record.source.name, {
                type: record.source.blob.type,
            }),
            { restored: record, activate: true },
        );
    }
    byId("transcribe-library").addEventListener(
        "change",
        report((e) => openSong(e.target.value)),
    );
    function saveSource(file) {
        const id = crypto.randomUUID();
        sourceId = id;
        storage.select(id);
        const source = { version: 1, id, name: file.name, blob: file };
        const state = savedState(id);
        commitSave(
            () =>
                storage.replace(source, state).then((ok) => {
                    void refreshLibrary();
                    return ok;
                }),
            id,
        );
    }

    function applySavedDraft(record) {
        byId("transcribe-harmony").value = "off";
        for (const [key, version] of record.state.clipVersions ?? [])
            clipVersions.set(key, version);
        for (const key of SAVED_FIELDS) {
            const value = record.state.settings[key];
            if (typeof value !== "string") continue;
            if (key === "transcribe-engine") {
                if (!Object.hasOwn(TRANSCRIPTION_ENGINES, value)) continue;
                engineChosen = true;
            }
            byId(key).value = value;
        }
        appliedClip = clipFields();
        setLevel(
            LEVELS.includes(record.state.level) ? record.state.level : "melody",
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
        userEditedArrangement = true;
        selectEngine(false);
        byId("transcribe-setup").open = !capture;
        storageStatus("restored");
    }

    async function restoreDraft() {
        const request = job;
        storageStatus("restoring");
        try {
            await storage.migrateLegacy();
            void refreshLibrary();
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
        if (importController) cancelImport(true);
        invalidate();
        const request = job;
        storageRevision++;
        storageStatus("clearing");
        try {
            const cleared = await storage.clear(sourceId);
            if (job !== request || pageGone) return;
            if (!cleared) {
                storageStatus("conflict");
                return;
            }
        } catch {
            storageStatus("deleteFailed");
            return;
        }
        clipVersions.clear();
        sourceId = null;
        byId("transcribe-setup").open = true;
        resetResults();
        releaseSource();
        decoded = null;
        sourceName = "";
        clipMs = 0;
        byId("transcribe-file").value = "";
        byId("transcribe-url").value = "";
        byId("transcribe-clip").hidden = true;
        controls();
        storageStatus("empty");
        void refreshLibrary();
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
        byId("transcribe-diagnostic-options").hidden = true;
        job++;
        showPipeline = false;
        pipeline.reset();
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
        if (clearCaptures) {
            captures.clear();
            userEditedArrangement = false;
            clearVocal();
        }
        melodyNotes = null;
        arrangements = null;
        selected = null;
        byId("transcribe-results").hidden = true;
        byId("transcribe-preview").replaceChildren();
        byId("transcribe-stats").textContent = "";
        byId("transcribe-analysis").textContent = "";
        showWarning("");
        editor.render(null);
    }

    function captureKey(engine, language) {
        return engine === "basic-pitch"
            ? "basic-pitch"
            : `${engine}:${language}`;
    }

    function applyMusicalFit() {
        if (!melodyNotes?.length) return;
        const analysis = analyzeMelody(melodyNotes, {
            clipMs,
            firstNote: firstNote(),
        });
        if (analysis.confidence >= 0.2) {
            byId("transcribe-bpm").value = String(analysis.bpm);
            byId("transcribe-origin").value = String(analysis.originMs);
        }
        byId("transcribe-transpose").value = String(analysis.whiteKeyTranspose);
    }

    function selectEngine(persist = true) {
        invalidate();
        resetResults(false);
        vocalAudio.pause();
        renderVocal();
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
        if (decoded) void restoreVocal();
        controls();
        if (persist) saveState();
    }

    function pauseSource() {
        vocalAudio.pause();
        try {
            byId("transcribe-source").pause();
        } catch {
            /* nothing playing */
        }
    }

    function presentVocal(blob) {
        vocalBlob = blob;
        vocalUrl = URL.createObjectURL(blob);
        vocalAudio.src = vocalUrl;
        const link = byId("transcribe-vocals-download");
        link.href = vocalUrl;
        link.download = `${baseName()} · vocals.wav`;
    }
    async function restoreVocal() {
        const capture = currentCapture();
        if (
            (!capture && enginePicker.value !== "game-separated") ||
            !sourceId ||
            vocalUrl
        )
            return;
        const id = sourceId,
            request = job;
        const start = capture?.clipStartMs ?? Number(startInput.value) * 1000;
        const duration =
            capture?.clipMs ??
            Math.min(
                Number(lengthInput.value),
                decoded.duration - start / 1000,
            ) * 1000;
        try {
            const blob = await storage.loadStem(id, vocalKey(start, duration));
            if (id !== sourceId || request !== job || vocalUrl) return;
            if (!blob && !capture) return;
            vocalRange = { start, end: start + duration };
            vocalUnavailable = !blob;
            if (blob) presentVocal(blob);
            renderVocal();
            editor.render(currentCapture(), phase !== "idle");
        } catch {
            if (id === sourceId && request === job)
                showError(t("transcribe.disk.stemFailed"));
        }
    }

    function renderVocal() {
        const visible =
            !!vocalRange &&
            (enginePicker.value === "game-separated" || !!vocalUrl);
        byId("transcribe-vocals").hidden = !visible;
        byId("transcribe-vocals-actions").hidden = !vocalUrl;
        if (!visible) return;
        const key = vocalUrl
            ? "ready"
            : vocalUnavailable
              ? "unavailable"
              : "waiting";
        const text = t(`transcribe.vocals.${key}`, {
            start: formatClock(vocalRange.start),
            end: formatClock(vocalRange.end),
        });
        const status = byId("transcribe-vocals-status");
        if (status.textContent !== text) status.textContent = text;
    }

    function clearVocal() {
        if (vocalUrl) {
            vocalAudio.pause();
            vocalAudio.removeAttribute("src");
            vocalAudio.load();
            byId("transcribe-vocals-download").removeAttribute("href");
            URL.revokeObjectURL(vocalUrl);
        }
        vocalUrl = null;
        vocalBlob = null;
        vocalRange = null;
        vocalUnavailable = false;
        renderVocal();
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
        const historyPicker = byId("transcribe-clip-history");
        const keys = [...clipVersions.keys()];
        historyPicker.parentElement.hidden = !keys.length;
        if (historyPicker.dataset.keys !== JSON.stringify(keys)) {
            historyPicker.dataset.keys = JSON.stringify(keys);
            historyPicker.replaceChildren(
                new Option(t("transcribe.returnClip"), ""),
            );
            for (const key of keys) {
                const [from, length] = key.split("/").map(Number);
                historyPicker.add(
                    new Option(
                        formatClock(from * 1000) +
                            " – " +
                            formatClock(
                                Math.min(
                                    decoded?.duration ?? Infinity,
                                    from + length,
                                ) * 1000,
                            ),
                        key,
                    ),
                );
            }
        }
        historyPicker.disabled = phase !== "idle" || importing;
        byId("transcribe-method").textContent = t(
            "transcribe.method." + enginePicker.value,
        );
        const library = byId("transcribe-library");
        library.disabled =
            library.options.length <= 1 || phase !== "idle" || importing;
        const pick = byId("transcribe-pick-file");
        pick.classList.toggle("primary", !decoded);
        pick.textContent = t(
            decoded
                ? "transcribe.workspace.changeFile"
                : "transcribe.chooseAudio",
        );
        byId("transcribe-drop-hint").hidden = !!decoded;
        byId("transcribe-mode-name").textContent =
            enginePicker.selectedOptions[0]?.textContent ?? "";
        const guide = {
            "basic-pitch": "engineBasicGuide",
            game: "engineGameGuide",
            "game-separated": "engineGameSeparatedGuide",
        };
        byId("transcribe-current-guide").textContent = t(
            "transcribe." + guide[enginePicker.value],
        );
        enginePicker.disabled = phase !== "idle" || importing;
        byId("transcribe-language").disabled =
            phase !== "idle" ||
            importing ||
            enginePicker.value === "basic-pitch";
        const runDisabled =
            !decoded ||
            phase !== "idle" ||
            importing ||
            enginePicker.selectedOptions[0]?.disabled;
        for (const id of [
            "transcribe-run",
            "transcribe-trial",
            "transcribe-whole",
        ])
            byId(id).disabled = runDisabled;
        byId("transcribe-whole").hidden =
            !decoded ||
            (startInput.valueAsNumber === 0 &&
                lengthInput.valueAsNumber >= decoded.duration);
        const start = startInput.valueAsNumber,
            length = lengthInput.valueAsNumber;
        const remaining = (decoded?.duration ?? 0) - start;
        const validRange =
            decoded &&
            start >= 0 &&
            remaining > 0 &&
            length >= 1 &&
            length <= MAX_AUDIO_SECONDS;
        const whole = validRange && start === 0 && length >= remaining;
        const trial = byId("transcribe-trial"),
            run = byId("transcribe-run");
        trial.hidden =
            phase === "working" ||
            (validRange &&
                Math.abs(
                    Math.min(length, remaining) -
                        Math.min(TRIAL_SECONDS, remaining),
                ) < 0.001);
        run.hidden = phase === "working";
        run.textContent = t(
            whole ? "transcribe.whole" : "transcribe.workspace.runClip",
        );
        run.classList.toggle("primary", trial.hidden || !whole);
        trial.classList.toggle("primary", !trial.hidden && whole);
        byId("transcribe-range-label").textContent = validRange
            ? formatClock(start * 1000) +
              " – " +
              formatClock((start + Math.min(length, remaining)) * 1000)
            : "";
        byId("transcribe-extend").hidden = byId("transcribe-whole").hidden;
        byId("transcribe-extend").disabled = runDisabled;
        byId("transcribe-cancel").hidden = phase !== "working";
        for (const id of ["transcribe-start", "transcribe-length"])
            byId(id).disabled = !decoded || importing || phase === "decoding";
        byId("transcribe-pick-file").disabled = phase === "working";
        byId("transcribe-fetch").disabled = importing || phase === "working";
        batch.setCanOpen(phase === "idle" && !importing);
        batch.syncModes(enginePicker);
        batch.pump();
        byId("transcribe-fetch-cancel").hidden = !importing;
        updateActions();
        editor.render(currentCapture(), phase !== "idle" || importing);
    }

    // ---- source -------------------------------------------------------------------------------

    async function loadSource(
        file,
        { restored = null, activate = false } = {},
    ) {
        if (!restored) restoreAllowed = false;
        invalidate();
        const request = job;
        showError("");
        if (file.size > MAX_FILE_BYTES) {
            showError(t("transcribe.errors.tooLarge", { limit: 50 }));
            return false;
        }
        phase = "decoding";
        byId("transcribe-status").textContent = t("transcribe.status.decoding");
        controls();
        const reject = (text) => {
            if (request !== job) return;
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
            resetResults();
            clipVersions.clear();
            setLevel("melody");
            byId("transcribe-harmony").value = "off";
            releaseSource();
            sourceId = null;
            storageRevision++;
            storageStatus("unsaved");
            sourceName = file.name;
            byId("transcribe-source-name").textContent = sourceName;
            const audio = byId("transcribe-source");
            sourceUrl = URL.createObjectURL(file);
            audio.src = sourceUrl;
            audio.hidden = false;
            byId("transcribe-setup").open = true;
            byId("transcribe-review").open = false;
            decoded = decodedBuffer;
            byId("transcribe-mode-options").open = true;
            startInput.value = "0";
            startInput.max = String(decoded.duration);
            lengthInput.max = String(MAX_AUDIO_SECONDS);
            // Default to the whole source, rounded up to 0.1 s so the tail is
            // never clipped by the requested length.
            lengthInput.value = String(requestedLength(decoded.duration));
            appliedClip = clipFields();
            byId("transcribe-clip").hidden = false;
            phase = "idle";
            byId("transcribe-status").textContent = "";
            controls();
            if (restored) {
                applySavedDraft(restored);
                storage.select(restored.source.id);
                if (activate) {
                    switchView("work");
                    byId(
                        currentCapture()
                            ? "transcribe-score-title"
                            : "transcribe-source-heading",
                    ).focus();
                }
                void refreshLibrary();
            } else saveSource(file);
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
        if (hadImport) invalidate();
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

    async function fetchAudioFile(url, signal) {
        if (url.length > MAX_URL_LENGTH) throw importError("tooLongUrl");
        const status = await fetch("/api/audio-import/status", {
            signal,
        });
        assertNotAborted(signal);
        const statusType = status.headers.get("content-type") || "";
        if (!status.ok || !statusType.includes("json"))
            throw importError("server-missing");
        const info = await status.json();
        assertNotAborted(signal);
        if (info && info.ready === false)
            throw importError("unavailable", (info.missing || []).join(", "));
        const response = await fetch("/api/audio-import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
            signal,
        });
        assertNotAborted(signal);
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
        assertNotAborted(signal);
        if (!blob.size) throw importError("empty-result");
        if (blob.size > MAX_FILE_BYTES) throw importError("too-large");
        return new File([blob], importFileName(response), {
            type: contentType.includes("flac") ? "audio/flac" : "audio/wav",
        });
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
        const seq = importSeq;
        invalidate();
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
            const file = await fetchAudioFile(url, importController.signal);
            if (seq !== importSeq) return;
            await loadSource(file);
        } catch (error) {
            if (seq !== importSeq || error?.name === "AbortError") return;
            showError(importErrorText(error));
        } finally {
            if (seq === importSeq) finishImport();
        }
    }

    // ---- transcription ------------------------------------------------------------------------

    function jobStatusText(snapshot) {
        const { stage, progress, engine } = snapshot;
        const windows = pipelineWindows(
            snapshot,
            stage === "separating"
                ? "separate"
                : engine === "basic-pitch"
                  ? "browser"
                  : "game",
        );
        const percent = formatDecimal(
            (windows ? windows.done / windows.total : (progress ?? 0)) * 100,
            1,
        );
        switch (stage) {
            case "initializing":
                return t("transcribe.status.initializing");
            case "loading":
                return t("transcribe.status.loading");
            case "warming":
                return t("transcribe.status.warming");
            case "separating":
                return t("transcribe.status.separating", {
                    percent,
                });
            case "loading-game":
                return t("transcribe.status.loadingGame");
            case "transcribing":
                return t("transcribe.status.working", {
                    percent,
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
        byId("transcribe-diagnostic-options").hidden = !(
            showPipeline && snapshot.jobId
        );
        if (showPipeline) pipeline.render(snapshot);
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
        const startedFromSetup = byId("transcribe-setup").contains(
            document.activeElement,
        );
        const start = Number(startInput.value),
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
        if (
            currentCapture()?.editedNotes !== undefined &&
            !window.confirm(t("transcribe.editor.confirmRerun"))
        )
            return;
        engineChosen = true;
        preferences.set(ENGINE_PREFERENCE, engine);
        // Capture the decoded buffer now: preparation is async and a later
        // source change must never swap the PCM under a running job.
        const audioBuffer = decoded;
        resetResults(false);
        invalidate();
        const request = job;
        showPipeline = true;
        if (engine === "game-separated") {
            clearVocal();
            vocalRange = {
                start: start * 1000,
                end: (start + actualSeconds) * 1000,
            };
            renderVocal();
        }
        showError("");
        pauseSource();
        byId("transcribe-setup").open = true;
        byId("transcribe-progress-detail").open = true;
        phase = "working";
        clipMs = 0;
        byId("transcribe-status").textContent = t("transcribe.status.clipping");
        controls();
        try {
            while (batch.full) {
                byId("transcribe-status").textContent = t(
                    "transcribe.disk.waitingSlot",
                );
                await new Promise((resolve) => setTimeout(resolve, 200));
                if (request !== job) return;
            }
            const notes = await task.start(
                async (signal) => {
                    const prepared = await prepareAudio(
                        audioBuffer,
                        start,
                        actualSeconds,
                        engine,
                        signal,
                    );
                    const { samples } = prepared;
                    clipMs = prepared.clipMs;
                    const origin = byId("transcribe-origin");
                    origin.max = String(Math.round(clipMs));
                    if (Number(origin.value) > clipMs) origin.value = "0";
                    if (engine !== "basic-pitch") return samples;
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
            if (engine === "game-separated" && !vocalUrl) {
                vocalUnavailable = true;
                renderVocal();
            }
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
            if (!userEditedArrangement) applyMusicalFit();

            const moveFocus =
                startedFromSetup &&
                !panel.hidden &&
                byId("transcribe-work").getClientRects().length &&
                (document.activeElement === document.body ||
                    byId("transcribe-setup").contains(document.activeElement));
            byId("transcribe-setup").open = false;
            byId("transcribe-progress-detail").open = false;
            phase = "idle";
            byId("transcribe-results").hidden = false;
            byId("transcribe-status").textContent = t(
                "transcribe.status.done",
                { count: melodyNotes.length },
            );
            hideDiagnostic();
            renderResults();
            controls();
            if (moveFocus) byId("transcribe-score-title").focus();
            saveState();
        } catch (error) {
            if (request !== job || error?.name === "AbortError") return;
            phase = "idle";
            if (engine === "game-separated" && !vocalUrl) {
                vocalUnavailable = true;
                renderVocal();
            }
            byId("transcribe-status").textContent = "";
            hideDiagnostic();
            showError(transcriptionErrorText(error));
            controls();
        }
    }

    function cancel() {
        invalidate();
        showPipeline = true;
        pipeline.render(task.snapshot);
        if (!vocalUrl) clearVocal();
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
            autoHarmony: byId("transcribe-harmony").value === "auto",
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
            renderAnalysis();
            renderLevelCounts();
            renderStats();
            renderPreview();
            updateActions();
            return;
        }
        byId("transcribe-analysis").textContent = "";
        if (error) return renderResultsError(error);
        updateActions();
    }

    function renderAnalysis() {
        if (!melodyNotes?.length) {
            byId("transcribe-analysis").textContent = "";
            return;
        }
        const info = analyzeMelody(melodyNotes, {
            clipMs,
            firstNote: firstNote(),
        });
        const keyLabel = `${info.majorName} / ${info.minorName}m`;
        const shiftText =
            info.whiteKeyTranspose > 0
                ? `+${info.whiteKeyTranspose}`
                : String(info.whiteKeyTranspose);
        byId("transcribe-analysis").textContent = t("transcribe.analysis", {
            bpm: info.bpm,
            origin: info.originMs,
            key: keyLabel,
            rawFit: Math.round(info.rawMainKeyRatio * 100),
            transpose: shiftText,
            bestFit: Math.round(info.transposedMainKeyRatio * 100),
        });
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
            const dyads =
                button.dataset.level === "fuller" &&
                arrangements?.fuller.stats.dyads;
            button.querySelector(".transcribe-level-count").textContent =
                count === undefined
                    ? ""
                    : [
                          t("transcribe.notesCount", { count }),
                          dyads
                              ? t("transcribe.dyadCount", { count: dyads })
                              : "",
                          dyads && arrangements.fuller.stats.generatedHarmony
                              ? t("transcribe.generatedHarmony", {
                                    count: arrangements.fuller.stats
                                        .generatedHarmony,
                                })
                              : "",
                      ]
                          .filter(Boolean)
                          .join(" · ");
        }
    }

    function renderStats() {
        if (!selected) return;
        const { stats, bpm } = selected;
        byId("transcribe-stats").textContent = t("transcribe.stats", {
            source: stats.source,
            output: stats.output,
            filtered: stats.filtered,
            reduced: stats.reduced,
            octave: stats.octaveAdjusted,
            shift: stats.octaveShift,
            out: stats.outOfRange,
            bpm: formatDecimal(bpm, 2),
        });
    }

    function renderPreview(notes = selected?.notes ?? [], first = 0) {
        const box = byId("transcribe-preview");
        box.replaceChildren();
        if (!selected) return;
        if (!notes.length) {
            box.append(el("p", t("transcribe.emptyVersion"), "muted"));
            return;
        }
        const key = numberedKey(); // fixed 1=C; no key detection happens here
        let end = Math.min(first + PREVIEW_NOTES, notes.length);
        if (
            level === "fuller" &&
            first &&
            notes[first]?.timeMs === notes[first - 1].timeMs
        )
            first--;
        if (
            level === "fuller" &&
            end < notes.length &&
            notes[end].timeMs === notes[end - 1].timeMs
        )
            end++;
        let column;
        for (const [offset, note] of notes.slice(first, end).entries()) {
            const pitch = numberedPitch(note.note, key),
                token = el("span", "", "transcribe-note");
            token.title = `${noteName(note.note)} · ${formatDecimal(note.timeMs / 1000, 2)} s`;
            if (note.generatedHarmony)
                token.title += " · " + t("transcribe.harmonyAuto");
            token.dataset.index = String(first + offset);
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
            if (level === "fuller") {
                if (
                    !column ||
                    note.timeMs !== notes[first + offset - 1]?.timeMs
                ) {
                    column = el("span", "", "transcribe-onset");
                    box.append(column);
                }
                column.append(token);
            } else box.append(token);
        }
        if (notes.length > end)
            box.append(
                el(
                    "span",
                    t("transcribe.previewMore", {
                        count: notes.length - end,
                    }),
                    "muted",
                ),
            );
    }

    function updateActions() {
        const notes = selected?.notes ?? [];
        const playable = notes.length > 0;
        byId("transcribe-audition").disabled = !selected?.notes.length;
        byId("transcribe-compare-working").disabled = !melodyNotes?.length;
        const issues = melodyNotes?.filter((n) => n.boundary).length ?? 0;
        const cue = byId("transcribe-review-cue");
        cue.hidden = !issues;
        cue.textContent = t("transcribe.reviewCues", { count: issues });
        byId("transcribe-score-title").textContent = sourceName;
        byId("transcribe-version").textContent = selected
            ? t("transcribe.version", {
                  name: t("transcribe.level." + level + ".name"),
                  count: notes.length,
                  bpm: selected.bpm,
              })
            : "";
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
        const active = audition.active && scorePlayback;
        const playing = audition.loading
            ? "transcribe.auditionLoading"
            : "transcribe.auditionStop";
        byId("transcribe-audition").textContent = t(
            active === "version" ? playing : "transcribe.playVersion",
            { name: t("transcribe.level." + level + ".name") },
        );
        byId("transcribe-compare-working").textContent = t(
            active === "compare" ? playing : "transcribe.compareWorking",
        );
    }

    // ---- wiring --------------------------------------------------------------------------------

    function setLevel(key) {
        level = key;
        byId("transcribe-harmony-field").hidden = key !== "fuller";
        for (const node of byId("transcribe-levels").querySelectorAll(
            ".transcribe-level",
        ))
            node.setAttribute(
                "aria-pressed",
                String(node.dataset.level === key),
            );
    }

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
                setLevel(key);
                renderResults();
                saveState();
            });
            group.append(button);
        }
    }

    renderLevelCards();
    enginePicker.addEventListener("change", () => {
        engineChosen = true;
        preferences.set(ENGINE_PREFERENCE, enginePicker.value);
        selectEngine();
    });
    byId("transcribe-language").addEventListener("change", () =>
        selectEngine(),
    );
    byId("transcribe-source").addEventListener("play", () => {
        vocalAudio.pause();
        editor.stop();
        audition.stop();
    });
    vocalAudio.addEventListener("play", () => {
        byId("transcribe-source").pause();
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
            if (pageGone) return;
            byId("transcribe-engine-game").disabled = !status?.available;
            byId("transcribe-engine-game-separated").disabled = !(
                status?.available && status?.separationAvailable
            );
            const key = status?.available
                ? status?.separationAvailable
                    ? "transcribe.engineSeparatedReady"
                    : "transcribe.engineReady"
                : status?.disabled
                  ? "transcribe.engineDisabled"
                  : "transcribe.engineMissing";
            byId("transcribe-engine-status").dataset.i18n = key;
            byId("transcribe-engine-status").textContent = t(key);
            if (!engineChosen) {
                const preferred = preferences.get(ENGINE_PREFERENCE);
                const available = Array.from(enginePicker.options).some(
                    (option) => option.value === preferred && !option.disabled,
                );
                enginePicker.value = available
                    ? preferred
                    : status?.available
                      ? "game"
                      : "basic-pitch";
                saveState();
            }
            controls();
        });
    byId("transcribe-pick-file").addEventListener("click", () =>
        byId("transcribe-file").click(),
    );
    byId("transcribe-use-position").addEventListener("click", () => {
        if (decoded)
            changeClip(
                String(
                    Math.max(
                        0,
                        Math.min(
                            Math.floor(
                                byId("transcribe-source").currentTime * 10,
                            ) / 10,
                            decoded.duration - 0.1,
                        ),
                    ),
                ),
                lengthInput.value,
            );
    });
    const drop = byId("transcribe-drop");
    async function importFiles(files) {
        if (!files.length || phase === "working") return;
        if (files.length > 1) {
            batch.stage(files);
            switchView("library");
            byId("transcribe-batch").open = true;
            byId("transcribe-batch-mode").focus();
            return;
        }
        if (importController) cancelImport(true);
        await loadSource(files[0]);
    }
    for (const type of ["dragover", "drop"])
        drop.addEventListener(type, (event) => {
            if (!event.dataTransfer?.types.includes("Files")) return;
            event.preventDefault();
            const allowed = phase !== "working";
            if (type === "dragover") {
                event.dataTransfer.dropEffect = allowed ? "copy" : "none";
                drop.classList.toggle("dragging", allowed);
            } else {
                drop.classList.remove("dragging");
                if (!allowed) return;
                report(importFiles)(Array.from(event.dataTransfer.files));
            }
        });
    drop.addEventListener("dragleave", (event) => {
        if (!drop.contains(event.relatedTarget))
            drop.classList.remove("dragging");
    });
    byId("transcribe-file").addEventListener(
        "change",
        report(async (event) => {
            const input = event.target;
            const files = Array.from(input.files);
            input.value = "";
            await importFiles(files);
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
    byId("transcribe-trial").addEventListener(
        "click",
        report(async () => {
            const start = startInput.valueAsNumber;
            if (
                !decoded ||
                !Number.isFinite(start) ||
                start < 0 ||
                start >= decoded.duration
            ) {
                showError(t("transcribe.errors.invalidClip"));
                return;
            }
            const length = requestedLength(
                Math.min(TRIAL_SECONDS, decoded.duration - start),
            );
            if (changeClip(startInput.value, String(length))) await run();
        }),
    );
    byId("transcribe-extend").addEventListener("click", () =>
        byId("transcribe-whole").click(),
    );
    byId("transcribe-whole").addEventListener(
        "click",
        report(async () => {
            if (
                decoded &&
                changeClip("0", String(requestedLength(decoded.duration)))
            )
                await run();
        }),
    );
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
    byId("transcribe-clip-history").addEventListener("change", (event) => {
        const key = event.target.value;
        event.target.value = "";
        if (clipVersions.has(key)) changeClip(...key.split("/"));
    });
    function requestedLength(duration) {
        return Math.min(
            MAX_AUDIO_SECONDS,
            Math.max(1, Math.ceil(duration * 10) / 10),
        );
    }
    function changeClip(start, length) {
        const changed = start !== appliedClip[0] || length !== appliedClip[1];
        if (changed) {
            const edited = [...captures.values()].some(
                (capture) => capture.editedNotes !== undefined,
            );
            if (edited && !window.confirm(t("transcribe.editor.confirmClip"))) {
                [startInput.value, lengthInput.value] = appliedClip;
                return false;
            }
            if (captures.size)
                clipVersions.set(appliedClip.join("/"), {
                    captures: [...captures],
                    firstNote: firstNote(),
                    level,
                    settings: Object.fromEntries(
                        SAVED_FIELDS.map((id) => [id, byId(id).value]),
                    ),
                });
            const key = [start, length].join("/");
            const saved = clipVersions.get(key);
            appliedClip = [start, length];
            [startInput.value, lengthInput.value] = appliedClip;
            invalidate();
            resetResults();
            if (saved) {
                clipVersions.delete(key);
                const fields = {
                    ...saved.settings,
                    "transcribe-start": start,
                    "transcribe-length": length,
                };
                applySavedDraft({
                    source: { id: sourceId },
                    state: { ...saved, settings: fields },
                });
            }
            controls();
            saveState();
        }
        return true;
    }
    // Handle input immediately so in-flight inference cannot land on a new clip.
    for (const input of [startInput, lengthInput])
        for (const event of ["input", "change"])
            input.addEventListener(event, () => changeClip(...clipFields()));
    for (const id of [
        "transcribe-bpm",
        "transcribe-harmony",
        "transcribe-origin",
        "transcribe-transpose",
        "transcribe-min-pitch",
        "transcribe-max-pitch",
    ])
        byId(id).addEventListener("change", () => {
            if (
                [
                    "transcribe-bpm",
                    "transcribe-origin",
                    "transcribe-transpose",
                ].includes(id)
            )
                userEditedArrangement = true;
            renderResults();
            saveState();
        });
    byId("transcribe-auto-fit").addEventListener("click", () => {
        if (!melodyNotes?.length) return;
        userEditedArrangement = false;
        applyMusicalFit();
        renderResults();
        saveState();
    });
    byId("transcribe-original-key").addEventListener("click", () => {
        if (!melodyNotes?.length) return;
        userEditedArrangement = true;
        byId("transcribe-transpose").value = "0";
        renderResults();
        saveState();
    });
    for (const id of SAVED_FIELDS.filter(
        (id) =>
            ![
                "transcribe-start",
                "transcribe-length",
                "transcribe-audition-volume",
                "transcribe-harmony",
            ].includes(id),
    ))
        byId(id).addEventListener("input", saveState);
    async function playScore(notes, target) {
        if (audition.active && scorePlayback === target) {
            editor.stop();
            audition.stop();
            return;
        }

        if (notes?.length) {
            editor.stop();
            pauseSource();
            audition.stop();
            scorePlayback = target;
            let page = 0;
            if (target === "version") renderPreview(notes);
            await audition.play(notes, {
                skipIntro:
                    byId("transcribe-preview-start").value === "phrase"
                        ? "phrase"
                        : true,
                speed: Number(byId("transcribe-preview-speed").value),
                onSounding(voices) {
                    if (!voices) scorePlayback = null;
                    if (target === "compare") {
                        markSoundingNotes(
                            byId("transcribe-compare-working"),
                            byId("transcribe-compare-sounding"),
                            voices,
                        );
                        return;
                    }
                    const label = byId("transcribe-sounding");
                    if (!voices) renderPreview();
                    if (voices?.length) {
                        const first =
                            Math.floor(
                                voices.at(-1).displayIndex / PREVIEW_NOTES,
                            ) * PREVIEW_NOTES;
                        if (page !== first) {
                            page = first;
                            renderPreview(notes, page);
                        }
                    }
                    markSoundingNotes(
                        byId("transcribe-preview"),
                        label,
                        voices,
                    );
                },
            });
        }
    }
    for (const id of ["transcribe-preview-start", "transcribe-preview-speed"]) {
        byId(id).addEventListener(
            "change",
            report(() => {
                if (!scorePlayback || !audition.active) return;
                const target = scorePlayback;
                audition.stop();
                return playScore(
                    target === "version" ? selected?.notes : melodyNotes,
                    target,
                );
            }),
        );
    }
    byId("transcribe-audition").addEventListener(
        "click",
        report(() => playScore(selected?.notes, "version")),
    );
    byId("transcribe-compare-working").addEventListener(
        "click",
        report(() => playScore(melodyNotes, "compare")),
    );
    byId("transcribe-review-cue").addEventListener("click", () => {
        byId("transcribe-review").open = true;
        const next = byId("transcribe-editor").querySelector(
            '[data-action="nextBoundary"]',
        );
        next.click();
        next.focus();
        byId("transcribe-editor")
            .querySelector('[data-action="compare"]')
            .click();
    });
    byId("transcribe-review").addEventListener("toggle", () => {
        if (!byId("transcribe-review").open) {
            editor.stop();
            if (scorePlayback === "compare") audition.stop();
        }
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
            const capture = currentCapture();
            const originMs =
                level === "original"
                    ? 0
                    : Number(byId("transcribe-origin").value);
            const openingNote =
                selected.notes[phrasePreviewIndex(selected.notes)];
            const opening = phraseRanges(
                selected.notes,
                selected.durationMs,
            ).find(
                (r) =>
                    r.start <= openingNote.timeMs && openingNote.timeMs < r.end,
            );
            const start = capture.clipStartMs ?? 0;
            const stem =
                vocalRange &&
                vocalKey(
                    vocalRange.start,
                    vocalRange.end - vocalRange.start,
                ) === vocalKey(start, capture.clipMs)
                    ? vocalBlob
                    : null;
            if (
                await loadPracticeFile(file, {
                    buffer: decoded,
                    stem,
                    clipStartMs: start,
                    clipMs: capture.clipMs,
                    originMs,
                    bpm: selected.bpm,
                    transpose:
                        level === "original"
                            ? 0
                            : Number(byId("transcribe-transpose").value),
                    opening,
                })
            )
                location.hash = "teach";
        }),
    );
    window.addEventListener("pagehide", (event) => {
        batch.cancelAll();
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
    void refreshLibrary();
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
