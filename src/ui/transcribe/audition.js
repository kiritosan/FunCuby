import { AppError } from "../../core/message.js";
import { createPianoBank, pianoSample } from "./piano-bank.js";

const RELEASE_SECONDS = 0.12;
const LOOKAHEAD_SECONDS = 0.5;
const MAX_VOICES = 48;

// Listening dynamics are separate from model activation and exported MIDI.
export function pianoVelocity(velocity) {
    return 0.65 + 0.35 * Math.sqrt(Math.max(0, Math.min(127, velocity)) / 127);
}

export function createAudition(
    getContext,
    onChange = () => {},
    {
        bank = createPianoBank(),
        setTimer = (fn, ms) => setInterval(fn, ms),
        clearTimer = (timer) => clearInterval(timer),
        requestFrame = (fn) => requestAnimationFrame(fn),
        cancelFrame = (id) => cancelAnimationFrame(id),
    } = {},
) {
    let current = null,
        volume = 0.75;

    function stop() {
        const session = current;
        current = null;
        if (session) {
            session.abort.abort();
            clearTimer(session.timer);
            if (session.frame !== undefined) cancelFrame(session.frame);
            session.onSounding?.(null);
            for (const voice of session.voices) {
                voice.source.onended = null;
                try {
                    voice.source.stop();
                } catch {
                    /* already ended */
                }
                voice.source.disconnect();
                voice.gain.disconnect();
            }
            session.voices.clear();
            session.master?.disconnect();
            session.compressor?.disconnect();
        }
        onChange();
    }

    async function play(
        input,
        { durationMs = null, loop = false, skipIntro = false, onSounding } = {},
    ) {
        stop();
        if (
            durationMs !== null &&
            (!Number.isFinite(durationMs) || durationMs <= 0)
        )
            throw new RangeError("Invalid playback duration");
        if (loop && durationMs === null)
            throw new RangeError("Loop requires duration");
        if (loop && durationMs < 100)
            throw new RangeError("Loop must be at least 100 ms");
        if (!input.length && durationMs === null) return;
        const notes = input
            .map((note, i) => ({
                ...note,
                displayIndex: note.displayIndex ?? i,
            }))
            .sort((a, b) => a.timeMs - b.timeMs);
        const offsetMs = skipIntro && durationMs === null ? notes[0].timeMs : 0;
        const session = {
            abort: new AbortController(),
            voices: new Set(),
            timer: null,
            master: null,
            compressor: null,
            loading: true,
            onSounding,
        };
        current = session;
        onChange();
        try {
            const context = getContext();
            if (context.state === "suspended") await context.resume();
            if (current !== session) return;
            const samples = await bank.load(
                context,
                notes,
                session.abort.signal,
            );
            if (current !== session) return;
            session.loading = false;
            session.master = context.createGain();
            session.master.gain.value = volume;
            session.compressor = context.createDynamicsCompressor();
            session.compressor.threshold.value = -10;
            session.compressor.knee.value = 6;
            session.compressor.ratio.value = 16;
            session.compressor.attack.value = 0.003;
            session.compressor.release.value = 0.15;
            session.master.connect(session.compressor);
            session.compressor.connect(context.destination);
            const startAt = context.currentTime + 0.08;
            let cursor = 0,
                cycle = 0;
            const release = (voice) => {
                voice.source.disconnect();
                voice.gain.disconnect();
                session.voices.delete(voice);
                if (
                    current === session &&
                    durationMs === null &&
                    cursor === notes.length &&
                    !session.voices.size
                )
                    stop();
            };
            const pump = () => {
                if (current !== session) return;
                const now = context.currentTime;
                if (
                    durationMs !== null &&
                    !loop &&
                    now >= startAt + durationMs / 1000
                ) {
                    stop();
                    return;
                }
                if (loop && notes.length) {
                    const currentCycle = Math.max(
                        0,
                        Math.floor(((now - startAt) * 1000) / durationMs),
                    );
                    if (currentCycle > cycle) {
                        cycle = currentCycle;
                        cursor = 0;
                    }
                }
                while (
                    notes.length &&
                    (cursor < notes.length || loop) &&
                    startAt +
                        (cursor < notes.length
                            ? cycle * (durationMs ?? 0) +
                              (notes[cursor].timeMs - offsetMs)
                            : (cycle + 1) * durationMs + notes[0].timeMs) /
                            1000 <
                        now + LOOKAHEAD_SECONDS
                ) {
                    if (cursor === notes.length) {
                        cycle++;
                        cursor = 0;
                    }
                    const note = notes[cursor++];
                    const requested =
                        startAt +
                        (cycle * (durationMs ?? 0) + (note.timeMs - offsetMs)) /
                            1000;
                    const end =
                        requested + Math.max(0.03, note.durationMs / 1000);
                    if (end <= now) continue;
                    if (session.voices.size >= MAX_VOICES) {
                        const oldest = session.voices.values().next().value;
                        oldest.source.onended = null;
                        try {
                            oldest.source.stop();
                        } catch {
                            /* already ended */
                        }
                        release(oldest);
                    }
                    const anchor = pianoSample(note.note);
                    const sample = samples.get(anchor.midi);
                    const source = context.createBufferSource();
                    const gain = context.createGain();
                    const begin = Math.max(now, requested);
                    source.buffer = sample.buffer;
                    source.playbackRate.value =
                        2 ** ((note.note - anchor.midi) / 12);
                    const strength =
                        0.38 *
                        pianoVelocity(note.velocity) *
                        sample.normalization;
                    gain.gain.setValueAtTime(0, begin);
                    gain.gain.linearRampToValueAtTime(strength, begin + 0.004);
                    gain.gain.setValueAtTime(
                        strength,
                        Math.max(begin + 0.004, end),
                    );
                    gain.gain.linearRampToValueAtTime(0, end + RELEASE_SECONDS);
                    source.connect(gain);
                    gain.connect(session.master);
                    const voice = { source, gain, begin, end, note };
                    session.voices.add(voice);
                    source.onended = () => release(voice);
                    source.start(begin);
                    source.stop(end + RELEASE_SECONDS + 0.01);
                }
                if (
                    durationMs === null &&
                    cursor === notes.length &&
                    !session.voices.size
                )
                    stop();
            };
            // A bounded scheduling horizon avoids thousands of long-song nodes.
            session.timer = setTimer(pump, 50);
            pump();
            if (onSounding && current === session) {
                let previous = [];
                const follow = () => {
                    if (current !== session) return;
                    const now = context.currentTime;
                    const active = [...session.voices].filter(
                        (v) => v.begin <= now && now < v.end,
                    );
                    if (
                        active.length !== previous.length ||
                        active.some((v, i) => v !== previous[i])
                    ) {
                        onSounding(active.map((v) => v.note));
                        previous = active;
                    }
                    session.frame = requestFrame(follow);
                };
                follow();
            }
            onChange();
            return { startAt };
        } catch (error) {
            if (current !== session) return;
            stop();
            throw new AppError("transcribe.errors.piano", {
                reason: String(error?.message ?? error).slice(0, 200),
            });
        }
    }

    return {
        play,
        stop,
        setVolume(value) {
            if (!Number.isFinite(value)) throw new RangeError("Invalid volume");
            volume = Math.max(0, Math.min(1, value));
            current?.master?.gain.setTargetAtTime(
                volume,
                getContext().currentTime,
                0.015,
            );
        },
        get active() {
            return current !== null;
        },
        get loading() {
            return current?.loading ?? false;
        },
    };
}
