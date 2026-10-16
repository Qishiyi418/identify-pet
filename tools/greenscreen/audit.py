"""Audit every animation in the project against the first-frame reference.

usage: python tools/greenscreen/audit.py [--repo DIR] [--json FILE]

Per clip: frame count against the config, and for idle-pose first/last frames the
CIEDE2000 per part (hair and clothing reported first), placement and sharpness.
Clips in special poses get pose-independent colour classes pooled over the clip.
Then the colour jump wherever two clips meet: the idle loop, idle hand-offs,
segment joins and loop seams (largest jump over hair, red, black, white, skin).

To compare with an earlier version:
  git archive -o work/before.tar <commit> assets config
  mkdir work/before && tar -xf work/before.tar -C work/before
  python tools/greenscreen/audit.py --repo work/before --json work/before.json
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (TOOLS, REPO, REFERENCE, WEAR, OTHER, load, read_config, clips, frames, probe, parts_de,
                    colour_classes, lab_mean, to_lab, de2000, silhouette, sharpness, is_idle_pose)


def pooled_colour(samples, ref, exclude):
    acc = {}
    for im in samples:
        for k, m in colour_classes(im, exclude).items():
            if m.sum():
                acc.setdefault(k, []).append(im[..., :3][m])
    rc = colour_classes(ref)
    return {k: round(de2000(lab_mean(ref, rc[k]), to_lab(np.concatenate(v)).mean(0)), 2)
            for k, v in acc.items() if sum(len(x) for x in v) >= 30}


def jump(a, b):
    ca, cb = colour_classes(a), colour_classes(b)
    v = [de2000(lab_mean(a, ca[k]), lab_mean(b, cb[k])) for k in ca if ca[k].sum() >= 40 and cb[k].sum() >= 40]
    return round(max(v), 2) if v else None


def fmt(v):
    return '-' if v is None else f'{v:.2f}'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--repo', default=str(REPO))
    ap.add_argument('--json')
    args = ap.parse_args()
    repo = Path(args.repo)
    ref = load(REFERENCE)
    cfg = read_config(repo)
    plan = {g['group']: g for g in json.loads((TOOLS / 'plan.json').read_text(encoding='utf-8'))['groups']}
    report, ends = [], {}
    print(f"{'clip':<20} {'frames':>9}  {'frame':<5} {'hair+clothing':>13} {'skin/eyes/bow':>13}  {'h':>3} {'bottom':>6} {'feet x':>6} {'sharp':>5}")
    for c in clips(cfg):
        seg = c['seg']; path = repo / seg['file']
        w, h = probe(path)
        first = last = None; n = 0; samples = []
        for i, fr in frames(path):
            first = fr if first is None else first
            last, n = fr, n + 1
            if i % 8 == 0:
                samples.append(fr)
        ends[c['name']] = (first, last)
        r = dict(name=c['name'], group=c['group'], frames=n, config_frames=seg.get('frames'), size=[w, h])
        count = '%d/%s' % (n, seg.get('frames'))
        flag = '' if n == seg.get('frames') else '  << frame count differs from config'
        shown = False
        for tag, im in (('first', first), ('last', last)):
            if is_idle_pose(im, ref):
                p = parts_de(im, ref); g = silhouette(im[..., 3])
                r[f'{tag}_parts'], r[f'{tag}_geom'], r[f'{tag}_sharp'] = p, g, round(sharpness(im))
                wear = max((p[k] for k in WEAR if p.get(k) is not None), default=None)
                other = max((p[k] for k in OTHER if p.get(k) is not None), default=None)
                label, shown_count, note = (('', '', '') if shown else (c['name'], count, flag))
                print(f"{label:<20} {shown_count:>9}  {tag:<5} {fmt(wear):>13} {fmt(other):>13}  "
                      f"{g['h']:>3} {g['bottom']:>6} {g['footx']:>6} {r[tag + '_sharp']:>5}{note}")
                shown = True
        exclude = plan.get(c['group'], {}).get('excludeColour', ())
        r['colour_pooled'] = pooled_colour(samples, ref, exclude)
        if not shown:
            pooled = ', '.join(f'{k} {v}' for k, v in r['colour_pooled'].items())
            print(f"{c['name']:<20} {count:>9}  special pose, pooled colour: {pooled}{flag}")
        report.append(r)

    # where clips meet
    groups = {}
    for c in clips(cfg):
        groups.setdefault(c['group'], []).append(c['name'])
    seams = {}
    if 'idle' in ends:
        seams['idle loop'] = jump(ends['idle'][1], ends['idle'][0])
    idle0 = ends['idle'][0]
    for g, names in groups.items():
        if g == 'idle':
            continue
        if is_idle_pose(ends[names[0]][0], ref):
            seams[f'idle > {g}'] = jump(idle0, ends[names[0]][0])
        if is_idle_pose(ends[names[-1]][1], ref):
            seams[f'{g} > idle'] = jump(ends[names[-1]][1], idle0)
        for a, b in zip(names, names[1:]):
            seams[f'{a} > {b}'] = jump(ends[a][1], ends[b][0])
        for s in names:
            if s.endswith('.loop'):
                seams[f'{s} seam'] = jump(ends[s][1], ends[s][0])
    print('\ncolour jump where clips meet (largest class difference)')
    for k, v in seams.items():
        print(f'  {k:<32} {fmt(v)}')

    parts = {k: [] for k in WEAR + OTHER}
    for r in report:
        for tag in ('first', 'last'):
            for k, v in (r.get(f'{tag}_parts') or {}).items():
                if v is not None:
                    parts[k].append(v)
    print('\nidle-pose frames, mean / max per part: ' + '  '.join(
        f'{k} {np.mean(v):.2f}/{np.max(v):.1f}' for k, v in parts.items() if v))
    hand = [v for k, v in seams.items() if 'idle' in k and v is not None]
    print(f'idle hand-offs: mean {np.mean(hand):.2f}, max {np.max(hand):.2f}')
    if args.json:
        Path(args.json).write_text(json.dumps(dict(clips=report, seams=seams), indent=1))


if __name__ == '__main__':
    main()
