# Bao 直播间（POC）

一个说英文的、憨憨的 3D 南瓜小包子虚拟主播 Bao（Three.js 实时渲染，代码建模，不需要模型文件）：你对着麦克风说话，或者输入模拟评论，它就会用 DeepSeek 想出回复，再用语音念出来，同时张嘴、晃身体。戳它一下也会有反应，有点像汤姆猫。

```
麦克风 / 评论 → 语音识别 → DeepSeek（流式）→ 按句切分 → 浏览器 TTS → 嘴型动画
```

## 怎么跑起来

1. 安装 Node.js 18 或更高版本（不需要 `npm install`，项目没有依赖）
2. 复制配置文件，填入 DeepSeek API Key（https://platform.deepseek.com 申请）：
   ```bash
   cp .env.example .env
   ```
   模型默认是 `deepseek-v4-flash`，启动时终端会提示 Key 和模型是否可用。不填 Key 也能跑，会进入「模拟模式」，只说预设台词。
3. 启动：
   ```bash
   npm start
   ```
4. 用**电脑版 Edge**（推荐，自带微软晓晓、晓伊这类自然音色）或 Chrome 打开 http://localhost:3000
5. 点「开启麦克风」，允许权限，然后直接说话。**建议戴耳机**，不然它可能会听到自己的声音。

## 功能
- 🎙 麦克风对话：用的是浏览器自带的 Web Speech API，它说话时会自动暂停收音
- 💬 模拟观众评论：可以自己填昵称，测试多人评论时的排队（最多排 5 条，多了就丢掉最旧的）
- 🔊 音色、音调、语速可以调（默认音调 1.6，偏可爱）
- 👆 点包子会触发「戳一戳」反应（会被压扁再弹回来），不调用 API
- 👀 3D 形象会眨眼、眼睛跟着鼠标转、思考时歪头看上面、说话时张嘴和挥手
- 🧠 会记住最近十几轮对话，可以一键清空记忆
- 🛡 提示词里加了防注入和不聊敏感话题的规则，服务端还有一个简单的关键词过滤
- 画面右上角固定显示「虚拟主播 · AI生成内容」标识

## 改人设
- 编辑 `persona.js`：系统提示词、标题（Ask me anything~）、戳一戳台词都在这里
- 完整的角色设定和 Gemini 生图提示词在 [`docs/character.md`](docs/character.md)
- 想换背景：把图片存成 `public/bg.jpg`，然后刷新网页

## 更自然的声音（ElevenLabs）
1. 去 https://elevenlabs.io 注册，点头像 → **API Keys** → 新建一个 Key
2. 在 `.env` 里加一行 `ELEVENLABS_API_KEY=你的key`，然后重新启动
3. 网页「声音」里，语音引擎选 ElevenLabs，再选音色。想要可爱的音色，去 **Voice Library** 搜 cute / cartoon / squeaky，加到 My Voices，然后刷新网页
4. 用 ElevenLabs 时，嘴型会跟着**真实音量**动
5. 免费方案：用 **Edge** 浏览器，音色选 **Microsoft Ana Online (Natural)**（小孩音）

## 接 OBS（以后要直播时用）
- 打开 `http://localhost:3000/?obs=1`，这个页面只显示直播画面。按 `M` 开关麦克风，按 `Esc` 让它闭嘴
- OBS 里用「窗口采集」采这个浏览器窗口，声音用「桌面音频」。浏览器源对语音合成和识别的支持不稳定，不建议用

## POC 的局限 / 下一步
- 嘴型现在是随机开合，不是根据真实音量。以后换成云端 TTS（Azure、火山、Fish Audio 等）拿到音频后，可以按音量驱动嘴型
- 语音识别依赖浏览器（Chrome 会走 Google 服务器），以后可以换成 Whisper 或讯飞
- 还没接 TikTok 真实评论：可以用非官方库 `TikTokLive` 或 `tiktok-live-connector` 抓评论，调用同一个 `/api/chat`（注意有违反服务条款的风险）
- 正式直播前需要更完善的内容审核
