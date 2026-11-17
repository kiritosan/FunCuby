"""Optional local evaluation adapter for the pinned UVR vocal ONNX model."""
import hashlib
import math
import os
from pathlib import Path
import wave

import numpy as np
import onnxruntime as ort

MODEL_SHA256 = "534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111"
MODEL_BYTES = 66762490
SAMPLE_RATE = 44100
N_FFT = 7680
HOP = 1024
DIM_F = 3072
FRAMES = 256
CHUNK = HOP * (FRAMES - 1)
TRIM = N_FFT // 2
CORE = CHUNK - 2 * TRIM
COMPENSATE = 1.021


class Spectrogram:
    """Periodic Hann, centered reflect STFT and overlap-normalized inverse."""
    def __init__(self, n_fft=N_FFT, hop=HOP, dim_f=DIM_F):
        self.n_fft, self.hop, self.dim_f = n_fft, hop, dim_f
        self.window = np.hanning(n_fft + 1)[:-1].astype(np.float32)

    def encode(self, audio):
        padded = np.pad(audio, ((0, 0), (self.n_fft // 2, self.n_fft // 2)), mode="reflect")
        frames = np.lib.stride_tricks.sliding_window_view(padded, self.n_fft, axis=-1)[:, ::self.hop]
        spectrum = np.fft.rfft(frames * self.window, axis=-1).transpose(0, 2, 1)
        # The graph expects left real/imaginary followed by right real/imaginary.
        return np.stack((spectrum.real, spectrum.imag), axis=1).reshape(
            1, 4, self.n_fft // 2 + 1, spectrum.shape[-1]
        )[:, :, :self.dim_f].astype(np.float32)

    def decode(self, tensor):
        frames = tensor.shape[-1]
        bins = self.n_fft // 2 + 1
        padded = np.pad(tensor[0], ((0, 0), (0, bins - tensor.shape[-2]), (0, 0)))
        complex_spectrum = padded.reshape(2, 2, bins, frames)
        complex_spectrum = complex_spectrum[:, 0] + 1j * complex_spectrum[:, 1]
        waves = np.fft.irfft(complex_spectrum.transpose(0, 2, 1), n=self.n_fft, axis=-1)
        size = self.hop * (frames - 1) + self.n_fft
        result, divisor = np.zeros((2, size)), np.zeros(size)
        for index in range(frames):
            at = index * self.hop
            result[:, at:at + self.n_fft] += waves[:, index] * self.window
            divisor[at:at + self.n_fft] += self.window ** 2
        result /= np.maximum(divisor, 1e-12)
        trim = self.n_fft // 2
        return result[:, trim:-trim].astype(np.float32)


def read_stereo(path, max_seconds=600):
    with wave.open(str(path), "rb") as source:
        if (source.getframerate(), source.getnchannels(), source.getsampwidth()) != (SAMPLE_RATE, 2, 2):
            raise ValueError("Expected 44100 Hz stereo 16-bit PCM WAV")
        frames = source.getnframes()
        if not 1 <= frames <= SAMPLE_RATE * max_seconds:
            raise ValueError(f"Audio must be at most {max_seconds} seconds")
        data = source.readframes(frames)
        if len(data) != frames * 4:
            raise ValueError("Truncated WAV")
    return np.frombuffer(data, dtype="<i2").reshape(-1, 2).T.astype(np.float32) / 32768


def write_stereo(path, audio, gain):
    pcm = np.round(np.clip(audio.T * gain, -1, 32767 / 32768) * 32768).astype("<i2")
    with open(path, "xb") as target:
        with wave.open(target, "wb") as output:
            output.setparams((2, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
            output.writeframes(pcm.tobytes())


class VocalSeparator:
    def __init__(self, path, session_factory=None):
        model = Path(path)
        if model.stat().st_size != MODEL_BYTES or hashlib.sha256(model.read_bytes()).hexdigest() != MODEL_SHA256:
            raise ValueError("Invalid separator model; run npm run setup:separation")
        ort.disable_telemetry_events()
        options = ort.SessionOptions()
        options.intra_op_num_threads = max(1, min(4, int(os.environ.get("FUNCUBY_MDX_THREADS", "2"))))
        options.inter_op_num_threads = 1
        self.session = (session_factory or ort.InferenceSession)(
            str(model), sess_options=options, providers=["CPUExecutionProvider"])
        incoming, outgoing = self.session.get_inputs(), self.session.get_outputs()
        if len(incoming) != 1 or incoming[0].shape[-3:] != [4, DIM_F, FRAMES] or len(outgoing) != 1:
            raise ValueError("Unexpected MDX graph signature")
        self.input_name, self.output_name = incoming[0].name, outgoing[0].name
        self.transform = Spectrogram()

    def separate(self, mix, on_progress=lambda _done, _total: None):
        if mix.ndim != 2 or mix.shape[0] != 2 or not np.isfinite(mix).all() or mix.shape[1] == 0:
            raise ValueError("Invalid stereo input")
        length = mix.shape[1]
        total = math.ceil(length / CORE)
        padded = np.pad(mix, ((0, 0), (TRIM, total * CORE - length + TRIM)))
        vocals = np.zeros_like(mix)
        on_progress(0, total)
        for index in range(total):
            offset = index * CORE
            tensor = self.transform.encode(padded[:, offset:offset + CHUNK])
            tensor[:, :, :3] = 0
            predicted = self.session.run([self.output_name], {self.input_name: tensor})[0]
            if predicted.shape != tensor.shape or not np.isfinite(predicted).all():
                raise ValueError("Invalid separation output")
            wave_chunk = self.transform.decode(predicted)
            end = min(length, offset + CORE)
            vocals[:, offset:end] = wave_chunk[:, TRIM:TRIM + end - offset] * COMPENSATE
            on_progress(index + 1, total)
        return vocals
