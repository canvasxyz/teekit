#!/usr/bin/env bash

set -euo pipefail

err() {
  echo "Error: $*" >&2
}

# Ensure we're in a git repository
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  err "Not inside a git repository."; exit 1
fi

# Abort if there are unstaged or uncommitted changes
if ! git diff --quiet; then
  err "Unstaged changes present. Commit or stash before syncing."; exit 1
fi
if ! git diff --cached --quiet; then
  err "Staged but uncommitted changes present. Commit or stash before syncing."; exit 1
fi

# Ensure we are on a branch (not detached)
if ! branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null); then
  err "Detached HEAD. Check out a branch before syncing."; exit 1
fi

# Verify the remote named "priv" exists
if ! git remote get-url priv >/dev/null 2>&1; then
  err "Remote 'priv' not found."; exit 1
fi

# Fetch from priv
git fetch --quiet priv

# Verify the corresponding remote branch exists
if ! git rev-parse --verify --quiet "refs/remotes/priv/${branch}" >/dev/null; then
  err "Remote branch 'priv/${branch}' does not exist."; exit 1
fi

# Determine ahead/behind to ensure fast-forward is possible
read -r left right < <(git rev-list --left-right --count HEAD..."priv/${branch}")

if [[ ${left} -ne 0 ]]; then
  err "Local branch has commits not on priv/${branch}; non-fast-forward."; exit 1
fi

if [[ ${right} -eq 0 ]]; then
  echo "Already up to date with priv/${branch}."
  exit 0
fi

# Fast-forward merge
git merge --ff-only "priv/${branch}"
echo "Fast-forwarded to priv/${branch}."
