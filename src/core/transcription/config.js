export const SAMPLE_RATE = 22050;
export const MAX_AUDIO_SECONDS = 600;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_SAMPLES = SAMPLE_RATE * MAX_AUDIO_SECONDS;
export const MAX_OFFSET_MS = MAX_AUDIO_SECONDS * 1000;
export const STALL_WARNING_MS = 60000;
export const PROTOCOL_VERSION = 1;
// A WebGL context is not a model compatibility check. Use validated execution.
export const TRANSCRIPTION_BACKEND = "cpu";
export const TRANSCRIPTION_ENGINES = Object.freeze({
    "basic-pitch": Object.freeze({ sampleRate: SAMPLE_RATE, channels: 1 }),
    game: Object.freeze({ sampleRate: 44100, channels: 1 }),
    "game-separated": Object.freeze({ sampleRate: 44100, channels: 2 }),
});
export const GAME_LANGUAGES = Object.freeze(["auto", "zh", "en", "ja", "yue"]);

// Match the pinned Basic Pitch model and the existing note extraction settings.
export const BASIC_PITCH = Object.freeze({
    fftHop: 256,
    pitches: 88,
    onsetThreshold: 0.5,
    frameThreshold: 0.3,
    minNoteLength: 8,
});
