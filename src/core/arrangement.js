import { MAX_OFFSET_MS } from "./transcription/config.js";
import { estimateKeyAndTranspose } from "./transcription/musical-analysis.js";

export const PLAYABLE_VERSIONS = Object.freeze([
    "melody",
    "fuller",
    "original",
]);

// Pocket-keyboard arrangements with lead-voice tracking and phrase-aware octave placement.
// Never mutate the input transcription.
export const ARRANGEMENT_LEVELS = Object.freeze({
    starter: Object.freeze({
        grid: 1,
        voices: 1,
        minBeats: 0.35,
    }),
    melody: Object.freeze({
        grid: 0,
        voices: 1,
        minBeats: 0,
    }),
    fuller: Object.freeze({
        grid: 0.25,
        voices: 2,
        minBeats: 0.125,
    }),
    original: Object.freeze({
        grid: 0,
        voices: Infinity,
        minBeats: 0,
    }),
});

const MAIN_OFFSETS = new Set([
    0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24,
]);
const WHITE_PC = new Set([0, 2, 4, 5, 7, 9, 11]);
const mod = (value, divisor) => ((value % divisor) + divisor) % divisor;

function requireNumber(value, min, max, integer = false) {
    if (
        !Number.isFinite(value) ||
        value < min ||
        value > max ||
        (integer && !Number.isInteger(value))
    )
        throw new RangeError("Invalid arrangement setting");
    return value;
}

export function cleanTranscription(input) {
    return input
        .filter(
            (n) =>
                Number.isInteger(n.note) &&
                n.note >= 0 &&
                n.note <= 127 &&
                Number.isFinite(n.timeMs) &&
                n.timeMs >= 0 &&
                Number.isFinite(n.durationMs) &&
                n.durationMs > 0 &&
                Number.isFinite(n.velocity),
        )
        .map((n) => ({
            note: n.note,
            timeMs: n.timeMs,
            durationMs: n.durationMs,
            velocity: Math.max(1, Math.min(127, Math.round(n.velocity))),
        }))
        .sort((a, b) => a.timeMs - b.timeMs || b.note - a.note);
}

function cleanMonophonicGlitches(notes) {
    if (notes.length < 3) return notes.map((n) => ({ ...n }));
    const out = [];
    for (let i = 0; i < notes.length; i++) {
        const current = { ...notes[i] };
        const previous = out.at(-1);
        const next = notes[i + 1];
        if (
            current.durationMs < 85 &&
            previous &&
            next &&
            current.timeMs - (previous.timeMs + previous.durationMs) < 40 &&
            next.timeMs - (current.timeMs + current.durationMs) < 40 &&
            previous.durationMs >= 140 &&
            next.durationMs >= 140 &&
            current.note !== previous.note &&
            current.note !== next.note &&
            (Math.abs(current.note - previous.note) === 1 ||
                Math.abs(current.note - next.note) === 1)
        ) {
            previous.durationMs = Math.max(
                previous.durationMs,
                current.timeMs + current.durationMs - previous.timeMs,
            );
            continue;
        }
        out.push(current);
    }
    return out;
}

function isDensePolyphonic(notes) {
    if (notes.length < 12) return false;
    let overlaps = 0,
        low = 127,
        high = 0;
    for (let i = 0; i < notes.length; i++) {
        low = Math.min(low, notes[i].note);
        high = Math.max(high, notes[i].note);
        if (
            i > 0 &&
            notes[i].timeMs <
                notes[i - 1].timeMs +
                    Math.min(notes[i - 1].durationMs, 180) -
                    25
        )
            overlaps++;
    }
    return high - low > 14 && overlaps >= Math.max(3, notes.length * 0.1);
}

/**
 * Extracts a single-line lead melody from dense polyphonic candidates using
 * harmonic suppression and Viterbi pitch-continuity tracking, or cleans tiny
 * pitch-scoop glitches on monophonic vocal streams.
 */
export function extractLeadMelody(input) {
    const raw = cleanTranscription(input);
    if (raw.length <= 2) return raw;
    if (!isDensePolyphonic(raw)) return cleanMonophonicGlitches(raw);

    const rawClusters = [];
    for (const note of raw) {
        if (note.durationMs < 45) continue;
        const last = rawClusters.at(-1);
        if (last && note.timeMs - last[0].timeMs <= 45) last.push(note);
        else rawClusters.push([note]);
    }
    const clusters = [];
    for (const group of rawClusters) {
        const byPitch = new Map();
        for (const note of group) {
            const existing = byPitch.get(note.note);
            if (
                !existing ||
                note.durationMs * note.velocity >
                    existing.durationMs * existing.velocity
            )
                byPitch.set(note.note, note);
        }
        const unique = [...byPitch.values()].sort((a, b) => a.note - b.note);
        const highestMid = Math.max(
            ...unique.filter((c) => c.note <= 79).map((c) => c.note),
            -1,
        );
        const scored = unique
            .filter((n) => n.note >= 50)
            .map((n) => {
                let harmonicPenalty = 0;
                for (const fund of unique) {
                    const diff = n.note - fund.note;
                    if (
                        (diff === 12 || diff === 19 || diff === 24) &&
                        fund.velocity >= n.velocity * 0.8
                    )
                        harmonicPenalty += diff === 12 ? 1.45 : 1.85;
                }
                let registerPrior;
                if (n.note < 57) registerPrior = -0.24 * (57 - n.note);
                else if (n.note > 80) registerPrior = -0.22 * (n.note - 80);
                else registerPrior = 0.62 - 0.015 * Math.abs(n.note - 68);
                const durationScore = Math.min(
                    1.4,
                    Math.log1p(n.durationMs / 120),
                );
                const velocityScore = (n.velocity / 127) * 1.1;
                const leadVoiceBonus =
                    n.note === highestMid
                        ? 0.45
                        : n.note < highestMid
                          ? -0.15
                          : 0;
                return {
                    note: n,
                    emit:
                        registerPrior +
                        durationScore +
                        velocityScore +
                        leadVoiceBonus -
                        harmonicPenalty,
                };
            });
        if (scored.length) clusters.push(scored);
    }
    if (!clusters.length) return raw;

    const clusterCost = clusters.map((group) => {
        const bestEmit = Math.max(...group.map((item) => item.emit));
        // Weak low-register accompaniment clusters can be skipped freely during vocal rests.
        return bestEmit <= 0.85 ? 0 : bestEmit * 0.55;
    });
    const prefixSkip = [0];
    for (const cost of clusterCost) prefixSkip.push(prefixSkip.at(-1) + cost);
    const rangeSkipCost = (fromExclusive, toExclusive) =>
        fromExclusive >= toExclusive
            ? 0
            : prefixSkip[toExclusive] - prefixSkip[fromExclusive];

    const dp = clusters.map((group) =>
        group.map(() => ({ score: -Infinity, prevT: -1, prevK: -1 })),
    );
    for (let t = 0; t < clusters.length; t++) {
        for (let k = 0; k < clusters[t].length; k++) {
            const current = clusters[t][k];
            let best = {
                score: current.emit - rangeSkipCost(0, t),
                prevT: -1,
                prevK: -1,
            };
            const lookback = Math.max(0, t - 8);
            for (let prevT = t - 1; prevT >= lookback; prevT--) {
                const skipPenalty = rangeSkipCost(prevT + 1, t);
                for (let prevK = 0; prevK < clusters[prevT].length; prevK++) {
                    const previous = clusters[prevT][prevK];
                    const gapMs =
                        current.note.timeMs -
                        (previous.note.timeMs + previous.note.durationMs);
                    const dtMs = current.note.timeMs - previous.note.timeMs;
                    const deltaPitch = Math.abs(
                        current.note.note - previous.note.note,
                    );
                    let transition = 0;
                    if (deltaPitch <= 4) transition += 0.48;
                    else if (deltaPitch <= 7) transition += 0.16;
                    else if (deltaPitch <= 12)
                        transition -= 0.14 * (deltaPitch - 7);
                    else transition -= 0.7 + 0.26 * (deltaPitch - 12);
                    if (gapMs > 600 && transition < 0) transition *= 0.35;
                    if (
                        gapMs < -80 &&
                        current.note.note < previous.note.note - 3
                    )
                        transition -= 0.95;
                    if (dtMs < 90 && deltaPitch > 2) transition -= 0.65;
                    const candidateScore =
                        dp[prevT][prevK].score +
                        current.emit +
                        transition -
                        skipPenalty;
                    if (candidateScore > best.score)
                        best = { score: candidateScore, prevT, prevK };
                }
            }
            dp[t][k] = best;
        }
    }

    let endT = clusters.length - 1,
        endK = 0,
        bestFinal = -Infinity;
    for (let t = Math.max(0, clusters.length - 8); t < clusters.length; t++) {
        const tailCost = rangeSkipCost(t + 1, clusters.length);
        for (let k = 0; k < clusters[t].length; k++) {
            const total = dp[t][k].score - tailCost;
            if (total > bestFinal) {
                bestFinal = total;
                endT = t;
                endK = k;
            }
        }
    }

    const chosen = [];
    let ct = endT,
        ck = endK;
    while (ct >= 0 && ck >= 0) {
        chosen.push({ ...clusters[ct][ck].note });
        const step = dp[ct][ck];
        ct = step.prevT;
        ck = step.prevK;
    }
    chosen.reverse();
    for (let i = 0; i < chosen.length - 1; i++) {
        if (chosen[i].timeMs + chosen[i].durationMs > chosen[i + 1].timeMs) {
            chosen[i].durationMs = Math.max(
                40,
                chosen[i + 1].timeMs - chosen[i].timeMs,
            );
        }
    }
    return chosen;
}

function foldIntoPocketRange(candidates, firstNote, transpose, globalShift) {
    if (!candidates.length) return [];
    const maxNote = firstNote + 24;
    // Split into phrases across >= 300ms rests so a high/low phrase shifts
    // together by an octave before resorting to per-note wrapping.
    const phrases = [];
    for (const item of candidates) {
        const current = phrases.at(-1);
        const prevEnd = current
            ? current.at(-1).timeMs + current.at(-1).durationMs
            : -Infinity;
        if (!current || item.timeMs - prevEnd >= 300) phrases.push([item]);
        else current.push(item);
    }

    const mapped = [];
    for (const phrase of phrases) {
        let bestDelta = 0,
            bestOutliers = Infinity;
        for (const delta of [0, -12, 12]) {
            let outliers = 0;
            for (const source of phrase) {
                const shifted = source.note + transpose + globalShift + delta;
                if (shifted < firstNote || shifted > maxNote) outliers++;
            }
            if (outliers < bestOutliers) {
                bestOutliers = outliers;
                bestDelta = delta;
            }
        }
        for (const source of phrase) {
            const before = source.note + transpose;
            let note = before + globalShift + bestDelta;
            if (note < firstNote)
                note += Math.ceil((firstNote - note) / 12) * 12;
            if (note > maxNote) note -= Math.ceil((note - maxNote) / 12) * 12;
            mapped.push({
                ...source,
                note,
                octaveAdjusted: note !== before,
            });
        }
    }
    return mapped;
}

// Choose a lower chord tone from the surrounding two beats. The estimated
// scale is in the arranged key, after transposition and octave placement.
function addLowerVoice(notes, firstNote, beatMs) {
    const { majorRoot } = estimateKeyAndTranspose(notes);
    const scale = [...WHITE_PC].map((pc) => (pc + majorRoot) % 12);
    const chords = scale.map((root, i) => [
        root,
        scale[(i + 2) % 7],
        scale[(i + 4) % 7],
    ]);
    const blockOf = (n) => Math.floor(n.timeMs / (2 * beatMs));
    const weights = new Map();
    for (const n of notes) {
        const block = blockOf(n);
        if (!weights.has(block)) weights.set(block, new Float64Array(12));
        weights.get(block)[n.note % 12] += Math.min(n.durationMs, 2 * beatMs);
    }
    let previousPitch = firstNote + 5,
        lastAttack = -Infinity;
    const result = [];
    for (const [i, n] of notes.entries()) {
        result.push(n);
        if (
            notes[i - 1]?.timeMs === n.timeMs ||
            notes[i + 1]?.timeMs === n.timeMs
        ) {
            lastAttack = n.timeMs;
            continue;
        }
        if (n.durationMs < 0.4 * beatMs || n.timeMs - lastAttack < 1.7 * beatMs)
            continue;
        const weight = weights.get(blockOf(n));
        let pitch = null,
            best = -Infinity;
        for (const chord of chords) {
            if (!chord.includes(n.note % 12)) continue;
            const fit = chord.reduce((sum, pc) => sum + weight[pc], 0) / beatMs;
            for (const interval of [3, 4, 7, 8, 9]) {
                const low = n.note - interval;
                if (low < firstNote || !chord.includes(low % 12)) continue;
                const score =
                    fit -
                    0.05 * Math.abs(low - previousPitch) +
                    (low % 12 === chord[0] ? 0.08 : 0);
                if (score > best) {
                    best = score;
                    pitch = low;
                }
            }
        }
        if (pitch !== null) {
            result.push({
                ...n,
                note: pitch,
                velocity: Math.max(1, Math.round(n.velocity * 0.62)),
                generatedHarmony: true,
            });
            previousPitch = pitch;
            lastAttack = n.timeMs;
        }
    }
    return result;
}

export function arrangeTranscription(
    input,
    {
        level = "melody",
        bpm = 120,
        firstNote = 60,
        transpose = 0,
        originMs = 0,
        minPitch = 0,
        maxPitch = 127,
        autoHarmony = false,
    } = {},
) {
    const preset = ARRANGEMENT_LEVELS[level];
    if (!preset) throw new RangeError("Unknown arrangement level");
    requireNumber(bpm, 20, 240);
    requireNumber(firstNote, 0, 103, true);
    requireNumber(transpose, -12, 12, true);
    requireNumber(originMs, 0, MAX_OFFSET_MS);
    requireNumber(minPitch, 0, 127, true);
    requireNumber(maxPitch, minPitch, 127, true);
    const raw = cleanTranscription(input);
    const stats = {
        source: raw.length,
        filtered: 0,
        reduced: 0,
        dyads: 0,
        generatedHarmony: 0,
        omittedMainKeys: 0,
        octaveAdjusted: 0,
        octaveShift: 0,
        outOfRange: 0,
        transpose,
    };
    const beatMs = 60000 / bpm;
    const gridMs = preset.grid * beatMs;
    const minDuration = level === "melody" ? 55 : preset.minBeats * beatMs;
    let working = raw;
    if (level !== "original" && isDensePolyphonic(raw)) {
        const inBounds = raw.filter(
            (n) =>
                n.note >= minPitch &&
                n.note <= maxPitch &&
                n.timeMs >= originMs,
        );
        stats.filtered += raw.length - inBounds.length;
        const lead = extractLeadMelody(inBounds);
        if (preset.voices === 1) {
            stats.reduced += inBounds.length - lead.length;
            working = lead;
        } else {
            // Keep the tracked lead melody as primary voice and attach at most
            // one consonant lower harmony note (3..10 semitones below) per onset.
            const duo = [];
            let cursor = 0;
            for (const primary of lead) {
                duo.push(primary);
                while (
                    cursor < inBounds.length &&
                    inBounds[cursor].timeMs < primary.timeMs - 45
                )
                    cursor++;
                let bestHarmony = null;
                for (
                    let j = cursor;
                    j < inBounds.length &&
                    inBounds[j].timeMs <= primary.timeMs + 45;
                    j++
                ) {
                    const candidate = inBounds[j];
                    const interval = primary.note - candidate.note;
                    if (interval < 3 || interval > 10) continue;
                    if (
                        !bestHarmony ||
                        candidate.durationMs * candidate.velocity >
                            bestHarmony.durationMs * bestHarmony.velocity
                    )
                        bestHarmony = candidate;
                }
                if (bestHarmony) {
                    duo.push({
                        ...bestHarmony,
                        timeMs: primary.timeMs,
                        durationMs: Math.min(
                            bestHarmony.durationMs,
                            primary.durationMs,
                        ),
                    });
                }
            }
            stats.reduced += Math.max(0, inBounds.length - duo.length);
            working = duo;
        }
    }

    const groups = [];
    let lastBucket;
    let candidates = [];
    for (const source of working) {
        if (level === "original") {
            candidates.push({ ...source });
            continue;
        }
        if (
            source.note < minPitch ||
            source.note > maxPitch ||
            source.timeMs < originMs ||
            source.durationMs < minDuration
        ) {
            stats.filtered++;
            continue;
        }
        const shiftedMs = source.timeMs - originMs;
        const bucket = gridMs
            ? Math.round(shiftedMs / gridMs) * gridMs
            : shiftedMs;
        const note = {
            ...source,
            timeMs: level === "fuller" ? bucket : shiftedMs,
            durationMs:
                level === "fuller"
                    ? Math.max(
                          gridMs,
                          Math.round(source.durationMs / gridMs) * gridMs,
                      )
                    : source.durationMs,
            rawDurationMs: source.durationMs,
            gridErrorMs: Math.abs(shiftedMs - bucket),
        };
        let group = groups.at(-1);
        if (!group || bucket !== lastBucket) {
            group = { start: shiftedMs, notes: [] };
            groups.push(group);
        } else if (level === "fuller" && shiftedMs - group.start > 45) {
            // Two separate attacks landed on one grid line. Keep their order
            // and original spacing rather than turning them into a chord.
            for (const previous of group.notes) previous.timeMs = group.start;
            group = { start: shiftedMs, notes: [], useSourceStart: true };
            groups.push(group);
        }
        if (group.useSourceStart) note.timeMs = group.start;
        group.notes.push(note);
        lastBucket = bucket;
    }

    if (level !== "original") {
        let upperEnd = -Infinity,
            upperPitch = -Infinity;
        const rankCandidate = (n) => {
            const onMainKey =
                level !== "starter" ||
                WHITE_PC.has(mod(n.note + transpose - firstNote, 12));
            // For simultaneous chord notes (same gridError & duration), fall back
            // to upper-voice pitch & velocity; when sequential notes quantize to
            // the same coarse beat, prefer playable main-key beat anchors.
            return {
                mainKey: onMainKey ? 1 : 0,
                anchorScore:
                    Math.min(1.5, n.rawDurationMs / Math.max(1, gridMs)) -
                    (n.gridErrorMs / Math.max(1, gridMs)) * 0.65,
            };
        };
        for (const { notes: group } of groups) {
            group.sort((a, b) => {
                const ra = rankCandidate(a),
                    rb = rankCandidate(b);
                if (ra.mainKey !== rb.mainKey) return rb.mainKey - ra.mainKey;
                if (Math.abs(ra.anchorScore - rb.anchorScore) > 0.25)
                    return rb.anchorScore - ra.anchorScore;
                return b.note - a.note || b.velocity - a.velocity;
            });
            const unique = group.filter(
                (note, i) => i === 0 || note.note !== group[i - 1].note,
            );
            const selected = unique
                .slice(0, preset.voices)
                .map(
                    ({ rawDurationMs: _d, gridErrorMs: _e, ...clean }) => clean,
                );
            if (
                preset.voices === 1 &&
                selected[0].timeMs + 45 < upperEnd &&
                selected[0].note < upperPitch
            ) {
                stats.reduced += group.length;
                continue;
            }
            candidates.push(...selected);
            stats.reduced += group.length - selected.length;
            upperEnd = selected[0].timeMs + selected[0].durationMs;
            upperPitch = selected[0].note;
        }
        const sortedPitches = candidates
            .map((n) => n.note + transpose)
            .sort((a, b) => a - b);
        if (sortedPitches.length) {
            const lower = Math.ceil((firstNote - sortedPitches[0]) / 12);
            const upper = Math.floor(
                (firstNote + 24 - sortedPitches.at(-1)) / 12,
            );
            const centered = Math.round(
                (firstNote +
                    12 -
                    sortedPitches[Math.floor(sortedPitches.length / 2)]) /
                    12,
            );
            stats.octaveShift =
                12 *
                (lower <= upper
                    ? Math.max(lower, Math.min(upper, centered))
                    : centered);
        }
        candidates = foldIntoPocketRange(
            candidates,
            firstNote,
            transpose,
            stats.octaveShift,
        ).flatMap((mapped) => {
            if (
                level === "starter" &&
                !MAIN_OFFSETS.has(mapped.note - firstNote)
            ) {
                stats.omittedMainKeys++;
                return [];
            }
            return [mapped];
        });
        // Limit simultaneous demands, including sustained notes and octave-fold collisions.
        const active = [];
        const deduped = [];
        let at = -Infinity;
        const pitches = new Set();
        for (const note of candidates) {
            if (note.timeMs !== at) {
                at = note.timeMs;
                pitches.clear();
                for (const previous of active)
                    previous.durationMs = Math.min(
                        previous.durationMs,
                        at - previous.timeMs,
                    );
                active.length = 0;
            }
            if (pitches.has(note.note)) {
                stats.reduced++;
                continue;
            }
            if (pitches.size === 1) stats.dyads++;
            pitches.add(note.note);
            active.push(note);
            deduped.push(note);
        }
        candidates = deduped.filter((n) => n.durationMs > 0);
        stats.octaveAdjusted = candidates.filter(
            (n) => n.octaveAdjusted,
        ).length;
    }
    if (level === "fuller" && autoHarmony) {
        const duet = addLowerVoice(candidates, firstNote, beatMs);
        stats.generatedHarmony = duet.length - candidates.length;
        stats.dyads += stats.generatedHarmony;
        candidates = duet;
    }
    const notes = candidates.map(({ octaveAdjusted: _adjusted, ...n }) => n);
    stats.outOfRange = notes.filter(
        (n) => n.note < firstNote || n.note > firstNote + 24,
    ).length;
    stats.output = notes.length;
    return {
        level,
        notes,
        stats,
        sourceBpm: bpm,
        bpm,
        durationMs: notes.reduce(
            (end, n) => Math.max(end, n.timeMs + n.durationMs),
            0,
        ),
    };
}

// One-track SMF shared by the existing file parser, practice page and MIDI download.
export function transcriptionMidi(
    input,
    { bpm = 120, name = "Transcription" } = {},
) {
    requireNumber(bpm, 20, 240);
    const notes = cleanTranscription(input);
    const division = 480;
    const tempo = Math.round(60000000 / bpm);
    const tickAt = (ms) => Math.round(((ms * 1000) / tempo) * division);
    const variable = (value) => {
        requireNumber(value, 0, 0x0fffffff, true);
        const bytes = [value & 127];
        for (let n = Math.floor(value / 128); n > 0; n = Math.floor(n / 128))
            bytes.unshift((n & 127) | 128);
        return bytes;
    };
    const uint = (n, count) =>
        Array.from(
            { length: count },
            (_, i) => (n >>> ((count - i - 1) * 8)) & 255,
        );
    const text = [...new TextEncoder().encode(String(name))].slice(0, 4096);
    const track = [
        0,
        255,
        81,
        3,
        ...uint(tempo, 3),
        0,
        255,
        88,
        4,
        4,
        2,
        24,
        8,
        0,
        255,
        3,
        ...variable(text.length),
        ...text,
        0,
        192,
        0, // General MIDI Acoustic Grand Piano, channel 1.
    ];
    const events = notes
        .flatMap((n) => {
            const start = tickAt(n.timeMs);
            return [
                { tick: start, on: true, note: n.note, velocity: n.velocity },
                {
                    tick: Math.max(start + 1, tickAt(n.timeMs + n.durationMs)),
                    on: false,
                    note: n.note,
                    velocity: 0,
                },
            ];
        })
        .sort((a, b) => a.tick - b.tick || Number(a.on) - Number(b.on));
    let previous = 0;
    for (const event of events) {
        track.push(
            ...variable(event.tick - previous),
            event.on ? 144 : 128,
            event.note,
            event.velocity,
        );
        previous = event.tick;
    }
    track.push(0, 255, 47, 0);
    return Uint8Array.from([
        77,
        84,
        104,
        100,
        0,
        0,
        0,
        6,
        0,
        0,
        0,
        1,
        ...uint(division, 2),
        77,
        84,
        114,
        107,
        ...uint(track.length, 4),
        ...track,
    ]);
}
