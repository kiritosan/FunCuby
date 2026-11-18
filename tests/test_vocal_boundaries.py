import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from vocal_boundaries import suggest_vocal_boundaries


class VocalBoundariesTest(unittest.TestCase):
    def suggest(self, samples):
        note = {"note": 69, "timeMs": 0, "durationMs": len(samples) / 44.1}
        return suggest_vocal_boundaries([note], samples)[0].get("boundary")

    def setUp(self):
        t = np.arange(44100) / 44100
        # A sustained note with vibrato and a natural decrescendo.
        self.voice = (0.3 * (1 - 0.8 * t) *
                      np.sin(2 * np.pi * 440 * t + 1.8 * np.sin(2 * np.pi * 5 * t)))

    def test_trailing_rest(self):
        self.voice[22050:] = 0
        result = self.suggest(self.voice)
        self.assertAlmostEqual(result["releaseMs"], 500, delta=25)
        self.assertNotIn("repeatMs", result)

    def test_same_note_after_rest(self):
        self.voice[13230:22050] = 0
        result = self.suggest(self.voice)
        self.assertAlmostEqual(result["releaseMs"], 300, delta=25)
        self.assertAlmostEqual(result["repeatMs"], 500, delta=25)

    def test_sustain_brief_dip_and_silence(self):
        self.assertIsNone(self.suggest(self.voice))
        self.voice[13230:14553] = 0
        self.assertIsNone(self.suggest(self.voice))
        self.assertIsNone(self.suggest(np.zeros(44100)))

    def test_different_pitch_does_not_create_repeat(self):
        for semitones in (1, -1, 7, 12):
            with self.subTest(semitones=semitones):
                self.voice[13230:22050] = 0
                frequency = 440 * 2 ** (semitones / 12)
                self.voice[22050:] = 0.2 * np.sin(np.arange(22050) * 2 * np.pi * frequency / 44100)
                result = self.suggest(self.voice)
                self.assertFalse(result and "repeatMs" in result)


if __name__ == "__main__":
    unittest.main()
