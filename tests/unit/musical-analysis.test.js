import assert from "node:assert/strict";
import { test } from "node:test";
import {
    analyzeMelody,
    estimateKeyAndTranspose,
    estimateTempoAndOrigin,
} from "../../src/core/transcription/musical-analysis.js";
import { arrangeTranscription } from "../../src/core/arrangement.js";

const note = (pitch, timeMs, durationMs = 240, velocity = 96) => ({
    note: pitch,
    timeMs,
    durationMs,
    velocity,
});

test("estimateTempoAndOrigin recovers pop eighth-note tempo and never cuts off the first note", () => {
    const bpm = 136;
    const eighthMs = 60000 / bpm / 2;
    const pitches = [
        64, 67, 69, 67, 64, 67, 71, 72, 71, 67, 64, 67, 74, 72, 71, 69,
    ];
    const phrase = pitches.map((pitch, index) =>
        note(
            pitch,
            18 + Math.round(index * eighthMs),
            Math.round(eighthMs * 0.9),
        ),
    );
    const detected = estimateTempoAndOrigin(phrase, 10000);
    assert.ok(
        Math.abs(detected.bpm - bpm) <= 2,
        `expected ~136 BPM, received ${detected.bpm}`,
    );
    assert.ok(detected.originMs <= phrase[0].timeMs);
    assert.ok(detected.confidence > 0.5);

    const arranged = arrangeTranscription(phrase, {
        level: "starter",
        bpm: detected.bpm,
        originMs: detected.originMs,
        firstNote: 60,
    });
    assert.equal(arranged.notes[0].timeMs, 0);
    assert.ok(arranged.notes.length >= 7);
});

test("estimateKeyAndTranspose shifts G major and F major onto pocket-keyboard main keys", () => {
    // G major phrase containing F# (66)
    const gMajor = [67, 69, 71, 72, 74, 76, 66, 67, 71, 69, 66, 67].map(
        (pitch, i) => note(pitch, i * 600, 280),
    );
    const gFit = estimateKeyAndTranspose(gMajor, 60);
    assert.equal(gFit.majorName, "G");
    assert.equal(gFit.whiteKeyTranspose, 5);
    assert.equal(gFit.transposedMainKeyRatio, 1);

    // Place one note per starter beat to isolate the main-key omission rule.
    const starterRaw = arrangeTranscription(gMajor, {
        level: "starter",
        bpm: 100,
        transpose: 0,
        firstNote: 60,
    });
    const starterFit = arrangeTranscription(gMajor, {
        level: "starter",
        bpm: 100,
        transpose: gFit.whiteKeyTranspose,
        firstNote: 60,
    });
    assert.ok(starterRaw.stats.omittedMainKeys > 0);
    assert.equal(starterFit.stats.omittedMainKeys, 0);

    // F major phrase containing Bb (70) -> shifts by -5 semitones into C major
    const fMajor = [65, 67, 69, 70, 72, 74, 76, 70, 69, 67, 65].map(
        (pitch, i) => note(pitch, i * 300, 280),
    );
    const fFit = estimateKeyAndTranspose(fMajor, 60);
    assert.equal(fFit.majorName, "F");
    assert.equal(fFit.whiteKeyTranspose, -5);
    assert.equal(fFit.transposedMainKeyRatio, 1);

    // Already in C major -> keeps transpose = 0
    const cMajor = [60, 62, 64, 65, 67, 69, 71, 72].map((pitch, i) =>
        note(pitch, i * 300, 280),
    );
    const cFit = analyzeMelody(cMajor, { clipMs: 4000, firstNote: 60 });
    assert.equal(cFit.whiteKeyTranspose, 0);
    assert.equal(cFit.rawMainKeyRatio, 1);
});

test("estimateKeyAndTranspose respects calibrated non-C firstNote on the pocket keyboard", () => {
    // Song in C major, but pocket keyboard firstNote is calibrated to D4 (62):
    // shifting by +2 aligns C major onto D-based physical main keys!
    const cMajor = [60, 62, 64, 65, 67, 69, 71, 72].map((pitch, i) =>
        note(pitch, i * 300, 280),
    );
    const fit = estimateKeyAndTranspose(cMajor, 62);
    assert.equal(fit.whiteKeyTranspose, 2);
    assert.equal(fit.transposedMainKeyRatio, 1);
});
