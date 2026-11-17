# Third-Party Notices

FunCuby's Transcribe feature bundles the following third-party components into
the locally served `vendor/` directory at build time (`npm run build:transcription`,
also run automatically by `npm start`). The `vendor/` directory is gitignored;
these notices apply to the distributed bundles.

## @spotify/basic-pitch — Apache License 2.0

- Version: 1.0.1 (the `basic-pitch-ts` JavaScript/TypeScript package)
- Repository: <https://github.com/spotify/basic-pitch-ts>
- License: Apache-2.0 — full text at `licenses/Apache-2.0.txt` in this
  repository (also shipped under `vendor/` after a build: `vendor/basic-pitch/LICENSE`
  and `vendor/licenses/Apache-2.0.txt`). Because FunCuby's adapter derives
  Basic Pitch framing, the license text is tracked in the repository rather
  than only produced at build time.
- Used for: on-device audio-to-MIDI note transcription (the "Transcribe" tab).
- The bundled model files (`vendor/basic-pitch/model.json`,
  `vendor/basic-pitch/group1-shard1of1.bin`) are part of this package.
- FunCuby's adapter (`src/core/transcription/basic-pitch.js`) derives its
  windowed inference loop from Basic Pitch's `evaluateModel` framing under the
  same Apache-2.0 terms, with modified resource management (explicit per-window
  tensor scopes and terminal model disposal). Pitch-contour outputs that
  upstream reads back are unused here and are disposed without being read.

## @tensorflow/tfjs — Apache License 2.0

- Version: 3.21.0
- Repository: <https://github.com/tensorflow/tfjs>
- License: Apache-2.0 (declared in the package metadata; the tfjs packages ship
  no LICENSE or NOTICE file, so the identical Apache-2.0 text from
  `@spotify/basic-pitch` is reproduced at `vendor/licenses/Apache-2.0.txt`).
- Copyright: the TensorFlow authors (no upstream copyright file is shipped).
- Used for: tensor operations and model execution inside the transcription
  worker (`vendor/transcription-runtime.js`).

## esbuild — MIT License

- Version: 0.25.12 (build-time dev dependency only; not shipped to browsers)
- Repository: <https://github.com/evanw/esbuild>
- License: MIT — full text at `vendor/licenses/esbuild-LICENSE.md` after a build.
- Used for: bundling the transcription runtime; it does not run in the browser.

## Salamander Grand Piano v3 — CC BY 3.0

- Piano recordings: Alexander Holm, Yamaha C5, Salamander Grand Piano v3.
- Source: <https://sfzinstruments.github.io/pianos/salamander/>.
- MP3 distribution: <https://github.com/Tonejs/audio/tree/master/salamander>,
  pinned to commit `efd8296360f9526e379bfbe5c1698ff54d6a1d34`.
- License: Creative Commons Attribution 3.0 Unported, reproduced in
  `licenses/CC-BY-3.0.txt`. This sample license is separate from FunCuby's MIT
  software license.
- Setup: `npm run setup:piano` obtains 30 MP3 samples (2,012,677 bytes),
  checks their sizes and pinned Git blob hashes, and stores them in
  `vendor/piano/`. Cached verified files need no network access.
- Samples are copied without modification. The playback engine repitches
  nearby recordings, adjusts gain, and envelopes note releases. It uses one
  sampled velocity layer, not the original full 16-layer instrument.
- Audio is served from localhost; playback makes no requests to a sample CDN.

## Processing Notes

- Basic Pitch runs locally in the browser. Optional GAME runs in an owned
  Python process behind the localhost server; audio never goes to cloud inference.
- These components are included "as is" without warranty. Compatibility is
  verified only for the pinned versions above; other Basic Pitch models or
  tfjs versions are not covered.
- FunCuby itself is licensed under the MIT License (see `LICENSE`).

## GAME 1.0.3 Small ONNX

- Source: <https://github.com/openvpi/GAME>, tag `v1.0.3`.
- Source implementation: MIT, reproduced in `licenses/GAME-MIT.txt`.
- Model weights: CC BY-NC-SA 4.0, reproduced in
  `licenses/CC-BY-NC-SA-4.0.txt`; this is not the project's MIT software license.
- Official artifact: `GAME-1.0.3-small-onnx.zip` from the v1.0.3 release.
- SHA-256: `00ba0c64115b6b874d9ea4afd3e6cf822abda2a04e52569233b0a044fd40e4e8`.
- Models are optional and gitignored under `.tools/game-model/`. They are
  extracted without modification and are not served as browser assets.
- Our orchestration follows the published ONNX workflow: encoder, iterative
  boundary decoder, duration converter, then pitch/presence estimator.
- Optional Python dependencies: NumPy 2.2.0 (BSD-3-Clause and bundled notices)
  and ONNX Runtime 1.30.0 (MIT). They are installed separately, not bundled.
  Their installed distributions contain their own license notices.

## Ultimate Vocal Remover MDX-Net (`UVR-MDX-NET-Voc_FT.onnx`) — MIT

- Source project: Ultimate Vocal Remover GUI (<https://github.com/Anjok07/ultimatevocalremovergui>),
  core developers Anjok07 and aufr33; MDX-Net architecture by Kuielab & Woosung Choi
  (<https://github.com/kuielab/mdx-net>).
- License: MIT, reproduced in `licenses/UVR-MIT.txt` with credit to Ultimate Vocal
  Remover (Anjok07 and aufr33).
- Official model artifact: `UVR-MDX-NET-Voc_FT.onnx` (66,762,490 bytes),
  SHA-256 `534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111`.
- Optional and gitignored under `.tools/UVR-MDX-NET-Voc_FT.onnx`, downloaded on
  demand via `npm run setup:separation` and executed locally on CPU via ONNX Runtime.
