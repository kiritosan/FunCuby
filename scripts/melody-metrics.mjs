import { arrangeTranscription } from "../src/core/arrangement.js";
import { MAIN_KEYS } from "../src/core/keyboard/layout.js";
import { ONSET_EPSILON_MS } from "../src/core/teaching/epsilon.js";

export const ONSET_TOLERANCE_MS = 50;
const round = (value) => Math.round(value * 10000) / 10000;
const endTime = (note) => note.timeMs + note.durationMs;

function groupByPitch(notes, key) {
    const groups = new Map();
    notes.forEach((note, index) => {
        const pitch = key(note);
        if (!groups.has(pitch)) groups.set(pitch, []);
        groups.get(pitch).push({ note, index });
    });
    for (const group of groups.values())
        group.sort((a, b) => a.note.timeMs - b.note.timeMs);
    return groups;
}

function matchNotes(reference, detected, key) {
    const pairs = [];
    const candidates = groupByPitch(detected, key);
    for (const [pitch, expected] of groupByPitch(reference, key)) {
        const actual = candidates.get(pitch);
        if (!actual) continue;
        // Within a pitch group, matching in time order gives a maximum
        // one-to-one match. Within that maximum, prefer smaller onset errors.
        const width = actual.length + 1;
        const scores = new Float64Array((expected.length + 1) * width);
        const priority =
            1 + ONSET_TOLERANCE_MS * Math.min(expected.length, actual.length);
        const reward = (i, j) => {
            const error = Math.abs(
                expected[i].note.timeMs - actual[j].note.timeMs,
            );
            return error <= ONSET_TOLERANCE_MS ? priority - error : -Infinity;
        };
        for (let i = expected.length - 1; i >= 0; i--) {
            for (let j = actual.length - 1; j >= 0; j--) {
                const at = i * width + j;
                scores[at] = Math.max(
                    scores[at + width],
                    scores[at + 1],
                    reward(i, j) + scores[at + width + 1],
                );
            }
        }
        let i = 0,
            j = 0;
        while (i < expected.length && j < actual.length) {
            const at = i * width + j;
            if (scores[at] === reward(i, j) + scores[at + width + 1]) {
                pairs.push([expected[i++].index, actual[j++].index]);
            } else if (scores[at] === scores[at + width]) {
                i++;
            } else {
                j++;
            }
        }
    }
    return pairs;
}

function unmatched(notes, pairs, side) {
    const matched = new Set(pairs.map((pair) => pair[side]));
    return notes.filter((_, index) => !matched.has(index));
}

export function evaluateNotes(reference, detected) {
    const exact = matchNotes(reference, detected, (note) => note.note);
    const missing = unmatched(reference, exact, 0);
    const extras = unmatched(detected, exact, 1);
    const octaves = matchNotes(missing, extras, (note) => note.note % 12);
    let longNotes = 0,
        earlyReleases = 0,
        onsetError = 0,
        offsetError = 0;
    for (const [i, j] of exact) {
        const expected = reference[i],
            actual = detected[j];
        onsetError += Math.abs(expected.timeMs - actual.timeMs);
        offsetError += Math.abs(endTime(expected) - endTime(actual));
        if (
            actual.durationMs - expected.durationMs >
            Math.max(150, expected.durationMs * 0.5)
        )
            longNotes++;
        if (
            endTime(expected) - endTime(actual) >
            Math.max(100, expected.durationMs * 0.25)
        )
            earlyReleases++;
    }
    const ratio = (numerator, denominator) =>
        denominator ? round(numerator / denominator) : null;
    return {
        referenceNotes: reference.length,
        detectedNotes: detected.length,
        matched: exact.length,
        missed: missing.length,
        extra: extras.length,
        longNotes,
        earlyReleases,
        octaveErrors: octaves.filter(
            ([i, j]) => missing[i].note !== extras[j].note,
        ).length,
        precision: ratio(exact.length, detected.length),
        recall: ratio(exact.length, reference.length),
        f1: ratio(exact.length * 2, reference.length + detected.length),
        onsetMeanAbsMs: ratio(onsetError, exact.length),
        offsetMeanAbsMs: ratio(offsetError, exact.length),
    };
}

export function starterPlayability(notes, firstNote) {
    const keys = MAIN_KEYS.map(({ note }) => note - 60 + firstNote);
    const ordered = [...notes].sort((a, b) => a.timeMs - b.timeMs);
    const keyIndices = ordered.map(({ note }) => keys.indexOf(note));
    const offMainKeys = keyIndices.filter((index) => index < 0).length;
    let maxMainKeyJump = 0,
        minOnsetGapMs = Infinity;
    for (let i = 1; i < ordered.length; i++) {
        if (keyIndices[i] >= 0 && keyIndices[i - 1] >= 0)
            maxMainKeyJump = Math.max(
                maxMainKeyJump,
                Math.abs(keyIndices[i] - keyIndices[i - 1]),
            );
        const gap = ordered[i].timeMs - ordered[i - 1].timeMs;
        if (gap > ONSET_EPSILON_MS)
            minOnsetGapMs = Math.min(minOnsetGapMs, gap);
    }
    const edges = ordered.flatMap((note) => [
        [note.timeMs, 1],
        [endTime(note), -1],
    ]);
    edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let simultaneous = 0,
        maxSimultaneous = 0;
    let i = 0;
    while (i < edges.length) {
        const time = edges[i][0];
        // Tempo scaling can put adjacent edges a few floating-point units
        // apart even when one note ends exactly where the next begins.
        do {
            simultaneous += edges[i++][1];
        } while (i < edges.length && edges[i][0] - time < ONSET_EPSILON_MS);
        maxSimultaneous = Math.max(maxSimultaneous, simultaneous);
    }
    return {
        offMainKeys,
        maxSimultaneous,
        maxMainKeyJump,
        minOnsetGapMs: Number.isFinite(minOnsetGapMs)
            ? round(minOnsetGapMs)
            : null,
        mainKeySolo:
            notes.length > 0 && offMainKeys === 0 && maxSimultaneous === 1,
    };
}

export function evaluateStarter(reference, detected, settings) {
    const preset = { ...settings, level: "starter" };
    const expected = arrangeTranscription(reference, preset);
    const actual = arrangeTranscription(detected, preset);
    return {
        bpm: actual.bpm,
        mainKeyOmissions: actual.stats.omittedMainKeys,
        notes: evaluateNotes(expected.notes, actual.notes),
        playability: starterPlayability(actual.notes, settings.firstNote),
    };
}

// Compare the selected melody on the source timeline, allowing the two
// playable versions to use different practice tempos, keys and octaves.
export function evaluateAutoStarter(
    reference,
    detected,
    referenceSettings,
    actualSettings,
) {
    function arrange(notes, settings) {
        const result = arrangeTranscription(notes, {
            ...settings,
            level: "starter",
        });
        const sourceScale = result.bpm / result.sourceBpm;
        return {
            playable: starterPlayability(result.notes, settings.firstNote),
            source: result.notes.map((n) => ({
                ...n,
                note: (((n.note - settings.transpose) % 12) + 12) % 12,
                timeMs: n.timeMs * sourceScale + settings.originMs,
                durationMs: n.durationMs * sourceScale,
            })),
        };
    }
    const expected = arrange(reference, referenceSettings);
    const actual = arrange(detected, actualSettings);
    return {
        settings: actualSettings,
        pitchClassOnset: evaluateNotes(expected.source, actual.source),
        playability: actual.playable,
    };
}
