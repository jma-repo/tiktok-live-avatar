// 2D 形象：一张图拆成背景、身体、眼睛、嘴巴四层（public/avatar/），这里只负责让它动起来
// app.js 通过 window.avatarState 驱动：{ mouth: 0~1, speaking, mood: null|'thinking'|'listening', poke: 时间戳 }
(() => {
  const state = (window.avatarState ||= { mouth: 0, speaking: false, mood: null, poke: 0 });
  const root = document.getElementById('avatar');
  const eyes = root.querySelector('.eyes');
  const mouth = root.querySelector('.mouth');

  let mouthSm = 0, open = 1, tilt = 0, bounce = 0, nextBlink = 1500, blinkUntil = 0;

  function frame(now) {
    const t = now / 1000;
    const speaking = state.speaking;
    mouthSm += ((state.mouth || 0) - mouthSm) * 0.4;

    // 身体：平时慢慢呼吸，说话时跟着音量往上颠；脚底是锚点，所以不会离开桌面
    bounce += ((speaking ? mouthSm * 0.045 : 0) - bounce) * 0.3;
    const breathe = Math.sin(t * 2.2) * 0.012;
    let sx = 1 + breathe, sy = 1 - breathe + bounce;
    const since = (now - (state.poke || -1e9)) / 1000;
    if (since < 0.8) { // 戳一戳：弹簧式压扁再弹回
      const k = Math.exp(-since * 6) * Math.cos(since * 22);
      sy -= 0.2 * k;
      sx += 0.14 * k;
    }
    let tiltT = Math.sin(t * 0.7) * 1.2;
    if (state.mood === 'thinking') tiltT = 6;
    if (state.mood === 'listening') tiltT = -4 + Math.sin(t * 2);
    if (speaking) tiltT += Math.sin(t * 3.1) * 2.5;
    tilt += (tiltT - tilt) * 0.08;
    root.style.transform = `rotate(${tilt.toFixed(2)}deg) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;

    // 嘴：不说话时就是原图的笑嘴；说话时按音量从一条线张到比原图更大
    open += ((speaking ? 0.15 + mouthSm * 1.15 : 1) - open) * 0.35;
    mouth.style.transform = `scaleY(${open.toFixed(3)})`;

    if (now > nextBlink) {
      blinkUntil = now + 130;
      nextBlink = now + 1800 + Math.random() * 3500;
    }
    eyes.style.transform = `scaleY(${now < blinkUntil ? 0.1 : 1})`;

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
