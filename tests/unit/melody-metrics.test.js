import assert from "node:assert/strict";
import { test } from "node:test";
import {
    evaluateAutoStarter,
    evaluateNotes,
    evaluateStarter,
    starterPlayability,
} from "../../scripts/melody-metrics.mjs";

const note = (pitch, timeMs, durationMs = 200) => ({
    note: pitch,
    timeMs,
    durationMs,
    velocity: 96,
});

test("a long note only matches one repeat and octave errors stay in the miss/extra counts", () => {
    const reference = [
        note(60, 0),
        note(60, 250),
        note(64, 500),
        note(65, 900),
    ];
    const detected = [
        note(60, 10, 450),
        note(76, 515),
        note(69, 700),
        note(65, 950),
    ];
    const result = evaluateNotes(reference, detected);
    assert.equal(result.matched, 2);
    assert.equal(result.missed, 2);
    assert.equal(result.extra, 2);
    assert.equal(result.longNotes, 1);
    assert.equal(result.octaveErrors, 1);
    assert.equal(result.onsetMeanAbsMs, 30);
    assert.equal(result.f1, 0.5);
    assert.equal(
        evaluateNotes([note(60, 0, 500)], [note(60, 0, 300)]).earlyReleases,
        1,
    );
});

test("note pairing maximizes coverage before preferring small onset errors", () => {
    const reference = [note(60, 100), note(60, 140)];
    const detected = [note(60, 135)];
    assert.equal(evaluateNotes(reference, detected).onsetMeanAbsMs, 5);
    assert.equal(
        evaluateNotes(reference, [...detected, note(60, 190)]).matched,
        2,
    );
    assert.equal(evaluateNotes(reference, []).recall, 0);
});

test("starter measures the calibrated main keys, overlap and spacing", () => {
    const raw = [note(62, 100, 70), note(64, 110, 70), note(63, 200)];
    assert.deepEqual(starterPlayability(raw, 62), {
        offMainKeys: 1,
        maxSimultaneous: 2,
        maxMainKeyJump: 1,
        minOnsetGapMs: 10,
        mainKeySolo: false,
    });
    const phrase = [note(62, 0, 400), note(64, 600, 400), note(66, 1200, 400)];
    const result = evaluateStarter(phrase, phrase, {
        firstNote: 62,
        bpm: 100,
        originMs: 0,
        transpose: 0,
    });
    assert.equal(result.notes.f1, 1);
    assert.equal(result.playability.mainKeySolo, true);
    const settings = { firstNote: 62, bpm: 100, originMs: 0, transpose: 0 };
    assert.equal(
        evaluateAutoStarter(phrase, phrase, settings, {
            ...settings,
            transpose: 12,
        }).pitchClassOnset.f1,
        1,
    );
    assert.equal(starterPlayability([], 62).mainKeySolo, false);
    assert.equal(
        starterPlayability([note(62, 0, 400 + 1e-9), note(64, 400)], 62)
            .maxSimultaneous,
        1,
    );
});
