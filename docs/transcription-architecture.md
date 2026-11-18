# Transcription architecture

FunCuby runs Basic Pitch in the browser and GAME in an optional local Python
process. Inference audio stays on the device. Optional URL import fetches
public audio through the local server (see `docs/url-import.md`) and feeds
the same pipeline.

## Pipeline

1. **Input.** The Transcribe tab accepts a local file (WAV/MP3/etc. via
   `loadSource`) or an imported URL result. Shared limits come from
   `src/core/transcription/config.js`: `SAMPLE_RATE` 22050 Hz,
   `MAX_AUDIO_SECONDS` 600, `MAX_FILE_BYTES` 50 MiB, `MAX_SAMPLES`,
   `MAX_OFFSET_MS` 600 000. The same constants are imported by the UI, the
   arrangement validator and the URL-import server — there is no second copy.
2. **Preparation.** `TranscriptionJob.start(prepareSamples)` initiates
   browser-side clip preparation: an `OfflineAudioContext` renders the selected
   1–600 s window to `Float32Array` samples. Basic Pitch takes 22.05 kHz mono,
   GAME takes 44.1 kHz mono, and `game-separated` takes 44.1 kHz stereo
   (left-channel samples followed by right-channel samples). The UI rejects
   silence and checks the Basic Pitch assets before creating its worker.
   The elapsed clock includes preparation.
3. **Job controller.** `src/core/transcription/job.js` owns one active job:
   the UI owns the source/clip epoch; the controller filters stale messages
   by job id _and_ worker instance, validates the prepared buffer, creates
   exactly one worker, posts one versioned `start` envelope with the sample
   buffer transferred, and settles exactly once. Starting while active rejects
   with `TranscriptionError("busy")`; there is no queue and no automatic retry
   — a failed job is retried only by an explicit new `start` (fresh worker,
   fresh job id).
4. **Versioned worker.** `src/core/transcription-worker.js` is a thin entry:
   it validates the envelope (version, job id, type, sample rate, buffer type
   and length) _before_ dynamically importing the TensorFlow runtime, so a bad
   request or a missing vendor file becomes a structured `error` envelope
   instead of a hang. Adapter status callbacks are forwarded as `status`
   envelopes; the terminal outcome is a `result` or `error` envelope.
   `src/core/transcription/protocol.js` defines and validates every envelope.
5. **Model adapter.** `src/core/transcription/basic-pitch.js` wraps
   Spotify Basic Pitch: per-window tensor scopes, terminal model disposal,
   with separate initialization, loading, warmup, inference and extraction
   stages. Real `completedWindows`, `totalWindows`, `progress`, `tensorCount`
   and `backend` values are reported as they become known. Progress is emitted only
   after a window's execution, readback and cleanup — `warming` progress 0
   means "first window running", not "done". `tensorCount` is a logical
   TensorFlow count. For both GAME modes, the worker sends PCM to the loopback
   Node service and forwards the Python process's NDJSON events. The separated
   mode counts UVR windows first and GAME windows second in the same progress
   total. Cancellation disconnects the request and ends the owned Python process.
6. **Arrangement.** Each engine/language capture retains its raw notes and
   optional working edits. Musical analysis suggests tempo, beat origin and
   main-key transpose. The four levels (`starter`, `melody`, `fuller`,
   `original`) run `arrangeTranscription` on the working notes. `originMs`
   is bounded by `MAX_OFFSET_MS` (600 000 ms).
7. **Practice.** MIDI export and the Practice handoff reuse the existing
   paths; transcription itself never starts teaching.

## Lifecycle rules

- **One active job per controller.** A second `start` rejects `busy`. Two separate
  epochs guard staleness: the UI owns a source/clip epoch (bumped by
  `invalidate()` on source change, clip edit, cancel or page leave) so stale
  async UI work cannot land, while the controller owns job/worker identity
  (job id + worker instance) so stale worker messages cannot land either.
- **One clock.** The controller's single 1 s ticker is the only timer: it
  emits a fresh snapshot on every stage/progress change and every second, and
  the UI renders `task.snapshot` from each `onUpdate` — there is no second UI
  interval and no fabricated heartbeat.
- **Cancellation is hard.** `cancel()` aborts the preparation signal _and_
  calls `worker.terminate()`, which destroys the worker isolate — its
  `finally` blocks are **not** guaranteed to run, so tensor/model cleanup on
  that path relies on isolate teardown, not graceful disposal. Graceful
  completion/error paths do run the adapter's cleanup (verified: tensor count
  returns to 0 after the model is disposed). Async preparation is aborted
  separately and late resolves are ignored; no worker is created for a
  cancelled preparation.
- **Diagnostics are observation, not a heartbeat.** The snapshot exposes
  stage, backend, window counts, progress, elapsed wall-clock and
  `lastActivityAgeMs`; `stalled` is advisory after `STALL_WARNING_MS`
  (60 000 ms) without a newer stage or strictly increasing progress/completion.
  Elapsed and idle time say nothing about whether the worker is alive — they
  are not a liveness signal and there is no ETA or fabricated percentage.
  `getDiagnostics()` returns a bounded (64-event), frozen, serializable trace
  with no audio data, source names or note contents.
- **BFCache.** `pagehide` cancels the running job and releases the audio
  element, AudioContext and decoded PCM for both outcomes; with
  `persisted === true` the `TranscriptionJob` client stays reusable for
  `pageshow`/back-forward navigation, while a non-persisted `pagehide`
  disposes it. A persisted `pageshow` restores the last committed disk library
  workbench without restarting inference; pagehide still releases decoded PCM.
  Switching tabs (visibility change, not `pagehide`) does
  **not** cancel a running transcription — it continues in the background
  worker until it finishes, errors, the page is actually hidden/unloaded, or
  the user cancels.
- **Ten minutes is an input cap, not a performance guarantee.** CPU inference
  can be slow; duration alone is not a reliable prediction of processing time.
- **Backend policy is explicit.** `TRANSCRIPTION_BACKEND` defaults to `cpu`.
  A real user diagnostic showed WebGL loading the model and framing audio in
  about one second, then completing zero windows for over eight minutes.
  Successful WebGL initialization is not sufficient evidence that this pinned
  model/driver combination works. Do not automatically select GPU based solely
  on context availability. GPU acceleration would need a bounded, actual-model
  compatibility check and safe recovery before becoming a supported default.

## Verification

- `npm test` covers the protocol, injected-clock job lifecycle and existing
  arrangement/import logic; it does not need a real worker or a model download.
- `npm run test:e2e` runs the browser smoke checks, including short real model
  inference, MIDI/practice handoff, long-input progress/cancel, and deterministic
  stall/error/BFCache recovery. It also creates `.test-artifacts/clip219.wav`.
- With the local server running, `node scripts/verify-transcription.mjs`
  checks exact frame/onset/note parity against the pinned upstream implementation
  and tensor cleanup. It captures its reference once, then reuses that capture.
  This is an implementation parity check, not a musical-accuracy benchmark.
- After the smoke fixture exists, with the local server still running,
  `node tests/e2e/transcription-long-run.mjs` processes the entire synthetic
  219-second fixture. It records every model window, validates progress and
  tensor lifetimes, and saves the raw report and a screenshot under
  `.test-artifacts/`. It uses an isolated headless Edge profile by default;
  `BROWSER` and `BASE_URL` can override the executable and application origin.
- Add `--gpu-enabled` to that command to leave browser GPU support enabled.
  This variant first verifies WebGL initialization in a separate worker, then
  asserts that the real transcription still selects CPU and completes. Its
  report has a separate name so it does not overwrite the earlier CPU-only
  acceptance capture.
