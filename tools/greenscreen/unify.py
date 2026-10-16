"""Colour-match clips to the first-frame reference and re-encode them.

usage: python tools/greenscreen/unify.py --out DIR [--raw NAME=FRAMES_DIR ...] [GROUP ...]

Without GROUP every group in the config is processed. Outputs keep the repo layout
(DIR/assets/animations/...); install.py copies them into the project.

--raw NAME=FRAMES_DIR uses key.py output as the source of clip NAME instead of the
webm in the repo. Raw footage is first tone-matched to the reference (same pose)
and lightly sharpened. A NAME that is not in the config yet becomes
assets/animations/daily-idle-match-v001/NAME-v001-m01.webm.

Per group a 3x4 colour matrix is fitted on part colour means (hair and clothing
weighted double, ridge toward identity) and applied per frame as plan.json says.
Placement is never changed.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (TOOLS, REPO, REFERENCE, WEAR, DAILY_DIR, load, read_config, clips, read_frames,
                    classes, colour_classes)

SPATIAL_LAM, COLOUR_LAM = 500.0, 1000.0
WEAR_WEIGHT = 2.0
CRF = 2          # near-lossless; re-encoding an existing clip stays above 42 dB PSNR


def fit(pairs, lam):
    """pairs: (source RGB mean, target RGB mean, weight). Ridge toward the identity matrix."""
    X = np.array([p[0] for p in pairs]); Y = np.array([p[1] for p in pairs]); w = np.array([p[2] for p in pairs])
    A = np.hstack([X, np.ones((len(X), 1))]); Wd = np.diag(w / w.mean())
    I = np.vstack([np.eye(3), np.zeros((1, 3))])
    # Gains are pulled toward identity; the offset row is in 0-255 units, so scale its
    # penalty down or a plain brightness lift (e.g. dark cap/shorts) could never be fitted.
    P = np.diag([lam, lam, lam, lam / 65025.0])
    return np.linalg.solve(A.T @ Wd @ A + P, A.T @ Wd @ Y + P @ I)


class Reference:
    def __init__(self):
        self.im = load(REFERENCE)
        self.parts, self.colours = classes(self.im), colour_classes(self.im)

    def part_pairs(self, im, exclude=()):
        return [(im[..., :3][m].astype(float).mean(0), self.im[..., :3][self.parts[k]].astype(float).mean(0),
                 np.sqrt(m.sum()) * (WEAR_WEIGHT if k in WEAR else 1.0))
                for k, m in classes(im).items() if k not in exclude and m.sum() >= 15]

    def colour_pairs(self, samples, exclude=()):
        pooled = {}
        for im in samples:
            for k, m in colour_classes(im, exclude).items():
                if m.sum():
                    pooled.setdefault(k, []).append(im[..., :3][m].astype(float))
        out = []
        for k, lst in pooled.items():
            px = np.concatenate(lst)
            if len(px) >= 30:
                out.append((px.mean(0), self.im[..., :3][self.colours[k]].astype(float).mean(0),
                            np.sqrt(len(px) / len(samples)) * (WEAR_WEIGHT if k == 'hair' else 1.0)))
        return out


class Pregrade:
    """Tone curve (first frame vs reference, same pose) and a light unsharp mask, for raw footage."""
    def __init__(self, first, ref, amount=0.7, sigma=1.0):
        m = cv2.erode(((first[..., 3] == 255) & (ref[..., 3] == 255)).astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
        qs = np.linspace(0, 100, 21)
        self.curves = []
        for i in range(3):
            a = np.maximum.accumulate(np.percentile(first[..., i][m], qs))
            b = np.maximum.accumulate(np.percentile(ref[..., i][m], qs))
            self.curves.append((np.concatenate([[0], a, [255]]), np.concatenate([[0], b, [255]])))
        self.amount, self.sigma = amount, sigma

    def __call__(self, im):
        rgb = np.dstack([np.interp(im[..., i], *self.curves[i]) for i in range(3)]).astype(np.float32)
        rgb = rgb + self.amount * (rgb - cv2.GaussianBlur(rgb, (0, 0), self.sigma))
        return np.dstack([np.clip(rgb, 0, 255).round().astype(np.uint8), im[..., 3]])


def apply(im, M):
    rgb = np.clip(im[..., :3].astype(np.float32) @ M[:3].astype(np.float32) + M[3].astype(np.float32), 0, 255)
    return np.dstack([rgb.round().astype(np.uint8), im[..., 3]])


def encode(frames_iter, w, h, out):
    out.parent.mkdir(parents=True, exist_ok=True)
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', f'{w}x{h}', '-r', '24',
                          '-i', '-', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', str(CRF), '-g', '128',
                          '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-an', str(out)], stdin=subprocess.PIPE)
    n = 0
    for f in frames_iter:
        p.stdin.write(np.ascontiguousarray(f).tobytes()); n += 1
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError(f'encode failed: {out}')
    return n


def plan_groups(cfg, raw):
    planned = json.loads((TOOLS / 'plan.json').read_text(encoding='utf-8'))['groups']
    by_group = {g['group']: g for g in planned}
    groups, seen = [], set()
    for c in clips(cfg):
        if c['group'] in seen:
            continue
        seen.add(c['group'])
        groups.append(by_group.get(c['group'], dict(group=c['group'], segments=[c['name']], mode='ramp')))
    for name in raw:
        if name not in seen:
            groups.append(dict(group=name, segments=[name], mode='ramp'))
    return groups


def process(plan, cfg, raw, ref, out_root, repo):
    by_name = {c['name']: c for c in clips(cfg)}
    segs = []
    for s in plan['segments']:
        file = by_name[s]['seg']['file'] if s in by_name else f'assets/animations/{DAILY_DIR}/{s}-v001-m01.webm'
        segs.append(dict(name=s, file=file, src=raw.get(s, Path(repo) / file)))
    pre = None
    if any(s['name'] in raw for s in segs):
        first_raw = next(read_frames(segs[0]['src']))[1]
        pre = Pregrade(first_raw, ref.im)
    prep = (lambda im: pre(im)) if pre else (lambda im: im)

    # pass 1: the group's first and last frames and a sample for colour classes
    first = last = None; samples = []; counts = []
    for s in segs:
        n = 0
        for i, fr in read_frames(s['src']):
            fr = prep(fr)
            first = fr if first is None else first
            last = fr
            if i % 8 == 0:
                samples.append(fr)
            n += 1
        counts.append(n)
    mode, ex = plan['mode'], plan.get('excludeParts', ())
    colour_fit = lambda: fit(ref.colour_pairs(samples, plan.get('excludeColour', ())), COLOUR_LAM)
    part_fit = lambda im: fit(ref.part_pairs(im, ex), SPATIAL_LAM)
    if mode == 'colour':
        Ma = Mb = colour_fit()
    elif mode == 'first':
        Ma = Mb = part_fit(first)
    elif mode == 'last':
        Ma = Mb = part_fit(last)
    elif mode == 'colour-last':
        Ma, Mb = colour_fit(), part_fit(last)
    elif mode in ('ramp', 'group'):
        Ma, Mb = part_fit(first), part_fit(last)
    else:
        raise SystemExit(f"unknown mode {mode} for {plan['group']}")
    Mmid = (Ma + Mb) / 2

    def matrix(si, i, n):
        t = i / max(1, n - 1)
        if mode == 'ramp':
            return Ma * (1 - t) + Mb * t
        if mode == 'colour-last':
            return Ma * (1 - t) + Mb * t if si == len(segs) - 1 else Ma
        if mode == 'group':
            phase = segs[si]['name'].rsplit('.', 1)[1]
            return Ma * (1 - t) + Mmid * t if phase == 'start' else Mmid if phase == 'loop' else Mmid * (1 - t) + Mb * t
        return Ma

    # pass 2: apply and encode
    h, w = first.shape[:2]
    for si, s in enumerate(segs):
        n = counts[si]
        gen = (apply(prep(fr), matrix(si, i, n)) for i, fr in read_frames(s['src']))
        written = encode(gen, w, h, Path(out_root) / s['file'])
        assert written == n, (s['name'], written, n)
        print(f"{s['name']:<20} {mode:<11} {n:4d} frames -> {s['file']}", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', required=True)
    ap.add_argument('--raw', action='append', default=[], metavar='NAME=FRAMES_DIR')
    ap.add_argument('--repo', default=str(REPO), help='project to read clips and config from')
    ap.add_argument('groups', nargs='*')
    args = ap.parse_args()
    raw = {}
    for item in args.raw:
        name, _, path = item.partition('=')
        if not Path(path).is_dir():
            ap.error(f'--raw {item}: not a directory of key.py frames')
        raw[name] = Path(path)
    cfg = read_config(args.repo)
    ref = Reference()
    groups = plan_groups(cfg, raw)
    names = {g['group'] for g in groups}
    for g in args.groups:
        if g not in names:
            ap.error(f'unknown group {g}; known: {", ".join(sorted(names))}')
    for plan in groups:
        if not args.groups or plan['group'] in args.groups:
            process(plan, cfg, raw, ref, args.out, args.repo)


if __name__ == '__main__':
    main()
