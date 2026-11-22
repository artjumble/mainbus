#!/bin/sh
# Starts the stable build named in current.txt, or in previous.txt with --previous (the rollback).
# The stable build always uses the stable data home, so test and dev overrides are cleared first.
set -eu

# Mainbus sets MAINBUS_AGENT for its agents: an agent must never start or replace the user's stable build.
if [ -n "${MAINBUS_AGENT:-}" ]; then
  echo "Refusing to start the stable build: MAINBUS_AGENT is set, so this is running inside a Mainbus agent. Run pnpm run run:stable from your own terminal." >&2
  exit 1
fi
if [ "$(uname -s)" != "Darwin" ]; then
  echo "run-stable.sh is for macOS. On Windows use scripts/run-stable.ps1." >&2
  exit 1
fi

file=current.txt
if [ "${1:-}" = "--previous" ] || [ "${1:-}" = "-Previous" ]; then file=previous.txt; fi
appRoot="$HOME/Library/Application Support/Mainbus/app"
name=
if [ -f "$appRoot/$file" ]; then
  { IFS= read -r name || :; } < "$appRoot/$file"
fi
cr=$(printf '\r')
name=${name%"$cr"}
if [ -z "$name" ]; then
  if [ "$file" = previous.txt ]; then hint="There is no earlier build to roll back to yet."; else hint="Run pnpm build:stable first."; fi
  echo "$file in $appRoot is missing or empty. $hint" >&2
  exit 1
fi

app="$appRoot/$name/Mainbus.app"
if [ ! -x "$app/Contents/MacOS/Mainbus" ]; then
  echo "$app/Contents/MacOS/Mainbus does not exist" >&2
  exit 1
fi

# A build folder newer than current.txt means a build run stopped before it moved the pointer.
if [ "$file" = current.txt ]; then
  newest=
  for dir in $(cd "$appRoot" && ls -1 | sort -r); do
    case $dir in
      *.tmp) continue ;;
      [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]-*) newest=$dir; break ;;
    esac
  done
  if [ -n "$newest" ] && [ "$newest" \> "$name" ]; then
    echo "Warning: current.txt names $name, but $newest is newer: an earlier build did not finish. Starting $name; run pnpm build:stable again to make the newest build current." >&2
  fi
fi

unset MAINBUS_HOME MAINBUS_RUNTIME MAINBUS_TEST_REPO ELECTRON_RUN_AS_NODE ELECTRON_RENDERER_URL

# open starts the app through LaunchServices, the way Finder does: it gets its own microphone and
# notification permissions, and the login-shell PATH applies. If it is already running, it comes forward.
open "$app"
echo "Started $name"
