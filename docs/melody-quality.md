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

## Optional local GAME and vocal separation

For a deployment that omits the noncommercial GAME weights, leave the GAME
and UVR model assets out of the distribution and start the local server with
`FUNCUBY_GAME_ENABLED=0` (PowerShell: `$env:FUNCUBY_GAME_ENABLED = "0"`).
The server then skips the Python probe and disables both GAME inference paths.
Basic Pitch remains available. Using GAME in a paid offering requires a
separate licensing decision.

The browser Basic Pitch path uses CPU and handles instrumental audio. New
sessions select direct GAME when available and Basic Pitch otherwise. The page
remembers the chosen mode. The GAME 1.0.3 small ONNX path targets singing.
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
npm run setup:separation
npm start
```

`setup:game` downloads the official 45,676,364-byte small ONNX archive, supports
resuming, and verifies SHA-256 before extraction:

```text
00ba0c64115b6b874d9ea4afd3e6cf822abda2a04e52569233b0a044fd40e4e8
```

Model source: https://github.com/openvpi/GAME/releases/tag/v1.0.3

GAME weights use **CC BY-NC-SA 4.0** and the upstream implementation uses MIT.
`setup:separation` is optional. It downloads and verifies the pinned UVR
MDX-Net Voc FT ONNX model for CPU vocal separation. See
[third-party notices](../THIRD_PARTY_NOTICES.md) for model sources and licenses.

## Usage and comparison

1. Import audio, set the clip start to a familiar phrase and select **Try 25
   seconds**. It uses the current mode and ends at the source end if less audio
   remains. Use **Transcribe whole track** when you're ready to expand the clip.
2. Select **GAME · Clear vocals** and the singing language for a quick draft
   from a clear lead vocal. If the backing track masks the singer, select
   **UVR + GAME · Mixed vocals** to extract the vocal stem before transcription.
   For instrumental clips, select **Browser · Instruments** (Basic Pitch).
3. Audition, MIDI export and practice share the selected difficulty. Open melody review for the unsimplified working draft or to check a phrase against source audio with beat clicks.
4. Switching between completed modes restores their independent captures
   without re-inference.

During a run, the progress panel shows each phase. Basic Pitch and GAME count
completed inference windows. UVR + GAME tracks UVR and GAME separately. Each
UVR window goes through spectrogram conversion, vocal extraction and waveform
reconstruction before it is joined with the rest of the clip. You can play or
download the 44.1 kHz stereo vocal WAV when separation finishes, including while
GAME is still running. The local service saves the WAV with its clip range. Reopening that clip restores it for listening and phrase comparisons.

After a new capture, the page estimates tempo and beat origin from the note
onsets and recommends a semitone shift using the detected pitch classes and
the calibrated first key. The suggested fit weights notes by duration and
velocity. **Auto Tempo + Main-Key Fit** reapplies the estimates to the current
working melody. If tempo confidence is low, the current BPM and beat origin
are kept. **Original Key** resets the transpose to zero and keeps the
current rhythm settings. The BPM, beat origin, transpose and pitch bounds are
editable. The single-line melody keeps the timing of the selected attacks.
Detailed uses a sixteenth-note grid and keeps existing two-note attacks.
Its optional auto-harmony adds a softer lower chord tone to selected single
attacks, using the arranged key and the surrounding melody. Its counter shows
how many dyads include a generated note. Both playable versions fit the pocket
keyboard range and use the source tempo. The working
melody is available separately with its original pitches and timing.

The full-score preview can bypass one or two isolated opening attacks when
at least four seconds of silence lead into three attacks spaced no more than
1.5 seconds apart. Chords count as one attack. **First note** includes the
opening again. The preview speed and start controls apply only to full-score
listening. Phrase comparisons, MIDI export and practice use the score timing.

New files and video links replace the active song after decoding succeeds.
The Node server keeps a separate folder per song under `.funcuby-library/` (override with `FUNCUBY_LIBRARY_DIR`). The page shows the current folder. Each source is written once. `song.json` identifies the active snapshot containing `draft.json` and MIDI files grouped by clip and mode. UVR WAVs are saved as soon as they arrive. New edits publish a complete replacement snapshot. Revision checks reject stale edits from another tab.

The batch panel accepts multiple full audio files with one mode and language. It runs two tasks concurrently and tracks each song separately. Keep the tab open while processing. Imported audio and completed artifacts survive closing the browser or clearing site data. When first opened in a browser with previous FunCuby drafts, the app copies those local IndexedDB records to disk. Missing stems from older sessions require another separation pass.

Run `npm run test:e2e:storage` for write failures, stale revisions, deletion and restart checks. To test two real separations and disk restoration, run `node tests/e2e/song-batch.mjs path/to/short-vocal.flac` after setting up the models.

Direct GAME input is 44.1 kHz mono float32. The separation path uses 44.1 kHz
stereo float32, runs UVR first, then downmixes the vocal stem for GAME. New URL
imports supply a **44.1 kHz stereo 16-bit FLAC working master** that preserves
the channels from the conversion. Previously saved audio is reused as stored.

## Phrase review and non-destructive editing

After transcription, the review panel selects a 0.1-30 second phrase relative to
the clip. Play the original, isolated vocals or piano draft individually, or
select **Play in sequence**. With **Loop phrase** enabled, the chosen track or
sequence repeats. A stem from the same clip can also be reviewed when another
mode is selected. If a stem is unavailable, the sequence plays original then
piano. Original audio adds `clipStartMs`; the WAV stem uses clip-relative time.
Each starts from the same phrase endpoint, and the piano uses the unquantized
working notes. The timing display follows the Web Audio clock. Notes crossing
the phrase bounds are clipped and rests retain their duration.

Select a note to change MIDI pitch, onset or duration, delete it, split it into
repeated notes, or merge adjacent same-pitch notes. Add missing notes with the
same fields. Split segments must each last at least 20 ms; merge permits at most
a 250 ms gap and remains an explicit user decision. Timings are clip-relative;
the piano's current transposition and simplified BPM do not affect this editor.
Short notes, octave-or-larger leaps and overlaps with the preceding onset-sorted
note are prompts for listening, not probabilities or proof of errors. There is
no automatic correction based on these flags.

New GAME captures can also carry suggested rests. Direct GAME checks the input
waveform and UVR + GAME checks the isolated vocals. Choose **Jump to a possible
rest** in the phrase editor to focus playback around the gap. Compare the source
or vocal stem, **Hear current notes**, and **Hear suggested notes**. **Apply this
suggestion** shortens the selected note and, when the same pitch resumes, inserts
a second note after the rest. Undo restores the previous draft. The suggestions
survive refresh with the capture. Existing captures need a new run to acquire
waveform-based suggestions.

The check uses 30 ms frames, looking for a sustained drop in energy and
periodicity. It checks the fundamental on both sides before proposing a repeat.
Reverb, backing singers and very soft singing can obscure these cues. The
editor leaves each decision to the listener.

Each engine capture stores immutable `notes` plus optional `editedNotes`.
Edits feed all arrangements, practice handoff and working-melody MIDI, but
recognizer MIDI remains separately downloadable. Restore-recognizer and up to
20 session-local undo snapshots support comparison. Edits survive refresh; undo
history does not. Changing the transcription clip or rerunning an edited mode
requires confirmation. Replacing the imported song retains the existing
local song archive available from the source picker.

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
  isolation for all modes. Both GAME envelopes select 44.1 kHz and a validated
  language. Separation and GAME count toward the same progress total.
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

On a 219-second stereo PCM clip of the same recording, direct GAME completed
28 inference windows and returned 423 notes in about 63 seconds. UVR + GAME
completed 39 separation windows and 28 inference windows and returned 469
notes in about 257 seconds. Both browser runs checked window progress and cached
mode switching. The separated run also checked that auto-fit set 136 BPM,
an 18 ms beat origin and a +5 semitone shift, that Original Key preserved manual
rhythm settings, and that the result and settings survived a reload.

The [local benchmark](melody-evaluation.md) uses independent vocal annotations
and a known piano score. Lead and backing vocals can still be confused, and choirs,
instrumental interludes and octave errors remain important failure cases. Tempo
may be interpreted at half or double speed. Automatically arranged harmony is
one possible accompaniment. Checking the original chords requires listening
to the backing track.

Reproduce the short UI acceptance runs against a running local server:

```text
node tests/e2e/transcription-long-run.mjs --game --clip=PATH_TO_24_SECOND_WAV --seconds=24
node tests/e2e/transcription-long-run.mjs --game-separated --clip=PATH_TO_24_SECOND_STEREO_WAV --seconds=24
node tests/e2e/transcription-long-run.mjs --clip=PATH_TO_24_SECOND_WAV --seconds=24
```

`BASE_URL` can point at an isolated test server. Reports and explicit benchmark
note outputs are local `.test-artifacts/` files, not diagnostic downloads.
