import { createAudition } from "../../src/ui/transcribe/audition.js";

export async function measurePiano(pitches, velocity = 80) {
    const offline = new OfflineAudioContext(2, 44100, 44100);
    const context = {
        state: "running",
        get currentTime() {
            return offline.currentTime;
        },
        destination: offline.destination,
        decodeAudioData: (...args) => offline.decodeAudioData(...args),
        createGain: () => offline.createGain(),
        createDynamicsCompressor: () => offline.createDynamicsCompressor(),
        createBufferSource: () => offline.createBufferSource(),
    };
    const player = createAudition(
        () => context,
        () => {},
        {
            setTimer: () => null,
            clearTimer: () => {},
        },
    );
    await player.play(
        pitches.map((note) => ({
            note,
            velocity,
            timeMs: 0,
            durationMs: 500,
        })),
    );
    const rendered = await offline.startRendering();
    player.stop();
    let peak = 0,
        energy = 0,
        nonzero = 0;
    for (let channel = 0; channel < rendered.numberOfChannels; channel++) {
        for (const value of rendered.getChannelData(channel)) {
            peak = Math.max(peak, Math.abs(value));
            energy += value * value;
            if (Math.abs(value) > 0.0001) nonzero++;
        }
    }
    return {
        peak,
        rms: Math.sqrt(energy / (rendered.length * rendered.numberOfChannels)),
        nonzero,
    };
}
