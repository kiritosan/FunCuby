# FunCuby

[English](#english) | [中文](#中文)

## English

FunCuby is an unofficial open-source web tool for CubyFun easyplay 1s that connects to your device over Bluetooth for MIDI playback and practice

[Click here to use](https://funcuby.pages.dev/)

### Features

- Device: Bluetooth connection, live key display and first-key calibration
- Test: Send MIDI messages and raw HEX packets to test device responses
- Play: Import MIDI files, select tracks, adjust speed and play
- Transcribe: Turn a local audio file into pocket-piano practice scores, entirely on-device
- Practice: Follow-along mode, rhythm game scoring, loops and latency calibration
- Logs: View, import and export communication logs

### Usage

Install Node.js (the project uses Node.js 26), then in the project directory run `npm ci` followed by:

```sh
npm start
```

`npm start` first builds the local transcription runtime (`npm run build:transcription`).

Open <http://localhost:5173> and connect your keyboard on the Device page.

For Bluetooth connections, use a browser that supports Web Bluetooth, such as Chrome, and open the site over localhost or HTTPS.

**Transcribe** turns a local audio file into a practice score. Import MP3, WAV or another browser-decodable format (up to 50 MB and 10 minutes), then use the whole source or trim a 1–600 s clip. Use Basic Pitch for instruments, direct GAME for clear lead vocals, or UVR + GAME when the backing track masks the singer. The page remembers your mode. On first use it selects direct GAME when available and Basic Pitch otherwise. The two GAME modes require Python and model setup. See [local model setup](docs/melody-quality.md#optional-local-game-and-vocal-separation).

After transcription, **Auto Tempo + Main-Key Fit** estimates BPM and beat origin and suggests a transpose for the keyboard's main keys. **Original Key** sets transpose to zero. You can edit these settings, audition the single-line melody, the detailed arrangement with optional auto-harmony, or the working melody, download MIDI, or open a score in Practice. Inference runs entirely on your device and can be cancelled.

The progress panel shows preparation, model loading, completed processing windows and note extraction. UVR + GAME shows separation and transcription independently. When UVR finishes, you can play or download the isolated stereo WAV while GAME continues. Reopening the clip restores its saved vocal preview.

You can also paste a public Bilibili or YouTube video link and click **Fetch audio**. The local server downloads and normalizes the audio with yt-dlp + ffmpeg, then hands it to the same file pipeline — transcription still only runs when you click Start. This needs internet access, the local `npm start` server, and yt-dlp plus ffmpeg/ffprobe (see [docs/url-import.md](docs/url-import.md) for setup). It uses no cookies, no login, and no DRM or access-control bypass — only fetch content you are allowed to download.

The local Node server saves each song in `.funcuby-library/` in the project. Set `FUNCUBY_LIBRARY_DIR` to choose another directory before starting the server. Each song contains the original audio, available vocal WAVs, editable notes and MIDI files for each difficulty. Batch transcription processes up to two full songs concurrently. Keep the tab open until the queue finishes. New songs open on the single-line melody with its original rhythm. Piano previews start at the first continuous phrase when the opening contains isolated notes. Choose **First note** to hear those notes, or lower the preview speed to listen more closely. Phrase comparisons, practice and MIDI use the score timeline.

Use **Try 25 seconds** to transcribe a short sample from the current start, then
**Transcribe whole track** when ready. In melody review you can play the same
phrase from the source, isolated vocals and piano draft in a loop. Edits to
pitch, timing, splits and merges update all difficulty versions and are saved
separately from the recognizer notes. After a new GAME run, **Jump to a possible
rest** focuses on a suggested release or repeated note. Audition the current
and suggested versions before applying the edit. See the [local benchmark](docs/melody-evaluation.md)
for reference-based evaluation.

Transcription uses [Spotify Basic Pitch](https://github.com/spotify/basic-pitch-ts) and [TensorFlow.js](https://github.com/tensorflow/tfjs), bundled locally under `vendor/` (gitignored, rebuilt by `npm start`). Both are Apache-2.0; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Personal use does not remove license obligations. The job/worker/diagnostics design is documented in [docs/transcription-architecture.md](docs/transcription-architecture.md).

Licensed under the [MIT License](LICENSE).

If this project helped you, please give it a [Star ⭐]

## 中文

FunCuby 是 CubyFun easyplay 1s 的非官方开源网页工具，通过蓝牙连接设备，支持 MIDI 演奏和练习

[点这里使用](https://funcuby.pages.dev/)

### 功能

- 设备：蓝牙连接、实时按键显示、首键校准
- 测试：发送 MIDI 消息和原始 HEX 报文，测试设备响应
- 演奏：导入 MIDI 文件，选择音轨、调整速度并播放
- 扒谱：把本机音频文件转成口袋钢琴练习谱，完全本地运行
- 练习：跟练、音游评分、循环练习和延迟校准
- 日志：查看、导入和导出通信记录

### 使用

安装 Node.js（项目使用 Node.js 26），在项目目录先运行 `npm ci`，再运行：

```sh
npm start
```

`npm start` 会先构建本地转写运行时（`npm run build:transcription`）。

打开 <http://localhost:5173>，在 设备 页面连接键盘。

蓝牙连接请使用支持蓝牙的浏览器，如 chrome ，通过 localhost 或 HTTPS 访问。

**扒谱**把本机音频文件转成练习谱。支持 MP3、WAV 等浏览器可解码的格式，最大 50 MB、10 分钟。可以使用整首音频，也可以裁剪 1–600 秒片段。钢琴、吉他等器乐可用浏览器 Basic Pitch，清晰人声优先用 GAME 直扒，伴奏盖住主唱时可用 UVR 分离人声后再转写。页面会记住选用的模式。首次使用时，GAME 就绪便选直扒，否则使用浏览器模式。两个 GAME 模式都需要安装 Python 依赖和模型。见[本机模型安装说明](docs/melody-quality.md#optional-local-game-and-vocal-separation)。

转写完成后，可用「自动节拍 + 全大键适配」估算 BPM、节拍原点和适合大键的移调量。「还原原调」将移调设回 0。你也可以手动调整参数，试听原节奏单音、细节版或工作旋律。细节版可选择自动配和声，三版均可下载 MIDI，可弹音域内的谱可直接跟练。推理全程在本机运行，可随时取消。

进度面板显示音频准备、模型加载、已完成窗口和音符整理。「本机精扒」分别显示 UVR 分离和 GAME 转写。分离完成后即可试听双声道人声 WAV，重新打开该片段也能回听。新歌默认选「原节奏单音」。钢琴试听遇到孤立前奏音时会从首个连续乐句进入，可切换到「第一个音」核对，也可单独放慢试听速度。短句对照、跟练和 MIDI 使用谱面时间轴。

也可以在「扒谱」中粘贴公开的 B 站或 YouTube 视频链接并点击「获取音频」。本地服务器会通过 yt-dlp + ffmpeg 下载并规范化音频，然后走与文件导入相同的流程——识别仍需手动点击开始。该功能需要联网、本地 `npm start` 服务，以及 yt-dlp 和 ffmpeg/ffprobe（安装方法见 [docs/url-import.md](docs/url-import.md)）。不使用 Cookie、登录，也不绕过 DRM 或访问控制——请仅下载你有权获取的内容。

「本机曲库」按歌曲把原音频、分离人声、识别稿、修订和各难度 MIDI 保存在项目的 `.funcuby-library/` 目录。启动前设置 `FUNCUBY_LIBRARY_DIR` 可以更改目录。页面的「磁盘保存位置」显示实际路径。使用原浏览器和地址打开新版时，已有的浏览器草稿会复制到磁盘。

在「批量扒谱」选好模式与语言，可以一次添加多首本地音频，也可以每行粘贴一个 B 站或 YouTube 视频链接。链接按加入顺序获取，最多两首同时解析，其余等待。每首有独立的进度和结果，处理期间请保持页面打开。换歌后可以从曲库打开旧谱，切换片段后可以找回对应修订。
详情见[旋律质量与本机保存说明](docs/melody-quality.md)。

「试扒 25 秒」从当前片段起点快速出谱，之后可点「转写整首」。在「旋律核对与修订」
中，可以在同一短句范围依次循环试听原曲、分离人声和钢琴草稿，并修改音高、时值、
拆分或合并同音。修订会更新各难度并保存在本机，原始识别稿单独保留。
重新运行 GAME 后，有候选停顿的片段会显示「跳到收音疑点」。可对比当前弹法和建议弹法，逐条采用收音或同音重起建议，也可以撤销。
识别质量可用[本机基准评测](docs/melody-evaluation.md)追踪。

转写功能使用 [Spotify Basic Pitch](https://github.com/spotify/basic-pitch-ts) 与 [TensorFlow.js](https://github.com/tensorflow/tfjs)，打包在本地 `vendor/` 目录（已被 gitignore，由 `npm start` 重新生成）。两者均为 Apache-2.0 协议，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。个人使用并不免除许可义务。任务/Worker/诊断设计见 [docs/transcription-architecture.md](docs/transcription-architecture.md)。

本项目采用 [MIT 协议](LICENSE)。

如果项目帮助了你，请给我点个 [Star ⭐]
