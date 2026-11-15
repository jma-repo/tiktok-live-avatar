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
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const MOCK = !API_KEY;

// 非常粗糙的输入过滤，正式直播需要换成更完整的审核方案
const BLOCKED = ['加微信', '加v', '赌博', '博彩', '色情', '约炮', '代开发票'];
const isBlocked = (text) => BLOCKED.some((w) => text.toLowerCase().includes(w));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
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
      max_tokens: 120,
      messages: [{ role: 'system', content: persona.systemPrompt }, ...messages]
    })
  });
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    console.error('DeepSeek 错误', upstream.status, text);
    res.end('哎呀，俺脑子卡住了，等一下下。');
    return;
  }
  const decoder = new TextDecoder();
  let buf = '';
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
        if (delta) res.write(delta);
      } catch { /* 忽略不完整的行 */ }
    }
  }
  res.end();
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
    res.end('这个俺可不能聊，咱们说点别的吧！');
    return;
  }
  try {
    if (MOCK) await streamMock(res);
    else await streamDeepSeek(messages, res);
  } catch (err) {
    console.error(err);
    if (!res.writableEnded) res.end('哎呀，网卡了，俺没听清。');
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/status') {
    return send(res, 200, JSON.stringify({ mock: MOCK, model: MODEL, name: persona.name, pokeLines: persona.pokeLines }), MIME['.json']);
  }
  if (req.method === 'POST' && req.url === '/api/chat') return handleChat(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  send(res, 405, 'Method not allowed');
});

server.listen(PORT, () => {
  console.log(`\n  ${persona.name} 已上线：http://localhost:${PORT}`);
  console.log(`  OBS 采集用（隐藏控制面板）：http://localhost:${PORT}/?obs=1`);
  console.log(MOCK ? '  ⚠ 没有 DEEPSEEK_API_KEY，当前是模拟模式\n' : `  使用模型：${MODEL}\n`);
});
