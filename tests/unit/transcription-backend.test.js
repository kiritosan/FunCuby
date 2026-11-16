import assert from "node:assert/strict";
import { test } from "node:test";
import { transcribeSamples } from "../../src/core/transcription/basic-pitch.js";
import { TRANSCRIPTION_BACKEND } from "../../src/core/transcription/config.js";

function runtimeForBackend({ ready = true, actualBackend = "cpu" } = {}) {
    const attempts = [];
    let modelConstructed = false;
    return {
        attempts,
        get modelConstructed() {
            return modelConstructed;
        },
        runtime: {
            tf: {
                setBackend: async (name) => {
                    attempts.push(name);
                    return ready;
                },
                ready: async () => {},
                getBackend: () => actualBackend,
            },
            BasicPitch: class {
                constructor() {
                    modelConstructed = true;
                    this.model = Promise.reject(new Error("model sentinel"));
                }
            },
        },
    };
}

test("default transcription uses CPU without attempting WebGL", async () => {
    const fake = runtimeForBackend();
    const statuses = [];
    assert.equal(TRANSCRIPTION_BACKEND, "cpu");
    await assert.rejects(
        transcribeSamples({
            samples: new Float32Array([0.1, 0.2]),
            runtime: fake.runtime,
            modelUrl: "/model.json",
            onStatus: (status) => statuses.push(status),
        }),
        (error) => error.code === "model",
    );
    assert.deepEqual(fake.attempts, ["cpu"]);
    assert.equal(fake.modelConstructed, true);
    assert.equal(
        statuses.find((status) => status.stage === "loading").backend,
        "cpu",
    );
});

test("CPU initialization failure does not silently fall back to WebGL", async () => {
    const fake = runtimeForBackend({ ready: false });
    await assert.rejects(
        transcribeSamples({
            samples: new Float32Array([0.1]),
            runtime: fake.runtime,
            modelUrl: "/model.json",
        }),
        (error) => error.code === "backend",
    );
    assert.deepEqual(fake.attempts, ["cpu"]);
    assert.equal(fake.modelConstructed, false);
});

test("backend mismatch fails before running the model", async () => {
    const fake = runtimeForBackend({ actualBackend: "webgl" });
    await assert.rejects(
        transcribeSamples({
            samples: new Float32Array([0.1]),
            runtime: fake.runtime,
            modelUrl: "/model.json",
        }),
        (error) =>
            error.code === "backend" && /Expected cpu/.test(error.detail),
    );
    assert.equal(fake.modelConstructed, false);
});
