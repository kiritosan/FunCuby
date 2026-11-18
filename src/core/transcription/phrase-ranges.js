// Clip-relative practice ranges. A rest can close a phrase only after all
// overlapping notes have ended. Keep a little silence for the next pickup.
export function phraseRanges(notes, clipMs) {
    const ranges = [];
    let start = null,
        end = 0;
    function append(until) {
        while (until - start > 30000) {
            // Leave at least one second in the last range.
            const cut = Math.min(start + 30000, until - 1000);
            ranges.push({ start, end: cut });
            start = cut;
        }
        ranges.push({ start, end: until });
    }
    for (const n of [...notes].sort((a, b) => a.timeMs - b.timeMs)) {
        if (n.timeMs >= clipMs) break;
        const gap = n.timeMs - end;
        const span = n.timeMs - start;
        if (
            start !== null &&
            (gap >= 1200 || (gap >= 350 && end - start >= 2000) || span >= 8000)
        ) {
            const cut = gap >= 350 ? end + 150 : n.timeMs;
            append(cut);
            start = gap >= 350 ? n.timeMs - 150 : cut;
        }
        if (start === null) start = Math.max(0, n.timeMs - 150);
        end = Math.max(end, n.timeMs + n.durationMs);
    }
    if (start !== null) {
        const until = Math.min(clipMs, Math.max(start + 100, end + 150));
        if (until - start < 100 && ranges.length) {
            start = Math.max(0, until - 100);
        }
        append(until);
    } else ranges.push({ start: 0, end: Math.min(clipMs, 10000) });
    return ranges;
}
