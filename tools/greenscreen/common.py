"""Shared helpers for the green-screen and colour tools.

Project clips, frame I/O (VP9 with alpha via ffmpeg), part masks on the
idle-aligned 640x360 canvas, and CIELAB colour maths.
"""
import json
import subprocess
from pathlib import Path

import numpy as np
import cv2

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parents[1]
REFERENCE = TOOLS / 'reference' / 'first-frame-aligned.png'
# Hair and clothing colour matter most for consistency, so they lead fits and reports.
WEAR = ('hair', 'cap', 'shirt', 'pompom_red', 'pompom_white', 'shorts')
OTHER = ('skin', 'eyes', 'bow')
# Folder and colorVariant for clips made with these tools.
DAILY_DIR = 'daily-idle-match-v001'
VARIANT = 'firstframe-match-v001'


def load(path):
    im = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if im is None:
        raise FileNotFoundError(path)
    if im.ndim == 2 or im.shape[2] == 3:
        im = cv2.cvtColor(im, cv2.COLOR_BGR2BGRA if im.ndim == 3 else cv2.COLOR_GRAY2BGRA)
    return cv2.cvtColor(im, cv2.COLOR_BGRA2RGBA)


def save(path, rgba):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), cv2.cvtColor(np.ascontiguousarray(rgba), cv2.COLOR_RGBA2BGRA), [cv2.IMWRITE_PNG_COMPRESSION, 9])


def read_config(repo=REPO):
    return json.loads((Path(repo) / 'config' / 'runtime.json').read_text(encoding='utf-8'))


def write_config(cfg, repo=REPO):
    (Path(repo) / 'config' / 'runtime.json').write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def clips(cfg):
    """Every animation in the config as dict(name, group, seg); group segments are named '<id>.<phase>'."""
    out = []
    for key in ('idle', 'headTouch', 'bodyTouch', 'run', 'flight'):
        if cfg.get(key):
            out.append(dict(name=key, group=key, seg=cfg[key]))
    for item in cfg['activities']['items']:
        if item['type'] == 'group':
            for phase in ('start', 'loop', 'end'):
                out.append(dict(name=f"{item['id']}.{phase}", group=item['id'], seg=item[phase]))
        else:
            out.append(dict(name=item['id'], group=item['id'], seg=item['segment']))
    out.append(dict(name='drag.hold', group='drag', seg=cfg['dragFeedback']['hold']))
    out.append(dict(name='drag.release', group='drag', seg=cfg['dragFeedback']['release']))
    out.append(dict(name='hover.greet', group='hover.greet', seg=cfg['hover']['greet']))
    out.append(dict(name='hover.fall', group='hover.fall', seg=cfg['hover']['fall']))
    return out


def probe(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height',
                        '-of', 'json', str(path)], capture_output=True, text=True, check=True)
    s = json.loads(r.stdout)['streams'][0]
    return s['width'], s['height']


def frames(path, every=1):
    """Yield (index, RGBA uint8 array) from a webm. The libvpx decoder is forced so alpha is kept."""
    w, h = probe(path)
    p = subprocess.Popen(['ffmpeg', '-v', 'quiet', '-c:v', 'libvpx-vp9', '-i', str(path),
                          '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], stdout=subprocess.PIPE)
    size, i = w * h * 4, 0
    try:
        while True:
            buf = p.stdout.read(size)
            if len(buf) < size:
                break
            if i % every == 0:
                yield i, np.frombuffer(buf, np.uint8).reshape(h, w, 4).copy()
            i += 1
    finally:
        p.stdout.close(); p.kill(); p.wait()


def read_frames(src, every=1):
    """Frames from a directory of RGBA PNGs (key.py output) or from a webm."""
    src = Path(src)
    if src.is_dir():
        for i, p in enumerate(sorted(src.glob('*.png'))):
            if i % every == 0:
                yield i, load(p)
    else:
        yield from frames(src, every)


def first_last(src):
    first = last = None
    n = 0
    for _, fr in read_frames(src):
        if first is None:
            first = fr
        last, n = fr, n + 1
    return first, last, n


def classes(im):
    """Part masks for the idle pose on the aligned 640x360 canvas (only valid when the pose matches)."""
    rgb, a = np.ascontiguousarray(im[..., :3]), im[..., 3]
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV).astype(int)
    H, S, V = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    yy, xx = np.mgrid[0:im.shape[0], 0:im.shape[1]]
    solid = cv2.erode((a == 255).astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    head = yy < 205
    mid = (xx > 285) & (xx < 355)          # torso column between the pom-poms
    side = (xx < 290) | (xx > 350)
    return {
        'hair': solid & (H >= 6) & (H <= 20) & (S > 140) & (V > 110) & head,
        'cap': solid & (V < 70) & (yy < 140),
        'skin': solid & (H <= 20) & (S > 15) & (S < 110) & (V > 200) & (yy > 120) & (yy < 190) & (xx > 280) & (xx < 365),
        'eyes': solid & (H >= 95) & (H <= 125) & (S > 80) & (yy > 120) & (yy < 175) & (xx > 290) & (xx < 355),
        'bow': solid & (H >= 95) & (H <= 125) & (S > 80) & (yy > 140) & (yy < 200) & ((xx < 290) | (xx > 355)),
        'shirt': solid & (S < 40) & (V > 170) & (yy > 190) & (yy < 250) & mid,
        'pompom_red': solid & ((H <= 5) | (H >= 170)) & (S > 120) & (V > 60) & (yy > 195) & side,
        'pompom_white': solid & (S < 50) & (V > 180) & (yy > 195) & side,
        'shorts': solid & (V < 70) & (yy > 245) & (yy < 300) & mid,
    }


def main_body(a, thr=128):
    """The largest opaque blob, which drops ground shadows and detached props."""
    m = (a > thr).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    if n <= 1:
        return m.astype(bool)
    return lab == 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))


def colour_classes(im, exclude=()):
    """Pose-independent classes by colour only, inside the main body (for running, lifted, ... poses)."""
    rgb, a = np.ascontiguousarray(im[..., :3]), im[..., 3]
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV).astype(int)
    H, S, V = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    body = main_body(a) & cv2.erode((a == 255).astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    out = {
        'hair': body & (H >= 6) & (H <= 22) & (S > 120) & (V > 100),
        'red': body & ((H <= 4) | (H >= 172)) & (S > 130) & (V > 70),
        'black': body & (V < 60),
        'white': body & (S < 22) & (V > 185),
        'skin': body & (H <= 20) & (S >= 28) & (S < 100) & (V > 215),
    }
    for k in exclude:
        out.pop(k, None)
    return out


def to_lab(rgb):
    return cv2.cvtColor((np.asarray(rgb, np.float32).reshape(-1, 1, 3) / 255), cv2.COLOR_RGB2LAB).reshape(-1, 3)


def lab_mean(im, mask):
    return to_lab(im[..., :3][mask]).mean(0)


def de2000(l1, l2):
    """CIEDE2000 colour difference between two CIELAB colours."""
    L1, a1, b1 = l1; L2, a2, b2 = l2
    C1, C2 = np.hypot(a1, b1), np.hypot(a2, b2); Cb = (C1 + C2) / 2
    G = 0.5 * (1 - np.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
    a1p, a2p = a1 * (1 + G), a2 * (1 + G)
    C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p, h2p = np.degrees(np.arctan2(b1, a1p)) % 360, np.degrees(np.arctan2(b2, a2p)) % 360
    dLp, dCp = L2 - L1, C2p - C1p
    dh = h2p - h1p
    dh = dh - 360 if dh > 180 else dh + 360 if dh < -180 else dh
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dh / 2))
    Lbp, Cbp = (L1 + L2) / 2, (C1p + C2p) / 2
    hb = (h1p + h2p) / 2 + (180 if abs(h1p - h2p) > 180 else 0)
    T = (1 - .17 * np.cos(np.radians(hb - 30)) + .24 * np.cos(np.radians(2 * hb))
         + .32 * np.cos(np.radians(3 * hb + 6)) - .2 * np.cos(np.radians(4 * hb - 63)))
    SL = 1 + .015 * (Lbp - 50) ** 2 / np.sqrt(20 + (Lbp - 50) ** 2); SC = 1 + .045 * Cbp; SH = 1 + .015 * Cbp * T
    RT = -2 * np.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7)) * np.sin(np.radians(60 * np.exp(-((hb - 275) / 25) ** 2)))
    return float(np.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH)))


def parts_de(im, ref, exclude=()):
    """Per-part CIEDE2000 of an idle-pose frame against the reference (None when a part is not visible)."""
    ci, cr = classes(im), classes(ref)
    return {k: (round(de2000(lab_mean(ref, cr[k]), lab_mean(im, m)), 2) if m.sum() >= 15 else None)
            for k, m in ci.items() if k not in exclude}


def silhouette(a, thr=32):
    ys, xs = np.where(a > thr)
    b = ys.max(); f = xs[ys >= b - 12]
    return dict(top=int(ys.min()), bottom=int(b), h=int(b - ys.min() + 1), footx=float((f.min() + f.max()) / 2))


def iou(a, b):
    A, B = a > 128, b > 128
    return float((A & B).sum() / max(1, (A | B).sum()))


def sharpness(im):
    g = cv2.cvtColor(np.ascontiguousarray(im[..., :3]), cv2.COLOR_RGB2GRAY)
    m = cv2.erode((im[..., 3] == 255).astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool)
    return float(cv2.Laplacian(g, cv2.CV_32F)[m].var())


def is_idle_pose(im, ref, thr=0.9):
    return im.shape[:2] == ref.shape[:2] and iou(im[..., 3], ref[..., 3]) >= thr
