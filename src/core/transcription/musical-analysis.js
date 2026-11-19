import { MAX_OFFSET_MS } from "./config.js";

const WHITE_OFFSETS = new Set([0, 2, 4, 5, 7, 9, 11]);
const MAJOR_NAMES = [
    "C",
    "D♭",
    "D",
    "E♭",
    "E",
    "F",
    "F♯",
    "G",
    "A♭",
    "A",
    "B♭",
    "B",
];
const RELATIVE_MINOR_NAMES = [
    "A",
    "B♭",
    "B",
    "C",
    "C♯",
    "D",
    "D♯",
    "E",
    "F",
    "F♯",
    "G",
    "G♯",
];
// Diatonic major profile with tonic, fifth, third and sixth stability emphasis.
const MAJOR_PROFILE = [1.35, 0, 1.0, 0, 1.15, 0.95, 0, 1.25, 0, 1.15, 0, 0.95];

const mod = (value, divisor) => ((value % divisor) + divisor) % divisor;

function clusterOnsets(notes) {
    const valid = notes
        .filter(
            (n) =>
                Number.isInteger(n?.note) &&
                n.note >= 0 &&
                n.note <= 127 &&
                Number.isFinite(n.timeMs) &&
                n.timeMs >= 0 &&
                Number.isFinite(n.durationMs) &&
                n.durationMs >= 50,
        )
        .sort((a, b) => a.timeMs - b.timeMs || b.note - a.note);
    const clusters = [];
    for (const note of valid) {
        const velocity = Number.isFinite(note.velocity) ? note.velocity : 96;
        // Mid/upper melodic register carries stronger metrical cue than deep rumble.
        const registerWeight = note.note >= 52 && note.note <= 84 ? 1 : 0.55;
        const weight =
            Math.min(1.5, Math.max(0.15, note.durationMs / 400)) *
            (0.5 + 0.5 * (Math.max(1, Math.min(127, velocity)) / 127)) *
            registerWeight;
        const previous = clusters.at(-1);
        if (previous && note.timeMs - previous.anchorMs <= 35) {
            if (weight > previous.peakWeight) {
                previous.timeMs = note.timeMs;
                previous.peakWeight = weight;
            }
            previous.weight += weight * 0.35;
            previous.maxDurationMs = Math.max(
                previous.maxDurationMs,
                note.durationMs,
            );
        } else {
            clusters.push({
                anchorMs: note.timeMs,
                timeMs: note.timeMs,
                peakWeight: weight,
                weight,
                maxDurationMs: note.durationMs,
            });
        }
    }
    return clusters;
}

/**
 * Estimates song tempo (BPM) and beat-grid phase offset (`originMs`) from
 * detected note onsets using circular phase coherence + inter-onset resonance.
 */
export function estimateTempoAndOrigin(notes, clipMs = MAX_OFFSET_MS) {
    const onsets = clusterOnsets(Array.isArray(notes) ? notes : []);
    if (onsets.length < 4) {
        return { bpm: 120, originMs: 0, confidence: 0 };
    }
    const totalWeight = onsets.reduce((sum, item) => sum + item.weight, 0);
    const maxOrigin = Math.max(
        0,
        Math.min(
            MAX_OFFSET_MS,
            Number.isFinite(clipMs) && clipMs > 0
                ? Math.floor(clipMs)
                : MAX_OFFSET_MS,
        ),
    );
    let best = { score: -1, bpm: 120, originMs: 0, confidence: 0 };
    for (let bpm = 68; bpm <= 176; bpm += 0.5) {
        const beatMs = 60000 / bpm;
        const subMs = beatMs / 2;
        let subCos = 0,
            subSin = 0,
            beatCos = 0,
            beatSin = 0;
        for (const onset of onsets) {
            const subAngle = (2 * Math.PI * onset.timeMs) / subMs;
            subCos += onset.weight * Math.cos(subAngle);
            subSin += onset.weight * Math.sin(subAngle);
            const beatAngle = (2 * Math.PI * onset.timeMs) / beatMs;
            beatCos += onset.weight * Math.cos(beatAngle);
            beatSin += onset.weight * Math.sin(beatAngle);
        }
        const subCoherence = Math.hypot(subCos, subSin) / totalWeight;
        const beatCoherence = Math.hypot(beatCos, beatSin) / totalWeight;

        let ioiScore = 0,
            ioiWeight = 0;
        for (let i = 0; i < onsets.length; i++) {
            for (let j = i + 1; j < onsets.length && j <= i + 6; j++) {
                const dt = onsets[j].timeMs - onsets[i].timeMs;
                if (dt < 90 || dt > 2400) continue;
                const units = dt / subMs;
                const nearest = Math.max(0.5, Math.round(units * 2) / 2);
                const isSixteenth =
                    Math.abs(nearest - Math.round(nearest)) > 0.1;
                const error = Math.abs(units - nearest);
                const pairWeight =
                    (onsets[i].weight + onsets[j].weight) *
                    (j === i + 1 ? 1 : 0.45);
                ioiScore +=
                    pairWeight *
                    Math.exp(-(error * error) / 0.02) *
                    (isSixteenth ? 0.65 : 1);
                ioiWeight += pairWeight;
            }
        }
        const ioiResonance = ioiWeight > 0 ? ioiScore / ioiWeight : 0;
        const tempoPrior = Math.exp(-0.5 * (Math.log2(bpm / 118) / 0.52) ** 2);
        const score =
            (0.52 * subCoherence + 0.18 * beatCoherence + 0.3 * ioiResonance) *
            (0.78 + 0.22 * tempoPrior);
        if (score > best.score) {
            let phaseSub = (Math.atan2(subSin, subCos) / (2 * Math.PI)) * subMs;
            if (phaseSub < 0) phaseSub += subMs;
            let downbeatZero = 0,
                downbeatHalf = 0;
            for (const onset of onsets) {
                const durFactor =
                    onset.weight * Math.min(2, onset.maxDurationMs / 300);
                downbeatZero +=
                    durFactor *
                    Math.cos(
                        (2 * Math.PI * (onset.timeMs - phaseSub)) / beatMs,
                    );
                downbeatHalf +=
                    durFactor *
                    Math.cos(
                        (2 * Math.PI * (onset.timeMs - (phaseSub + subMs))) /
                            beatMs,
                    );
            }
            const rawOrigin =
                Math.round(
                    downbeatHalf > downbeatZero ? phaseSub + subMs : phaseSub,
                ) % Math.round(beatMs);
            // Never advance originMs past the opening note, because arrangement
            // treats originMs as a start cutoff and would drop the first downbeat.
            const safeOrigin = Math.min(
                rawOrigin,
                Math.floor(onsets[0].timeMs),
            );
            best = {
                score,
                bpm: Math.max(20, Math.min(240, Math.round(bpm))),
                originMs: Math.max(0, Math.min(maxOrigin, safeOrigin)),
                confidence: Number(
                    Math.max(0, Math.min(1, subCoherence)).toFixed(3),
                ),
            };
        }
    }
    return {
        bpm: best.bpm,
        originMs: best.originMs,
        confidence: best.confidence,
    };
}

/**
 * Detects the best-fitting diatonic key and computes `whiteKeyTranspose`
 * (-6..+6 semitones) so the melody lands maximally on the pocket keyboard's
 * 15 main keys relative to `firstNote`.
 */
export function estimateKeyAndTranspose(notes, firstNote = 60) {
    const pitchClassWeight = new Array(12).fill(0);
    let totalWeight = 0;
    for (const note of Array.isArray(notes) ? notes : []) {
        if (
            !Number.isInteger(note?.note) ||
            note.note < 0 ||
            note.note > 127 ||
            !Number.isFinite(note.durationMs) ||
            note.durationMs < 55
        )
            continue;
        const velocity = Number.isFinite(note.velocity) ? note.velocity : 96;
        const weight =
            Math.min(note.durationMs, 1500) *
            (0.5 + 0.5 * (Math.max(1, Math.min(127, velocity)) / 127));
        pitchClassWeight[mod(note.note, 12)] += weight;
        totalWeight += weight;
    }
    if (!(totalWeight > 0)) {
        return {
            tonic: "C",
            majorRoot: 0,
            majorName: "C",
            minorName: "A",
            mode: "major",
            rawMainKeyRatio: 1,
            whiteKeyTranspose: 0,
            transposedMainKeyRatio: 1,
        };
    }

    let majorRoot = 0,
        bestScaleScore = -1;
    for (let root = 0; root < 12; root++) {
        let score = 0;
        for (let offset = 0; offset < 12; offset++) {
            score +=
                pitchClassWeight[(root + offset) % 12] * MAJOR_PROFILE[offset];
        }
        if (score > bestScaleScore) {
            bestScaleScore = score;
            majorRoot = root;
        }
    }
    const minorRoot = (majorRoot + 9) % 12;
    const isMinor =
        pitchClassWeight[minorRoot] > pitchClassWeight[majorRoot] * 1.15;
    const targetPc = mod(firstNote, 12);

    const mainKeyRatioAt = (transpose) => {
        let matched = 0;
        for (let pc = 0; pc < 12; pc++) {
            if (WHITE_OFFSETS.has(mod(pc + transpose - targetPc, 12))) {
                matched += pitchClassWeight[pc];
            }
        }
        return matched / totalWeight;
    };

    const rawRatio = mainKeyRatioAt(0);
    let bestTranspose = 0,
        bestScore = -1;
    for (let transpose = -6; transpose <= 6; transpose++) {
        const ratio = mainKeyRatioAt(transpose);
        // Never pick a non-zero transpose that strictly worsens main-key fit.
        if (transpose !== 0 && ratio + 1e-6 < rawRatio) continue;
        const rootAligned =
            mod(majorRoot + transpose - targetPc, 12) === 0 ? 0.008 : 0;
        const distanceCost = Math.abs(transpose) * 0.0015;
        const score = ratio + rootAligned - distanceCost;
        if (score > bestScore) {
            bestScore = score;
            bestTranspose = transpose;
        }
    }
    // If raw notes already achieve virtually identical main-key coverage, keep 0.
    if (mainKeyRatioAt(bestTranspose) - rawRatio < 0.01) {
        bestTranspose = 0;
    }

    return {
        tonic: isMinor
            ? RELATIVE_MINOR_NAMES[majorRoot]
            : MAJOR_NAMES[majorRoot],
        majorRoot,
        majorName: MAJOR_NAMES[majorRoot],
        minorName: RELATIVE_MINOR_NAMES[majorRoot],
        mode: isMinor ? "minor" : "major",
        rawMainKeyRatio: Number(rawRatio.toFixed(3)),
        whiteKeyTranspose: bestTranspose,
        transposedMainKeyRatio: Number(
            mainKeyRatioAt(bestTranspose).toFixed(3),
        ),
    };
}

export function analyzeMelody(
    notes,
    { clipMs = MAX_OFFSET_MS, firstNote = 60 } = {},
) {
    return {
        ...estimateTempoAndOrigin(notes, clipMs),
        ...estimateKeyAndTranspose(notes, firstNote),
    };
}
