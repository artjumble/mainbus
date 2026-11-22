#!/bin/sh
# Installs a built Mainbus.app as the newest stable build: install-stable.sh <built .app> <data home> <build name>.
# The macOS half of build-stable.ps1: copies the app to <home>/app/<name>, rolls current.txt and previous.txt,
# installs <home>/bin/mainbus (scripts/mainbus) and keeps the 3 newest builds.
# The data home is an argument so tests can use a temporary one; build-stable.sh passes the real one.
set -eu

if [ -n "${MAINBUS_AGENT:-}" ]; then
  echo "Refusing to install the stable build: MAINBUS_AGENT is set, so this is running inside a Mainbus agent. Run pnpm build:stable from your own terminal." >&2
  exit 1
fi
if [ "$#" -ne 3 ]; then
  echo "usage: install-stable.sh <built .app> <data home> <build name>" >&2
  exit 2
fi
source=$1
home=$2
name=$3
scripts=$(cd -- "$(dirname -- "$0")" && pwd)
keep=3

case $name in
  */*) echo "Bad build name '$name': it must not contain /." >&2; exit 2 ;;
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]-*) ;;
  *) echo "Bad build name '$name': expected yyyymmdd-hhmm-<rev>." >&2; exit 2 ;;
esac

[ -f "$source/Contents/MacOS/Mainbus" ] || { echo "No Contents/MacOS/Mainbus in $source" >&2; exit 1; }
[ -f "$source/Contents/Resources/cli/mainbus.cjs" ] || { echo "No Contents/Resources/cli/mainbus.cjs in $source" >&2; exit 1; }

appRoot="$home/app"
mkdir -p "$appRoot"

# The text of a pointer file, or '' when it is missing or empty.
read_name() {
  r=
  if [ -f "$1" ]; then
    { IFS= read -r r || :; } < "$1"
  fi
  cr=$(printf '\r')
  printf '%s' "${r%"$cr"}"
}

# Written beside the pointer and renamed over it (atomic), then read back: a pointer that quietly
# keeps its old name starts the wrong build.
write_name() {
  printf '%s' "$2" > "$1.tmp"
  mv -f "$1.tmp" "$1"
  written=$(read_name "$1")
  if [ "$written" != "$2" ]; then
    echo "$1 reads '$written' after writing '$2'" >&2
    return 1
  fi
}

# Leftovers of an interrupted install (<name>.tmp) are never worth keeping.
for leftover in "$appRoot"/*.tmp; do
  [ -e "$leftover" ] || continue
  rm -rf -- "$leftover" || echo "Warning: could not remove leftover $leftover" >&2
done

target="$appRoot/$name"
staging="$target.tmp"
currentFile="$appRoot/current.txt"
previousFile="$appRoot/previous.txt"
old=$(read_name "$currentFile")

# Copy to <name>.tmp first and rename once the copy is complete, so a failed copy never leaves a
# half-built folder under a real name.
rm -rf -- "$staging"
mkdir -p "$staging"
if command -v ditto >/dev/null 2>&1; then
  ditto "$source" "$staging/Mainbus.app"
else
  cp -R "$source" "$staging/Mainbus.app"
fi
rm -rf -- "$target"
mv "$staging" "$target"

# Roll the pointers: what was current becomes previous, if that build is still on disk.
roll() {
  if [ -n "$old" ] && [ "$old" != "$name" ] && [ -d "$appRoot/$old" ]; then
    write_name "$previousFile" "$old" || return 1
  fi
  write_name "$currentFile" "$name"
}
if ! roll; then
  echo "Copied the build to $target, but could not make it current, so run-stable.sh still starts '$old'. Run the build again." >&2
  exit 1
fi

# The launcher runs whatever current.txt names, so it only needs writing when its text changes. It is
# written beside and renamed over the old one, so a running launcher keeps its own file.
binDir="$home/bin"
launcher="$binDir/mainbus"
if [ ! -f "$launcher" ] || ! cmp -s "$scripts/mainbus" "$launcher"; then
  mkdir -p "$binDir"
  cp "$scripts/mainbus" "$launcher.tmp"
  chmod 755 "$launcher.tmp"
  mv -f "$launcher.tmp" "$launcher"
  echo "Agent launcher written: $launcher"
fi

# Keep the 3 newest builds, and never remove the one a pointer names. A build that can't be removed
# is only a warning: the install itself has succeeded.
pinnedPrevious=$(read_name "$previousFile")
count=0
for dir in $(cd "$appRoot" && ls -1 | sort -r); do
  case $dir in
    *.tmp) continue ;;
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]-*) ;;
    *) continue ;;
  esac
  [ -d "$appRoot/$dir" ] || continue
  count=$((count + 1))
  [ "$count" -gt "$keep" ] || continue
  [ "$dir" != "$name" ] && [ "$dir" != "$pinnedPrevious" ] || continue
  rm -rf -- "$appRoot/$dir" || echo "Warning: could not remove old build $dir" >&2
done

echo "Stable build installed: $target"
echo "current.txt: $(read_name "$currentFile")   previous.txt: $(read_name "$previousFile")"
