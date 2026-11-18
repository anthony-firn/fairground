"""Require the second BendTT checker, not just the front-end's exit code/banner."""
from pathlib import Path
import os
import subprocess

root = Path(__file__).resolve().parents[1]
env = {**os.environ, 'BEND_NO_TELEMETRY': '1', 'ELAN_TOOLCHAIN': 'leanprover/lean4:v4.34.0'}
bend = os.environ.get('BEND', str(Path.home()/'.bend/bin/bend'))
r = subprocess.run([bend, 'proofs/fund-policy/PROOF.bend', '--verdict'], cwd=root, env=env, text=True, capture_output=True)
out = r.stdout + r.stderr
print(out, end='')
if r.returncode or 'ALL PROOFS CHECK' not in out or 'SOME PROOFS FAIL' in out:
    raise SystemExit('The independently checked fund-policy proof gate failed.')
