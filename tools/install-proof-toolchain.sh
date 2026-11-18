#!/bin/sh
# Pinned vendor release, hash verified. No account, publication or telemetry.
set -eu
task_tmp=$(mktemp -d)
archive="$task_tmp/bend.tar.gz"
trap 'rm -rf "$task_tmp"' EXIT
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/bendlang/bend/releases/download/v2.0.40/bend-2.0.40-linux-x64.tar.gz -o "$archive"
printf '%s  %s\n' c9ff8d67bd903fb6ad9a26b43d8a62c01021de82a44d55ce4a3dcd4732113d6b "$archive" | sha256sum -c -
mkdir -p "$HOME/.bend"
tar -xzf "$archive" --strip-components=1 -C "$HOME/.bend"
if ! command -v elan >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -fsSL https://github.com/leanprover/elan/releases/download/v4.2.4/elan-x86_64-unknown-linux-gnu.tar.gz -o "$task_tmp/elan.tar.gz"
  printf '%s  %s\n' 42b94d4244e8353142c456ec0e4ca6528fd898a6c604d4059f494e706e431f63 "$task_tmp/elan.tar.gz" | sha256sum -c -
  tar -xzf "$task_tmp/elan.tar.gz" -C "$task_tmp"
  "$task_tmp/elan-init" -y --no-modify-path --default-toolchain none
fi
export PATH="$HOME/.elan/bin:$PATH"
elan toolchain install leanprover/lean4:v4.34.0
