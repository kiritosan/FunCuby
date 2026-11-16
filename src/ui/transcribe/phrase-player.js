import { phraseNotes } from "../../core/transcription/melody-edit.js";

// One transport for A/B comparison, never a synchronized duet. Both modes use
// clip-relative time; source playback adds the original source clip offset.
export function createPhrasePlayer(
    getContext,
    piano,
    {
        onUpdate = () => {},
        setTimer = (fn) => setInterval(fn, 40),
        clearTimer = (id) => clearInterval(id),
    } = {},
) {
    let session = null;
    function stop() {
        const run = session;
        session = null;
        if (!run) return;
        clearTimer(run.timer);
        if (run.source) {
            run.source.onended = null;
            try {
                run.source.stop();
            } catch {
                /* already ended */
            }
            run.source.disconnect();
        }
        run.gain?.disconnect();
        piano.stop();
        onUpdate({ active: false });
    }
    async function play({
        mode,
        buffer,
        notes,
        clipStartMs,
        fromMs,
        toMs,
        loop,
        volume = 0.75,
    }) {
        stop();
        piano.stop();
        if (
            !["source", "piano"].includes(mode) ||
            !buffer ||
            !Number.isFinite(clipStartMs) ||
            clipStartMs < 0 ||
            !Number.isFinite(fromMs) ||
            !Number.isFinite(toMs) ||
            fromMs < 0 ||
            toMs - fromMs < 100 ||
            toMs - fromMs > 30000 ||
            clipStartMs + toMs > buffer.duration * 1000 + 1
        )
            throw new RangeError("Invalid comparison range");
        const run = { source: null, gain: null, timer: null };
        session = run;
        onUpdate({ active: true, loading: true, mode, positionMs: fromMs });
        try {
            const context = getContext();
            if (context.state === "suspended") await context.resume();
            if (session !== run) return;
            const durationMs = toMs - fromMs;
            let startAt;
            if (mode === "source") {
                const source = context.createBufferSource();
                run.source = source;
                run.gain = context.createGain();
                run.gain.gain.value = Math.max(0, Math.min(1, volume));
                source.buffer = buffer;
                source.connect(run.gain);
                run.gain.connect(context.destination);
                startAt = context.currentTime + 0.08;
                source.loop = Boolean(loop);
                source.loopStart = (clipStartMs + fromMs) / 1000;
                source.loopEnd = (clipStartMs + toMs) / 1000;
                if (loop) source.start(startAt, source.loopStart);
                else source.start(startAt, source.loopStart, durationMs / 1000);
            } else {
                const result = await piano.play(
                    phraseNotes(notes, fromMs, toMs),
                    { durationMs, loop },
                );
                if (session !== run) return;
                startAt = result?.startAt;
                if (!Number.isFinite(startAt)) {
                    stop();
                    return;
                }
            }
            run.timer = setTimer(() => {
                if (session !== run) return;
                const elapsed = Math.max(
                    0,
                    (context.currentTime - startAt) * 1000,
                );
                if (!loop && elapsed >= durationMs) {
                    stop();
                    return;
                }
                onUpdate({
                    active: true,
                    loading: false,
                    mode,
                    positionMs:
                        fromMs + (loop ? elapsed % durationMs : elapsed),
                });
            });
            onUpdate({
                active: true,
                loading: false,
                mode,
                positionMs: fromMs,
            });
        } catch (error) {
            if (session !== run) return;
            stop();
            throw error;
        }
    }
    return {
        play,
        stop,
        get active() {
            return session !== null;
        },
    };
}
