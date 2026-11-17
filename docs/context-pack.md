# FunCuby 项目上下文包（供外部 AI 阅读）

> 生成时间：2026-11-17。用途：把项目现状压缩粘贴给 ChatGPT 等外部助手，
> 使其无需完整聊天记录即可接手讨论或协作。

## 1. 项目是什么

FunCuby：CubyFun/SummerTones EasyPlay 1S 口袋琴（15 个大键 + 小键，蓝牙 MIDI）的
**本地网页伴侣应用**。核心场景：导入喜欢的歌 → 自动转录成旋律 → 生成
多难度简化谱 → 钢琴音色试听 → 导出 MIDI → 跟琴练习。个人学习用途，非商用。

- 运行方式：纯静态前端 + 本地 Node server（`server.js`），`npm start` 起在
  `http://127.0.0.1:5173`，扒谱页 `#transcribe`。
- 隐私约束：所有识别推理在本地完成（浏览器 Worker 或本机 Python），不上云。
- 语言：i18n（zh-CN / en），界面双语。

## 2. 转录/扒谱管线（当前架构）

```
音频导入（B 站/YouTube 链接经 yt-dlp + ffmpeg，或本地文件；保留 44.1kHz 双声道 FLAC）
  → 引擎选择：
      a) basic-pitch     浏览器 Worker 内 TensorFlow.js，默认 CPU
      b) game            本机 Python + ONNX Runtime：GAME-1.0.3-small 歌声转 MIDI 模型
      c) game-separated  本机精扒：先 UVR-MDX-NET-Voc_FT 人声分离，再进 GAME
  → 音符结果 → 自动分析（musical-analysis.js：估算 BPM/拍点偏移/调性/推荐移调）
  → arrangement.js：Viterbi 主旋律追踪 + 泛音/毛刺清理 + 乐句级八度 + 按拍锚点
  → 四档难度：starter(入门主键骨干) / melody(基础单音) / fuller(进阶双音) / original(原始)
  → 钢琴采样试听（Salamander）、旋律编辑器、IndexedDB 持久化、MIDI 导出、跟练
```

关键实现文件：

- `src/core/arrangement.js` — 主旋律提取 + 分级简化（刚重构为 Viterbi 追踪）
- `src/core/transcription/musical-analysis.js` — `estimateTempoAndOrigin` 基于音符起点的
  相位一致性与起点间隔估算节拍，`estimateKeyAndTranspose` 根据音级权重估算调性和大键移调
- `src/core/transcription/{config,protocol,job,game-client}.js` + `transcription-worker.js`
  — 引擎注册表、Worker 协议、任务控制器（取消/重试/隔离/进度）
- `server/game-transcription.js` — `/api/transcription/game` 本机推理服务（含分离）
- `scripts/game-transcribe.py` — Python 侧编排：可选 MDX 分离 → GAME encoder →
  迭代边界解码 → 时长/音高估计；8s 窗 + 1s 上下文拼接
- `scripts/mdx-separation.py`、`scripts/setup-separation.mjs` — 人声分离
- `src/ui/transcribe/transcribe-page.js` — 扒谱页 UI（自动节拍/自动大键移调控件）
- `src/core/storage/transcription-store.js` — IndexedDB：音频 + 各引擎结果 + 编辑稿

## 3. 已完成（已验证）

- GAME 本机推理 + 取消/重试/409 忙槽。120 个 JS 单测、2 个 Python 分离测试、
  lint 和格式检查通过
- 钢琴采样试听（音量、力度压缩、防削波）、IndexedDB 持久化（刷新/重启恢复）
- 旋律编辑器：改音高/时值、拆分合并同音、撤销、原稿/修订分离保存、短句循环对照
- 链接导入保留双声道 FLAC；诊断 JSON 下载
- 实测（《崩坏：星穹铁道》EP「无中生有」219s，B 站 BV1nEWu6xEyq）：
    - GAME 直扒完成 28 个窗口，约 63 秒。UVR + GAME 完成 39 个分离窗口与 28 个推理窗口，约 257 秒
    - UVR + GAME 结果的自动拟合为 136 BPM、18 ms 原点、+5 半音，检测到的 G 大调与 E 小调共享音阶
    - 浏览器回归验证了不重新推理切换缓存，自动适配、还原原调与刷新恢复
- 浏览器冒烟、IndexedDB 存储、旋律编辑回归通过。安装和复现命令见 [旋律质量说明](melody-quality.md)

## 4. 待办

- [ ] 人工核对一组参考旋律，量化转写准确率并评估四档的可弹性。

## 5. 已诊断的核心瓶颈（本轮重构依据）

1. 混音直进 GAME 会被伴奏掩蔽 → 需先人声分离（已实测有效）
2. 写死 120 BPM/0ms 起点 → 网格错位吞节奏 → 自动 tempo/origin 估算
3. 调性失配 → starter 删小键音 → 自动全大键移调（15 大键 = C 大调音阶布局）
4. arrangement 旧逻辑过粗：按时长删短音、每格挑最高音、逐音折八度
   → 已改 Viterbi + 乐句级处理

## 6. 常用命令

```powershell
cd C:\Users\MI\Documents\DevinSpace\FunCuby
npm start                    # 起服务（先 build worker + 下载钢琴采样）
npm test                     # node --test tests/unit/*.test.js
npm run lint && npm run format:check
npm run test:e2e             # 浏览器冒烟
python tests/test_mdx_separation.py   # 分离模型单测
npm run setup:game / setup:separation / setup:piano   # 模型/素材下载
```

## 7. 约束与偏好

- 本地优先，不上云；不引入重型依赖（GAME 走 ONNX CPU，无 PyTorch）
- 许可合规：GAME 代码 MIT 但权重 CC BY-NC-SA 4.0（仅个人学习可用）；
  UVR 模型许可已记录在 `THIRD_PARTY_NOTICES.md` + `licenses/`
- 个人学习用途、非商用；用户是初学者，重视「听得出原曲、好弹」而非学术精度
- 回复用中文；改代码要遵循现有模块边界，验证优先（先失败后通过的测试）
