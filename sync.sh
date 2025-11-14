#!/usr/bin/env bash
# Pull in fast-forward commits from a remote called 'priv' or 'pub'.

set -euo pipefail

err() {
  echo "Error: $*" >&2
}

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  err "Not inside a git repository."; exit 1
fi

if ! git diff --quiet; then
  err "Unstaged changes present. Commit or stash before syncing."; exit 1
fi
if ! git diff --cached --quiet; then
  err "Staged but uncommitted changes present. Commit or stash before syncing."; exit 1
fi

if ! branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null); then
  err "Detached HEAD. Check out a branch before syncing."; exit 1
fi

if git remote get-url priv >/dev/null 2>&1; then
  remote="priv"
elif git remote get-url pub >/dev/null 2>&1; then
  remote="pub"
else
  err "Neither 'priv' nor 'pub' remote found."; exit 1
fi

git fetch --quiet "${remote}"

if ! git rev-parse --verify --quiet "refs/remotes/${remote}/${branch}" >/dev/null; then
  err "Remote branch '${remote}/${branch}' does not exist."; exit 1
fi

read -r left right < <(git rev-list --left-right --count HEAD..."${remote}/${branch}")

if [[ ${left} -ne 0 ]]; then
  err "Local branch has commits not on ${remote}/${branch}; non-fast-forward."; exit 1
fi

if [[ ${right} -eq 0 ]]; then
  echo "Already up to date with ${remote}/${branch}."
  exit 0
fi

git merge --ff-only "${remote}/${branch}"
echo "Fast-forwarded to ${remote}/${branch}."
