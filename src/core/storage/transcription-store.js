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
        state?.version !== 1 ||
        typeof source.id !== "string" ||
        source.id !== state.sourceId ||
        !(source.blob instanceof Blob) ||
        !source.blob.size ||
        source.blob.size > MAX_FILE_BYTES ||
        typeof source.name !== "string" ||
        !Array.isArray(state.captures) ||
        state.captures.length > CAPTURE_KEYS.size ||
        typeof state.settings !== "object" ||
        !state.settings
    )
        throw new Error("Invalid saved transcription");
    for (const [key, capture] of state.captures) {
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
    return { source, state };
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
        return this.#run("readwrite", (store) => {
            store.put(source, "source");
            store.put(state, "state");
            return true;
        });
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

    clear() {
        return this.#run("readwrite", (store) => {
            store.clear();
        });
    }
}
