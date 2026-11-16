// 小服务器：托管前端页面 + 代理 DeepSeek 对话和语音合成接口（API Key 只留在服务端）+ 转发 TikTok 直播评论
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TikTokLiveConnection, WebcastEvent, ControlEvent, UserOfflineError } from 'tiktok-live-connector';
import { persona } from './persona.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 简单读取 .env（不引入 dotenv 依赖）
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const MOCK = !API_KEY;
const TIKTOK_USERNAME = (process.env.TIKTOK_USERNAME || '').replace(/^@/, '');
const STREAM_LANG = process.env.STREAM_LANG === 'en' ? 'en' : 'zh';
const IDLE_TALK_SECONDS = Number(process.env.IDLE_TALK_SECONDS) || 0;

// 非常粗糙的输入过滤，正式直播需要换成更完整的审核方案
const BLOCKED = ['加微信', '加v', '赌博', '博彩', '色情', '约炮', '代开发票'];
// 英文按整词匹配，免得 sex 误伤 Essex 这类词
const BLOCKED_EN = /\b(wechat|whatsapp|telegram|onlyfans|gambl\w*|casino|betting|porn\w*|nsfw|nudes?|sexy?|hook ?up)\b/i;
const isBlocked = (text) => BLOCKED.some((w) => text.toLowerCase().includes(w)) || BLOCKED_EN.test(text);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8'
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(__dirname, 'public', urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(path.join(__dirname, 'public'))) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 100_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamMock(lang, res) {
  const pool = persona.mockLines[lang];
  const line = pool[Math.floor(Math.random() * pool.length)];
  await sleep(400);
  for (const ch of line) {
    res.write(ch);
    await sleep(40);
  }
  res.end();
}

// 对话记忆放在服务端：刷新页面不会丢，几个页面共用同一段记忆。服务重启才清空
const history = [];
const HISTORY_LIMIT = 24;

// DeepSeek 的「用户元数据」：告诉模型今天的日期，问日期、搜新闻时才不会答错。不带地点
function latestReminder(lang) {
  const now = new Date();
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  const weekday = now.toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-CN', { weekday: 'long' });
  return `${date},${weekday},,Web,${lang === 'en' ? 'English' : '中文'}`;
}

// 返回 { text, refused }。观众提问时打开联网搜索；不管提问还是冷场聊天都开安全检查
// （DeepSeek 要求面向公众的服务开启：输入输出都审核，有风险就拒绝）
async function askDeepSeek(userContent, lang, search) {
  const system = lang === 'en' ? `${persona.systemPrompt}\n\n${persona.englishRule}` : persona.systemPrompt;
  const upstream = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      max_tokens: 400,
      thinking: { type: 'disabled' },
      safety_check: { level: 'high' },
      ...(search && { tools: [{ type: 'deepseek_web_search' }] }),
      messages: [
        { role: 'system', content: system },
        ...history,
        { role: 'latest_reminder', content: latestReminder(lang) },
        { role: 'user', content: userContent }
      ]
    })
  });
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text();
    if (upstream.status === 400 && detail.includes('Content Exists Risk')) return { text: '', refused: true };
    throw Object.assign(new Error(`HTTP ${upstream.status} ${detail}`), { upstream: true });
  }
  // 安全检查要等整段输出生成完才审核，结果可能在最后一刻才变成拒绝，所以收齐再交给页面，不能边生成边念
  const decoder = new TextDecoder();
  let buf = '', text = '', finish = null;
  for await (const chunk of upstream.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:') || t === 'data: [DONE]') continue;
      const data = JSON.parse(t.slice(5));
      if (data.error) throw Object.assign(new Error(JSON.stringify(data.error)), { upstream: true });
      text += data.choices?.[0]?.delta?.content ?? '';
      finish = data.choices?.[0]?.finish_reason ?? finish;
    }
  }
  return { text: text.trim(), refused: finish === 'content_filter' };
}

// 请求体：观众说话 { name, text, lang }，冷场主动聊 { idle: true, lang }
async function handleChat(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, 'bad json');
  }
  const lang = body?.lang === 'en' ? 'en' : 'zh';
  const idle = body?.idle === true;
  const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 300) : '';
  if (!idle && !text) return send(res, 400, 'need text');
  const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 30) : '观众';
  const lines = persona.fallbackLines[lang];

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  if (!idle && isBlocked(text)) return res.end(lines.blocked);
  if (MOCK) return streamMock(lang, res);

  const userContent = idle ? persona.idlePrompt[lang] : `${name}：${text}`;
  try {
    const { text: reply, refused } = await askDeepSeek(userContent, lang, !idle);
    // 冷场聊天被拦或没内容就不说话，免得突然冒出一句「这个不能聊」
    if (refused) {
      console.log(`  安全检查拦下了：${idle ? '冷场聊天' : `${name}：${text}`}`);
      return res.end(idle ? '' : lines.blocked);
    }
    if (!reply) return res.end(idle ? '' : lines.emptyReply);
    // 被拦下的不进记忆：安全检查也审核历史消息，留着会让后面的提问一直被拒
    history.push({ role: 'user', content: userContent }, { role: 'assistant', content: reply });
    history.splice(0, history.length - HISTORY_LIMIT);
    res.end(reply);
  } catch (err) {
    console.error('  DeepSeek 错误：', err.message);
    res.end(idle ? '' : err.upstream ? lines.upstreamError : lines.networkError);
  }
}

// voice 交给 DeepSeek 校验：传错时它返回 400，报错里列出可选音色，打印在服务端日志里
async function handleTTS(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, 'bad json');
  }
  const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 300) : '';
  if (!text) return send(res, 400, 'need text');
  if (MOCK) return send(res, 503, 'no DEEPSEEK_API_KEY');
  try {
    const upstream = await fetch(`${BASE_URL}/v1/tools/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ text, voice_id: body.voice })
    });
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status} ${await upstream.text()}`);
    send(res, 200, Buffer.from(await upstream.arrayBuffer()), 'audio/wav');
  } catch (err) {
    console.error('DeepSeek TTS 错误', err.message);
    send(res, 502, 'tts failed');
  }
}

// ---------- TikTok 直播评论：服务端连直播间，用 SSE 推给页面 ----------
// 只推给最后打开的那个页面：同时开着两个页面的话，两个都会回答、都会出声
let liveStatus = TIKTOK_USERNAME ? 'waiting' : 'off';
const livePages = new Set(); // { res, obs }

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

// 评论只交给一个页面，不然几个页面会同时回答、同时出声。
// 直播窗口（?obs=1）开着就一定交给它，免得开个控制面板或预览就把直播间的评论抢走；没有直播窗口时交给最后打开的页面
function chatReceiver() {
  const pages = [...livePages];
  return pages.findLast((p) => p.obs) ?? pages.at(-1);
}

function setLiveStatus(status) {
  if (status === liveStatus) return;
  liveStatus = status;
  console.log(status === 'live'
    ? `  已连上 @${TIKTOK_USERNAME} 的直播间，评论会交给${persona.name}回答`
    : `  … @${TIKTOK_USERNAME} 不在直播，每 30 秒再检查一次`);
  for (const p of livePages) sse(p.res, 'status', { status, username: TIKTOK_USERNAME });
}

function handleLiveEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  const page = { res, obs: new URL(req.url, 'http://x').searchParams.has('obs') };
  livePages.add(page);
  sse(res, 'status', { status: liveStatus, username: TIKTOK_USERNAME });
  req.on('close', () => livePages.delete(page));
}

function watchTikTok() {
  const connection = new TikTokLiveConnection(TIKTOK_USERNAME, {}); // 2.5.0 不传 options 会在构造函数里崩，虽然文档说可选
  let retryTimer, lastError = '';
  // 没开播是常态，不算错误；UserOfflineError 的 name 是 'Error'，只能用 instanceof 判断。
  // 从没开过播的账号拿不到直播间 ID，报的错和用户名不存在一样，分不出来，所以同一个错只提示一次
  const retryLater = (err) => {
    const msg = err instanceof UserOfflineError ? '' : err?.message ?? '';
    if (msg && msg !== lastError) console.error(`  TikTok 连接失败：${msg}\n  账号还没开过播时也会这样，开播后会自动连上；开播了还连不上，先检查 TIKTOK_USERNAME`);
    lastError = msg;
    setLiveStatus('waiting');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, 30_000);
  };
  const connect = () => connection.connect().then(() => { lastError = ''; setLiveStatus('live'); }, retryLater);
  // 2.5.0 实际的字段是 content / nickname / displayId，README 里写的 comment / uniqueId 是旧的，所以 package.json 锁了版本
  connection.on(WebcastEvent.CHAT, (data) => {
    if (!data.content) return;
    const name = data.user?.nickname || data.user?.displayId || '观众';
    const page = chatReceiver();
    console.log(`  评论 ${name}：${data.content}${page ? '' : '（没有页面在线，没人回答）'}`);
    if (page) sse(page.res, 'chat', { name, text: data.content });
  });
  connection.on(ControlEvent.DISCONNECTED, () => retryLater());
  // 连接阶段的错误由 connect() 的结果报告，这里只管连上之后的
  connection.on(ControlEvent.ERROR, ({ info, exception }) => {
    if (liveStatus === 'live') console.error('  TikTok 连接出错：', info, exception?.message ?? '');
  });
  connect();
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/status') {
    return send(res, 200, JSON.stringify({ mock: MOCK, model: MODEL, name: persona.name, pokeLines: persona.pokeLines, lang: STREAM_LANG, idleSeconds: IDLE_TALK_SECONDS }), MIME['.json']);
  }
  if (req.method === 'POST' && req.url === '/api/clear') {
    history.length = 0;
    return send(res, 200, 'ok');
  }
  if (req.method === 'POST' && req.url === '/api/chat') return handleChat(req, res);
  if (req.method === 'POST' && req.url === '/api/tts') return handleTTS(req, res);
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/live') return handleLiveEvents(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  send(res, 405, 'Method not allowed');
});

server.listen(PORT, () => {
  console.log(`\n  ${persona.name} 已上线：http://localhost:${PORT}`);
  console.log(`  OBS 采集用（隐藏控制面板）：http://localhost:${PORT}/?obs=1`);
  console.log(MOCK ? '  ⚠ 没有 DEEPSEEK_API_KEY，当前是模拟模式\n' : `  使用模型：${MODEL}\n`);
  console.log(TIKTOK_USERNAME ? `  TikTok 评论：@${TIKTOK_USERNAME} 开播后自动连上\n` : '  TikTok 评论：没配置 TIKTOK_USERNAME，只能用模拟评论\n');
  if (!MOCK) checkKey();
  if (TIKTOK_USERNAME) watchTikTok();
});

// 启动时检查一下 Key 和模型名对不对
async function checkKey() {
  try {
    const r = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    if (!r.ok) return console.log(`  ❌ DeepSeek Key 校验失败（HTTP ${r.status}），请检查 .env\n`);
    const ids = ((await r.json()).data || []).map((m) => m.id);
    console.log(ids.includes(MODEL)
      ? `  ✅ DeepSeek 连接正常，模型 ${MODEL} 可用\n`
      : `  ⚠ 模型 ${MODEL} 不在可用列表里：${ids.join(', ')}。请在 .env 设置 DEEPSEEK_MODEL\n`);
  } catch (e) {
    console.log('  ❌ 连不上 DeepSeek：', e.message, '\n');
  }
}
