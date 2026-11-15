// 3D 形象：南瓜小包子「憨包」，全部用代码建模（不需要外部模型文件）
// app.js 通过 window.avatarState 驱动：{ mouth: 0~1, speaking, mood: null|'thinking'|'listening', poke: 时间戳 }
import * as THREE from 'three';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';

const state = (window.avatarState ||= { mouth: 0, speaking: false, mood: null, poke: 0 });
const container = document.getElementById('avatar3d');

// ---------- 渲染器 / 场景 / 相机 ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.append(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;

const camera = new THREE.PerspectiveCamera(24, 9 / 16, 0.1, 100);
camera.position.set(0, 2.8, 14);
camera.lookAt(0, 1.7, 0);

// 暖色灯光：主光 + 天光 + 背后轮廓光
scene.add(new THREE.HemisphereLight(0xfff0d8, 0x8a5530, 0.9));
const key = new THREE.DirectionalLight(0xffe2b8, 2.6);
key.position.set(-3, 6, 5);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.left = -3; key.shadow.camera.right = 3;
key.shadow.camera.top = 4; key.shadow.camera.bottom = -2;
key.shadow.radius = 6;
key.shadow.bias = -0.0005;
scene.add(key);
const rim = new THREE.DirectionalLight(0xffa040, 2.2);
rim.position.set(3, 4, -4);
scene.add(rim);
const fill = new THREE.PointLight(0xffd0a0, 6, 12);
fill.position.set(2.5, 1.5, 4);
scene.add(fill);

// 地面只接收阴影，透出后面 CSS 画的柜台
const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.ShadowMaterial({ opacity: 0.32 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ---------- 材质 ----------
const mat = {
  bun: new THREE.MeshPhysicalMaterial({ color: 0xffa914, roughness: 0.55, sheen: 0.35, sheenRoughness: 0.6, sheenColor: 0xffd27a, clearcoat: 0.15 }),
  bunDark: new THREE.MeshPhysicalMaterial({ color: 0xe8870c, roughness: 0.6, sheen: 0.3, sheenColor: 0xffe0a0 }),
  white: new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05 }),
  iris: new THREE.MeshPhysicalMaterial({ color: 0x2f6fb8, roughness: 0.2, clearcoat: 1 }),
  pupil: new THREE.MeshPhysicalMaterial({ color: 0x0c0a0a, roughness: 0.1, clearcoat: 1 }),
  glint: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  cheek: new THREE.MeshStandardMaterial({ color: 0xff7f6e, roughness: 0.8, transparent: true, opacity: 0.55, depthWrite: false }),
  mouth: new THREE.MeshStandardMaterial({ color: 0x5a1712, roughness: 0.7 }),
  tongue: new THREE.MeshStandardMaterial({ color: 0xff7a7a, roughness: 0.6 }),
  line: new THREE.MeshStandardMaterial({ color: 0x5b2a10, roughness: 0.6 }),
  hat: new THREE.MeshPhysicalMaterial({ color: 0xfffaf0, roughness: 0.85, sheen: 1, sheenColor: 0xffffff }),
  scarf: new THREE.MeshPhysicalMaterial({ color: 0xd8342a, roughness: 0.7, sheen: 0.6, sheenColor: 0xff9a80 }),
  wood: new THREE.MeshStandardMaterial({ color: 0xb07a45, roughness: 0.7 }),
  woodDark: new THREE.MeshStandardMaterial({ color: 0x7a4a24, roughness: 0.8 }),
  bowl: new THREE.MeshPhysicalMaterial({ color: 0xfdfbf5, roughness: 0.2, clearcoat: 1 }),
  bowlBlue: new THREE.MeshStandardMaterial({ color: 0x2b55a0, roughness: 0.3 }),
  soup: new THREE.MeshPhysicalMaterial({ color: 0xd9822b, roughness: 0.15, clearcoat: 1 })
};

// ---------- 身体（旋转体 + 顶部扭转褶子） ----------
const profile = new THREE.SplineCurve([
  [0.0, 0.0], [0.75, 0.02], [1.0, 0.14], [1.1, 0.34], [1.1, 0.56], [1.03, 0.82],
  [0.9, 1.06], [0.7, 1.28], [0.46, 1.45], [0.22, 1.56], [0.0, 1.6]
].map(([x, y]) => new THREE.Vector2(x, y)));
const profilePts = profile.getPoints(80);
const radiusAt = (y) => {
  for (let i = 1; i < profilePts.length; i++) {
    const a = profilePts[i - 1], b = profilePts[i];
    if ((y >= a.y && y <= b.y) || (y <= a.y && y >= b.y)) {
      const k = (y - a.y) / (b.y - a.y || 1);
      return a.x + (b.x - a.x) * k;
    }
  }
  return 0;
};
const bodyGeo = new THREE.LatheGeometry(profilePts, 128);
{
  const p = bodyGeo.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const ang = Math.atan2(v.z, v.x);
    const t = THREE.MathUtils.smoothstep(v.y, 0.85, 1.5);
    const s = 1 + t * 0.06 * Math.sin(14 * ang + v.y * 7);
    p.setXYZ(i, v.x * s, v.y, v.z * s);
  }
  bodyGeo.computeVertexNormals();
}

const root = new THREE.Group();      // 整体（位置/朝向）
const squash = new THREE.Group();    // 呼吸/挤压，从底部缩放
root.add(squash);
scene.add(root);

const body = new THREE.Mesh(bodyGeo, mat.bun);
body.castShadow = true;
squash.add(body);
const knot = new THREE.Mesh(new THREE.SphereGeometry(0.11, 24, 16), mat.bunDark);
knot.position.y = 1.6;
squash.add(knot);

// 把一个部件贴到身体表面：y 高度，theta 0 = 正前方
function onSurface(obj, y, theta, out = 0) {
  const r = radiusAt(y) + out;
  obj.position.set(Math.sin(theta) * r, y, Math.cos(theta) * r);
  const n = new THREE.Vector3(Math.sin(theta), 0.25 * (y - 0.6), Math.cos(theta)).normalize();
  obj.lookAt(obj.position.clone().add(n));
  squash.add(obj);
  return obj;
}

// ---------- 眼睛 ----------
const eyes = [];
for (const side of [-1, 1]) {
  const eye = new THREE.Group();
  const white = new THREE.Mesh(new THREE.SphereGeometry(0.2, 32, 24), mat.white);
  white.scale.set(0.95, 1.12, 0.55);
  eye.add(white);
  const look = new THREE.Group();        // 眼珠整体，可以转动
  look.position.z = 0.07;
  const iris = new THREE.Mesh(new THREE.SphereGeometry(0.13, 32, 24), mat.iris);
  iris.scale.set(1, 1.08, 0.45);
  const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.085, 24, 16), mat.pupil);
  pupil.scale.set(1, 1.08, 0.45);
  pupil.position.z = 0.02;
  const g1 = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), mat.glint);
  g1.position.set(0.04, 0.05, 0.06);
  const g2 = new THREE.Mesh(new THREE.SphereGeometry(0.016, 12, 8), mat.glint);
  g2.position.set(-0.04, -0.045, 0.06);
  look.add(iris, pupil, g1, g2);
  eye.add(look);
  onSurface(eye, 0.86, side * 0.36, -0.03);
  eyes.push({ eye, look });
}

// 眉毛（细小的弧，憨憨的八字眉）
const brows = [];
for (const side of [-1, 1]) {
  const brow = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.018, 8, 20, Math.PI * 0.7), mat.line);
  const g = new THREE.Group();
  brow.rotation.z = Math.PI * 0.15;
  g.add(brow);
  onSurface(g, 1.1, side * 0.36, -0.005);
  g.rotateZ(side * -0.25);
  brows.push(g);
}

// 腮红
for (const side of [-1, 1]) {
  const c = new THREE.Mesh(new THREE.SphereGeometry(0.15, 24, 16), mat.cheek);
  c.scale.set(1, 0.6, 0.25);
  onSurface(c, 0.64, side * 0.6, 0.0);
}

// ---------- 嘴巴 ----------
const mouthG = new THREE.Group();
onSurface(mouthG, 0.6, 0, -0.01);
const smile = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.02, 10, 24, Math.PI), mat.line);
smile.rotation.z = Math.PI;              // 弧朝下 = 微笑
smile.position.y = 0.06;
mouthG.add(smile);
const mouthOpen = new THREE.Group();
const mouthHole = new THREE.Mesh(new THREE.SphereGeometry(0.15, 32, 16), mat.mouth);
const tongue = new THREE.Mesh(new THREE.SphereGeometry(0.09, 24, 16), mat.tongue);
tongue.scale.set(1, 0.5, 0.6);
mouthOpen.add(mouthHole, tongue);
mouthG.add(mouthOpen);

// ---------- 小手 ----------
const arms = [];
for (const side of [-1, 1]) {
  const pivot = new THREE.Group();
  pivot.position.set(side * 0.98, 0.5, 0.15);
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.22, 24, 16), mat.bun);
  hand.scale.set(1, 0.78, 0.85);
  hand.position.set(side * 0.16, -0.04, 0);
  hand.castShadow = true;
  pivot.add(hand);
  squash.add(pivot);
  arms.push({ pivot, side });
}

// ---------- 厨师帽 + 小红围巾 ----------
const hat = new THREE.Group();
const band = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.4, 0.26, 40), mat.hat);
hat.add(band);
for (const [x, y, z, r] of [[0, 0.3, 0, 0.3], [-0.2, 0.24, 0.08, 0.22], [0.2, 0.24, 0.08, 0.22], [0, 0.24, -0.18, 0.22], [0, 0.26, 0.18, 0.2]]) {
  const puff = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), mat.hat);
  puff.position.set(x, y, z);
  puff.castShadow = true;
  hat.add(puff);
}
hat.position.set(0.12, 1.58, -0.05);
hat.rotation.z = -0.22;
squash.add(hat);

const scarf = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.07, 16, 96), mat.scarf);
scarf.rotation.x = Math.PI / 2;
scarf.position.y = 0.2;
scarf.scale.set(1.0, 1.0, 1);
squash.add(scarf);
const knotScarf = new THREE.Mesh(new THREE.SphereGeometry(0.12, 20, 16), mat.scarf);
knotScarf.scale.set(1.2, 0.9, 0.7);
onSurface(knotScarf, 0.22, 0.75, 0.08);

// ---------- 桌上道具：蒸笼 & 面碗 ----------
const steamer = new THREE.Group();
for (let i = 0; i < 2; i++) {
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.32, 48, 1, true), mat.wood);
  ring.position.y = 0.16 + i * 0.34;
  ring.material.side = THREE.DoubleSide;
  const rim2 = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.03, 8, 48), mat.woodDark);
  rim2.rotation.x = Math.PI / 2;
  rim2.position.y = 0.32 + i * 0.34;
  steamer.add(ring, rim2);
}
const lid = new THREE.Mesh(new THREE.SphereGeometry(0.76, 48, 12, 0, Math.PI * 2, 0, Math.PI / 5), mat.wood);
lid.scale.y = 0.6;
lid.position.y = 0.4;
steamer.add(lid);
steamer.traverse((o) => { o.castShadow = true; });
steamer.position.set(-1.55, 0, -2.0);
steamer.scale.setScalar(0.85);
scene.add(steamer);

const bowl = new THREE.Group();
const bowlGeo = new THREE.LatheGeometry(
  new THREE.SplineCurve([[0.25, 0], [0.32, 0.02], [0.55, 0.18], [0.66, 0.38], [0.64, 0.4]].map(([x, y]) => new THREE.Vector2(x, y))).getPoints(20), 48);
const bowlMesh = new THREE.Mesh(bowlGeo, mat.bowl);
bowlMesh.material.side = THREE.DoubleSide;
const bowlRim = new THREE.Mesh(new THREE.TorusGeometry(0.65, 0.025, 8, 48), mat.bowlBlue);
bowlRim.rotation.x = Math.PI / 2;
bowlRim.position.y = 0.4;
const soup = new THREE.Mesh(new THREE.CircleGeometry(0.6, 40), mat.soup);
soup.rotation.x = -Math.PI / 2;
soup.position.y = 0.33;
bowl.add(bowlMesh, bowlRim, soup);
bowl.traverse((o) => { o.castShadow = true; });
bowl.position.set(1.45, 0, 1.1);
bowl.scale.setScalar(0.75);
scene.add(bowl);

// ---------- 动画 ----------
let blinkUntil = 0, nextBlink = 1500;
let lookX = 0, lookY = 0, lookTX = 0, lookTY = 0, nextLook = 0;
let mouthSm = 0, tilt = 0, bob = 0;
const pointer = { x: 0, y: 0, t: -1e9 };
container.addEventListener('pointermove', (e) => {
  const r = container.getBoundingClientRect();
  pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = ((e.clientY - r.top) / r.height) * 2 - 1;
  pointer.t = performance.now();
});

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  const now = performance.now();

  // 呼吸 / 说话时上下颠
  const speaking = state.speaking;
  bob += ((speaking ? Math.abs(Math.sin(t * 8)) * 0.06 : 0) - bob) * 0.3;
  const breathe = Math.sin(t * 2.2) * 0.015;
  let sx = 1 + breathe, sy = 1 - breathe;

  // 戳一戳：弹簧式挤压
  const since = (now - (state.poke || -1e9)) / 1000;
  if (since < 0.8) {
    const k = Math.exp(-since * 6) * Math.cos(since * 22);
    sy -= 0.2 * k;
    sx += 0.14 * k;
  }
  squash.scale.set(sx, sy, sx);
  root.position.y = bob;

  // 姿态
  let tiltT = Math.sin(t * 0.7) * 0.03;
  let turnT = Math.sin(t * 0.45) * 0.12;
  if (state.mood === 'thinking') { tiltT = 0.12; turnT = -0.15; }
  if (state.mood === 'listening') { tiltT = -0.1 + Math.sin(t * 2) * 0.02; }
  if (speaking) tiltT += Math.sin(t * 3.1) * 0.05;
  tilt += (tiltT - tilt) * 0.08;
  root.rotation.z = tilt;
  root.rotation.y += (turnT - root.rotation.y) * 0.05;

  // 眼睛：眨眼 + 四处看 / 跟鼠标
  if (now > nextBlink) { blinkUntil = now + 130; nextBlink = now + 1800 + Math.random() * 3500; }
  const blink = now < blinkUntil ? 0.08 : 1;
  if (now > nextLook) {
    lookTX = (Math.random() - 0.5) * 0.06;
    lookTY = (Math.random() - 0.5) * 0.04;
    nextLook = now + 800 + Math.random() * 2200;
  }
  let tx = lookTX, ty = lookTY;
  if (now - pointer.t < 2500) { tx = pointer.x * 0.06; ty = -pointer.y * 0.05; }
  if (state.mood === 'thinking') { tx = -0.04; ty = 0.06; }
  lookX += (tx - lookX) * 0.15;
  lookY += (ty - lookY) * 0.15;
  for (const { eye, look } of eyes) {
    eye.scale.y += (blink - eye.scale.y) * 0.6;
    look.position.x = lookX;
    look.position.y = lookY;
  }
  const browLift = state.mood === 'thinking' ? 0.04 : speaking ? Math.abs(Math.sin(t * 4)) * 0.02 : 0;
  brows.forEach((b) => { b.children[0].position.y += (browLift - b.children[0].position.y) * 0.2; });

  // 嘴巴
  mouthSm += ((state.mouth || 0) - mouthSm) * 0.4;
  const open = mouthSm > 0.05;
  smile.visible = !open;
  mouthOpen.visible = open;
  mouthHole.scale.set(1 - mouthSm * 0.15, 0.15 + mouthSm * 1.0, 0.35);
  tongue.position.set(0, -0.05 - mouthSm * 0.03, 0.02);
  tongue.visible = mouthSm > 0.35;

  // 手
  for (const { pivot, side } of arms) {
    const wave = speaking ? Math.sin(t * 7 + (side > 0 ? 1.5 : 0)) * 0.35 : Math.sin(t * 1.5 + side) * 0.05;
    pivot.rotation.z = side * (0.1 + wave);
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function resize() {
  const w = container.clientWidth, h = container.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(container);
resize();
frame();
window.avatarReady = true;
document.getElementById('loading')?.remove();
