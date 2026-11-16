const FIRST_SAMPLE = 21;
const LAST_SAMPLE = 108;
const NAMES = { 0: "C", 3: "Ds", 6: "Fs", 9: "A" };

export function pianoSample(pitch) {
    const midi = Math.max(
        FIRST_SAMPLE,
        Math.min(
            LAST_SAMPLE,
            FIRST_SAMPLE + Math.round((pitch - FIRST_SAMPLE) / 3) * 3,
        ),
    );
    return {
        midi,
        file: `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}.mp3`,
    };
}

export function createPianoBank({
    fetchImpl = (...args) => fetch(...args),
} = {}) {
    const contexts = new WeakMap();
    return {
        async load(context, notes, signal) {
            let cache = contexts.get(context);
            if (!cache) {
                cache = new Map();
                contexts.set(context, cache);
            }
            const anchors = new Set(
                notes.map((note) => pianoSample(note.note).midi),
            );
            await Promise.all(
                [...anchors].map(async (midi) => {
                    if (cache.has(midi)) return;
                    const { file } = pianoSample(midi);
                    const url = new URL(
                        `../../../vendor/piano/${file}`,
                        import.meta.url,
                    );
                    const response = await fetchImpl(url.href, { signal });
                    if (!response.ok)
                        throw new Error(
                            `Piano sample ${file}: HTTP ${response.status}`,
                        );
                    const bytes = await response.arrayBuffer();
                    signal?.throwIfAborted();
                    const buffer = await context.decodeAudioData(bytes);
                    signal?.throwIfAborted();
                    let peak = 0;
                    for (
                        let channel = 0;
                        channel < buffer.numberOfChannels;
                        channel++
                    )
                        for (const value of buffer.getChannelData(channel))
                            peak = Math.max(peak, Math.abs(value));
                    if (!(peak > 0.00001))
                        throw new Error(`Silent piano sample: ${file}`);
                    cache.set(midi, { buffer, normalization: 0.9 / peak });
                }),
            );
            signal?.throwIfAborted();
            return cache;
        },
    };
}
