import importlib.util
from pathlib import Path
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location(
    "mdx", Path(__file__).resolve().parents[1] / "scripts" / "mdx-separation.py")
mdx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mdx)


class SeparationTests(unittest.TestCase):
    def test_complex_stereo_stft_roundtrip_keeps_phase_and_length(self):
        transform = mdx.Spectrogram(n_fft=64, hop=16, dim_f=33)
        rng = np.random.default_rng(20)
        audio = rng.normal(size=(2, 16 * 15)).astype(np.float32)
        encoded = transform.encode(audio)
        self.assertEqual(encoded.shape, (1, 4, 33, 16))
        decoded = transform.decode(encoded)
        np.testing.assert_allclose(decoded, audio, atol=1e-6)
        self.assertFalse(np.allclose(decoded[0], decoded[1]))

    def test_padded_chunk_identity_has_no_time_shift_or_tail_loss(self):
        # Bypass only graph loading, not real STFT/chunk/reconstruction code.
        class Identity:
            def run(self, _names, feeds):
                return [feeds["input"]]
        separator = mdx.VocalSeparator.__new__(mdx.VocalSeparator)
        separator.session = Identity()
        separator.input_name = "input"
        separator.output_name = "output"
        separator.transform = mdx.Spectrogram(dim_f=mdx.N_FFT // 2 + 1)
        length = mdx.CORE + 8000
        audio = np.zeros((2, length), dtype=np.float32)
        # Impulses reveal chunk joins/offsets; DC filtering adds a small smear.
        audio[0, [10000, mdx.CORE, length - 100]] = 0.5
        audio[1, [12000, mdx.CORE + 1000]] = -0.4
        progress = []
        decoded = separator.separate(audio, lambda done, total: progress.append((done, total)))
        self.assertEqual(decoded.shape, audio.shape)
        self.assertEqual(progress, [(0, 2), (1, 2), (2, 2)])
        for at in (10000, mdx.CORE, length - 100):
            self.assertEqual(int(np.argmax(decoded[0, at - 3:at + 4])) - 3, 0)
        self.assertGreater(float(decoded[0, length - 100]), 0.49)
        self.assertLess(float(np.max(np.abs(decoded - audio * mdx.COMPENSATE))), 0.002)


if __name__ == "__main__":
    unittest.main()
