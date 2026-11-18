import { byId, el } from "../dom.js";
import { t } from "../../i18n/i18n.js";
import {
    MAX_AUDIO_SECONDS,
    MAX_FILE_BYTES,
} from "../../core/transcription/config.js";
import { TranscriptionJob } from "../../core/transcription/job.js";
import { analyzeMelody } from "../../core/transcription/musical-analysis.js";
import { prepareAudio } from "./prepare-audio.js";
import { vocalKey } from "../../core/storage/disk-library.js";

export function createSongBatch({
    storage,
    audioContext,
    getFields,
    foregroundBusy,
    firstNote,
    onChange,
    openSong,
    describe,
    errorText,
    fetchSong,
}) {
    const items = [];
    let running = 0,
        imports = Promise.resolve();
    const mode = byId("transcribe-batch-mode");
    const language = byId("transcribe-batch-language");
    const list = byId("transcribe-batch-list");
    const input = byId("transcribe-batch-files");
    const msg = (key) => t("transcribe.disk." + key);
    function display(item, status, detail) {
        item.status = status;
        item.row.dataset.state = status;
        item.statusText.textContent = detail ?? msg(status);
        const action = {
            importing: "cancel",
            queued: "cancel",
            running: "cancel",
            done: "open",
            failed: "retry",
            cancelled: "retry",
        }[status];
        item.button.hidden = !action;
        item.button.textContent = action ? msg(action) : "";
    }
    async function decode(file) {
        const audio = await audioContext().decodeAudioData(
            await file.arrayBuffer(),
        );
        if (
            !Number.isFinite(audio.duration) ||
            audio.duration <= 0 ||
            audio.duration > MAX_AUDIO_SECONDS
        )
            throw new Error(t("transcribe.errors.tooLong", { limit: 10 }));
        return audio;
    }
    async function process(item) {
        const { id, engine, language: lang } = item;
        const file = item.file ?? (await storage.loadSong(id))?.source.blob;
        if (!file) throw new Error(msg("missing"));
        const audio = item.audio ?? (await decode(file));
        item.audio = null;
        if (item.cancelled) return;
        const duration = audio.duration;
        const state = item.state;
        state.settings["transcribe-length"] = String(
            Math.max(1, Math.ceil(duration * 10) / 10),
        );
        let clipMs,
            stemWrite = Promise.resolve(),
            stemError;
        const task = new TranscriptionJob({
            onUpdate: (s) => {
                if (item.status === "running" && s.status === "running")
                    display(item, "running", describe(s));
            },
            onVocalStem: (blob) => {
                if (!blob) {
                    stemError = new Error(msg("stemFailed"));
                    return;
                }
                stemWrite = storage
                    .saveStem(id, vocalKey(0, clipMs), blob)
                    .catch((e) => {
                        stemError = e;
                    });
            },
        });
        item.task = task;
        try {
            let notes;
            while (!item.cancelled) {
                try {
                    notes = await task.start(
                        async (signal) => {
                            const prepared = await prepareAudio(
                                audio,
                                0,
                                duration,
                                engine,
                                signal,
                            );
                            clipMs = prepared.clipMs;
                            return prepared.samples;
                        },
                        { engine, language: lang },
                    );
                    break;
                } catch (e) {
                    if (e.code !== "busy" || item.cancelled) throw e;
                    display(item, "running", msg("waitingSlot"));
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                }
            }
            await stemWrite;
            if (item.cancelled) return;
            if (!notes?.length) throw new Error(t("transcribe.errors.noNotes"));
            const key = engine === "basic-pitch" ? engine : engine + ":" + lang;
            state.captures = [[key, { notes, clipMs, clipStartMs: 0 }]];
            const fit = analyzeMelody(notes, {
                clipMs,
                firstNote: state.firstNote,
            });
            state.settings["transcribe-transpose"] = String(
                fit.whiteKeyTranspose,
            );
            if (fit.confidence >= 0.2) {
                state.settings["transcribe-bpm"] = String(fit.bpm);
                state.settings["transcribe-origin"] = String(fit.originMs);
            }
            display(item, "saving");
            if (!(await storage.saveState(id, state)))
                throw new Error(t("transcribe.storage.conflict"));
            state.captures = [];
            display(
                item,
                "done",
                stemError ? msg("done") + " · " + msg("stemFailed") : undefined,
            );
        } finally {
            task.dispose();
            item.task = null;
        }
    }
    function pump() {
        while (running < (foregroundBusy() ? 1 : 2)) {
            const item = items.find((i) => i.status === "queued");
            if (!item) break;
            running++;
            item.processing = true;
            display(item, "running", t("transcribe.status.decoding"));
            void process(item)
                .catch((e) => {
                    if (!item.cancelled)
                        display(
                            item,
                            "failed",
                            e.key ? errorText(e) : e.message,
                        );
                })
                .finally(() => {
                    if (item.cancelled) display(item, "cancelled");
                    item.file = null;
                    item.audio = null;
                    item.processing = false;
                    running--;
                    void onChange();
                    pump();
                });
        }
    }
    function cancel(item) {
        item.cancelled = true;
        item.audio = null;
        item.request?.abort();
        item.task?.cancel();
        display(item, "cancelled");
        if (!item.task && item.persisted) item.file = null;
    }
    function add(sources, engine, lang) {
        for (const source of sources) {
            const url = typeof source === "string" ? source : "";
            const id = crypto.randomUUID();
            const settings = {
                ...getFields().settings,
                "transcribe-engine": engine,
                "transcribe-language": lang,
                "transcribe-start": "0",
                "transcribe-length": "600",
                "transcribe-url": url,
                "transcribe-bpm": "120",
                "transcribe-origin": "0",
                "transcribe-transpose": "0",
            };
            const row = el("li"),
                label = el("strong", url || source.name),
                statusText = el("span"),
                button = el("button");
            const summary = el("div");
            summary.append(label, statusText);
            row.append(summary, button);
            list.append(row);
            const state = {
                version: 1,
                sourceId: id,
                captures: [],
                level: "starter",
                settings,
                firstNote: firstNote(),
            };
            const item = {
                id,
                engine,
                language: lang,
                state,
                file: url ? null : source,
                row,
                button,
                statusText,
                cancelled: false,
            };
            items.push(item);
            let generation = 0;
            function enqueueImport() {
                const attempt = ++generation;
                display(item, "importing", msg("queued"));
                imports = imports.then(async () => {
                    if (attempt !== generation || item.cancelled) return;
                    item.request = new AbortController();

                    try {
                        display(
                            item,
                            "importing",
                            url
                                ? t("transcribe.url.status.fetching")
                                : t("transcribe.status.decoding"),
                        );
                        const file = url
                            ? await fetchSong(url, item.request.signal)
                            : source;
                        if (attempt !== generation || item.cancelled) return;
                        label.textContent = file.name;
                        item.file = file;
                        if (!file.size || file.size > MAX_FILE_BYTES)
                            throw new Error(
                                t("transcribe.errors.tooLarge", { limit: 50 }),
                            );
                        const audio = await decode(file);
                        if (attempt !== generation || item.cancelled) return;
                        display(item, "saving");
                        state.settings["transcribe-length"] = String(
                            Math.max(1, Math.ceil(audio.duration * 10) / 10),
                        );
                        if (running < 2) item.audio = audio;
                        await storage.replace(
                            { version: 1, id, name: file.name, blob: file },
                            state,
                        );
                        item.persisted = true;
                        if (!item.cancelled) display(item, "queued");
                        void onChange();
                        pump();
                    } catch (e) {
                        if (attempt === generation && !item.cancelled)
                            display(item, "failed", e.message);
                    } finally {
                        item.request = null;
                    }
                });
            }
            enqueueImport();
            button.onclick = async () => {
                if (item.status === "done") {
                    try {
                        await openSong(id);
                    } catch (e) {
                        item.statusText.textContent = e.message;
                    }
                    return;
                }
                if (["importing", "queued", "running"].includes(item.status)) {
                    cancel(item);
                    void onChange();
                    return;
                }
                if (item.task || item.processing) return;
                item.cancelled = false;
                if (!item.persisted) {
                    enqueueImport();
                } else {
                    display(item, "queued");
                    pump();
                }
            };
        }
    }
    byId("transcribe-batch-add").onclick = () => input.click();
    input.onchange = () => {
        add(Array.from(input.files), mode.value, language.value);
        input.value = "";
    };
    const links = byId("transcribe-batch-urls");
    const importLinks = byId("transcribe-batch-import");
    links.oninput = () => {
        importLinks.disabled = !links.value.trim();
    };
    importLinks.onclick = () => {
        const urls = [
            ...new Set(
                links.value
                    .split(/\r?\n/)
                    .map((s) => s.trim())
                    .filter(Boolean),
            ),
        ];
        add(urls, mode.value, language.value);
        links.value = "";
        importLinks.disabled = true;
    };
    let modes = "";
    return {
        pump,
        get full() {
            return running >= 2;
        },
        add,
        isActive: (id) =>
            items.some(
                (i) =>
                    i.id === id &&
                    ["importing", "saving", "queued", "running"].includes(
                        i.status,
                    ),
            ),
        syncModes(picker) {
            const signature =
                Array.from(picker.options, (o) =>
                    [o.value, o.disabled, o.textContent].join("|"),
                ).join(",") + picker.value;
            if (signature === modes) return;
            modes = signature;
            const last = mode.value;
            mode.replaceChildren(
                ...Array.from(picker.options, (o) => {
                    const option = new Option(o.textContent, o.value);
                    option.disabled = o.disabled;
                    return option;
                }),
            );
            mode.value =
                Array.from(mode.options).some(
                    (o) => o.value === last && !o.disabled,
                ) && mode.dataset.chosen
                    ? last
                    : picker.value;
            mode.onchange = () => {
                mode.dataset.chosen = "1";
                language.disabled = mode.value === "basic-pitch";
            };
            language.replaceChildren(
                ...Array.from(
                    byId("transcribe-language").options,
                    (o) => new Option(o.textContent, o.value),
                ),
            );
            language.value =
                language.dataset.chosen ?? byId("transcribe-language").value;
            language.onchange = () => {
                language.dataset.chosen = language.value;
            };
            language.disabled = mode.value === "basic-pitch";
        },
        cancelAll() {
            for (const item of items)
                if (
                    ["importing", "saving", "running", "queued"].includes(
                        item.status,
                    )
                )
                    cancel(item);
        },
    };
}
