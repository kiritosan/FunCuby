import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import * as tf from "@tensorflow/tfjs";
import {
    BasicPitch,
    noteFramesToTime,
    outputToNotesPoly,
} from "@spotify/basic-pitch";
import {
    evaluateBasicPitchFrames,
    normalizeNotes,
} from "../src/core/transcription/basic-pitch.js";

// An exact parity check against the pinned upstream implementation, not an
// accuracy benchmark. Capture the reference once; later runs reuse that data.
const RATE = 22050;
const SECONDS = 9.5;
const artifacts = resolve(".test-artifacts");
const referencePath = resolve(artifacts, "transcription-reference.json");
const reportPath = resolve(artifacts, "transcription-parity.json");
const modelUrl = new URL(
    "/vendor/basic-pitch/model.json",
    process.env.BASE_URL || "http://127.0.0.1:5173",
).href;
const digest = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");

function samplesForReference() {
    const samples = new Float32Array(Math.floor(RATE * SECONDS));
    const segments = [
        [72, 0, 1.2],
        [76, 1.4, 1.2],
        [79, 2.8, 1.6],
        [72, 4.6, 1.2],
        [76, 6, 1.2],
        [79, 7.4, 2],
    ];
    for (const [note, start, length] of segments) {
        const frequency = 440 * 2 ** ((note - 69) / 12);
        const first = Math.floor(start * RATE);
        const last = Math.min(
            samples.length,
            Math.floor((start + length) * RATE),
        );
        for (let index = first; index < last; index++) {
            const time = (index - first) / RATE;
            const envelope = Math.min(1, time / 0.008) * Math.exp(-time / 1.2);
            let value = 0;
            for (const [harmonic, gain] of [
                [1, 1],
                [2, 0.4],
                [3, 0.2],
                [4, 0.1],
            ])
                value +=
                    gain *
                    Math.sin(
                        2 * Math.PI * frequency * harmonic * time +
                            harmonic * 0.3,
                    );
            samples[index] += value * envelope * 0.22;
        }
    }
    return samples;
}

// The previous production worker's conversion, independent of the new adapter.
function referenceNotes(frames, onsets) {
    return noteFramesToTime(
        outputToNotesPoly(
            frames.map((row) => [...row]),
            onsets.map((row) => [...row]),
            0.5,
            0.3,
            8,
        ),
    )
        .map((note) => {
            const start = Math.max(0, note.startTimeSeconds * 1000);
            const end = Math.min(
                SECONDS * 1000,
                (note.startTimeSeconds + note.durationSeconds) * 1000,
            );
            return {
                note: note.pitchMidi,
                timeMs: start,
                durationMs: end - start,
                velocity: Math.max(
                    1,
                    Math.min(127, Math.round(note.amplitude * 127)),
                ),
            };
        })
        .filter(
            (note) =>
                Number.isInteger(note.note) &&
                note.note >= 0 &&
                note.note <= 127 &&
                Number.isFinite(note.timeMs) &&
                note.timeMs >= 0 &&
                Number.isFinite(note.durationMs) &&
                note.durationMs > 0 &&
                Number.isFinite(note.velocity),
        )
        .sort((a, b) => a.timeMs - b.timeMs || b.note - a.note);
}

await mkdir(artifacts, { recursive: true });
await tf.setBackend("cpu");
await tf.ready();
const samples = samplesForReference();
const inputSha256 = createHash("sha256")
    .update(
        new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
    )
    .digest("hex");
const identity = {
    schema: "funcuby-transcription-reference-v1",
    tfjs: tf.version.tfjs,
    basicPitch: "1.0.1",
    sampleRate: RATE,
    seconds: SECONDS,
    inputSha256,
};
let reference;
try {
    reference = JSON.parse(await readFile(referencePath, "utf8"));
} catch (error) {
    if (error.code !== "ENOENT") throw error;
}
if (!reference) {
    const pitch = new BasicPitch(modelUrl);
    const model = await pitch.model;
    const frames = [],
        onsets = [];
    tf.engine().startScope("reference-inference");
    try {
        await pitch.evaluateModel(
            samples,
            (frameChunk, onsetChunk) => {
                frames.push(...frameChunk);
                onsets.push(...onsetChunk);
            },
            () => {},
        );
        reference = {
            ...identity,
            frames,
            onsets,
            notes: referenceNotes(frames, onsets),
        };
        await writeFile(referencePath, JSON.stringify(reference));
    } finally {
        tf.engine().endScope();
        model.dispose();
    }
}
for (const [key, value] of Object.entries(identity))
    assert.equal(
        reference[key],
        value,
        `Reference ${key} changed; do not silently recapture it`,
    );

const beforeModel = tf.memory().numTensors;
const pitch = new BasicPitch(modelUrl);
const model = await pitch.model;
const withModel = tf.memory().numTensors;
const windows = [];
let report;
try {
    const { frames, onsets } = await evaluateBasicPitchFrames({
        tf,
        pitch,
        samples,
        onWindow: (update) => windows.push({ ...update }),
    });
    const afterInference = tf.memory().numTensors;
    const expectedFramesHash = digest(reference.frames);
    const expectedOnsetsHash = digest(reference.onsets);
    const framesHash = digest(frames);
    const onsetsHash = digest(onsets);
    assert.equal(framesHash, expectedFramesHash, "Frame activations changed");
    assert.equal(onsetsHash, expectedOnsetsHash, "Onset activations changed");
    const notes = normalizeNotes(
        noteFramesToTime(outputToNotesPoly(frames, onsets, 0.5, 0.3, 8)),
        SECONDS * 1000,
    );
    assert.deepEqual(notes, reference.notes, "Detected notes changed");
    assert.equal(
        afterInference,
        withModel,
        "Inference left live tensors behind",
    );
    const completed = windows.filter((entry) => entry.completedWindows > 0);
    assert.ok(completed.length > 1, "Expected multiple model windows");
    assert.equal(
        new Set(completed.map((entry) => entry.tensorCount)).size,
        1,
        "Live tensor count grew between model windows",
    );
    assert.equal(completed.at(-1).progress, 1);
    report = {
        ...identity,
        exactFramesMatch: true,
        exactOnsetsMatch: true,
        exactNotesMatch: true,
        framesSha256: framesHash,
        onsetsSha256: onsetsHash,
        notes,
        windows,
        tensors: { beforeModel, withModel, afterInference },
        note: "Logical TensorFlow tensor counts, not resident RAM or GPU memory",
    };
} finally {
    model.dispose();
}
report.tensors.afterDispose = tf.memory().numTensors;
assert.equal(
    report.tensors.afterDispose,
    beforeModel,
    "Model disposal left live tensors behind",
);
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(`PASS: upstream frames, onsets and notes match; ${reportPath}`);
console.log(
    "PASS: window tensor counts stay constant and terminal tensors are released",
);
