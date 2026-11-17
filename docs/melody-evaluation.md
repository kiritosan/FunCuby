# Melody Evaluation

## Repeatable local benchmark

The benchmark runs the three production transcription modes in a separate,
headless browser. It uses four clips:

- Tracks 20 and 28 from vocadito v3. Both trained-musician note annotations (A1
  and A2) are scored separately. Source frequency is rounded to MIDI semitones.
- The same track 20 vocal mixed with fixed stereo piano backing 6 dB above the
  vocal RMS. Its two reference scores are identical to the solo case.
- A piano phrase with repeated notes, an accidental and a rest. It is rendered
  from hand-authored MIDI note events with the local Salamander C4 sample.

Dataset by Rachel M. Bittner, Katherine Pasalo, Juan José Bosch, Gabriel
Meseguer-Brocal and David Rubinstein (2021). The prepared WAVs and report stay
under `.test-artifacts/`. Download the original v3 archive for preparation.
[vocadito v3, DOI 10.5281/zenodo.5578807](https://zenodo.org/records/5578807)

```powershell
npm run build:transcription
npm run setup:piano
python scripts/prepare-melody-benchmark.py --vocadito .test-artifacts/vocadito-v3.zip
npm run evaluate:melody -- .test-artifacts/melody-benchmark/manifest.json
```

Preparation uses Python with NumPy plus FFmpeg. The runner requires a
Chromium-family browser (Edge by default, or set `BROWSER` to its executable).
For the GAME modes, install the local models as described in
[melody quality](melody-quality.md). `--engine basic-pitch` runs just the
browser mode. `--case vocadito-20-strong-backing` runs just the mixed clip.
Each run prints a table and writes a new `melody-report-*/report.json` with
source hashes, individual reference scores, detected notes and elapsed times.

### What the numbers measure

- **Recognition** matches notes one-to-one by MIDI pitch and a 50 ms onset
  tolerance. It maximizes the number of matches, then prefers smaller onset
  differences. It reports missed and extra notes, precision/recall/F1 and
  mean absolute onset/offset error. An abnormal long note has a matched pitch
  and lasts more than `max(150 ms, half the reference duration)` longer than
  its reference. Octave errors pair the remaining misses and extras by pitch
  class and onset, so they are already included in those counts.
- **Starter coverage** applies the same grid, range and key mapping to both
  the reference and the candidate. Settings come from the first annotated
  score and stay fixed across engines. The report compares the two simplified
  scores separately from raw recognition.
- **Starter playability** reports notes outside the 15 main keys, maximum
  simultaneous notes, largest main-key jump and shortest positive onset
  spacing. These describe keyboard demands. A playthrough is still needed
  to judge comfort and phrase identity.

The four cases are an initial regression baseline. In particular, the mixed
case uses constructed accompaniment and the piano is rendered from a score.
Use longer and more varied recordings for conclusions about general accuracy.

The initial CPU run produced the following note F1 scores. Vocal ranges show
the minimum and maximum across the two annotators.

| Clip                       | Basic Pitch |        GAME |  UVR + GAME |
| -------------------------- | ----------: | ----------: | ----------: |
| vocadito 20 solo           | 0.597–0.667 | 0.678–0.793 | 0.678–0.793 |
| vocadito 20 strong backing | 0.173–0.211 | 0.113–0.154 | 0.678–0.793 |
| vocadito 28 solo           | 0.521–0.568 | 0.494–0.667 | 0.471–0.643 |
| Rendered piano             |       0.727 |       1.000 |       0.000 |

For the strong-backing case, UVR + GAME reduced misses from 26–28 to 7–11
and raised starter F1 from 0 to 0.462. Six matched notes exceeded the long-note
threshold after separation. On the rendered piano, Basic Pitch and direct GAME
both found all 12 reference notes. Basic Pitch added nine extra notes, while
direct GAME held two matched notes past the long-note threshold. UVR returned
no transcription for that instrumental clip.

## Add a reference from a reviewed clip

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

Use the generated manifest as a template. Add the reviewed excerpt as a WAV
with known `durationMs`, `sha256`, `language`, and a `references` entry with
`label`, `provenance`, and checked `notes` in the benchmark's audio-relative
time. If you cut WAV audio from a longer capture, shift the checked note
timestamps to the new WAV start. Record the reviewer and evidence in provenance.
For local file hashes on Windows:

```powershell
Get-FileHash ".test-artifacts/quality-source.m4a" -Algorithm SHA256
```

## Compare only like with like

Use the same source interval, sample-rate conversion and language setting.
Keep direct GAME as a baseline and listen to the same phrase in the mix,
separated stem and unquantized piano. Check for weak notes lost during separation
and new artifacts introduced by the separator.

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
