#!/usr/bin/env bash
#
# Put `lykeion` on this machine's PATH.
#
# One command, one binary, no service manager and no root. The daemon is a
# thing a researcher starts when they want it and stops when they are done —
# it is not infrastructure, and installing it should not feel like installing
# infrastructure.
#
#   usage: scripts/install.sh
#
# It builds the bundle, links a small wrapper into ~/.local/bin, and — if that
# directory is not already on PATH — prints the one line to add and stops
# short of editing a shell profile. Editing somebody's profile behind their
# back is the kind of thing an installer does once and a person discovers
# months later.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
TARGET="${BIN_DIR}/lykeion"
WRAPPER="${REPO}/packages/daemon/bin/lykeion.js"

command -v node >/dev/null 2>&1 || {
  echo "lykeion needs Node 22 or newer, and there is no node on this PATH." >&2
  exit 1
}

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt 22 ]; then
  echo "lykeion needs Node 22 or newer; this is $(node -v)." >&2
  exit 1
fi

command -v pnpm >/dev/null 2>&1 || {
  echo "lykeion is built with pnpm, and there is no pnpm on this PATH." >&2
  echo "Install it with: npm install -g pnpm" >&2
  exit 1
}

echo "Building…"
cd "${REPO}"
pnpm install --frozen-lockfile >/dev/null
pnpm --filter @lykeion/ui build >/dev/null
pnpm --filter @lykeion/daemon build >/dev/null

mkdir -p "${BIN_DIR}"
# A symlink rather than a copy, so `git pull` and a rebuild are the whole of
# an upgrade. The wrapper resolves the bundle from its own real path, which is
# what makes that work.
ln -sf "${WRAPPER}" "${TARGET}"
chmod +x "${WRAPPER}"

echo "Installed ${TARGET}"
echo

case ":${PATH}:" in
  *":${BIN_DIR}:"*)
    echo "Run it:"
    echo
    echo "  lykeion"
    ;;
  *)
    # Not written into a profile on their behalf. Which file even is the
    # profile depends on the shell, whether it is a login shell, and what the
    # person has already arranged — and an installer guessing wrong leaves a
    # line in a file they did not know it touched.
    echo "${BIN_DIR} is not on your PATH. Add it:"
    echo
    echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc"
    echo
    echo "Then open a new terminal and run:"
    echo
    echo "  lykeion"
    ;;
esac
