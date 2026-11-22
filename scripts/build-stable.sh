#!/bin/sh
# Builds the app and installs it as the newest stable build under ~/Library/Application Support/Mainbus/app
# (macOS, Apple silicon). The install itself is scripts/install-stable.sh. Run it from your own terminal.
set -eu

# Mainbus sets MAINBUS_AGENT for its agents: an agent must never replace the user's stable build.
if [ -n "${MAINBUS_AGENT:-}" ]; then
  echo "Refusing to build the stable build: MAINBUS_AGENT is set, so this is running inside a Mainbus agent. Run pnpm build:stable from your own terminal." >&2
  exit 1
fi
if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-stable.sh is for macOS. On Windows use scripts/build-stable.ps1; Linux packaging comes later." >&2
  exit 1
fi
if [ "$(uname -m)" != "arm64" ]; then
  echo "The macOS build is arm64 only, so it can't run on this Mac ($(uname -m))." >&2
  exit 1
fi

scripts=$(cd -- "$(dirname -- "$0")" && pwd)
cd -- "$scripts/.."

pnpm run build
pnpm exec electron-builder --mac dir

rev=nogit
if sha=$(git rev-parse --short HEAD 2>/dev/null) && [ -n "$sha" ]; then
  rev=$sha
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then rev="$sha-dirty"; fi
fi
name="$(date +%Y%m%d-%H%M)-$rev"

exec sh "$scripts/install-stable.sh" dist/mac-arm64/Mainbus.app "$HOME/Library/Application Support/Mainbus" "$name"
