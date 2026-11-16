# Melody Quality and Piano Audition

## Two independent improvements

Piano playback does not fix transcription errors. The audition engine now uses
local Salamander recordings rather than triangle oscillators, with a volume
control, sample peak normalization, compressed listening dynamics and a
compressor. Exported MIDI velocities are not rewritten by the listening controls.
MIDI exports explicitly select General MIDI Acoustic Grand Piano.

The player loads only needed sample pitches, caches decoded samples per audio
context, and schedules a short horizon with a bounded live voice count.
Stop/source change/pagehide abort loading and disconnect scheduled sources.

## Optional local GAME inference

The browser Basic Pitch path remains the default and uses CPU. The experimental
GAME 1.0.3 small ONNX path targets **singing**, not general instrumental mixtures.
It runs on localhost in a directly owned Python process with ONNX Runtime's CPU
provider; no PyTorch, cloud inference, or browser GPU is needed. ORT telemetry is
disabled. Audio is posted from the worker to the local service, not the internet.

The current development machine already has the required Python packages; no
global Python packages were installed or downgraded. For a clean installation:

```powershell
python -m venv .tools/game-env
.tools/game-env/Scripts/python.exe -m pip install -r requirements-game.txt
$env:FUNCUBY_GAME_PYTHON = "$PWD/.tools/game-env/Scripts/python.exe"
npm run setup:game
npm start
```

`setup:game` downloads the official 45,676,364-byte small ONNX archive, supports
resuming, and verifies SHA-256 before extraction:

```text
00ba0c64115b6b874d9ea4afd3e6cf822abda2a04e52569233b0a044fd40e4e8
```

Model source: https://github.com/openvpi/GAME/releases/tag/v1.0.3

Model weights are **CC BY-NC-SA 4.0**, not MIT. The upstream implementation is
MIT. See `THIRD_PARTY_NOTICES.md` and the reproduced license texts before
redistributing weights or modified models.

## Usage and comparison

1. Import audio as before. Start with a familiar 20-30 second vocal phrase.
2. Select local GAME and the singing language, then start transcription.
3. GAME initially selects working-melody/original-timing piano playback. Judge this before
   judging a reduced pocket-keyboard arrangement.
4. Run the lightweight mode on the same clip if desired. Switching between
   completed modes restores their independent captures without re-inference.
5. Change volume freely; it does not rerun a model or modify exported notes.

Changing source or clip clears the corresponding in-memory captures. The most
recent successfully imported source, completed mode captures, clip, arrangement
and audition settings are now saved automatically in browser IndexedDB. Wait for
the local-save confirmation before refreshing. Reopening the same browser and
origin restores the work without source download, model inference or autoplay.
This retains one workbench, not a multi-song library. A newly imported song
replaces the previous save only after the new audio decodes successfully.

Audio bytes and their initial state commit atomically. Later edits write only
state, not the audio Blob. Source identities prevent late/stale tabs from
attaching notes to a different or deleted source. Storage failures are visible;
the current page stays usable, but saving is not claimed. Last committed data
survives a failed replacement. Deletion requires confirmation and clears the
current page too; queued stale writes cannot resurrect it.

IndexedDB is local to an origin: `localhost` and `127.0.0.1`, different ports,
browser profiles and private windows do not share it. Clearing site data or
browser storage eviction can remove the save, so MIDI exports remain useful
backups. This cannot retroactively recover data lost before persistence existed.

Run `npm run test:e2e:storage` for real IndexedDB, refresh, browser/server restart,
write-failure rollback, stale-tab, interrupted-restore and deletion checks.

GAME input is 44.1 kHz mono float32. The browser retains the decoded source and
resamples for the selected model. New URL imports now supply a **44.1 kHz stereo
16-bit FLAC working master**, rather than early 22.05 kHz downmixing. This is
lossless encoding of the converted PCM, not a claim that a platform's compressed
source is an original lossless studio master. Existing saved sources are not
silently fetched again or upgraded. Source separation has not been added.

## Phrase review and non-destructive editing

After transcription, the review panel selects a 0.1-30 second phrase relative to
the transcription clip. Alternate original audio and working piano using the
same endpoints, with an optional loop. Source playback adds `clipStartMs`, so a
clip starting at source minute one does not accidentally compare with the intro.
The comparison is A/B, not simultaneous duet playback. Each mode restarts from
the phrase start; no equal-loudness or perceptual synchronization claim is made.
Piano plays unquantized working notes, not the simplified arrangement. The
position display follows the Web Audio clock; notes that cross the phrase bounds
are clipped, and rests retain their duration.

Select a note to change MIDI pitch, onset or duration, delete it, split it into
repeated notes, or merge adjacent same-pitch notes. Add missing notes with the
same fields. Split segments must each last at least 20 ms; merge permits at most
a 250 ms gap and remains an explicit user decision. Timings are clip-relative;
the piano's current transposition and simplified BPM do not affect this editor.
Short notes, octave-or-larger leaps and overlaps with the preceding onset-sorted
note are prompts for listening, not probabilities or proof of errors. There is
no automatic correction based on these flags.

Each engine capture stores immutable `notes` plus optional `editedNotes`.
Edits feed all arrangements, practice handoff and working-melody MIDI, but
recognizer MIDI remains separately downloadable. Restore-recognizer and up to
20 session-local undo snapshots support comparison. Edits survive refresh; undo
history does not. Changing the transcription clip or rerunning an edited mode
requires confirmation. Replacing the imported song retains the existing
one-workbench replacement behavior.

Review JSON exports always say `referenceStatus: "unverified-draft"`, even after
manual edits. They include original/working notes, phrase endpoints and the clip
offset, but no audio. The exporter cannot certify musical correctness. See
[melody evaluation](melody-evaluation.md) for human reference requirements.

Verification: `npm run test:e2e:melody` exercises real audio decoding, source
offset/loop playback, piano samples, MIDI roundtrips, editing, reset/undo, local
restoration and mobile layout. Its model is deterministic and mocked; it proves
editing/transport wiring, not transcription accuracy. Unit tests cover phrase
boundary clipping, rests, cancellation and skipped scheduling cycles.

## Execution and safety boundaries

- A shared job controller owns preparation, progress, cancellation and stale-job
  isolation for both engines. Existing Basic Pitch start envelopes are unchanged;
  explicit GAME envelopes select 44.1 kHz and a validated language.
- GAME processes 8-second cores with one second of context on each side.
  Progress counts completed cores, not speculative inference percentages.
- Only boundary-clipped continuations can merge across cores. Repeated notes
  within a phrase are not blindly collapsed. Floating-point estimated pitches
  remain in standalone inference output; UI/MIDI notes use rounded semitones.
- Loopback peer, Host, Origin, method, content type, language and upload size are
  checked. One active inference is accepted; there is no queue or automatic retry.
- Uploads stream to a private owned temporary directory, not a user-supplied
  path. The 600-second bound, upload deadline, output limit and job deadline
  constrain resource use.
- Disconnect/cancel terminates the directly owned Python child. No guessed PID
  or unrelated process tree receives termination signals. Temporary input is
  cleaned up after the child exits.
- TensorFlow tensor telemetry does not apply to ONNX and is not fabricated.

## Verification and limitations

The same official Bilibili recording, BV1nEWu6xEyq (219.37 seconds), was used for
a 60-84 second comparison. In this local run, Basic Pitch returned 379 notes in
about 33 seconds; GAME returned 58 notes in about 8 seconds. These are operational
observations, **not a transcription accuracy score or a general speed claim**.
The original PCM CLI run and browser decode can differ slightly in segmentation.

A 219-second clip of the same recording also completed all 28 GAME cores,
returning 423 notes in about 70 seconds. UI, progress, result and cached-mode
assertions passed. Its optional screenshot timed out; this is recorded separately
from inference acceptance. A real running ONNX job was also cancelled and a fresh
request completed successfully, in addition to the mocked process-lifecycle tests.

No manually checked reference melody is available yet. Fewer notes, smoother
contours and a better piano sound do not prove that the lead melody is correct.
Lead/backing vocals, choirs, instrumental interludes and octave errors remain
important failure cases. Existing draft BPM, highest-voice fallback, small-key
omission and range-folding rules still constrain pocket-keyboard arrangements.
Further separation/model work should follow listening to the faithful melody,
not assume that another large dependency will improve it.

Reproduce the short UI acceptance runs against a running local server:

```text
node tests/e2e/transcription-long-run.mjs --game --clip=PATH_TO_24_SECOND_WAV --seconds=24
node tests/e2e/transcription-long-run.mjs --clip=PATH_TO_24_SECOND_WAV --seconds=24
```

`BASE_URL` can point at an isolated test server. Reports and explicit benchmark
note outputs are local `.test-artifacts/` files, not diagnostic downloads.
