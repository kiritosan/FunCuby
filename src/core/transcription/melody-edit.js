import { encodeResult } from "./protocol.js";

export const workingNotes = (capture) =>
    capture?.editedNotes ?? capture?.notes ?? [];

export function validateMelody(notes, clipMs) {
    if (
        !Number.isFinite(clipMs) ||
        clipMs <= 0 ||
        clipMs > 600000 ||
        !Array.isArray(notes) ||
        notes.length > 600000
    )
        throw new RangeError("Invalid melody");
    encodeResult({ jobId: 1, notes });
    if (notes.some((n) => n.timeMs + n.durationMs > clipMs + 1))
        throw new RangeError("Note exceeds clip");
    return notes;
}

// Editing is deliberately unquantized. Every command returns a new snapshot;
// recognizer notes remain immutable and polyphony is not silently discarded.
export function applyVocalBoundary(note) {
    const { boundary, ...original } = note;
    if (!boundary) return [original];
    const first = { ...original, durationMs: boundary.releaseMs };
    if (boundary.repeatMs === undefined) return [first];
    return [
        first,
        {
            ...original,
            timeMs: original.timeMs + boundary.repeatMs,
            durationMs: original.durationMs - boundary.repeatMs,
        },
    ];
}

export function editMelody(input, command, clipMs) {
    const notes = input.map((n) => ({ ...n }));
    const selected = notes[command.index];
    if (command.type !== "add" && !selected)
        throw new RangeError("Select a note");
    // Any manual change to a note invalidates evidence tied to its old bounds.
    if (selected && command.type !== "boundary" && command.type !== "add")
        delete selected.boundary;
    switch (command.type) {
        case "boundary":
            if (!selected.boundary)
                throw new RangeError("No boundary suggestion");
            notes.splice(command.index, 1, ...applyVocalBoundary(selected));
            break;
        case "update":
            notes[command.index] = { ...selected, ...command.note };
            break;
        case "add":
            notes.push({ velocity: 96, ...command.note });
            break;
        case "delete":
            notes.splice(command.index, 1);
            break;
        case "split": {
            const at = command.atMs;
            const end = selected.timeMs + selected.durationMs;
            if (
                !Number.isFinite(at) ||
                at - selected.timeMs < 20 ||
                end - at < 20
            )
                throw new RangeError(
                    "Split requires at least 20 ms on each side",
                );
            notes.splice(
                command.index,
                1,
                { ...selected, durationMs: at - selected.timeMs },
                { ...selected, timeMs: at, durationMs: end - at },
            );
            break;
        }
        case "merge": {
            const next = notes[command.index + 1];
            if (
                !next ||
                selected.note !== next.note ||
                next.timeMs < selected.timeMs ||
                next.timeMs - (selected.timeMs + selected.durationMs) > 250
            )
                throw new RangeError(
                    "Merge requires adjacent equal pitches, at most 250 ms apart",
                );
            notes.splice(command.index, 2, {
                ...selected,
                durationMs:
                    Math.max(
                        selected.timeMs + selected.durationMs,
                        next.timeMs + next.durationMs,
                    ) - selected.timeMs,
            });
            break;
        }
        default:
            throw new RangeError("Unknown melody command");
    }
    validateMelody(notes, clipMs);
    return Object.freeze(
        notes
            .sort((a, b) => a.timeMs - b.timeMs || b.note - a.note)
            .map(Object.freeze),
    );
}

export function phraseNotes(notes, fromMs, toMs, includeIndex = false) {
    if (
        !Number.isFinite(fromMs) ||
        !Number.isFinite(toMs) ||
        fromMs < 0 ||
        toMs <= fromMs
    )
        throw new RangeError("Invalid phrase");
    return notes.flatMap((n, index) => {
        const from = Math.max(fromMs, n.timeMs);
        const to = Math.min(toMs, n.timeMs + n.durationMs);
        return to > from
            ? [
                  {
                      ...n,
                      ...(includeIndex && {
                          displayIndex: n.displayIndex ?? index,
                      }),
                      timeMs: from - fromMs,
                      durationMs: to - from,
                  },
              ]
            : [];
    });
}

// These are review prompts, not probabilities and not automatic corrections.
export function reviewFlags(notes, index) {
    const n = notes[index],
        previous = notes[index - 1],
        flags = [];
    if (n.durationMs < 100) flags.push("short");
    if (n.boundary)
        flags.push(
            n.boundary.repeatMs === undefined
                ? "earlyRelease"
                : "samePitchRestart",
        );
    if (previous && Math.abs(n.note - previous.note) >= 12) flags.push("leap");
    if (previous && previous.timeMs + previous.durationMs > n.timeMs + 20)
        flags.push("overlap");
    return flags;
}
