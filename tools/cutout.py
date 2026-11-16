"""把一张「包子站在面馆里」的图拆成 4 层：背景（包子抹掉后补全）、身体、眼睛、嘴巴。
用法（需要 Pillow 和 numpy）：python tools/cutout.py tools/avatar-source.webp public/avatar 预览图目录
打印出的 box_pct / eyes_mid_y_pct / mouth_top_y_pct 要同步到 public/style.css 的 .avatar 规则里。
坐标都按原图 572x1024 手工标定，换图要重新标。"""
import json
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

src, out_dir, preview_dir = sys.argv[1:4]
img = np.asarray(Image.open(src).convert('RGB')).astype(np.float32) / 255
H, W, _ = img.shape


def shape_mask(draw_fn):
    m = Image.new('L', (W, H), 0)
    draw_fn(ImageDraw.Draw(m))
    return np.asarray(m) > 127


def editable(mask):
    # fromarray 返回的是只读图，floodfill 在只读图上会静默不生效，必须先 copy
    return Image.fromarray((mask * 255).astype(np.uint8)).copy()


def flood_keep(mask, seeds):
    """只保留和种子点连通的部分。"""
    im = editable(mask)
    for x, y in seeds:
        if mask[y, x]:
            ImageDraw.floodfill(im, (x, y), 128)
    return np.asarray(im) == 128


def fill_holes(mask):
    outside = editable(~mask)
    ImageDraw.floodfill(outside, (0, 0), 0)
    return mask | (np.asarray(outside) > 127)


def hsv(a):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    v = a.max(-1)
    c = v - a.min(-1)
    s = np.where(v > 0, c / np.maximum(v, 1e-6), 0)
    h = np.where(v == r, (g - b) / np.maximum(c, 1e-6) % 6,
                 np.where(v == g, (b - r) / np.maximum(c, 1e-6) + 2, (r - g) / np.maximum(c, 1e-6) + 4)) * 60
    return np.where(c > 0, h, 0), s, v


def feature(px, seeds, ring):
    # 高光、睫毛尖这类小块不一定和主体连着，主体附近 4px 内的同类像素也算进来；
    # 再往外带一圈皮肤（ring），眨眼/闭嘴压扁时接缝落在补过色的区域里，看不出来
    main = flood_keep(px, seeds)
    return grow(fill_holes(main | (grow(main, 4) & px)), ring)


def grow(mask, r):
    """r>0 膨胀，r<0 腐蚀（用最大/最小滤波）。"""
    m = Image.fromarray((mask * 255).astype(np.uint8))
    m = m.filter(ImageFilter.MaxFilter(2 * r + 1) if r > 0 else ImageFilter.MinFilter(-2 * r + 1))
    return np.asarray(m) > 127


def box_blur(a, r):
    if r <= 0:
        return a
    k = 2 * r + 1
    pad = [(r, r), (r, r)] + [(0, 0)] * (a.ndim - 2)
    p = np.pad(a, pad, mode='edge')
    c = p.cumsum(0)
    c = np.concatenate([c[k - 1:k], c[k:] - c[:-k]], 0)
    c = c.cumsum(1)
    c = np.concatenate([c[:, k - 1:k], c[:, k:] - c[:, :-k]], 1)
    return c / (k * k)


def pushpull(a, known):
    """金字塔式补洞：已知像素不动，未知像素用周围颜色平滑填上。"""
    h, w = known.shape
    if known.all() or min(h, w) <= 2:
        fill = a[known].mean(0) if known.any() else np.zeros(a.shape[-1])
        return np.where(known[..., None], a, fill)
    h2, w2 = (h + 1) // 2, (w + 1) // 2
    pad = ((0, h2 * 2 - h), (0, w2 * 2 - w))
    wgt = np.pad(known.astype(np.float32), pad)
    val = np.pad(a * known[..., None], pad + ((0, 0),))
    ws = wgt.reshape(h2, 2, w2, 2).sum((1, 3))
    vs = val.reshape(h2, 2, w2, 2, -1).sum((1, 3))
    small_known = ws > 0
    small = np.where(small_known[..., None], vs / np.maximum(ws, 1e-6)[..., None], 0)
    small = pushpull(small, small_known)
    up = box_blur(small.repeat(2, 0).repeat(2, 1)[:h, :w], 1)
    return np.where(known[..., None], a, up)


# ---------- 1. 手工轮廓（贴着包子描），再用局部颜色细化边缘 ----------
def rough(d):
    d.ellipse((154, 597, 430, 880), fill=255)                      # 身体
    d.polygon([(327, 566), (333, 559), (345, 555), (360, 557), (375, 563), (390, 573), (405, 583),
               (417, 591), (425, 599), (429, 609), (427, 619), (420, 626), (408, 631), (398, 640),
               (394, 650), (386, 655), (370, 650), (350, 640), (333, 628), (327, 615), (330, 603),
               (324, 590), (324, 576)], fill=255)                     # 帽子（背光那侧和背景颜色太像，只能照着描）
    d.polygon([(113, 760), (124, 744), (140, 740), (156, 750), (168, 770), (172, 797),
               (150, 804), (129, 797), (115, 781)], fill=255)         # 左手
    d.polygon([(426, 765), (439, 746), (455, 740), (469, 748), (474, 767), (466, 791),
               (448, 802), (428, 797)], fill=255)                    # 右手
    d.rounded_rectangle((226, 845, 280, 890), 16, fill=255)          # 左腿
    d.rounded_rectangle((305, 845, 360, 890), 16, fill=255)          # 右腿
    d.ellipse((280, 863, 305, 930), fill=0)                          # 两腿之间的缝


rough_mask = shape_mask(rough)
sure_fg = grow(rough_mask, -5)
sure_bg = ~grow(rough_mask, 5)
band = ~sure_fg & ~sure_bg

# 带状区域里逐点比较：离附近的「肯定是包子」颜色近，还是离「肯定是背景」颜色近
R, STRIDE = 22, 2
alpha = sure_fg.astype(np.float32)
ys, xs = np.nonzero(band)
for y, x in zip(ys, xs):
    y0, y1, x0, x1 = max(0, y - R), min(H, y + R + 1), max(0, x - R), min(W, x + R + 1)
    win = img[y0:y1:STRIDE, x0:x1:STRIDE].reshape(-1, 3)
    fg = sure_fg[y0:y1:STRIDE, x0:x1:STRIDE].reshape(-1)
    bg = sure_bg[y0:y1:STRIDE, x0:x1:STRIDE].reshape(-1)
    c = img[y, x]
    d_fg = np.sort(((win[fg] - c) ** 2).sum(1))[:4].mean() if fg.sum() >= 4 else 9
    d_bg = np.sort(((win[bg] - c) ** 2).sum(1))[:4].mean() if bg.sum() >= 4 else 9
    alpha[y, x] = 1.0 if d_fg < d_bg else 0.0

# 只留和身体连在一起的部分，去掉孤立的小点，再轻微羽化
solid = grow(grow(alpha > 0.5, -1), 1)
solid = fill_holes(flood_keep(solid, [(292, 740)]) | sure_fg)
alpha = box_blur(solid.astype(np.float32), 1)


# ---------- 2. 眼睛、嘴巴单独成层，身体上对应位置补成皮肤色 ----------
h_, s_, v_ = hsv(img)
in_box = lambda x0, y0, x1, y1: np.pad(np.ones((y1 - y0, x1 - x0), bool), ((y0, H - y1), (x0, W - x1)))
# 眼睛：深色（瞳孔、睫毛、眼线）或接近白色（眼白、高光）；皮肤和腮红都是亮且饱和的暖色
eye_px = in_box(200, 704, 380, 764) & ((v_ < 0.55) | ((s_ < 0.3) & (v_ > 0.6)) | (img[..., 2] > img[..., 0]))
# 嘴：暗红的嘴里和舌头，或者很暗的嘴线；腮红亮度高，不会被算进来
mouth_px = in_box(262, 750, 320, 790) & ((((h_ < 20) | (h_ > 340)) & (s_ > 0.55) & (v_ < 0.8)) | (v_ < 0.45))


eyes_m = feature(eye_px, [(240, 740), (342, 740)], 3)
mouth_m = feature(mouth_px, [(283, 766), (292, 774)], 2)
eyes_a = box_blur(eyes_m.astype(np.float32), 1)
mouth_a = box_blur(mouth_m.astype(np.float32), 1)

holes = grow(eyes_m | mouth_m, 3)
skin_known = ~holes & (alpha > 0.99)
body_rgb = pushpull(img.copy(), skin_known | ~grow(alpha > 0.01, 2))
body_rgb = np.where(holes[..., None], body_rgb, img)

# ---------- 3. 背景：整只包子抹掉补全 ----------
bg_rgb = pushpull(img.copy(), ~grow(alpha > 0.01, 4))


# ---------- 4. 输出 ----------
ys, xs = np.nonzero(alpha > 0.01)
M = 4
bx0, by0, bx1, by1 = max(0, xs.min() - M), max(0, ys.min() - M), min(W, xs.max() + 1 + M), min(H, ys.max() + 1 + M)


def layer(rgb, a):
    rgba = np.dstack([rgb, a])[by0:by1, bx0:bx1]
    return Image.fromarray((np.clip(rgba, 0, 1) * 255).astype(np.uint8))


body = layer(body_rgb, alpha)
eyes = layer(img, eyes_a * alpha)
mouth = layer(img, mouth_a * alpha)
bg = Image.fromarray((np.clip(bg_rgb, 0, 1) * 255).astype(np.uint8))

for name, im in [('body', body), ('eyes', eyes), ('mouth', mouth)]:
    im.save(f'{out_dir}/{name}.webp', quality=92, method=6)
bg.save(f'{out_dir}/bg.webp', quality=88, method=6)

ey = np.nonzero(eyes_m)[0]
my = np.nonzero(mouth_m)[0]
meta = {
    'box_pct': [round(bx0 / W * 100, 3), round(by0 / H * 100, 3), round((bx1 - bx0) / W * 100, 3), round((by1 - by0) / H * 100, 3)],
    'eyes_mid_y_pct': round(((ey.min() + ey.max()) / 2 - by0) / (by1 - by0) * 100, 2),
    'mouth_top_y_pct': round((my.min() - by0) / (by1 - by0) * 100, 2),
    'mouth_x_pct': round((290 - bx0) / (bx1 - bx0) * 100, 2),
    'bbox_px': [int(bx0), int(by0), int(bx1), int(by1)]
}
print(json.dumps(meta))

# 预览：棋盘格上的身体、去掉包子的背景、合成回去的对比
check = np.indices((by1 - by0, bx1 - bx0)).sum(0) // 8 % 2
check = np.dstack([0.55 + 0.25 * check] * 3)
def over(base, im):
    a = np.asarray(im).astype(np.float32) / 255
    return base * (1 - a[..., 3:]) + a[..., :3] * a[..., 3:]
prev = over(check, body)
prev = over(prev, eyes)
prev = over(prev, mouth)
Image.fromarray((prev * 255).astype(np.uint8)).resize(((bx1 - bx0) * 2, (by1 - by0) * 2), Image.LANCZOS).save(f'{preview_dir}/p_layers_on_checker.png')
magenta = np.dstack([np.ones_like(alpha), np.zeros_like(alpha), np.ones_like(alpha)])[by0:by1, bx0:bx1]
Image.fromarray((over(magenta, body) * 255).astype(np.uint8)).resize(((bx1 - bx0) * 2, (by1 - by0) * 2), Image.LANCZOS).save(f'{preview_dir}/p_body_on_magenta.png')
bg.crop((60, 500, 520, 940)).save(f'{preview_dir}/p_bg_hole.png')
body_noface = over(check, body)
Image.fromarray((body_noface * 255).astype(np.uint8)).crop((40, 80, 260, 220)).resize((660, 420), Image.LANCZOS).save(f'{preview_dir}/p_face_filled.png')
