import { phraseNotes } from "../../core/transcription/melody-edit.js";
import { decodeVocalPhrase } from "./vocal-phrase.js";

function beatPreview(context, buffer, startMs, durationMs, fromMs, beat) {
    if (
        !Number.isFinite(beat?.bpm) ||
        beat.bpm < 20 ||
        beat.bpm > 240 ||
        !Number.isFinite(beat.originMs)
    )
        throw new RangeError("Invalid beat grid");
    const rate = buffer.sampleRate,
        length = Math.ceil((durationMs * rate) / 1000);
    const mix = context.createBuffer(1, length, rate),
        channel = mix.getChannelData(0);
    const offset = Math.round((startMs * rate) / 1000);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
        const input = buffer
            .getChannelData(c)
            .subarray(offset, offset + length);
        for (let i = 0; i < input.length; i++)
            channel[i] += (input[i] * 0.7) / buffer.numberOfChannels;
    }
    const period = 60000 / beat.bpm;
    const first =
        beat.originMs + Math.ceil((fromMs - beat.originMs) / period) * period;
    for (let ms = first - fromMs; ms < durationMs; ms += period) {
        const at = Math.max(0, Math.round((ms * rate) / 1000));
        for (let i = 0; i < rate * 0.035 && at + i < length; i++)
            channel[at + i] +=
                0.27 *
                Math.sin((i * 2 * Math.PI * 1200) / rate) *
                Math.exp(-i / (0.007 * rate));
    }
    return mix;
}

// Each track uses the same clip-relative phrase. One transport owns the
// scheduled audio, pending decodes, and optional loop across tracks.
export function createPhrasePlayer(
    getContext,
    piano,
    {
        onUpdate = () => {},
        onError = () => {},
        loadVocal = decodeVocalPhrase,
        setTimer = (fn) => setInterval(fn, 40),
        clearTimer = (id) => clearInterval(id),
    } = {},
) {
    let session = null;
    function releaseTrack(run) {
        clearTimer(run.timer);
        run.timer = null;
        if (run.source) {
            try {
                run.source.stop();
            } catch {
                /* already ended */
            }
            run.source.disconnect();
            run.source = null;
        }
        run.gain?.disconnect();
        run.gain = null;
        piano.stop();
    }
    function stop() {
        const run = session;
        session = null;
        if (!run) return;
        releaseTrack(run);
        onUpdate({ active: false });
    }
    async function play({
        mode,
        buffer,
        vocalStem,
        notes,
        clipStartMs,
        fromMs,
        toMs,
        loop,
        volume = 0.75,
        onSounding,
        beat,
    }) {
        stop();
        piano.stop();
        if (
            !["source", "vocals", "piano", "compare", "beat"].includes(mode) ||
            (mode === "vocals" && !vocalStem) ||
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
        const tracks =
            mode === "compare"
                ? vocalStem
                    ? ["source", "vocals", "piano"]
                    : ["source", "piano"]
                : [mode];
        const loopTrack = loop && tracks.length === 1;
        const durationMs = toMs - fromMs;
        session = run;
        let context;
        async function playTrack(index) {
            const track = tracks[index];
            const update = (loading, positionMs) =>
                onUpdate({ active: true, loading, mode: track, positionMs });
            update(true, fromMs);
            if (context.state === "suspended") await context.resume();
            if (session !== run) return;
            let startAt;
            if (track === "piano") {
                const result = await piano.play(
                    phraseNotes(notes, fromMs, toMs, Boolean(onSounding)),
                    {
                        durationMs,
                        loop: loopTrack,
                        ...(onSounding && { onSounding }),
                    },
                );
                if (session !== run) return;
                startAt = result?.startAt;
                if (!Number.isFinite(startAt)) {
                    stop();
                    return;
                }
            } else {
                if (track === "vocals" && !run.vocalBuffer)
                    run.vocalBuffer = await loadVocal(
                        context,
                        vocalStem,
                        fromMs,
                        toMs,
                    );
                if (session !== run) return;
                const offset =
                    track === "source" ? (clipStartMs + fromMs) / 1000 : 0;
                const source = context.createBufferSource();
                run.source = source;
                run.gain = context.createGain();
                run.gain.gain.value = Math.max(0, Math.min(1, volume));
                source.buffer =
                    track === "beat"
                        ? beatPreview(
                              context,
                              buffer,
                              clipStartMs + fromMs,
                              durationMs,
                              fromMs,
                              beat,
                          )
                        : track === "source"
                          ? buffer
                          : run.vocalBuffer;
                source.connect(run.gain);
                run.gain.connect(context.destination);
                startAt = context.currentTime + 0.08;
                source.loop = Boolean(loopTrack);
                source.loopStart = offset;
                source.loopEnd = offset + durationMs / 1000;
                if (loopTrack) source.start(startAt, offset);
                else source.start(startAt, offset, durationMs / 1000);
            }
            run.timer = setTimer(() => {
                if (session !== run) return;
                const elapsed = Math.max(
                    0,
                    (context.currentTime - startAt) * 1000,
                );
                if (!loopTrack && elapsed >= durationMs) {
                    if (!loop && index === tracks.length - 1) stop();
                    else {
                        releaseTrack(run);
                        void playTrack((index + 1) % tracks.length).catch(
                            (error) => {
                                if (session !== run) return;
                                stop();
                                onError(error);
                            },
                        );
                    }
                    return;
                }
                update(
                    false,
                    fromMs + (loopTrack ? elapsed % durationMs : elapsed),
                );
            });
            update(false, fromMs);
        }
        try {
            context = getContext();
            await playTrack(0);
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
