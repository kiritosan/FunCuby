import assert from "node:assert/strict";
import { test } from "node:test";
import {
    TranscriptionStore,
    validateTranscriptionDraft,
} from "../../src/core/storage/transcription-store.js";

const draft = () => ({
    source: {
        version: 1,
        id: "source-a",
        name: "song.wav",
        blob: new Blob(["audio"]),
    },
    state: {
        version: 1,
        sourceId: "source-a",
        settings: {},
        captures: [
            [
                "basic-pitch",
                {
                    clipMs: 1000,
                    notes: [
                        { note: 60, timeMs: 0, durationMs: 200, velocity: 90 },
                    ],
                },
            ],
        ],
    },
});

test("saved work requires audio bytes and matching source identity", () => {
    assert.equal(validateTranscriptionDraft(), null);
    const valid = draft();
    assert.equal(
        validateTranscriptionDraft(valid).source.blob,
        valid.source.blob,
    );
    for (const mutate of [
        (d) => {
            d.source.blob = "blob:http://old-session";
        },
        (d) => {
            d.state.sourceId = "another-song";
        },
        (d) => {
            d.state.version = 2;
        },
        (d) => {
            d.state.captures[0][1].clipMs = Infinity;
        },
        (d) => {
            d.state.captures[0][1].notes[0].note = 999;
        },
        (d) => {
            d.state.captures[0][1].clipStartMs = -1;
        },
        (d) => {
            d.state.captures[0][1].editedNotes = [
                { note: 60, timeMs: 900, durationMs: 200, velocity: 90 },
            ];
        },
    ]) {
        const invalid = draft();
        mutate(invalid);
        assert.throws(() => validateTranscriptionDraft(invalid));
    }
});

test("unavailable IndexedDB rejects without preventing later operations settling", async () => {
    const store = new TranscriptionStore({ factory: null });
    await assert.rejects(store.load(), /unavailable/);
    await assert.rejects(store.clear(), /unavailable/);
});

test("a browser-restricted IndexedDB getter does not break page construction", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        get() {
            throw new DOMException("denied", "SecurityError");
        },
    });
    try {
        const store = new TranscriptionStore();
        await assert.rejects(
            store.load(),
            (error) => error.name === "SecurityError",
        );
    } finally {
        if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
        else delete globalThis.indexedDB;
    }
});

test("blocked database opening does not leak a late successful connection", async () => {
    let operation,
        closes = 0;
    const store = new TranscriptionStore({
        factory: {
            open() {
                operation = {
                    result: {
                        close() {
                            closes++;
                        },
                    },
                };
                queueMicrotask(() => operation.onblocked());
                return operation;
            },
        },
    });
    await assert.rejects(store.load(), /blocked/);
    operation.onsuccess();
    assert.equal(closes, 1);
});
