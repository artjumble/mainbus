#!/bin/sh
# CI: installs the packaged macOS app into a temporary data home, starts it through LaunchServices the way
# Finder does, and checks that the installed bin/mainbus launcher reaches it.
set -eu

repo=$(cd -- "$(dirname -- "$0")/../.." && pwd)
home="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/Stable home 'q'"
name=20261122-0000-ci
rm -rf -- "$home"

cleanup() {
  pkill -f "$home/app/$name/Mainbus.app" 2>/dev/null || true
  launchctl unsetenv MAINBUS_HOME 2>/dev/null || true
  launchctl unsetenv MAINBUS_RUNTIME 2>/dev/null || true
}
trap cleanup EXIT

sh "$repo/scripts/install-stable.sh" "$repo/dist/mac-arm64/Mainbus.app" "$home" "$name"

# Finder doesn't pass the shell's environment on, so the test settings go to LaunchServices instead.
launchctl setenv MAINBUS_HOME "$home"
launchctl setenv MAINBUS_RUNTIME "fake:$repo/e2e/fixtures/handoff.json"
open -n "$home/app/$name/Mainbus.app"

i=0
until [ -S "$home/intake.sock" ]; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then echo "Mainbus did not start: no $home/intake.sock after 60 s" >&2; exit 1; fi
  sleep 1
done

status=0
MAINBUS_HOME="$home" "$home/bin/mainbus" ticket list --json || status=$?
if [ "$status" -ne 0 ]; then echo "mainbus ticket list exited $status (3 means Mainbus isn't running)" >&2; exit 1; fi

out=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ci","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' |
  MAINBUS_HOME="$home" "$home/bin/mainbus" mcp)
echo "$out" | grep -q 'ticket' || { echo "mainbus mcp listed no ticket tool: $out" >&2; exit 1; }
echo "Stable install and launcher work."
