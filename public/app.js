// 憨包直播间 POC 前端
// 流程：麦克风(Web Speech) / 评论 → /api/chat(流式) → 按句切分 → 浏览器 TTS → 嘴型动画
(() => {
  const $ = (s) => document.querySelector(s);
  const avatar = $('#avatar');
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
    speakingCount: 0, // 正在排队播报的句子数
    micOn: false,
    pokeLines: ['哎哟！']
  };

  // ---------- 服务状态 ----------
  fetch('/api/status').then((r) => r.json()).then((s) => {
    state.pokeLines = s.pokeLines || state.pokeLines;
    const el = $('#status');
    if (s.mock) {
      el.textContent = '⚠ 模拟模式：没有配置 DEEPSEEK_API_KEY，只会说预设台词';
      el.classList.add('warn');
    } else {
      el.textContent = `✅ 已连接 DeepSeek（${s.model}）`;
    }
  }).catch(() => { $('#status').textContent = '❌ 连不上服务器，确认 npm start 在运行'; });

  // ---------- 形象状态 & 动画 ----------
  function setMood(mood) {
    avatar.classList.remove('thinking', 'listening');
    if (mood) avatar.classList.add(mood);
  }

  const mouthEllipse = $('#mouthEllipse');
  const tongue = $('#tongue');
  const mouthOpen = $('#mouthOpen');
  const smile = $('#smile');
  let mouth = 0, mouthTarget = 0, lastFlap = 0;
  function animate(t) {
    const speaking = state.speakingCount > 0 && speechSynthesis.speaking;
    avatar.classList.toggle('speaking', speaking);
    if (speaking) {
      // 没有真实音量数据，用随机开合模拟说话（约 8 次/秒）
      if (t - lastFlap > 120) {
        mouthTarget = mouthTarget > 0.3 ? Math.random() * 0.25 : 0.45 + Math.random() * 0.55;
        lastFlap = t;
      }
    } else {
      mouthTarget = 0;
    }
    mouth += (mouthTarget - mouth) * 0.35;
    const open = mouth > 0.05;
    mouthOpen.setAttribute('opacity', open ? 1 : 0);
    smile.setAttribute('opacity', open ? 0 : 1);
    mouthEllipse.setAttribute('ry', (3 + mouth * 13).toFixed(1));
    mouthEllipse.setAttribute('rx', (13 - mouth * 2).toFixed(1));
    tongue.setAttribute('cy', (206 + mouth * 7).toFixed(1));
    tongue.setAttribute('opacity', mouth > 0.4 ? 1 : 0);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  (function blinkLoop() {
    avatar.classList.add('blink');
    setTimeout(() => avatar.classList.remove('blink'), 120);
    setTimeout(blinkLoop, 2000 + Math.random() * 3500);
  })();

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

  // ---------- 语音合成 ----------
  const voiceSel = $('#voiceSel');
  const pitch = $('#pitch');
  const rate = $('#rate');
  pitch.value = store.get('pitch', pitch.value);
  rate.value = store.get('rate', rate.value);
  const showVals = () => { $('#pitchV').textContent = pitch.value; $('#rateV').textContent = rate.value; };
  showVals();
  pitch.oninput = () => { store.set('pitch', pitch.value); showVals(); };
  rate.oninput = () => { store.set('rate', rate.value); showVals(); };

  let voices = [];
  function loadVoices() {
    const all = speechSynthesis.getVoices();
    voices = all.filter((v) => /^(zh|cmn)/i.test(v.lang));
    if (!voices.length) voices = all;
    const saved = store.get('voice', '');
    voiceSel.innerHTML = '';
    voices.forEach((v, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = `${v.name} (${v.lang})`;
      voiceSel.append(o);
    });
    // 优先：上次选的 > 微软晓晓/晓伊（Edge 自然音色）> 任意大陆普通话
    let idx = voices.findIndex((v) => v.name === saved);
    if (idx < 0) idx = voices.findIndex((v) => /Xiaoyi|Xiaoxiao/i.test(v.name));
    if (idx < 0) idx = voices.findIndex((v) => /zh-CN|cmn/i.test(v.lang));
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

  let speechChain = Promise.resolve();
  function speak(text) {
    return new Promise((resolve) => {
      const t = cleanForSpeech(text);
      if (!t) return resolve();
      const u = new SpeechSynthesisUtterance(t);
      const v = voices[voiceSel.value];
      if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'zh-CN'; }
      u.pitch = Number(pitch.value);
      u.rate = Number(rate.value);
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }
  function enqueueSpeech(text) {
    state.speakingCount++;
    updateMic();
    speechChain = speechChain.then(() => speak(text)).finally(() => {
      state.speakingCount--;
      updateMic();
    });
    return speechChain;
  }
  function stopAll() {
    state.queue.length = 0;
    speechSynthesis.cancel();
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
      console.error(err);
      showBubble('哎呀，俺脑子卡住了……');
    } finally {
      state.busy = false;
      setMood(null);
      hideBubbleLater();
      updateMic();
      pump();
    }
  }

  async function respond({ name, text }) {
    state.history.push({ role: 'user', content: `${name}：${text}` });
    if (state.history.length > 20) state.history.splice(0, state.history.length - 20);
    setMood('thinking');
    showBubble('……', name);

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
      // 一句话一结束就开始念，降低延迟
      let m;
      while ((m = pending.match(/^[\s\S]*?[。！？!?…～~\n]+/))) {
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
  let rec = null, recRunning = false;

  if (!SR) {
    micBtn.disabled = true;
    micBtn.textContent = '此浏览器不支持语音识别';
    $('#micHint').textContent = '请用电脑版 Chrome 或 Edge 打开。也可以先用下面的文字评论测试。';
  } else {
    rec = new SR();
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
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

  // ---------- 其他交互 ----------
  $('#commentForm').onsubmit = (e) => {
    e.preventDefault();
    submit($('#viewerName').value || '路人', $('#commentText').value);
    $('#commentText').value = '';
  };
  document.querySelectorAll('.quick button').forEach((b) => {
    b.onclick = () => submit($('#viewerName').value || '路人', b.dataset.q);
  });
  $('#testVoice').onclick = () => enqueueSpeech('嘿嘿，俺是憨包，你听俺的声音可爱不？');
  $('#stopBtn').onclick = stopAll;
  $('#clearBtn').onclick = () => { state.history.length = 0; showBubble('嗯？俺刚才说到哪儿了？'); hideBubbleLater(); };

  // 戳一戳（像汤姆猫那样的即时反应，不走 API）
  $('#avatarWrap').onclick = () => {
    avatar.classList.remove('poked');
    void avatar.getBBox();
    avatar.classList.add('poked');
    setTimeout(() => avatar.classList.remove('poked'), 500);
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
