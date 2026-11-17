"""Same-input local MDX -> GAME comparison, without pretending to have ground truth."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import time

import numpy as np

from game_transcribe_loader import load_game


def load_separator():
    spec = importlib.util.spec_from_file_location("mdx_separation", Path(__file__).with_name("mdx-separation.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--language", default="zh", choices=("auto", "zh", "en", "ja", "yue"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    output = Path(args.output_dir)
    if not output.is_dir():
        raise ValueError("Output directory must already exist")
    separator = load_separator()
    mix = separator.read_stereo(args.input)
    started = time.perf_counter()
    model = separator.VocalSeparator(root / ".tools" / "UVR-MDX-NET-Voc_FT.onnx")
    vocal = model.separate(mix, lambda done, total: print(
        json.dumps({"stage": "separating", "completed": done, "total": total}), flush=True))
    separation_seconds = time.perf_counter() - started
    del model
    accompaniment = mix - vocal
    peak = max(float(np.max(np.abs(audio))) for audio in (mix, vocal, accompaniment))
    gain = min(1.0, 0.95 / peak) if peak else 1.0
    for name, audio in (("mix", mix), ("vocals", vocal), ("accompaniment", accompaniment)):
        separator.write_stereo(output / (name + ".wav"), audio, gain)
    game = load_game()
    game_model = game.GameModel(root / ".tools" / "game-model", args.language)
    candidates, timings = {}, {}
    for name, audio in (("mix", mix), ("vocals", vocal)):
        begin = time.perf_counter()
        candidates[name] = game_model.transcribe(audio.mean(axis=0).astype(np.float32))
        timings[name] = time.perf_counter() - begin
    result = {
        "schema": "funcuby.separation-evaluation", "version": 1,
        "referenceStatus": "unverified-draft",
        "inputSha256": hashlib.sha256(Path(args.input).read_bytes()).hexdigest(),
        "seconds": mix.shape[1] / 44100, "language": args.language,
        "separator": {"model": "UVR-MDX-NET-Voc_FT", "sha256": separator.MODEL_SHA256,
                      "backend": "CPUExecutionProvider", "denoise": False,
                      "compensate": separator.COMPENSATE, "seconds": separation_seconds},
        "game": {"model": "GAME-1.0.3-small", "steps": 8, "seconds": timings},
        "audio": {"sampleRate": 44100, "channels": 2, "sharedListeningGain": gain,
                  "rms": {name: float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))
                          for name, audio in (("mix", mix), ("vocals", vocal), ("accompaniment", accompaniment))}},
        "candidates": candidates,
        "warning": "Fewer notes, isolated vocal sound and mixture reconstruction do not establish lead-melody accuracy.",
    }
    with open(output / "comparison.json", "x", encoding="utf-8") as target:
        json.dump(result, target, indent=2, allow_nan=False)
    print(json.dumps({"stage": "complete", "counts": {key: len(value) for key, value in candidates.items()}}), flush=True)


if __name__ == "__main__":
    main()
