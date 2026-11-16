import { MAX_OFFSET_MS } from "./transcription/config.js";

// Draft arrangements, not musicological melody extraction. Never mutate the transcription.
export const ARRANGEMENT_LEVELS = Object.freeze({
    starter: Object.freeze({ grid: 1, voices: 1, minBeats: 0.5, maxBpm: 72 }),
    melody: Object.freeze({ grid: 0.5, voices: 1, minBeats: 0.25, maxBpm: 96 }),
    fuller: Object.freeze({
        grid: 0.25,
        voices: 2,
        minBeats: 0.125,
        maxBpm: 112,
    }),
    original: Object.freeze({
        grid: 0,
        voices: Infinity,
        minBeats: 0,
        maxBpm: 240,
    }),
});

const MAIN_OFFSETS = new Set([
    0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24,
]);

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

export function arrangeTranscription(
    input,
    {
        level = "starter",
        bpm = 120,
        firstNote = 60,
        transpose = 0,
        originMs = 0,
        minPitch = 0,
        maxPitch = 127,
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
        omittedMainKeys: 0,
        octaveAdjusted: 0,
        octaveShift: 0,
        outOfRange: 0,
        transpose,
    };
    const beatMs = 60000 / bpm;
    const gridMs = preset.grid * beatMs;
    const groups = new Map();
    let candidates = [];
    for (const source of raw) {
        if (level === "original") {
            candidates.push({ ...source });
            continue;
        }
        if (
            source.note < minPitch ||
            source.note > maxPitch ||
            source.timeMs < originMs ||
            source.durationMs < preset.minBeats * beatMs
        ) {
            stats.filtered++;
            continue;
        }
        const timeMs = Math.round((source.timeMs - originMs) / gridMs) * gridMs;
        const note = {
            ...source,
            timeMs,
            durationMs: Math.max(
                gridMs,
                Math.round(source.durationMs / gridMs) * gridMs,
            ),
        };
        const key = Math.round(timeMs / gridMs);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(note);
    }
    if (level !== "original") {
        // Upper-voice heuristic: simultaneous lower pitches are usually accompaniment.
        // Suppress lower attacks under a held upper note in single-voice drafts.
        let upperEnd = -Infinity,
            upperPitch = -Infinity;
        for (const group of groups.values()) {
            group.sort((a, b) => b.note - a.note || b.velocity - a.velocity);
            const unique = group.filter(
                (note, i) => i === 0 || note.note !== group[i - 1].note,
            );
            const selected = unique.slice(0, preset.voices);
            if (
                preset.voices === 1 &&
                selected[0].timeMs < upperEnd &&
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
        candidates = candidates.flatMap((source) => {
            const before = source.note + transpose;
            let note = before + stats.octaveShift;
            // Octave equivalence preserves pitch class; do not clamp to an unrelated pitch.
            if (note < firstNote)
                note += Math.ceil((firstNote - note) / 12) * 12;
            if (note > firstNote + 24)
                note -= Math.ceil((note - firstNote - 24) / 12) * 12;
            if (level === "starter" && !MAIN_OFFSETS.has(note - firstNote)) {
                stats.omittedMainKeys++;
                return [];
            }
            return [{ ...source, note, octaveAdjusted: note !== before }];
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
            pitches.add(note.note);
            active.push(note);
            deduped.push(note);
        }
        candidates = deduped.filter((n) => n.durationMs > 0);
        stats.octaveAdjusted = candidates.filter(
            (n) => n.octaveAdjusted,
        ).length;
    }
    const outputBpm = Math.min(bpm, preset.maxBpm);
    const scale = bpm / outputBpm;
    const notes = candidates.map(({ octaveAdjusted: _adjusted, ...n }) => ({
        ...n,
        timeMs: n.timeMs * scale,
        durationMs: n.durationMs * scale,
    }));
    stats.outOfRange = notes.filter(
        (n) => n.note < firstNote || n.note > firstNote + 24,
    ).length;
    stats.output = notes.length;
    return {
        level,
        notes,
        stats,
        sourceBpm: bpm,
        bpm: outputBpm,
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
