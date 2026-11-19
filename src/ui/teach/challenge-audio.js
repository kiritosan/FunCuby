import { decodeVocalPhrase } from "../transcribe/vocal-phrase.js";

const RATE = 24000;

// Pitch the source first, then overlap matching waveform segments to reach the
// chart duration. Each segment is anchored to the score clock to avoid drift.
export function fitBacking(input, speed, semitones, frames) {
    const pitch = 2 ** (semitones / 12);
    const pitched = new Float32Array(Math.ceil(input.length / pitch));
    for (let i = 0; i < pitched.length; i++) {
        const pos = i * pitch,
            at = Math.floor(pos),
            part = pos - at;
        pitched[i] = input[at] * (1 - part) + (input[at + 1] ?? 0) * part;
    }
    const output = new Float32Array(frames);
    const step = speed / pitch,
        hop = 480;
    if (Math.abs(step - 1) < 0.00001) {
        output.set(pitched.subarray(0, frames));
        return output;
    }
    for (let dest = 0; dest < frames; dest += hop) {
        const nominal = Math.round(dest * step);
        let source = nominal,
            best = -Infinity;
        if (dest) {
            for (
                let pos = Math.max(0, nominal - 160);
                pos <= nominal + 160 && pos + hop < pitched.length;
                pos += 4
            ) {
                let dot = 0,
                    energy = 1e-10;
                for (let j = 0; j < hop && dest + j < frames; j += 8) {
                    dot += output[dest + j] * pitched[pos + j];
                    energy += pitched[pos + j] ** 2;
                }
                const similarity = dot / Math.sqrt(energy);
                if (similarity > best) {
                    best = similarity;
                    source = pos;
                }
            }
        }
        for (let j = 0; j < 2 * hop && dest + j < frames; j++) {
            const blend = dest && j < hop ? j / hop : 1;
            output[dest + j] =
                output[dest + j] * (1 - blend) +
                (pitched[source + j] ?? 0) * blend;
        }
    }
    return output;
}

export async function buildBacking(context, media, plan, speed) {
    const relative = media.originMs + plan.startMs * speed;
    const length = Math.min(
        plan.durationMs * speed,
        media.clipMs - relative,
        media.buffer.duration * 1000 - media.clipStartMs - relative,
    );
    if (length <= 0) return null;
    const vocals = media.stem
        ? await decodeVocalPhrase(
              context,
              media.stem,
              relative,
              relative + length,
          )
        : null;
    const mix = media.buffer,
        start = (media.clipStartMs + relative) / 1000;
    const left = mix.getChannelData(0),
        right = mix.getChannelData(mix.numberOfChannels - 1);
    const vl = vocals?.getChannelData(0),
        vr = vocals?.getChannelData(1);
    const samples = new Float32Array(Math.ceil((length * RATE) / 1000));
    for (let i = 0; i < samples.length; i++) {
        const at = Math.floor((start + i / RATE) * mix.sampleRate);
        const vi = Math.floor((i * 44100) / RATE);
        samples[i] =
            ((left[at] ?? 0) +
                (right[at] ?? 0) -
                (vl?.[vi] ?? 0) -
                (vr?.[vi] ?? 0)) *
            0.35;
    }
    const result = fitBacking(
        samples,
        speed,
        media.transpose,
        Math.ceil((plan.durationMs * RATE) / 1000),
    );
    const buffer = context.createBuffer(1, result.length, RATE);
    buffer.copyToChannel(result, 0);
    return buffer;
}
