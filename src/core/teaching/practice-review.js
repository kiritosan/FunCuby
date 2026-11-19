import { phraseRanges } from "../transcription/phrase-ranges.js";

export class PracticeReview {
    trouble = new Map();
    quarters = new Set();
    chords = new Map();
    phrases = new Map();
    lastSign = 0;
    streak = 0;

    constructor(notes, durationMs) {
        const ranges = phraseRanges(notes, durationMs);
        let index = 0;
        for (const note of notes) {
            while (
                index + 1 < ranges.length &&
                note.timeMs >= ranges[index].end
            )
                index++;
            const phrase = ranges[index];
            phrase.remaining = (phrase.remaining ?? 0) + 1;
            this.phrases.set(note.id, phrase);
            const chord = this.chords.get(note.timeMs) ?? {
                size: 0,
                hits: 0,
                misses: 0,
                errors: [],
            };
            chord.size++;
            this.chords.set(note.timeMs, chord);
        }
        for (const [at, chord] of this.chords)
            if (chord.size < 2) this.chords.delete(at);
    }
    flag(note) {
        if (!note) return;
        this.trouble.set(note.bar, (this.trouble.get(note.bar) ?? 0) + 1);
        this.quarters.add(note.quarter);
        const phrase = this.phrases.get(note.id);
        if (phrase) phrase.slipped = true;
    }
    judge(hit, next) {
        if (["Wrong", "Miss", "50", "100"].includes(hit.grade))
            this.flag(hit.id === undefined ? next : hit);
        const phrase = this.phrases.get(hit.id);
        if (!phrase) return;
        if (--phrase.remaining === 0 && !phrase.slipped)
            return { key: "phraseClear" };
    }
    chordFeedback(hit) {
        const chord = this.chords.get(hit.timeMs);
        if (!chord) return;
        if (hit.grade === "Miss") {
            chord.misses++;
            return;
        }
        chord.hits++;
        chord.errors.push(hit);
        if (chord.hits < chord.size)
            return {
                key: "partial",
                args: { done: chord.hits, total: chord.size },
            };
        const leastAccurate = chord.errors.reduce((a, b) =>
            Math.abs(a.errorMs) >= Math.abs(b.errorMs) ? a : b,
        );
        return {
            key: chord.errors.every((n) => n.grade === "300")
                ? "chordDone"
                : leastAccurate.errorMs < 0
                  ? "chordEarly"
                  : "chordLate",
        };
    }
    timingHint(hit) {
        if (!["100", "50", "300"].includes(hit.grade)) {
            this.streak = 0;
            return;
        }
        const sign = hit.grade === "300" ? 0 : Math.sign(hit.errorMs);
        this.streak = sign === this.lastSign ? this.streak + 1 : 1;
        this.lastSign = sign;
        if (sign && this.streak === 3)
            return { key: sign < 0 ? "waitBeat" : "anticipate" };
    }
    chordSummary() {
        let partial = 0,
            missed = 0;
        for (const chord of this.chords.values()) {
            if (chord.misses) {
                missed++;
                if (chord.hits) partial++;
            }
        }
        return { partial, whole: missed - partial, missed };
    }
}
