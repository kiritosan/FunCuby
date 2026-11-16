"""CPU inference for official GAME 1.0.3 ONNX exports; no PyTorch required."""
import argparse
import json
import math
import os
from pathlib import Path
import sys
import wave

DEPENDENCY_ERROR = None
try:
    import numpy as np
    import onnxruntime as ort
except ImportError as error:
    DEPENDENCY_ERROR = str(error)
if DEPENDENCY_ERROR is None:
    ort.disable_telemetry_events()


def emit(event):
    print(json.dumps(event, ensure_ascii=True, allow_nan=False), flush=True)


def find_model(directory):
    root = Path(directory)
    candidates = [root / "config.json", *sorted(root.glob("*/config.json"))]
    for config in candidates:
        if config.is_file() and all(
            (config.parent / (name + ".onnx")).is_file()
            for name in ("encoder", "segmenter", "estimator", "bd2dur")
        ):
            return config.parent
    raise ValueError("GAME model not installed. Run npm run setup:game.")


def load_audio(path, np, raw=False):
    if raw:
        size = Path(path).stat().st_size
        if size < 4 or size % 4 or size > 44100 * 600 * 4:
            raise ValueError("Invalid 44100 Hz mono float32 audio")
        samples = np.fromfile(path, dtype="<f4")
        if not np.isfinite(samples).all():
            raise ValueError("Non-finite audio samples")
        return samples
    with wave.open(str(path), "rb") as source:
        if (source.getframerate(), source.getnchannels(), source.getsampwidth()) != (44100, 1, 2):
            raise ValueError("Expected mono 44100 Hz 16-bit PCM WAV")
        frames = source.getnframes()
        if not 1 <= frames <= 44100 * 600:
            raise ValueError("Expected audio up to 600 seconds")
        data = source.readframes(frames)
        if len(data) != frames * 2:
            raise ValueError("Truncated WAV data")
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


class GameModel:
    def __init__(self, directory, language="zh", steps=8):
        self.np = np
        self.directory = find_model(directory)
        self.config = json.loads((self.directory / "config.json").read_text(encoding="utf-8"))
        if self.config["samplerate"] != 44100:
            raise ValueError("Unsupported GAME sample rate")
        self.timestep = float(self.config["timestep"])
        if not 0 < self.timestep <= 0.1:
            raise ValueError("Invalid model time step")
        languages = self.config.get("languages") or {}
        if language != "auto" and language not in languages:
            raise ValueError("Unsupported model language")
        self.language = languages.get(language, 0)
        self.steps = steps
        ort.set_seed(0)
        options = ort.SessionOptions()
        options.intra_op_num_threads = max(1, min(4, int(os.environ.get("FUNCUBY_GAME_THREADS", "2"))))
        options.inter_op_num_threads = 1
        self.sessions = {
            name: ort.InferenceSession(
                str(self.directory / (name + ".onnx")),
                sess_options=options, providers=["CPUExecutionProvider"],
            )
            for name in ("encoder", "segmenter", "estimator", "bd2dur")
        }

    def run(self, name, values):
        session = self.sessions[name]
        feeds = {item.name: values[item.name] for item in session.get_inputs()}
        return dict(zip(
            (item.name for item in session.get_outputs()),
            session.run(None, feeds),
        ))

    def segment(self, samples):
        np = self.np
        length = len(samples) / 44100
        if len(samples) < 4410:
            samples = np.pad(samples, (0, 4410 - len(samples)))
        encoded = self.run("encoder", {
            "waveform": samples[np.newaxis, :],
            "duration": np.asarray([length], dtype=np.float32),
        })
        known = np.zeros_like(encoded["maskT"], dtype=np.bool_)
        boundaries = known
        count = self.steps if self.config.get("loop") else 1
        for step in range(count):
            boundaries = self.run("segmenter", {
                "x_seg": encoded["x_seg"],
                "language": np.asarray([self.language], dtype=np.int64),
                "known_boundaries": known,
                "prev_boundaries": boundaries,
                "t": np.asarray([step / count], dtype=np.float32),
                "maskT": encoded["maskT"],
                "threshold": np.asarray(0.2, dtype=np.float32),
                "radius": np.asarray(2, dtype=np.int64),
            })["boundaries"]
        regions = self.run("bd2dur", {
            "boundaries": boundaries, "maskT": encoded["maskT"],
        })
        # Export names are checked against the actual ONNX graph, not positional outputs.
        mask = regions.get("maskN")
        if mask is None:
            mask = regions.get("mask")
        if mask is None:
            raise ValueError("GAME duration converter did not return a note mask")
        estimates = self.run("estimator", {
            "x_est": encoded["x_est"], "boundaries": boundaries,
            "maskT": encoded["maskT"], "maskN": mask,
            "threshold": np.asarray(0.2, dtype=np.float32),
        })
        result, cursor = [], 0.0
        for duration, present, score, valid in zip(
            regions["durations"][0], estimates["presence"][0],
            estimates["scores"][0], mask[0],
        ):
            duration, score = float(duration), float(score)
            end = min(length, cursor + duration)
            if valid and present and math.isfinite(score) and 0 <= score <= 127 and end > cursor:
                result.append({
                    "note": int(math.floor(score + 0.5)),
                    "start": cursor, "end": end, "pitchSemitones": score,
                })
            cursor += duration
        return result

    def transcribe(self, samples, on_progress=lambda _done, _total: None):
        sr, core, context = 44100, 8, 1
        total = math.ceil(len(samples) / (core * sr))
        notes = []
        on_progress(0, total)
        for index in range(total):
            begin = index * core
            end = min(len(samples) / sr, begin + core)
            left = max(0, begin - context)
            right = min(len(samples), int((end + context) * sr))
            chunk = samples[int(left * sr):right]
            for detected in self.segment(chunk):
                raw_start = left + detected["start"]
                raw_end = left + detected["end"]
                start, finish = max(begin, raw_start), min(end, raw_end)
                if finish - start < 0.02:
                    continue
                item = {
                    "note": detected["note"], "timeMs": start * 1000,
                    "durationMs": (finish - start) * 1000, "velocity": 96,
                    "pitchSemitones": detected["pitchSemitones"],
                    "_left": raw_start < begin - self.timestep,
                    "_right": raw_end > end + self.timestep,
                }
                if notes and notes[-1]["_right"] and item["_left"] and (
                    notes[-1]["note"] == item["note"] and
                    abs(notes[-1]["timeMs"] + notes[-1]["durationMs"] - item["timeMs"]) < 1
                ):
                    notes[-1]["durationMs"] = finish * 1000 - notes[-1]["timeMs"]
                    notes[-1]["_right"] = item["_right"]
                else:
                    notes.append(item)
            on_progress(index + 1, total)
        return [{k: v for k, v in note.items() if not k.startswith("_")} for note in notes]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input")
    parser.add_argument("--model-dir", default=str(Path(__file__).resolve().parent.parent / ".tools" / "game-model"))
    parser.add_argument("--language", default="zh", choices=("auto", "zh", "en", "ja", "yue"))
    parser.add_argument("--steps", type=int, default=8, choices=range(1, 17))
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--raw-f32", action="store_true")
    args = parser.parse_args()
    stage = "initializing"
    try:
        if DEPENDENCY_ERROR:
            raise ValueError("Install numpy and onnxruntime for the selected Python interpreter: " + DEPENDENCY_ERROR)
        directory = find_model(args.model_dir)
        if args.check:
            emit({"available": True, "engine": "game-1.0.3-small", "sampleRate": 44100,
                  "numpy": np.__version__, "onnxruntime": ort.__version__})
            return 0
        if not args.input:
            raise ValueError("Missing input WAV")
        samples = load_audio(args.input, np, raw=args.raw_f32)
        stage = "loading"
        emit({"type": "status", "stage": stage, "backend": "cpu"})
        model = GameModel(directory, args.language, args.steps)
        stage = "warming"

        def progress(done, total):
            emit({"type": "status", "stage": "transcribing" if done else "warming",
                  "backend": "cpu", "completedWindows": done, "totalWindows": total,
                  "progress": done / total})
        notes = model.transcribe(samples, progress)
        emit({"type": "status", "stage": "extracting", "backend": "cpu", "progress": 1})
        emit({"type": "result", "notes": notes})
        return 0
    except Exception as error:
        emit({"type": "error", "code": "model" if stage == "loading" else "inference",
              "stage": stage, "message": str(error)[:500]})
        return 1


if __name__ == "__main__":
    sys.exit(main())
