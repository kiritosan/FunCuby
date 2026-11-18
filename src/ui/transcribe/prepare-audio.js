import {
    assertNotAborted,
    TranscriptionError,
} from "../../core/transcription/errors.js";
import { TRANSCRIPTION_ENGINES } from "../../core/transcription/config.js";
export async function prepareAudio(
    audioBuffer,
    start,
    actualSeconds,
    engine,
    signal,
) {
    const { sampleRate, channels } = TRANSCRIPTION_ENGINES[engine];
    const offline = new OfflineAudioContext(
        channels,
        Math.ceil(actualSeconds * sampleRate),
        sampleRate,
    );
    const source = offline.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offline.destination);
    source.start(0, start, actualSeconds);
    const rendered = await offline.startRendering();
    assertNotAborted(signal);
    const frameCount = rendered.length;
    let samples;
    if (channels === 2) {
        const left = rendered.getChannelData(0);
        const right =
            rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left;
        samples = new Float32Array(frameCount * 2);
        samples.set(left, 0);
        samples.set(right, frameCount);
    } else {
        samples = Float32Array.from(rendered.getChannelData(0));
    }

    if (samples.every((sample) => sample === 0))
        throw new TranscriptionError("silence");
    return { samples, clipMs: (frameCount / sampleRate) * 1000 };
}
