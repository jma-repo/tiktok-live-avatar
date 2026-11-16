// 憨包直播间 POC 前端
// 流程：麦克风(Web Speech) / 评论 → /api/chat(流式) → 按句切分 → /api/tts(DeepSeek TTS) → 按音量动嘴
(() => {
  const $ = (s) => document.querySelector(s);
    const params = new URLSearchParams(location.search);
  if (params.has('obs')) document.body.classList.add('obs');

  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 无痕模式等 */ } }
  };

  const state = {
    queue: [],        // 待回复的消息
    busy: false,      // 正在请求/回复
    speakingCount: 0, // 正在排队播报的句子数
    micOn: false,
    pokeLines: { zh: ['哎哟！'], en: ['Ouch!'] }
  };

  const LANGS = {
    zh: {
      rec: 'zh-CN', welcome: ['嗨，俺是憨包！', '有啥想问的，评论区尽管问～'],
      testLine: '嘿嘿，俺是憨包，你听俺的声音可爱不？', stuckLine: '哎呀，俺脑子卡住了……', clearedLine: '嗯？俺刚才说到哪儿了？'
    },
    en: {
      rec: 'en-US', welcome: ["Hi, my name is Bao!", 'Ask me anything in the comments~'],
      testLine: "Hehe, I'm Bao. Do you like my voice?", stuckLine: 'Oops, my brain got stuck...', clearedLine: 'Hmm? Where was I?'
    }
  };
  const langSel = $('#langSel');
  langSel.value = store.get('lang', langSel.value);

  // ---------- 服务状态 ----------
  fetch('/api/status').then((r) => r.json()).then((s) => {
    state.pokeLines = s.pokeLines || state.pokeLines;
    if (!store.get('lang', '')) applyLang(s.lang); // 这个浏览器没手动选过语言，就用 .env 里的 STREAM_LANG（直播窗口没有面板可选）
    if (params.has('obs') && s.idleSeconds > 0) startIdleTalk(s.idleSeconds);
    const el = $('#status');
    if (s.mock) {
      el.textContent = '⚠ 模拟模式：没有配置 DEEPSEEK_API_KEY，只显示预设台词，不出声';
      el.classList.add('warn');
    } else {
      el.textContent = `✅ 已连接 DeepSeek（${s.model}）`;
    }
  }).catch(() => { $('#status').textContent = '❌ 连不上服务器，确认 npm start 在运行'; });

  // ---------- 形象状态（avatar.js 读取 window.avatarState） ----------
  const avatarState = (window.avatarState ||= { mouth: 0, speaking: false, mood: null, poke: 0 });
  function setMood(mood) { avatarState.mood = mood; }

  // ---------- 字幕 & 评论区 ----------
  let bubbleTimer;
  function setBubble(to, text, sub, idle) {
    $('#bubble').classList.toggle('idle', idle);
    $('#bubbleTo').textContent = to;
    $('#bubbleText').textContent = text;
    $('#bubbleSub').textContent = sub;
  }
  function showBubble(text, to) {
    clearTimeout(bubbleTimer);
    setBubble(to ? '@' + to : '', text, '', false);
  }
  function showWelcome() {
    const [title, sub] = LANGS[langSel.value].welcome;
    setBubble('', title, sub, true);
  }
  function welcomeLater() {
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(showWelcome, 6000);
  }
  showWelcome();
  function addComment(name, text) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = name;
    li.append(b, document.createTextNode(text));
    const list = $('#comments');
    list.append(li);
    while (list.children.length > 6) list.firstChild.remove();
  }

  // ---------- 语音合成 ----------
  const voiceSel = $('#voiceSel');
  const rate = $('#rate');
  const audio = new Audio();
  voiceSel.value = store.get('ttsVoice', voiceSel.value);
  rate.value = store.get('rate', rate.value);
  const applyRate = () => { $('#rateV').textContent = rate.value; audio.defaultPlaybackRate = Number(rate.value); };
  applyRate();
  voiceSel.onchange = () => store.set('ttsVoice', voiceSel.value);
  rate.oninput = () => { store.set('rate', rate.value); applyRate(); };

  const audioCtx = new AudioContext();
  const analyser = audioCtx.createAnalyser();
  audioCtx.createMediaElementSource(audio).connect(analyser);
  analyser.connect(audioCtx.destination);
  const samples = new Float32Array(analyser.fftSize);
  const FULL_MOUTH_RMS = 0.17; // 实测 DeepSeek TTS 说话时九成音量（RMS）低于 0.17，到这个值嘴全张开

  function animate() {
    const speaking = !audio.paused;
    avatarState.speaking = speaking;
    let level = 0;
    if (speaking) {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      level = Math.min(1, Math.sqrt(sum / samples.length) / FULL_MOUTH_RMS);
    }
    avatarState.mouth = level;
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  const cleanForSpeech = (s) => s
    .replace(/[*#_`>~\[\]]/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')  // 去掉括号里的动作描写
    .replace(/\p{Extended_Pictographic}/gu, '')
    .trim();

  async function synthesize(text, signal) {
    const t = cleanForSpeech(text);
    if (!t) return null;
    try {
      const r = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t, voice: voiceSel.value }),
        signal
      });
      if (!r.ok) throw new Error('tts ' + r.status);
      return await r.blob();
    } catch (err) {
      if (!signal.aborted) console.warn('语音合成失败，这句只显示字幕', err);
      return null;
    }
  }

  let stopCurrent = () => {};
  function play(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        audio.pause();
        URL.revokeObjectURL(url);
        resolve();
      };
      stopCurrent = finish;
      audio.onended = audio.onerror = finish;
      audio.src = url;
      audioCtx.resume(); // 自动播放策略：页面被点过之后才能出声
      audio.play().catch(finish);
    });
  }

  // 每句一进来就开始合成，和上一句的播放重叠，句间停顿更短
  let speechChain = Promise.resolve();
  let stopCtrl = new AbortController();
  function enqueueSpeech(text) {
    const { signal } = stopCtrl;
    const prefetched = synthesize(text, signal);
    state.speakingCount++;
    updateMic();
    speechChain = speechChain
      .then(async () => {
        const blob = await prefetched;
        if (blob && !signal.aborted) await play(blob);
      })
      .finally(() => {
        state.speakingCount--;
        updateMic();
      });
    return speechChain;
  }
  function stopAll() {
    state.queue.length = 0;
    stopCtrl.abort();
    stopCtrl = new AbortController();
    stopCurrent();
  }

  // ---------- 对话 ----------
  function submit(name, text) {
    text = (text || '').trim();
    if (!text) return;
    addComment(name, text);
    state.queue.push({ name, text });
    if (state.queue.length > 5) state.queue.shift(); // 评论太多就丢掉最旧的
    pump();
  }

  async function pump() {
    if (state.busy) return;
    const item = state.queue.shift();
    if (!item) return;
    state.busy = true;
    updateMic();
    try {
      await respond(item);
    } catch (err) {
      if (err.name !== 'AbortError') { // 「闭嘴」中断请求不算出错
        console.error(err);
        showBubble(LANGS[langSel.value].stuckLine);
      }
    } finally {
      state.busy = false;
      setMood(null);
      welcomeLater();
      updateMic();
      pump();
    }
  }

  // 观众说话是 { name, text }，冷场主动聊是 { idle: true }。对话记忆在服务端
  async function respond({ name, text, idle }) {
    const { signal } = stopCtrl;
    setMood('thinking');
    showBubble('……', name);

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(idle ? { idle, lang: langSel.value } : { name, text, lang: langSel.value }),
      signal
    });
    if (!res.ok || !res.body) throw new Error('chat failed ' + res.status);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '', pending = '', first = true;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (first && chunk) { setMood(null); first = false; }
      full += chunk;
      pending += chunk;
      showBubble(full, name);
      // 一句话一结束就开始念，降低延迟。英文句号要后面跟空格才算，避免把 3.5 这类小数切开
      let m;
      while ((m = pending.match(/^[\s\S]*?(?:[。！？!?…～~\n]+|\.(?=\s))/))) {
        enqueueSpeech(m[0]);
        pending = pending.slice(m[0].length);
      }
    }
    if (pending.trim()) enqueueSpeech(pending);
    if (!full) showWelcome(); // 冷场聊天被安全检查拦下时，服务端什么都不回
    await speechChain; // 说完再处理下一条
  }

  // ---------- 冷场时主动聊（只在直播窗口里开，免得几个页面一起说话） ----------
  let lastActive = Date.now();
  function startIdleTalk(seconds) {
    setInterval(() => {
      if (state.busy || state.queue.length || state.speakingCount) lastActive = Date.now();
      else if (Date.now() - lastActive >= seconds * 1000) {
        lastActive = Date.now();
        state.queue.push({ idle: true });
        pump();
      }
    }, 1000);
  }

  // ---------- TikTok 直播评论（服务端连直播间推过来，和模拟评论走同一条路） ----------
  const liveStatusText = {
    off: () => 'TikTok 评论：没配置，在 .env 里填 TIKTOK_USERNAME 后重启',
    waiting: (u) => `TikTok 评论：等 @${u} 开播…`,
    live: (u) => `TikTok 评论：已连上 @${u} 的直播间`
  };
  // 直播窗口带上 obs=1：服务端只要看到直播窗口在线，评论就只交给它
  const live = new EventSource(params.has('obs') ? '/api/live?obs=1' : '/api/live');
  live.addEventListener('chat', (e) => { const c = JSON.parse(e.data); submit(c.name, c.text); });
  live.addEventListener('status', (e) => { const s = JSON.parse(e.data); $('#liveStatus').textContent = liveStatusText[s.status](s.username); });

  // ---------- 麦克风（Web Speech API，Chrome / Edge 可用） ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = $('#micBtn');
  let rec = null, recRunning = false;

  if (!SR) {
    micBtn.disabled = true;
    micBtn.textContent = '此浏览器不支持语音识别';
    $('#micHint').textContent = '请用电脑版 Chrome 或 Edge 打开。也可以先用下面的文字评论测试。';
  } else {
    rec = new SR();
    rec.lang = LANGS[langSel.value].rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      lastActive = Date.now(); // 主播正在说话，别让包子插嘴冷场聊天
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) submit($('#hostName').value || '主播', r[0].transcript);
        else interim += r[0].transcript;
      }
      $('#interim').textContent = interim;
      if (interim && !state.busy) setMood('listening');
    };
    rec.onstart = () => { recRunning = true; };
    rec.onend = () => {
      recRunning = false;
      $('#interim').textContent = '';
      setTimeout(updateMic, 250); // 浏览器静音一会儿会自动停，这里自动重启
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        state.micOn = false;
        $('#micHint').textContent = '麦克风权限被拒绝了，请在地址栏左边的权限设置里允许。';
        renderMic();
      }
    };
  }

  // 只在「麦克风开着 且 包子没在想/说话」时收音，避免它听到自己的声音
  function updateMic() {
    if (!rec) return;
    const shouldListen = state.micOn && !state.busy && state.speakingCount === 0;
    if (shouldListen && !recRunning) {
      try { rec.start(); recRunning = true; } catch { /* 已经在运行 */ }
    } else if (!shouldListen && recRunning) {
      rec.abort();
    }
  }
  function renderMic() {
    micBtn.textContent = state.micOn ? '关闭麦克风（收音中）' : '开启麦克风';
    micBtn.classList.toggle('on', state.micOn);
  }
  function toggleMic() {
    if (!rec) return;
    state.micOn = !state.micOn;
    renderMic();
    updateMic();
  }
  micBtn.onclick = toggleMic;
  function applyLang(lang) {
    langSel.value = lang;
    if ($('#bubble').classList.contains('idle')) showWelcome();
    if (!rec) return;
    rec.lang = LANGS[lang].rec;
    if (recRunning) rec.abort(); // 识别语言要重新 start 才生效，onend 里会自动重启
  }
  langSel.onchange = () => {
    store.set('lang', langSel.value);
    applyLang(langSel.value);
  };

  // ---------- 其他交互 ----------
  $('#commentForm').onsubmit = (e) => {
    e.preventDefault();
    submit($('#viewerName').value || '路人', $('#commentText').value);
    $('#commentText').value = '';
  };
  document.querySelectorAll('.quick button').forEach((b) => {
    b.onclick = () => submit($('#viewerName').value || '路人', b.dataset.q);
  });
  $('#testVoice').onclick = () => enqueueSpeech(LANGS[langSel.value].testLine);
  $('#stopBtn').onclick = stopAll;
  $('#clearBtn').onclick = () => {
    fetch('/api/clear', { method: 'POST' });
    showBubble(LANGS[langSel.value].clearedLine);
    welcomeLater();
  };

  // 戳一戳（像汤姆猫那样的即时反应，不走 API）
  $('#avatar').onclick = () => {
    avatarState.poke = performance.now();
    if (state.busy || state.speakingCount) return;
    const lines = state.pokeLines[langSel.value];
    const line = lines[Math.floor(Math.random() * lines.length)];
    showBubble(line);
    enqueueSpeech(line).then(welcomeLater);
  };

  // 快捷键：M 开关麦克风，Esc 停止（OBS 模式下没有面板时用）
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'm' || e.key === 'M') toggleMic();
    if (e.key === 'Escape') stopAll();
  });
})();
