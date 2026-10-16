"""Check frames against the first-frame reference: colour per part, hairstyle and placement.

usage: python tools/greenscreen/check.py [--max 2.5] <file>...

Each file is an RGBA PNG (e.g. key.py output) or a webm (its first and last frames
are checked). Colour is CIEDE2000 per part: under 1 is invisible, about 2 needs a
side-by-side look, over 3.5 is visible at a glance. With --max, the exit code is 1
when a hair or clothing part of an idle-pose frame exceeds that value.
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import REFERENCE, WEAR, OTHER, load, first_last, parts_de, silhouette, iou, sharpness, is_idle_pose


def hair_shape(im):
    """Hairline top, outermost x and lowest y of each pigtail."""
    hsv = cv2.cvtColor(np.ascontiguousarray(im[..., :3]), cv2.COLOR_RGB2HSV).astype(int)
    H, S, V = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    yy = np.mgrid[0:im.shape[0], 0:im.shape[1]][0]
    m = (im[..., 3] > 128) & (H >= 6) & (H <= 22) & (S > 110) & (V > 90) & (yy < 265)
    m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m)
    keep = np.zeros(n, bool); keep[1:] = st[1:, cv2.CC_STAT_AREA] >= 20
    ys, xs = np.where(keep[lab])
    left, right = xs < 300, xs > 340
    return dict(top=int(ys.min()), left_out=int(xs[left].min()), left_low=int(ys[left].max()),
                right_out=int(xs[right].max()), right_low=int(ys[right].max()))


def report(label, im, ref, ref_hair):
    if not is_idle_pose(im, ref):
        shape = f'{im.shape[1]}x{im.shape[0]}'
        print(f'{label}: not the idle pose (outline overlap {iou(im[..., 3], ref[..., 3]) if im.shape == ref.shape else 0:.2f}, {shape}); '
              'use audit.py for pose-independent colour checks')
        return None
    p = parts_de(im, ref)
    g = silhouette(im[..., 3])
    h = hair_shape(im)
    wear = max(v for k, v in p.items() if k in WEAR and v is not None)
    print(f'{label}')
    print('  colour  ' + '  '.join(f'{k} {v}' for k, v in p.items() if v is not None))
    print(f'  hair+clothing max {wear:.2f}   skin/eyes/bow max {max(v for k, v in p.items() if k in OTHER and v is not None):.2f}')
    print(f"  placement height {g['h']} (ref 252), bottom {g['bottom']} (ref 320), feet x {g['footx']} (ref 319.5); "
          f'outline overlap {iou(im[..., 3], ref[..., 3]):.3f}; sharpness {sharpness(im):.0f}')
    print('  hairstyle offset px ' + ', '.join(f'{k} {h[k] - ref_hair[k]:+d}' for k in h))
    return wear


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--max', type=float, default=None)
    ap.add_argument('files', nargs='+')
    args = ap.parse_args()
    ref = load(REFERENCE)
    ref_hair = hair_shape(ref)
    worst = 0.0
    for f in args.files:
        if Path(f).suffix.lower() == '.webm':
            first, last, n = first_last(f)
            frames = [(f'{f} [first of {n}]', first), (f'{f} [last]', last)]
        else:
            frames = [(f, load(f))]
        for label, im in frames:
            w = report(label, im, ref, ref_hair)
            worst = max(worst, w or 0)
    if args.max is not None and worst > args.max:
        print(f'FAIL: hair/clothing difference {worst:.2f} > {args.max}')
        sys.exit(1)


if __name__ == '__main__':
    main()
