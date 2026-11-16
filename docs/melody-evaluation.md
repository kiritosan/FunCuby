# Melody Evaluation Before Model Changes

## Current status

No human-verified reference melody is committed yet. The project's synthetic
audio checks and hand-authored note unit tests validate engineering behavior,
not accuracy on a commercial mixed recording. A model output, fewer notes, a
smooth contour or a manual edit alone is not a ground-truth reference.

The first real-song candidate remains the same official public recording,
BV1nEWu6xEyq, source seconds 60-84. It is an evaluation candidate, not an
annotated benchmark. Do not redistribute its audio or assume a matching title
means an identical master/version.

## Create a small, trustworthy reference

1. Use a legally obtained source and keep its bytes unchanged locally. Record
   its SHA-256, duration, channel count, sample rate, source URL/version and
   selected source interval. Keep a stereo working master separate from derived
   mono/model inputs. Do not compare different masters as if they were aligned.
2. Start with a familiar 10-20 second lead-vocal phrase, then cover a sustained
   vibrato, repeated same-pitch syllables, backing vocals, strong accompaniment
   and a rest. Later add an instrumental phrase; a vocal model must not be
   evaluated only on its easiest domain.
3. In the review panel, alternate the original phrase and unquantized piano.
   Check every onset, repeated note, rest, pitch and octave. Use an independent
   instrument, reliable score or pitch analysis as supporting evidence rather
   than trusting either candidate model. Do not quantize to the draft 120 BPM.
4. Export the review draft. Keep `recognizerNotes` unchanged. Copy the export as
   a separate proposed reference; list the actual review interval, reviewer,
   date and evidence. Mark ambiguous spans explicitly or exclude them with
   reasons. A human must approve a reference; application exports always remain
   `unverified-draft`.
5. Have another person/check pass validate the proposed reference when possible.
   Keep changes/version history, not a silently overwritten answer key.

For local file hashes on Windows:

```powershell
Get-FileHash ".test-artifacts/quality-source.m4a" -Algorithm SHA256
```

## Compare only like with like

Use the same source interval, sample-rate conversion and language setting.
Compare original-mix GAME against separation-then-GAME before integrating a
separator into the UI. Keep the original mix path as a baseline and retain the
separated stem for listening. A separator can remove weak lead notes or
introduce tonal artifacts; cleaner audio does not guarantee better transcription.

Record each candidate's model/version/weight checksum, settings, runtime, peak
memory when measured and model input provenance. Store these locally alongside
the reference; do not silently call a candidate export a reference.

Judge three separate outcomes:

- Recognition: exact semitone/octave mistakes, missed notes, extra notes and
  repeated-note split/merge errors.
- Timing: onset/offset deviations and rests. If calculating note metrics, state
  matching tolerances and use one-to-one matching so one long note cannot count
  as several correct repeated notes. Report precision and recall separately.
- Teaching arrangement: whether theme, contour and important rhythm survive,
  and whether a beginner can play the target pocket-keyboard version.

Use the same piano and listening gain for A/B tests. Assess phrase identity,
not which rendering sounds more polished. Keep the unquantized recognition
evaluation separate from draft BPM/range folding/small-key omission.

## Integration gate

Only prefer a separation/model path after reference-based checks show reduced
lead errors across several phrases without unacceptable missed notes, boundary
errors, memory or runtime. Document regressions and the conditions where the
baseline should remain selectable. Until that evidence exists, present GAME
and all review exports as drafts, not reliable automatic final scores.
