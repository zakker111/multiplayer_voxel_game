#!/usr/bin/env bash
# Commit the working tree and push the current branch to GitHub.
#
# Freebuff Desktop bundles git but does not always put it on PATH, and GitHub
# needs your personal access token as the password. This script finds the
# bundled git, refuses to guess a branch, and explains the token prompt instead
# of failing silently.
#
# Usage:
#   bash scripts/push-github.sh                 # commit (if needed) and push
#   PUSH_MESSAGE="Fix aiming" bash scripts/push-github.sh
#   bash scripts/push-github.sh upstream main
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/push-github.sh [remote] [branch]

Commits any pending changes (respecting .gitignore) and pushes the branch.
  remote   defaults to origin
  branch   defaults to the current branch
  PUSH_MESSAGE   commit message to use if there is something to commit
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Freebuff ships its own git; use it when the system has none.
if ! command -v git >/dev/null 2>&1; then
  GIT_ROOT="${FREEBUFF_GIT_DIR:-/opt/Freebuff/resources/git}"
  if [ ! -x "$GIT_ROOT/bin/git" ]; then
    echo "git is not installed and no bundled git exists at $GIT_ROOT/bin/git." >&2
    echo "Install git, or set FREEBUFF_GIT_DIR to a git install." >&2
    exit 1
  fi
  export PATH="$GIT_ROOT/bin:$PATH"
  export GIT_EXEC_PATH="$GIT_ROOT/libexec/git-core"
fi

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "Not a git repository: $PWD" >&2
  exit 1
}

REMOTE="${1:-origin}"
BRANCH="${2:-$(git branch --show-current)}"
if [ -z "$BRANCH" ]; then
  echo "Detached HEAD: check out a branch (or pass a branch name) before pushing." >&2
  exit 1
fi

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "Remote '$REMOTE' is not configured. Add it with:" >&2
  echo "  git remote add origin https://github.com/<owner>/<repo>.git" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  MESSAGE="${PUSH_MESSAGE:-Update voxel game}"
  echo "Staging changes (respecting .gitignore)…"
  git add -A
  git commit -m "$MESSAGE"
else
  echo "Working tree clean — nothing new to commit."
fi

echo "Pushing $BRANCH to $REMOTE ($(git remote get-url "$REMOTE"))…"
if ! git push -u "$REMOTE" "$BRANCH"; then
  cat >&2 <<'EOF'

Push failed. GitHub wants a personal access token as the password:
  • fine-grained token: Contents = Read and write for this repository
  • classic token: "repo" scope
Paste it at the password prompt, or store it once (kept in ~/.git-credentials):
  git config --global credential.helper store
EOF
  exit 1
fi

echo "Done: $BRANCH is on $REMOTE."
