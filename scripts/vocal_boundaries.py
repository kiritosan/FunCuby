"""Propose audible rests in GAME notes using the local mono vocal waveform."""

import numpy as np


def _repeats_pitch(frames, target):
    # A neighbouring semitone can correlate strongly at the target period.
    # Estimate the actual fundamental on both sides before proposing a split.
    agreements = 0
    for frame in frames:
        x = frame - frame.mean()
        power = np.r_[0.0, np.cumsum(x.astype(np.float64) ** 2)]
        lags = np.arange(4, len(x) // 2)
        scale = np.sqrt(np.maximum(power[len(x) - lags] * (power[-1] - power[lags]), 1e-20))
        scores = np.correlate(x, x, "full")[len(x) - 1 + lags] / scale
        peaks = np.flatnonzero((scores[1:-1] > scores[:-2]) & (scores[1:-1] >= scores[2:])) + 1
        if not len(peaks):
            continue
        strong = peaks[scores[peaks] >= max(0.75, 0.94 * max(scores[peaks]))]
        if not len(strong):
            continue
        i = strong[0]
        left, peak, right = scores[i - 1:i + 2]
        lag = lags[i] + 0.5 * (left - right) / (left - 2 * peak + right)
        pitch = 69 + 12 * np.log2(11025 / (440 * lag))
        agreements += abs(pitch - target) <= 0.55
    return agreements >= 3


def _suggest(samples, midi):
    # 30 ms frames, 10 ms hops, on a 11025 Hz analysis copy.
    hop, width = 110, 330
    if len(samples) < 2 * width:
        return None
    frames = np.lib.stride_tricks.sliding_window_view(samples, width)[::hop]
    rms = np.sqrt(np.einsum("ij,ij->i", frames, frames) / width)
    level = np.percentile(rms, 85)
    if level < 0.0001:
        return None
    period = 11025 / (440 * 2 ** ((midi - 69) / 12))
    periodicity = np.zeros(len(frames))
    # Allow modest vibrato and detuning around the estimated note.
    for lag in {round(period * scale) for scale in (0.95, 1, 1.05)}:
        a, b = frames[:, :-lag], frames[:, lag:]
        energy = np.einsum("ij,ij->i", a, a) * np.einsum("ij,ij->i", b, b)
        corr = np.einsum("ij,ij->i", a, b) / np.sqrt(np.maximum(energy, 1e-22))
        periodicity = np.maximum(periodicity, corr)
    voiced = (periodicity >= 0.68) & (rms >= 0.07 * level)
    quiet = (rms < 0.02 * level) | ((rms < 0.38 * level) & (periodicity < 0.55))
    edges = np.flatnonzero(np.diff(np.r_[False, quiet, False])).reshape(-1, 2)
    def to_ms(frame):
        return round((frame * hop + width / 2) * 1000 / 11025)
    for start, stop in edges:
        if stop - start < 7 or start < 4 or voiced[max(0, start - 9):start].sum() < 4:
            continue
        if stop == len(frames):
            return {"releaseMs": to_ms(start)}
        # A same-pitch restart needs consecutive voiced frames after the rest.
        if voiced[stop:stop + 5].sum() >= 4:
            suggestion = {"releaseMs": to_ms(start)}
            before = frames[max(0, start - 9):start][voiced[max(0, start - 9):start]][-5:]
            after = frames[stop:stop + 7][voiced[stop:stop + 7]][:5]
            if _repeats_pitch(before, midi) and _repeats_pitch(after, midi):
                suggestion["repeatMs"] = to_ms(stop)
            return suggestion
    return None


def suggest_vocal_boundaries(notes, audio):
    """Offsets are relative to each original note. Preserve every recognizer note."""
    mono = np.asarray(audio, dtype=np.float32)
    reduced = mono[:len(mono) // 4 * 4].reshape(-1, 4).mean(axis=1)
    result = []
    for note in notes:
        hint = None
        if note["durationMs"] >= 180 and 40 <= note["note"] <= 90:
            start = round(note["timeMs"] * 11.025)
            end = round((note["timeMs"] + note["durationMs"]) * 11.025)
            hint = _suggest(reduced[start:end], note["note"])
        result.append({**note, "boundary": hint} if hint else note)
    return result
