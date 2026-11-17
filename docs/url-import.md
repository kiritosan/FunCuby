# URL audio import — setup

The Transcribe tab can fetch audio from a public Bilibili or YouTube video
link. The local Node server (`npm start`) downloads the audio with **yt-dlp**,
probes it with **ffprobe**, and creates a 44100 Hz stereo, 16-bit FLAC working
master with **ffmpeg** before handing it to the same file pipeline. FLAC avoids
another lossy encoding step; it cannot restore information missing from the
platform's compressed source. Transcription still
only runs when you click Start.

Limits: videos up to 10 minutes, source and converted audio each up to 50 MiB.
Long or hard-to-compress stereo audio can exceed that cap and will be rejected,
not silently downgraded to mono. Everything runs
locally after the download; no cookies, no login, and no DRM or access-control
bypass — only fetch content you are allowed to download.

## Requirements

- Node.js and `npm start` serving `http://127.0.0.1:5173` (the feature is
  unavailable on a static deploy — use file upload instead).
- `yt-dlp` — <https://github.com/yt-dlp/yt-dlp>
- `ffmpeg` **and** `ffprobe` — <https://ffmpeg.org/download.html>
- Internet access to the video site.

## Tool resolution order

For each tool the server checks, in order:

1. `FUNCUBY_YTDLP`, `FUNCUBY_FFMPEG`, `FUNCUBY_FFPROBE` — a **single
   executable path** (not a command line).
2. Project-local `.tools/ffmpeg/bin/` for ffmpeg/ffprobe (gitignored — see
   below).
3. `PATH`.

`GET /api/audio-import/status` reports `{ready, missing}` without exposing any
paths.

## Installing yt-dlp

Any of:

```sh
pip install yt-dlp          # puts yt-dlp on PATH
# or download yt-dlp.exe from the releases page
# or set FUNCUBY_YTDLP=C:\path\to\yt-dlp.exe
```

## Installing ffmpeg / ffprobe

- **PATH**: install any recent ffmpeg build (`ffmpeg` and `ffprobe` on PATH).
- **Project-local (no admin, no PATH changes)**: download an ffmpeg release
  for your platform, extract it, and place the binaries so the server finds
  them at `.tools/ffmpeg/bin/ffmpeg[.exe]` and
  `.tools/ffmpeg/bin/ffprobe[.exe]`. The `.tools/` directory is gitignored —
  it is never committed. On this project's Windows dev machine the binaries
  are FFmpeg 6.1.1 essentials (gyan.dev build via `ffmpeg-static`), with
  SHA-256 recorded in the local `.tools/README.md`.
- **Env override**: `FUNCUBY_FFMPEG` / `FUNCUBY_FFPROBE` /
  `FUNCUBY_YTDLP` each take one executable path.

## Notes

- YouTube and Bilibili URLs are both accepted; availability depends on the
  network and the site's own restrictions. No cookies or browser-profile
  extraction is used.
- One import runs at a time; cancel is supported during download and
  conversion.
- The private temporary directory is bounded at 110 MiB to allow both the
  downloaded source and FLAC conversion. It is removed after the owned job.
- New imports preserve separate channels for the UVR + GAME transcription mode.
  Each transcription engine creates its own mono/resampled input in-browser.
  Existing saved mono sources remain usable but cannot regain stereo detail;
  reimport explicitly if a higher-quality working master is wanted.
