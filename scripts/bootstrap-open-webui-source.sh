#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd "$script_dir/.." && pwd)"
source_dir="$desktop_dir/vendor/open-webui"
source_repository="https://github.com/dincozdemir/open-webui.git"
source_ref="orbit"

if [[ ! -d "$source_dir/.git" ]]; then
  mkdir -p "$(dirname "$source_dir")"
  git clone --branch "$source_ref" --depth 1 "$source_repository" "$source_dir"
fi

git -C "$source_dir" remote set-url origin "$source_repository"
git -C "$source_dir" fetch --depth 1 origin "$source_ref"
git -C "$source_dir" checkout "$source_ref"
