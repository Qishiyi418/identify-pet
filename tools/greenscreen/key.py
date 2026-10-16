"""Key a green-screen clip and align it to the idle pose.

usage: python tools/greenscreen/key.py <video | frames_dir | image> <out_dir>

Writes 640x360 RGBA PNG frames (0001.png, ...) to out_dir and <out_dir>-stats.json.
The character is scaled and placed with one fixed transform for the whole clip,
taken from its first frame: standing height 252, feet centred at x 319.5 on row 320,
the same placement as every idle-matched animation in the project.
Only the largest figure is kept, so floating generator watermarks are dropped.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import cv2

CANVAS_W, CANVAS_H = 640, 360
TARGET_H, TARGET_BOTTOM, TARGET_FOOTX = 252, 320, 319.5
CHOKE = 0.2
LO, HI = 15.0, 190.0          # greenness G-max(R,B): <=LO fully opaque, >=HI fully transparent


def key(rgb):
    c = rgb.astype(np.float32)
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    green = g - np.maximum(r, b)
    # Estimate the backdrop from clearly-green pixels so lighting drift is followed.
    bgmask = green > HI
    bg = np.median(c[bgmask], axis=0) if bgmask.sum() > 1000 else np.array([0, 215, 0], np.float32)
    a = np.clip((HI - green) / (HI - LO), 0, 1)
    a[a < 0.02] = 0
    a[:2], a[-2:], a[:, :2], a[:, -2:] = 0, 0, 0, 0   # encoder edge artefacts
    a[a > 0.98] = 1
    # Keep only the character: the largest blob plus anything touching its neighbourhood.
    # This drops the floating generator watermark and stray specks.
    n, labels, st, _ = cv2.connectedComponentsWithStats((a > 0.1).astype(np.uint8), connectivity=8)
    if n > 1:
        main = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
        x, y, w, h = st[main, :4]
        pad = 24
        keep = np.zeros(n, bool)
        for i in range(1, n):
            xi, yi, wi, hi_ = st[i, :4]
            near = xi < x + w + pad and xi + wi > x - pad and yi < y + h + pad and yi + hi_ > y - pad
            # faint compression noise (e.g. along the frame border) never reaches solid alpha
            keep[i] = near and st[i, cv2.CC_STAT_AREA] >= 4 and a[labels == i].max() >= 0.6
        region = keep[labels]
        # include faint fringe pixels next to kept blobs
        region = cv2.dilate(region.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
        a = np.where(region, a, 0)
    # Recover foreground colour of mixed edge pixels: C = aF + (1-a)Bg.
    safe = np.maximum(a, 1e-3)[..., None]
    fg = np.clip((c - (1 - a)[..., None] * bg) / safe, 0, 255)
    # Despill: no part of the character is green, so cap G near max(R, B) where it leans green.
    m = np.maximum(fg[..., 0], fg[..., 2])
    fg[..., 1] = np.where(fg[..., 1] > m + 4, m + 4, fg[..., 1])
    # Along the silhouette the line art mixed with the backdrop reads olive; the
    # average despill (G <= (R+B)/2) turns it back to the drawn brown outline.
    # Interior colours are left alone so yellow hair highlights survive.
    band = cv2.dilate((a < 0.98).astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool)
    avg = (fg[..., 0] + fg[..., 2]) / 2
    fg[..., 1] = np.where(band, np.minimum(fg[..., 1], avg), fg[..., 1])
    # Choke the soft edge slightly: its outer ring carries the most backdrop colour.
    a = np.clip((a - CHOKE) / (1 - CHOKE), 0, 1)
    a = np.minimum(a, cv2.erode(a, np.ones((3, 3), np.uint8)) + 0.35)
    fg[a == 0] = 0
    return fg, a


def silhouette(a, thr=32 / 255):
    ys, xs = np.where(a > thr)
    bottom = ys.max()
    foot = xs[ys >= bottom - 30]
    return dict(left=int(xs.min()), right=int(xs.max()), top=int(ys.min()), bottom=int(bottom),
                footx=float((foot.min() + foot.max()) / 2))


def place(fg, a, ref):
    scale = TARGET_H / (ref['bottom'] - ref['top'] + 1)
    # Premultiply before resampling so edges do not pick up dark/green fringes.
    pm = np.dstack([fg * a[..., None], a * 255]).astype(np.float32)
    small = cv2.resize(pm, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    tx = TARGET_FOOTX - (ref['footx'] + 0.5) * scale + 0.5
    ty = TARGET_BOTTOM + 1 - (ref['bottom'] + 1) * scale
    canvas = cv2.warpAffine(small, np.float32([[1, 0, tx], [0, 1, ty]]), (CANVAS_W, CANVAS_H),
                            flags=cv2.INTER_LINEAR, borderValue=0)
    alpha = np.clip(canvas[..., 3], 0, 255)
    rgbp = canvas[..., :3]
    # Bleed edge colour into transparent pixels so 4:2:0 chroma does not pull in black at edges.
    blur_rgb, blur_a = cv2.blur(rgbp, (31, 31)), cv2.blur(alpha, (31, 31))
    a1 = alpha / 255.0
    col = np.where(a1[..., None] > 1e-3, rgbp / np.maximum(a1, 1e-3)[..., None],
                   blur_rgb / np.maximum(blur_a / 255.0, 1e-3)[..., None])
    return np.dstack([np.clip(col, 0, 255), alpha]).round().astype(np.uint8), scale


def source_frames(src, tmp):
    src = Path(src)
    if src.is_dir():
        return sorted(src.glob('*.png'))
    if src.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp'):
        return [src]
    subprocess.run(['ffmpeg', '-v', 'error', '-i', str(src), '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24',
                    f'{tmp}/%04d.png'], check=True)
    return sorted(Path(tmp).glob('*.png'))


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    stats, ref, scale = [], None, None
    with tempfile.TemporaryDirectory() as tmp:
        for idx, f in enumerate(source_frames(sys.argv[1], tmp)):
            rgb = cv2.cvtColor(cv2.imread(str(f), cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
            fg, a = key(rgb)
            s = silhouette(a)
            stats.append(s)
            ref = ref or s
            rgba, scale = place(fg, a, ref)
            cv2.imwrite(str(out / f'{idx + 1:04d}.png'), cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
    if not stats:
        sys.exit('no frames found')
    (out.parent / f'{out.name}-stats.json').write_text(json.dumps(stats))
    foot = np.array([s['footx'] for s in stats]); bottom = np.array([s['bottom'] for s in stats])
    print(f'{len(stats)} frames -> {out}  (scale {scale:.4f})')
    print(f'feet drift over the clip at output scale: x {(foot.min() - ref["footx"]) * scale:+.1f}..{(foot.max() - ref["footx"]) * scale:+.1f} px, '
          f'bottom {(bottom.min() - ref["bottom"]) * scale:+.1f}..{(bottom.max() - ref["bottom"]) * scale:+.1f} px')


if __name__ == '__main__':
    main()
