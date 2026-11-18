import { MAX_FILE_BYTES, MAX_AUDIO_SECONDS } from "../transcription/config.js";
import { encodeResult } from "../transcription/protocol.js";
import { validateMelody } from "../transcription/melody-edit.js";

const request = (operation) =>
    new Promise((resolve, reject) => {
        operation.onsuccess = () => resolve(operation.result);
        operation.onerror = () => reject(operation.error);
    });

const CAPTURE_KEYS = new Set([
    "basic-pitch",
    "game:auto",
    "game:zh",
    "game:en",
    "game:ja",
    "game:yue",
    "game-separated:auto",
    "game-separated:zh",
    "game-separated:en",
    "game-separated:ja",
    "game-separated:yue",
]);

export function validateTranscriptionDraft({ source, state } = {}) {
    if (!source && !state) return null;
    if (
        source?.version !== 1 ||
        typeof source.id !== "string" ||
        !(source.blob instanceof Blob) ||
        !source.blob.size ||
        source.blob.size > MAX_FILE_BYTES ||
        typeof source.name !== "string"
    )
        throw new Error("Invalid saved source");
    validateDraftState(source.id, state);
    return { source, state };
}

export function validateDraftState(id, state) {
    if (
        state?.version !== 1 ||
        state.sourceId !== id ||
        !Array.isArray(state.captures) ||
        state.captures.length > CAPTURE_KEYS.size ||
        typeof state.settings !== "object" ||
        !state.settings
    )
        throw new Error("Invalid saved transcription");
    validateCaptures(state.captures);
    if (state.clipVersions !== undefined) {
        if (!Array.isArray(state.clipVersions))
            throw new Error("Invalid clip history");
        for (const [range, version] of state.clipVersions) {
            const parts = range.split("/");
            if (
                parts.length !== 2 ||
                parts.some((v) => !v || !Number.isFinite(Number(v))) ||
                !version?.settings
            )
                throw new Error("Invalid saved clip version");
            validateCaptures(version.captures);
        }
    }
}

function validateCaptures(captures) {
    if (!Array.isArray(captures) || captures.length > CAPTURE_KEYS.size)
        throw new Error("Invalid captures");
    for (const [key, capture] of captures) {
        if (
            !CAPTURE_KEYS.has(key) ||
            !Number.isFinite(capture?.clipMs) ||
            capture.clipMs <= 0 ||
            capture.clipMs > MAX_AUDIO_SECONDS * 1000 ||
            !Array.isArray(capture.notes) ||
            capture.notes.length > 600000
        )
            throw new Error("Invalid saved capture");
        encodeResult({ jobId: 1, notes: capture.notes });
        if (
            capture.clipStartMs !== undefined &&
            (!Number.isFinite(capture.clipStartMs) ||
                capture.clipStartMs < 0 ||
                capture.clipStartMs + capture.clipMs >
                    MAX_AUDIO_SECONDS * 1000 + 1)
        )
            throw new Error("Invalid saved clip offset");
        if (capture.editedNotes !== undefined)
            validateMelody(capture.editedNotes, capture.clipMs);
    }
}

// One workbench, separate from device logs. Blob + initial state commit
// atomically; later edits never rewrite the audio. Source ids stop stale tabs
// or late callbacks from attaching old notes to a replacement/deleted source.
export class TranscriptionStore {
    #factory;
    #name;
    #connection = null;
    #queue = Promise.resolve();

    constructor({ factory, name = "funcuby-transcription" } = {}) {
        this.#factory = factory;
        this.#name = name;
    }

    #open() {
        if (this.#connection) return this.#connection;
        const opening = new Promise((resolve, reject) => {
            let factory;
            try {
                factory =
                    this.#factory === undefined
                        ? globalThis.indexedDB
                        : this.#factory;
            } catch (error) {
                reject(error);
                return;
            }
            if (!factory) {
                reject(new Error("IndexedDB is unavailable"));
                return;
            }
            let settled = false;
            const fail = (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            };
            const timer = setTimeout(
                () => fail(new Error("Storage open timed out")),
                8000,
            );
            let operation;
            try {
                operation = factory.open(this.#name, 1);
            } catch (error) {
                fail(error);
                return;
            }
            operation.onupgradeneeded = () =>
                operation.result.createObjectStore("workbench");
            operation.onblocked = () =>
                fail(new Error("Storage upgrade is blocked"));
            operation.onerror = () => fail(operation.error);
            operation.onsuccess = () => {
                if (settled) {
                    operation.result.close();
                    return;
                }
                settled = true;
                clearTimeout(timer);
                const database = operation.result;
                database.onclose = () => {
                    if (this.#connection === opening) this.#connection = null;
                };
                database.onversionchange = () => {
                    database.close();
                    this.#connection = null;
                };
                resolve(database);
            };
        });
        this.#connection = opening;
        opening.catch(() => {
            if (this.#connection === opening) this.#connection = null;
        });
        return opening;
    }

    #run(mode, action) {
        const work = this.#queue
            .catch(() => {})
            .then(async () => {
                const database = await this.#open();
                return new Promise((resolve, reject) => {
                    const tx = database.transaction("workbench", mode);
                    let result;
                    tx.oncomplete = () => resolve(result);
                    tx.onabort = tx.onerror = () =>
                        reject(
                            tx.error ||
                                new Error("Storage transaction aborted"),
                        );
                    try {
                        Promise.resolve(action(tx.objectStore("workbench")))
                            .then((value) => {
                                result = value;
                            })
                            .catch((error) => {
                                try {
                                    tx.abort();
                                } catch {
                                    /* already aborted */
                                }
                                reject(error);
                            });
                    } catch (error) {
                        try {
                            tx.abort();
                        } catch {
                            /* already aborted */
                        }
                        reject(error);
                    }
                });
            });
        this.#queue = work;
        return work;
    }

    async load() {
        const [source, state] = await this.#run("readonly", (store) =>
            Promise.all([
                request(store.get("source")),
                request(store.get("state")),
            ]),
        );
        return validateTranscriptionDraft({ source, state });
    }

    replace(source, state) {
        validateTranscriptionDraft({ source, state });
        return this.#run("readwrite", async (store) => {
            const [previous, draft, titles = []] = await Promise.all(
                ["source", "state", "library"].map((key) =>
                    request(store.get(key)),
                ),
            );
            const list = titles.filter(
                (item) => item.id !== source.id && item.id !== previous?.id,
            );
            if (previous && draft && previous.id !== source.id) {
                store.put(
                    { source: previous, state: draft },
                    "song:" + previous.id,
                );
                list.unshift({ id: previous.id, name: previous.name });
            }
            store.put(list, "library");
            store.delete("song:" + source.id);
            store.put(source, "source");
            store.put(state, "state");
            return true;
        });
    }

    listSongs() {
        return this.#run(
            "readonly",
            async (store) => (await request(store.get("library"))) ?? [],
        );
    }

    loadSong(id) {
        return this.#run("readonly", async (store) =>
            validateTranscriptionDraft(await request(store.get("song:" + id))),
        );
    }

    saveState(sourceId, state) {
        return this.#run("readwrite", async (store) => {
            const source = await request(store.get("source"));
            if (
                !source ||
                source.id !== sourceId ||
                state.sourceId !== sourceId
            )
                return false;
            store.put(state, "state");
            return true;
        });
    }

    clear(expectedId) {
        return this.#run("readwrite", async (store) => {
            if (
                expectedId !== undefined &&
                ((await request(store.get("source")))?.id ?? null) !==
                    expectedId
            )
                return false;
            store.delete("source");
            store.delete("state");
            return true;
        });
    }
}
