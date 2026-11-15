// 虚拟主播 POC 前端
// 流程：麦克风(Web Speech) / 评论 → /api/chat(流式) → 按句切分 → TTS（ElevenLabs 或浏览器）→ 3D 嘴型
(() => {
  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  if (params.has('obs')) document.body.classList.add('obs');

  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 无痕模式等 */ } }
  };

  const state = {
    history: [],      // 发给模型的对话记忆
    queue: [],        // 待回复的消息
    busy: false,      // 正在请求/回复
    speakingCount: 0, // 排队中/正在播报的句子数
    micOn: false,
    pokeLines: ['Hey!'],
    eleven: false
  };

  // 3D 形象在 avatar3d.js 里读取这个对象
  const avatarState = (window.avatarState ||= { mouth: 0, speaking: false, mood: null, poke: 0 });
  const setMood = (mood) => { avatarState.mood = mood; };

  // ---------- 服务状态 ----------
  fetch('/api/status').then((r) => r.json()).then((s) => {
    state.pokeLines = s.pokeLines || state.pokeLines;
    state.eleven = s.eleven;
    if (s.title) $('#stageTitle').textContent = s.title;
    if (s.name) { $('#hostTitle').textContent = s.name; document.title = `${s.name} Live`; }
    const el = $('#status');
    el.textContent = s.mock
      ? '⚠ 模拟模式：没有配置 DEEPSEEK_API_KEY，只会说预设台词'
      : `✅ 已连接 DeepSeek（${s.model}）`;
    el.classList.toggle('warn', s.mock);
    setupEleven(s);
  }).catch(() => { $('#status').textContent = '❌ 连不上服务器，确认 node server.js 在运行'; });

  // ---------- 字幕 & 评论区 ----------
  let bubbleTimer;
  function showBubble(text, to) {
    clearTimeout(bubbleTimer);
    $('#bubbleTo').textContent = to ? '@' + to : '';
    $('#bubbleText').textContent = text;
    $('#bubble').classList.remove('hidden');
  }
  function hideBubbleLater() {
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => $('#bubble').classList.add('hidden'), 6000);
  }
  function addComment(name, text) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = name;
    li.append(b, document.createTextNode(text));
    const list = $('#comments');
    list.append(li);
    while (list.children.length > 6) list.firstChild.remove();
  }

  // ---------- 声音设置 ----------
  const ttsEngine = $('#ttsEngine');
  const elevenVoice = $('#elevenVoice');
  const voiceSel = $('#voiceSel');
  const pitch = $('#pitch');
  const rate = $('#rate');
  pitch.value = store.get('pitch', pitch.value);
  rate.value = store.get('rate', rate.value);
  const showVals = () => { $('#pitchV').textContent = pitch.value; $('#rateV').textContent = rate.value; };
  showVals();
  pitch.oninput = () => { store.set('pitch', pitch.value); showVals(); };
  rate.oninput = () => { store.set('rate', rate.value); showVals(); };

  function renderEngine() {
    const eleven = ttsEngine.value === 'eleven';
    $('#elevenBox').hidden = !eleven;
    $('#browserBox').hidden = eleven;
  }
  ttsEngine.onchange = () => { store.set('tts', ttsEngine.value); renderEngine(); };

  async function setupEleven(s) {
    const opt = ttsEngine.querySelector('option[value=eleven]');
    if (!s.eleven) {
      opt.disabled = true;
      opt.textContent = 'ElevenLabs（未配置 Key）';
      ttsEngine.value = 'browser';
      renderEngine();
      return;
    }
    ttsEngine.value = store.get('tts', 'eleven');
    renderEngine();
    $('#elevenHint').textContent = '正在读取音色列表…';
    try {
      const voices = await (await fetch('/api/voices')).json();
      elevenVoice.innerHTML = '';
      for (const v of voices) {
        const o = document.createElement('option');
        o.value = v.id;
        o.textContent = v.desc ? `${v.name}（${v.desc}）` : v.name;
        elevenVoice.append(o);
      }
      const saved = store.get('elevenVoice', '') || s.elevenVoice;
      if (saved && voices.some((v) => v.id === saved)) elevenVoice.value = saved;
      $('#elevenHint').textContent = voices.length
        ? '想要更可爱的声音：去 ElevenLabs 的 Voice Library 搜 "cute" / "cartoon"，加到 My Voices 后刷新这个页面。'
        : '没读到音色，检查一下 ELEVENLABS_API_KEY。';
    } catch {
      $('#elevenHint').textContent = '读取音色列表失败，看一下 PowerShell 窗口里的报错。';
    }
  }
  elevenVoice.onchange = () => store.set('elevenVoice', elevenVoice.value);

  // 浏览器自带音色：只列英文，优先 Edge 的 Ana（小孩音）/ 其他 Natural 音色
  let voices = [];
  function loadVoices() {
    const all = speechSynthesis.getVoices();
    voices = all.filter((v) => /^en/i.test(v.lang));
    if (!voices.length) voices = all;
    voices.sort((a, b) => Number(/Natural/i.test(b.name)) - Number(/Natural/i.test(a.name)));
    const saved = store.get('voice', '');
    voiceSel.innerHTML = '';
    voices.forEach((v, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = `${v.name} (${v.lang})`;
      voiceSel.append(o);
    });
    let idx = voices.findIndex((v) => v.name === saved);
    if (idx < 0) idx = voices.findIndex((v) => /Ana.*Natural/i.test(v.name));
    if (idx < 0) idx = voices.findIndex((v) => /Natural/i.test(v.name) && /en-US/i.test(v.lang));
    if (idx < 0) idx = voices.findIndex((v) => /en-US/i.test(v.lang));
    voiceSel.value = String(Math.max(0, idx));
  }
  speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();
  voiceSel.onchange = () => store.set('voice', voices[voiceSel.value]?.name || '');

  const cleanForSpeech = (s) => s
    .replace(/[*#_`>~\[\]]/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')  // 去掉括号里的动作描写
    .replace(/\p{Extended_Pictographic}/gu, '')
    .trim();

  // ---------- 播放：ElevenLabs（真实音量驱动嘴型）----------
  let audioCtx = null, analyser = null, levelBuf = null, currentSrc = null;
  function ensureAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.connect(audioCtx.destination);
      levelBuf = new Float32Array(analyser.fftSize);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }
  document.addEventListener('pointerdown', ensureAudio, { once: true });
  document.addEventListener('keydown', ensureAudio, { once: true });

  async function fetchTTS(text) {
    const r = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voiceId: elevenVoice.value })
    });
    if (!r.ok) throw new Error('tts ' + r.status);
    return r.arrayBuffer();
  }
  async function playAudio(buf) {
    ensureAudio();
    const decoded = await audioCtx.decodeAudioData(buf);
    return new Promise((resolve) => {
      const src = audioCtx.createBufferSource();
      src.buffer = decoded;
      src.connect(analyser);
      src.onended = () => { if (currentSrc === src) currentSrc = null; resolve(); };
      currentSrc = src;
      src.start();
    });
  }

  // ---------- 播放：浏览器自带 ----------
  function speakBrowser(text) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = voices[voiceSel.value];
      if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'en-US'; }
      u.pitch = Number(pitch.value);
      u.rate = Number(rate.value);
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }

  // 句子排队播放；ElevenLabs 模式下会提前请求下一句的音频，减少停顿
  let speechChain = Promise.resolve();
  let generation = 0;
  function enqueueSpeech(text) {
    const t = cleanForSpeech(text);
    if (!t) return speechChain;
    const gen = generation;
    const audioP = ttsEngine.value === 'eleven' && state.eleven
      ? fetchTTS(t).catch((e) => { console.warn('ElevenLabs 失败，改用浏览器语音', e); return null; })
      : null;
    state.speakingCount++;
    updateMic();
    speechChain = speechChain.then(async () => {
      if (gen !== generation) return;
      const buf = audioP && await audioP;
      if (gen !== generation) return;
      if (buf) await playAudio(buf);
      else await speakBrowser(t);
    }).catch((e) => console.warn(e)).finally(() => {
      state.speakingCount--;
      updateMic();
    });
    return speechChain;
  }
  function stopAll() {
    generation++;
    state.queue.length = 0;
    speechSynthesis.cancel();
    try { currentSrc?.stop(); } catch { /* 已经停了 */ }
  }

  // ---------- 嘴型 ----------
  let mouthTarget = 0, lastFlap = 0;
  function animate(t) {
    if (currentSrc && analyser) {
      // 真实音量 → 嘴巴张开程度
      analyser.getFloatTimeDomainData(levelBuf);
      let sum = 0;
      for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
      const rms = Math.sqrt(sum / levelBuf.length);
      avatarState.speaking = true;
      avatarState.mouth = Math.min(1, Math.max(0, (rms - 0.015) * 9));
    } else if (state.speakingCount > 0 && speechSynthesis.speaking) {
      // 浏览器 TTS 拿不到音量，用随机开合模拟（约 8 次/秒）
      if (t - lastFlap > 120) {
        mouthTarget = mouthTarget > 0.3 ? Math.random() * 0.25 : 0.45 + Math.random() * 0.55;
        lastFlap = t;
      }
      avatarState.speaking = true;
      avatarState.mouth = mouthTarget;
    } else {
      avatarState.speaking = false;
      avatarState.mouth = 0;
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

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
      console.error(err);
      showBubble('Oh noodles, my brain got stuck...');
    } finally {
      state.busy = false;
      setMood(null);
      hideBubbleLater();
      updateMic();
      pump();
    }
  }

  async function respond({ name, text }) {
    state.history.push({ role: 'user', content: `${name}: ${text}` });
    if (state.history.length > 20) state.history.splice(0, state.history.length - 20);
    setMood('thinking');
    showBubble('…', name);

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: state.history.slice(-12) })
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
      // 一句话说完整就开始念，降低延迟（句号后要跟空格，避免切开 3.5；省略号 ... 不切）
      let m;
      while ((m = pending.match(/^[\s\S]*?(?:(?:(?<!\.)\.(?!\.)|[!?~]+)(?=\s)|[。！？\n]+)/))) {
        enqueueSpeech(m[0]);
        pending = pending.slice(m[0].length);
      }
    }
    if (pending.trim()) enqueueSpeech(pending);
    state.history.push({ role: 'assistant', content: full });
    await speechChain; // 说完再处理下一条
  }

  // ---------- 麦克风（Web Speech API，Chrome / Edge 可用） ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = $('#micBtn');
  const recLang = $('#recLang');
  recLang.value = store.get('recLang', 'en-US');
  let rec = null, recRunning = false;

  if (!SR) {
    micBtn.disabled = true;
    micBtn.textContent = '此浏览器不支持语音识别';
    $('#micHint').textContent = '请用电脑版 Chrome 或 Edge 打开。也可以先用下面的文字评论测试。';
  } else {
    rec = new SR();
    rec.lang = recLang.value;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) submit($('#hostName').value || 'Host', r[0].transcript);
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
  recLang.onchange = () => {
    store.set('recLang', recLang.value);
    if (rec) { rec.lang = recLang.value; if (recRunning) rec.abort(); }
  };

  // 只在「麦克风开着 且 没在想/说话」时收音，避免它听到自己的声音
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

  // ---------- 其他交互 ----------
  $('#commentForm').onsubmit = (e) => {
    e.preventDefault();
    submit($('#viewerName').value || 'viewer', $('#commentText').value);
    $('#commentText').value = '';
  };
  document.querySelectorAll('.quick button').forEach((b) => {
    b.onclick = () => submit($('#viewerName').value || 'viewer', b.dataset.q);
  });
  $('#testVoice').onclick = () => {
    const line = "Hehe~ hi, I'm Bao! Do you like my voice?";
    showBubble(line);
    enqueueSpeech(line).then(hideBubbleLater);
  };
  $('#stopBtn').onclick = stopAll;
  $('#clearBtn').onclick = () => {
    state.history.length = 0;
    showBubble('Huh? What were we talking about?');
    hideBubbleLater();
  };

  // 戳一戳（像汤姆猫那样的即时反应，不走 DeepSeek）
  $('#avatar3d').onclick = () => {
    avatarState.poke = performance.now();
    if (state.busy || state.speakingCount) return;
    const line = state.pokeLines[Math.floor(Math.random() * state.pokeLines.length)];
    showBubble(line);
    enqueueSpeech(line).then(hideBubbleLater);
  };

  // 快捷键：M 开关麦克风，Esc 停止（OBS 模式下没有面板时用）
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'm' || e.key === 'M') toggleMic();
    if (e.key === 'Escape') stopAll();
  });
})();
