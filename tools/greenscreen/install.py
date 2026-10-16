"""Copy unify.py output into the project: clips, posters, sha256 and config entries.

usage: python tools/greenscreen/install.py --out DIR [--new ID:LABEL:PROFILE:WEIGHT:COOLDOWN_MIN ...]

Every clip in the config that has a file under DIR is copied into place; its poster
is regenerated from the first decoded frame and its sha256 updated. --new adds a
single random activity for DIR/assets/animations/daily-idle-match-v001/ID-v001-m01.webm,
e.g. --new stretch:伸懒腰:dayPreferred:3:10 (profiles are randomPolicy.timeProfiles).
"""
import argparse
import hashlib
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import REPO, DAILY_DIR, VARIANT, read_config, write_config, clips, frames, save


def add_activity(cfg, spec, out):
    try:
        ident, label, profile, weight, cooldown = spec.split(':')
        weight, cooldown = int(weight), float(cooldown)
    except ValueError:
        raise SystemExit(f'--new {spec}: expected ID:LABEL:PROFILE:WEIGHT:COOLDOWN_MIN')
    if profile not in cfg['randomPolicy']['timeProfiles']:
        raise SystemExit(f"--new {spec}: unknown profile, use one of {', '.join(cfg['randomPolicy']['timeProfiles'])}")
    if any(i['id'] == ident for i in cfg['activities']['items']):
        return
    stem = f'{ident}-v001-m01'
    file = f'assets/animations/{DAILY_DIR}/{stem}.webm'
    if not (Path(out) / file).exists():
        raise SystemExit(f'--new {spec}: {Path(out) / file} not found; run unify.py --raw {ident}=... first')
    n = sum(1 for _ in frames(Path(out) / file))
    cfg['activities']['items'].append({'id': ident, 'label': label, 'type': 'single', 'segment': {
        'file': file, 'poster': f'assets/posters/{DAILY_DIR}/{stem}.png', 'materialId': stem, 'sha256': '',
        'width': 640, 'height': 360, 'fps': 24, 'frames': n, 'durationSec': n / 24, 'mirrorAllowed': False,
        'visibleHeight': 260, 'foot': [320, 321], 'viewport': {'x': 168, 'y': 32, 'width': 396, 'height': 300},
        'colorVariant': VARIANT, 'colorProfile': ident,
        'normalization': {'standingHeight': 252, 'footAnchor': [320, 321], 'fixedTransformPerClip': True}}})
    # keep the activities ahead of run/flight, as in the settings panel
    rules, ordered = cfg['randomPolicy']['defaults'], {}
    rule = {'enabled': True, 'weight': weight, 'timeProfile': profile, 'cooldownMs': int(cooldown * 60000)}
    for k, v in rules.items():
        if k == 'run':
            ordered[ident] = rule
        ordered[k] = v
    ordered.setdefault(ident, rule)
    cfg['randomPolicy']['defaults'] = ordered
    print(f'added activity {ident} ({label}), {n} frames')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', required=True)
    ap.add_argument('--new', action='append', default=[])
    ap.add_argument('--repo', default=str(REPO), help='project to install into')
    args = ap.parse_args()
    repo, out = Path(args.repo), Path(args.out)
    cfg = read_config(repo)
    for spec in args.new:
        add_activity(cfg, spec, out)
    installed = 0
    for c in clips(cfg):
        seg = c['seg']
        src = out / seg['file']
        if not src.exists():
            continue
        dst = repo / seg['file']
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        save(repo / seg['poster'], next(frames(dst))[1])
        seg['sha256'] = hashlib.sha256(dst.read_bytes()).hexdigest()
        if 'colorVariant' in seg:
            seg['colorVariant'] = VARIANT
        installed += 1
        print(f"installed {c['name']}")
    # the greet clip records which idle material it was normalised against
    greet = cfg['hover']['greet'].get('normalization', {})
    if 'referenceSha256' in greet:
        greet['referenceSha256'] = cfg['idle']['sha256']
    write_config(cfg, repo)
    print(f'{installed} clips installed; config updated')


if __name__ == '__main__':
    main()
