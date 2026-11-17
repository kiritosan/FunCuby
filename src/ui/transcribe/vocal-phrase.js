import { AppError } from "../../core/message.js";

// The local UVR service writes a 44-byte PCM header followed by interleaved
// stereo int16 frames. Decode only the selected phrase, even for a long stem.
export async function decodeVocalPhrase(context, stem, fromMs, toMs) {
    const header = new DataView(await stem.slice(0, 44).arrayBuffer());
    if (
        header.byteLength !== 44 ||
        header.getUint32(0) !== 0x52494646 || // RIFF
        header.getUint32(8) !== 0x57415645 || // WAVE
        header.getUint32(12) !== 0x666d7420 || // "fmt "
        header.getUint32(16, true) !== 16 ||
        header.getUint16(20, true) !== 1 ||
        header.getUint16(22, true) !== 2 ||
        header.getUint32(24, true) !== 44100 ||
        header.getUint16(32, true) !== 4 ||
        header.getUint16(34, true) !== 16 ||
        header.getUint32(36) !== 0x64617461 || // data
        header.getUint32(40, true) !== stem.size - 44 ||
        (stem.size - 44) % 4 !== 0
    )
        throw new AppError("transcribe.editor.vocalReadError");

    const frames = (stem.size - 44) / 4;
    const start = Math.round(fromMs * 44.1);
    const end = Math.min(frames, Math.round(toMs * 44.1));
    // Captures for different engines can differ by one resampling frame.
    if (end <= start || toMs > frames / 44.1 + 1)
        throw new AppError("transcribe.editor.vocalReadError");
    const pcm = new DataView(
        await stem.slice(44 + start * 4, 44 + end * 4).arrayBuffer(),
    );
    const buffer = context.createBuffer(2, end - start, 44100);
    for (let channel = 0; channel < 2; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < data.length; i++)
            data[i] = pcm.getInt16(i * 4 + channel * 2, true) / 32768;
    }
    return buffer;
}
