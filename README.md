# 憨包直播间（POC）

一个憨憨的小包子虚拟主播「憨包 / Bao」，站在面馆的桌子上。形象是一张 AI 生成的图，拆成背景、身体、眼睛、嘴巴四层（`public/avatar/`），用 CSS 动起来。你对着麦克风说话，或者输入模拟评论，它就会用 DeepSeek 想出回复，再用语音念出来，同时张嘴、晃身体。戳它一下也会有反应，有点像汤姆猫。

```
麦克风 / TikTok 评论 → 关键词过滤 → DeepSeek（联网搜索 + 安全检查）→ 按句切分 → DeepSeek TTS → 按音量动嘴
```

## 怎么跑起来

1. 安装 Node.js 20 或更高版本，然后装依赖（只有一个：读 TikTok 直播评论用的 `tiktok-live-connector`）：
   ```bash
   npm install
   ```
2. 复制配置文件，填入 DeepSeek API Key（https://platform.deepseek.com 申请，对话和语音合成共用这一个 Key）：
   ```bash
   cp .env.example .env
   ```
   模型默认是 `deepseek-flash`（联网搜索和安全检查只支持它），启动时终端会提示 Key 和模型是否可用。不填 Key 也能跑，会进入「模拟模式」，只显示预设台词，不出声。
   要接 TikTok 直播评论的话，再填 `TIKTOK_USERNAME`（你的 TikTok 用户名）。
3. 启动：
   ```bash
   npm start
   ```
4. 用电脑版 Chrome 或 Edge 打开 http://localhost:3000（麦克风识别用的是浏览器自带功能）
5. 点「开启麦克风」，允许权限，然后直接说话。**建议戴耳机**，不然它可能会听到自己的声音。

## 功能
- 🎙 麦克风对话：用的是浏览器自带的 Web Speech API，它说话时会自动暂停收音
- 💬 模拟观众评论：可以自己填昵称，测试多人评论时的排队（最多排 5 条，多了就丢掉最旧的）
- 🔊 语音用 DeepSeek TTS：音色可选女声 stella / 男声 tide，语速可调（DeepSeek 接口没有音调参数）
- 直播语言可切「中文 / English」：切到英文后，麦克风识别、回复、戳一戳和试听台词都换成英文（英文名 Bao）。默认语言由 `.env` 的 `STREAM_LANG` 决定，直播窗口没有面板，就靠它；面板里手动切换只影响那个浏览器
- 👆 点包子会触发「戳一戳」反应（会被压扁再弹回来），不调用 API
- 👀 会呼吸、眨眼，思考时歪头，说话时按音量张嘴、身体跟着颠
- 没人说话时，气泡里是欢迎语（「嗨，俺是憨包！」/「Hi, my name is Bao! Ask me anything in the comments~」）
- 🧠 会记住最近 12 轮对话：记忆存在服务端，刷新页面不会丢，几个页面共用，服务重启才清空。可以一键清空
- 🔎 联网搜索：观众问天气、新闻、比分、今天几号这类问题时，DeepSeek 自己判断要不要上网查（`deepseek_web_search`），模型也知道今天的日期
- 🛡 敏感话题三层把关：服务端的中英文关键词过滤 → DeepSeek 安全检查（`safety_check`，审核输入和输出，被拒就说兜底台词，被拒的内容不进记忆）→ 提示词里不聊政治、色情、暴力、赌博等话题、防注入的规则
- 冷场时主动聊：直播窗口里 `IDLE_TALK_SECONDS` 秒（默认 10）没人说话，包子就主动讲个冷知识或问观众一个小问题，不会重复前面说过的
- 「闭嘴」会同时打断正在生成的回复和还没念的句子
- 画面右上角固定显示「虚拟主播 · AI生成内容」标识

## 改人设
编辑 `persona.js`：系统提示词、戳一戳台词、模拟模式台词、出错时的兜底台词都在这里，中英文各一份。

## 换形象
`public/avatar/` 里的四张图是用 `tools/cutout.py` 从原图 `tools/avatar-source.webp` 抠出来的（需要 Pillow 和 numpy）：
```bash
python tools/cutout.py tools/avatar-source.webp public/avatar 预览图目录
```
脚本会打印各层的位置和动画锚点，对应 `public/style.css` 的 `.avatar` 规则。脚本里包子的轮廓、眼睛和嘴的位置是按这张图手工标定的，换图要重新标。

## 接 TikTok 直播
- 推流用 TikTok 官方的 LIVE Studio（https://www.tiktok.com/studio/download）
- 先 `npm start`，再 `npm run stage`：用一个专用的 Chrome 窗口打开直播画面（`/?obs=1`，只有舞台，铺满窗口）。这个窗口被挡住也照常刷新、不用点就能出声，配置单独放在 `%LOCALAPPDATA%\HanbaoStageChrome`
- LIVE Studio 里添加「窗口采集」，选「憨包直播间 POC」；声音在混音器里只选 Chrome。重新打开过这个窗口的话，LIVE Studio 里要重新选一次窗口
- 这个窗口不能最小化：Windows 不渲染最小化的窗口，LIVE Studio 会采到黑屏。直播窗口里按 `M` 开关麦克风，按 `Esc` 让它闭嘴
- 直播画面里不显示评论列表：TikTok 手机端自己的评论区就在画面下方，重复显示会挡住
- 直播里不能放没授权的音乐：TikTok《Music Terms of Service》写明直播里不能用 Sounds / Commercial Sounds 曲库，放别人的录音或唱别人的歌要先拿到授权
- 读评论：`.env` 里填了 `TIKTOK_USERNAME` 的话，服务会每 30 秒检查一次你开播没有，开播后自动连上直播间，评论和模拟评论走同一条路（排队，最多排 5 条）。控制面板顶部会显示连接状态
- 评论只交给一个页面，免得几个页面同时回答、同时出声：直播窗口（`?obs=1`）开着就一定交给它，打开控制面板也不会抢走；没有直播窗口时交给最后打开的页面。服务端终端会打印每条收到的评论

## POC 的局限 / 下一步
- 开了安全检查后，回复要整段生成、审核完才开始念（实测 1–2.5 秒，联网搜索时偏长），不能边生成边念：审核结果可能在最后一刻才判定拒绝，念出去的话收不回来
- 每句话单独请求一次 TTS，首包大约 1 秒（下一句会在上一句播放时提前合成）
- 语音识别依赖浏览器（Chrome 会走 Google 服务器），以后可以换成 Whisper 或讯飞
- 读评论用的 `tiktok-live-connector` 是非官方库，靠逆向工程连 TikTok，可能随时失效，也有违反服务条款的风险。版本锁在 2.5.0，因为用到的字段名和它的文档对不上，升级前要重新测
- 每条评论、每次冷场聊天都会调一次 DeepSeek 对话和语音合成；联网搜索按次数另收费，安全检查的 token 按输出 token 计费。评论多的直播间费用会跟着涨
- TikTok 手机端的评论区会盖住画面下方大约三分之一，包子站得偏下，开播前用手机看一眼效果
- 正式直播前需要更完善的内容审核
