"""Prepare short, local melody evaluation clips and their reference scores."""

import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import wave
from zipfile import ZipFile

import numpy as np


RATE = 44_100
ROOT = Path(__file__).resolve().parent.parent
VOCADITO_URL = "https://zenodo.org/records/5578807"
VOCADITO_SHA256 = "e0d6b99d3f9c594afe5ae5c4d7bdacebe569e53b809e90b89d1c771c4f9990e3"


def note(midi, start_ms, length_ms):
    return {"note": midi, "timeMs": start_ms, "durationMs": length_ms, "velocity": 96}


def sha256(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def load_vocal(archive, track):
    name = f"vocadito_{track}"
    with wave.open(io.BytesIO(archive.read(f"Audio/{name}.wav")), "rb") as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, RATE):
            raise ValueError(f"Unexpected source format: {name}")
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2") / 32768
    references = []
    for annotator in ("A1", "A2"):
        csv_path = f"Annotations/Notes/{name}_notes{annotator}.csv"
        rows = csv.reader(io.StringIO(archive.read(csv_path).decode("utf-8")))
        references.append({
            "label": annotator,
            "provenance": f"{VOCADITO_URL} · {csv_path} (musician annotation, Hz rounded to MIDI)",
            "notes": [
                note(round(69 + 12 * np.log2(float(hz) / 440)),
                     round(float(start) * 1000, 3), round(float(length) * 1000, 3))
                for start, hz, length in rows
            ],
        })
    return samples, references


def read_piano(ffmpeg):
    pcm = subprocess.run(
        [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
         "-protocol_whitelist", "file,pipe", "-i", str(ROOT / "vendor/piano/C4.mp3"),
         "-t", "4", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "pipe:1"],
        check=True, stdout=subprocess.PIPE, timeout=30,
    ).stdout
    return np.frombuffer(pcm, dtype="<i2") / 32768


def render_piano(sample, frames, notes):
    output = np.zeros(frames)
    for event in notes:
        start = round(event["timeMs"] * RATE / 1000)
        count = min(frames - start, round(event["durationMs"] * RATE / 1000))
        if count <= 0:
            continue
        t = np.arange(count)
        source = t * 2 ** ((event["note"] - 60) / 12)
        # Taper the last 15 ms to keep the authored note boundaries unambiguous.
        fade = np.minimum(1, (count - 1 - t) / (0.015 * RATE))
        output[start:start + count] += np.interp(source, np.arange(len(sample)), sample, right=0) * fade
    return output


def strong_mix(vocal, piano):
    # Fixed stereo backing on the same vocal take, 6 dB above vocal RMS.
    backing_tracks = []
    for part in ((0, 7, 12), (4, 7, 16)):
        events = [
            note(root + interval, beat * 500, 370)
            for beat, root in enumerate([48, 48, 45, 45, 41, 41, 43, 43] * 3)
            for interval in part
        ]
        backing_tracks.append(render_piano(piano, len(vocal), events))
    backing = np.column_stack(backing_tracks)
    gain = 10 ** (6 / 20) * np.sqrt(np.mean(vocal ** 2) / np.mean(backing ** 2))
    mix = vocal[:, None] + backing * gain
    return mix * min(1, 0.95 / np.max(np.abs(mix)))


def write_case(output, case_id, kind, audio, references, language="auto"):
    path = output / (case_id + ".wav")
    if audio.ndim == 1:
        audio = np.column_stack((audio, audio))
    pcm = np.clip(np.round(audio * 32768), -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as wav:
        wav.setparams((2, 2, RATE, len(pcm), "NONE", "not compressed"))
        wav.writeframes(pcm.tobytes())
    return {
        "id": case_id, "kind": kind, "audio": path.name, "sha256": sha256(path),
        "durationMs": len(pcm) * 1000 / RATE, "language": language,
        "references": references,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vocadito", required=True, type=Path, help="Official vocadito v3 ZIP")
    parser.add_argument("--output", type=Path, default=ROOT / ".test-artifacts/melody-benchmark")
    parser.add_argument("--ffmpeg")
    args = parser.parse_args()
    if sha256(args.vocadito) != VOCADITO_SHA256:
        raise ValueError("Expected the original vocadito v3 archive (Zenodo 5578807)")
    bundled = ROOT / ".tools/ffmpeg/bin/ffmpeg.exe"
    ffmpeg = args.ffmpeg or (str(bundled) if bundled.is_file() else shutil.which("ffmpeg"))
    if not ffmpeg or not (ROOT / "vendor/piano/C4.mp3").is_file():
        raise ValueError("Install FFmpeg and run npm run setup:piano")
    piano = read_piano(ffmpeg)
    args.output.mkdir(parents=True, exist_ok=True)
    cases = []
    with ZipFile(args.vocadito) as archive:
        # Mandarin songs 35 and 36 are independent, held-out recordings.
        for track, language in [(20, "en"), (28, "auto"), (35, "zh"), (36, "zh")]:
            vocal, references = load_vocal(archive, track)
            cases.append(write_case(args.output, f"vocadito-{track}-solo", "clean-vocal",
                                    vocal, references, language))
            if track == 20:
                cases.append(write_case(args.output, f"vocadito-{track}-strong-backing",
                                        "mixed-vocal", strong_mix(vocal, piano), references, language))

    score = [
        note(midi, start, duration)
        for midi, start, duration in [
            (60, 250, 300), (60, 750, 260), (62, 1250, 390), (64, 1750, 310),
            (67, 2250, 690), (66, 3250, 400), (67, 3750, 410), (72, 4250, 420),
            (69, 4750, 320), (64, 5750, 410), (62, 6250, 375), (60, 6750, 660),
        ]
    ]
    cases.append(write_case(args.output, "piano-phrase", "instrument",
                            render_piano(piano, 8 * RATE, score),
                            [{"label": "score", "provenance": "Authored MIDI note events rendered with Salamander C4",
                              "notes": score}]))
    manifest = args.output / "manifest.json"
    manifest.write_text(json.dumps({
        "schema": "funcuby.melody-benchmark",
        "version": 1,
        "cases": cases,
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(manifest.resolve())


if __name__ == "__main__":
    main()
