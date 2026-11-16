// 打开直播画面专用的 Chrome 窗口，给 TikTok LIVE Studio 的「窗口采集」用。
// 用单独的 Chrome 配置目录启动，下面这些参数才会生效（已经开着的 Chrome 会忽略启动参数）：
// 窗口被 LIVE Studio 挡住时照常刷新、不用先点一下页面就能出声、不被后台节流
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const port = process.env.PORT || 3000;
const chrome = [
  path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')
].find((p) => fs.existsSync(p));
if (!chrome) throw new Error('没找到 Chrome，请先安装 Google Chrome');

spawn(chrome, [
  `--user-data-dir=${path.join(process.env.LOCALAPPDATA, 'HanbaoStageChrome')}`,
  `--app=http://localhost:${port}/?obs=1`,
  '--window-size=354,664',
  '--window-position=920,0',
  '--no-first-run',
  '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling'
], { detached: true, stdio: 'ignore' }).unref();

console.log('直播画面窗口已打开。LIVE Studio 里「窗口采集」选「憨包直播间 POC」；这个窗口可以被挡住，但不能最小化。');
