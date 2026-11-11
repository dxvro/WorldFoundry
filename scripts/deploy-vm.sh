#!/usr/bin/env bash
# Builds the Linux package and installs it on a test machine over SSH, the same way a user installs it.
#
#   scripts/deploy-vm.sh <user@host> [--skip-build] [--arch x64|arm64] [-- <install.sh options>]
#
# Needs SSH access to the machine (best with a key: ssh-copy-id <user@host>) and sudo there. sudo asks for the
# password in this terminal, so run the script in a real terminal, not through a tool without one.
# The first installation gets --open-firewall; later runs update the installation and keep data and configuration.
set -euo pipefail

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
}

TARGET_HOST=""
SKIP_BUILD=0
ARCH=x64
INSTALL_ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1 ;;
    --arch)
      [ "$#" -ge 2 ] || { echo "--arch needs a value." >&2; exit 2; }
      ARCH="$2"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      INSTALL_ARGS=("$@")
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      [ -z "$TARGET_HOST" ] || { echo "Only one target machine." >&2; exit 2; }
      TARGET_HOST="$1"
      ;;
  esac
  shift
done
[ -n "$TARGET_HOST" ] || { usage >&2; exit 2; }
case "$ARCH" in x64 | arm64) ;; *) echo "--arch must be x64 or arm64." >&2; exit 2 ;; esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/packages/backend/package.json').version")"
NAME="worldfoundry-$VERSION-linux-$ARCH"
ARCHIVE="$ROOT/release/$NAME.tar.gz"

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "==> Building $NAME"
  (cd "$ROOT" && npm run --silent "package:linux-$ARCH")
fi
[ -f "$ARCHIVE" ] || { echo "Package not found: $ARCHIVE (build it first or drop --skip-build)." >&2; exit 1; }

echo "==> Copying to $TARGET_HOST"
scp -q "$ARCHIVE" "$TARGET_HOST:$NAME.tar.gz"

echo "==> Installing on $TARGET_HOST (sudo may ask for the password)"
# the arguments travel as one quoted string to the remote shell
# (printf with no arguments would still print one empty argument, which install.sh rejects)
REMOTE_ARGS=""
if [ "${#INSTALL_ARGS[@]}" -gt 0 ]; then REMOTE_ARGS="$(printf ' %q' "${INSTALL_ARGS[@]}")"; fi
ssh -t "$TARGET_HOST" "set -e
rm -rf '$NAME'
tar xzf '$NAME.tar.gz'
cd '$NAME'
if [ -d /opt/worldfoundry ]; then FIRST=''; else FIRST='--open-firewall'; fi
sudo ./install.sh \$FIRST$REMOTE_ARGS
cd ..
rm -rf '$NAME' '$NAME.tar.gz'"

HOST_ONLY="${TARGET_HOST#*@}"
echo "==> Done: http://$HOST_ONLY:3000 (log: ssh $TARGET_HOST journalctl -u worldfoundry -f)"
