#!/usr/bin/env bash

# Build the local Computer wheel and run Desktop with it as the managed
# sidecar. This is intentionally a development helper; production should use
# a signed wheel published by the Computer release workflow.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd "$script_dir/.." && pwd)"
computer_dir="$(cd "$desktop_dir/../computer" && pwd)"
open_webui_dir="$desktop_dir/vendor/open-webui"

usage() {
  cat <<'EOF'
Usage:
  npm run dev:integrated -- --upstream-url URL [--model MODEL] [--workspace PATH]

The upstream API key is read from WU_COMPUTER_UPSTREAM_API_KEY or requested
silently. It is never accepted as a command-line argument. When --model is
omitted, Computer selects the model whose ID is CPTR_MANAGED_MODEL_ID
(default: "cptr") from URL/models.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --upstream-url)
      export WU_COMPUTER_UPSTREAM_URL="${2:?missing value for --upstream-url}"
      shift 2
      ;;
    --model)
      export WU_COMPUTER_UPSTREAM_MODEL="${2:?missing value for --model}"
      shift 2
      ;;
    --workspace)
      export WU_COMPUTER_WORKSPACE="${2:?missing value for --workspace}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${WU_COMPUTER_UPSTREAM_URL:-}" ]]; then
  usage >&2
  exit 2
fi

if [[ -z "${WU_COMPUTER_UPSTREAM_API_KEY:-}" ]]; then
  read -r -s -p "Main-server API key (leave blank if none): " WU_COMPUTER_UPSTREAM_API_KEY
  echo
  export WU_COMPUTER_UPSTREAM_API_KEY
fi

export WU_COMPUTER_WORKSPACE="${WU_COMPUTER_WORKSPACE:-$HOME/Projects}"
# Set this even when empty. It tells Desktop to clear an old explicit model
# value and let Computer rediscover the configured managed model at /models.
export WU_COMPUTER_UPSTREAM_MODEL="${WU_COMPUTER_UPSTREAM_MODEL:-}"

wheel_path="$(find "$computer_dir/dist" -maxdepth 1 -name 'cptr-*-py3-none-any.whl' -print 2>/dev/null | sort | tail -n 1)"
computer_needs_build=0
if [[ -z "$wheel_path" || "$computer_dir/pyproject.toml" -nt "$wheel_path" ]] || \
  find "$computer_dir/cptr" \
    -path "$computer_dir/cptr/frontend/node_modules" -prune -o \
    -path "$computer_dir/cptr/frontend/build" -prune -o \
    -path '*/__pycache__' -prune -o \
    -type f -newer "$wheel_path" -print -quit | grep -q .; then
  computer_needs_build=1
fi

if [[ "$computer_needs_build" == "1" ]]; then
  if [[ ! -d "$computer_dir/cptr/frontend/node_modules" ]]; then
    echo "Installing Open WebUI Computer frontend dependencies…"
    npm --prefix "$computer_dir/cptr/frontend" ci
  fi
  echo "Building Open WebUI Computer…"
  npm --prefix "$computer_dir/cptr/frontend" run build
  (cd "$computer_dir" && uv run --with build python -m build --wheel)
  wheel_path="$(find "$computer_dir/dist" -maxdepth 1 -name 'cptr-*-py3-none-any.whl' -print | sort | tail -n 1)"
  if [[ -z "$wheel_path" ]]; then
    echo "Computer wheel was not created." >&2
    exit 1
  fi
  export WU_COMPUTER_FORCE_INSTALL=1
else
  echo "Reusing the existing Open WebUI Computer build."
fi

export WU_COMPUTER_PACKAGE="cptr[all] @ file://$wheel_path"
export WU_INTEGRATED_AUTOSTART=1

if [[ ! -f "$open_webui_dir/pyproject.toml" ]]; then
  echo "Fetching managed Open WebUI source from the Orbit fork…"
  "$script_dir/bootstrap-open-webui-source.sh"
fi

# The runtime is a pinned source checkout, not the PyPI Open WebUI frontend.
# Rebuild only after checkout changes; node_modules and generated build output
# are deliberately local development artifacts.
open_webui_needs_build=0
if [[ ! -d "$open_webui_dir/node_modules" || ! -f "$open_webui_dir/build/index.html" ]]; then
  open_webui_needs_build=1
elif [[ "$open_webui_dir/package-lock.json" -nt "$open_webui_dir/build/index.html" ]] || \
  find "$open_webui_dir/src" "$open_webui_dir/static" \
    -path "$open_webui_dir/node_modules" -prune -o \
    -type f -newer "$open_webui_dir/build/index.html" -print -quit | grep -q .; then
  open_webui_needs_build=1
fi

if [[ "$open_webui_needs_build" == "1" ]]; then
  if [[ ! -d "$open_webui_dir/node_modules" ]]; then
    echo "Installing managed Open WebUI frontend dependencies…"
    npm --prefix "$open_webui_dir" ci
  fi
  echo "Building managed Omio Orbit frontend…"
  npm --prefix "$open_webui_dir" run build
else
  echo "Reusing the existing managed Omio Orbit frontend build."
fi

export WU_OPEN_WEBUI_SOURCE_DIR="$open_webui_dir"

electron_path_file="$desktop_dir/node_modules/electron/path.txt"
if [[ ! -f "$electron_path_file" ]] || grep -qx 'Electron uninstall' "$electron_path_file"; then
  echo "Installing Electron binary…"
  (cd "$desktop_dir" && npm rebuild electron)
fi

native_runtime="$(cd "$desktop_dir" && node -p "process.versions.modules + '-' + require('./node_modules/electron/package.json').version")"
native_stamp="$desktop_dir/node_modules/.wu-native-modules-$native_runtime"
if [[ ! -f "$native_stamp" ]]; then
  echo "Rebuilding macOS native modules for Electron…"
  (cd "$desktop_dir" && npm rebuild node-pty && npx electron-builder install-app-deps)
  touch "$native_stamp"
fi

echo "Starting Desktop with local Computer sidecar…"
cd "$desktop_dir"
exec npm run dev
