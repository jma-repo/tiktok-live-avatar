// 零依赖的小服务器：托管前端页面 + 代理 DeepSeek 流式接口（API Key 只留在服务端）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const MOCK = !API_KEY;

// ElevenLabs 语音（可选）：填了 Key 才启用
const EL_KEY = process.env.ELEVENLABS_API_KEY || '';
const EL_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';
const EL_VOICE = process.env.ELEVENLABS_VOICE_ID || '';

// 非常粗糙的输入过滤，正式直播需要换成更完整的审核方案
const BLOCKED = ['加微信', '加v', '赌博', '博彩', '色情', '约炮', 'onlyfans', 'nude', 'casino', 'crypto giveaway', 'cashapp', 'telegram me'];
const isBlocked = (text) => BLOCKED.some((w) => text.toLowerCase().includes(w));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
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

async function streamMock(res) {
  const line = persona.mockLines[Math.floor(Math.random() * persona.mockLines.length)];
  await sleep(400);
  for (const ch of line) {
    res.write(ch);
    await sleep(40);
  }
  res.end();
}

async function streamDeepSeek(messages, res) {
  const upstream = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      temperature: 1.1,
      max_tokens: 400,
      messages: [{ role: 'system', content: persona.systemPrompt }, ...messages]
    })
  });
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    console.error('DeepSeek 错误', upstream.status, text);
    res.end('Oh noodles, my brain got stuck. Give me a second!');
    return;
  }
  const decoder = new TextDecoder();
  let buf = '', wrote = false;
  for await (const chunk of upstream.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) { res.write(delta); wrote = true; }
      } catch { /* 忽略不完整的行 */ }
    }
  }
  res.end(wrote ? '' : 'Hmm... I thought so hard I forgot what I was going to say.');
}

async function handleChat(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, 'bad json');
  }
  // 只接受 user/assistant 消息，限制条数和长度
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-16)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 300) }));
  if (!messages.length || messages.at(-1).role !== 'user') return send(res, 400, 'need user message');

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no'
  });

  if (isBlocked(messages.at(-1).content)) {
    res.end(persona.blockedReply);
    return;
  }
  try {
    if (MOCK) await streamMock(res);
    else await streamDeepSeek(messages, res);
  } catch (err) {
    console.error(err);
    if (!res.writableEnded) res.end("Oops, the internet hiccuped. I didn't catch that!");
  }
}

// ---------- ElevenLabs：把一句话转成 mp3 ----------
async function handleTTS(req, res) {
  if (!EL_KEY) return send(res, 400, 'ElevenLabs not configured');
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, 'bad json'); }
  const text = String(body.text || '').slice(0, 400).trim();
  const voiceId = /^[A-Za-z0-9]{10,40}$/.test(body.voiceId || '') ? body.voiceId : EL_VOICE;
  if (!text || !voiceId) return send(res, 400, 'need text and voiceId');
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': EL_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: EL_MODEL,
        voice_settings: { stability: 0.4, similarity_boost: 0.8 }
      })
    });
    if (!r.ok) {
      console.error('ElevenLabs 错误', r.status, await r.text().catch(() => ''));
      return send(res, 502, 'tts failed');
    }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error(e);
    send(res, 502, 'tts failed');
  }
}

async function handleVoices(res) {
  if (!EL_KEY) return send(res, 200, '[]', MIME['.json']);
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': EL_KEY } });
    if (!r.ok) {
      console.error('ElevenLabs 音色列表错误', r.status, await r.text().catch(() => ''));
      return send(res, 502, '[]', MIME['.json']);
    }
    const voices = ((await r.json()).voices || []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      desc: [v.labels?.gender, v.labels?.age, v.labels?.accent, v.labels?.description || v.labels?.descriptive].filter(Boolean).join(', ')
    }));
    send(res, 200, JSON.stringify(voices), MIME['.json']);
  } catch (e) {
    console.error(e);
    send(res, 502, '[]', MIME['.json']);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/status') {
    return send(res, 200, JSON.stringify({
      mock: MOCK, model: MODEL, name: persona.name, title: persona.title, pokeLines: persona.pokeLines,
      eleven: Boolean(EL_KEY), elevenVoice: EL_VOICE
    }), MIME['.json']);
  }
  if (req.method === 'POST' && req.url === '/api/chat') return handleChat(req, res);
  if (req.method === 'POST' && req.url === '/api/tts') return handleTTS(req, res);
  if (req.method === 'GET' && req.url === '/api/voices') return handleVoices(res);
  if (req.method === 'GET') return serveStatic(req, res);
  send(res, 405, 'Method not allowed');
});

server.listen(PORT, () => {
  console.log(`\n  ${persona.name} 已上线：http://localhost:${PORT}`);
  console.log(`  OBS 采集用（隐藏控制面板）：http://localhost:${PORT}/?obs=1`);
  console.log(MOCK ? '  ⚠ 没有 DEEPSEEK_API_KEY，当前是模拟模式\n' : `  使用模型：${MODEL}\n`);
  console.log(EL_KEY ? `  ElevenLabs 语音已启用（${EL_MODEL}）` : '  （没配置 ELEVENLABS_API_KEY，只能用浏览器自带语音）');
  if (!MOCK) checkKey();
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
