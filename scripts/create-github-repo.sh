#!/usr/bin/env bash
set -euo pipefail

repo_name="${1:-stream-ai-companion}"
visibility="${2:-private}"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required. Install it and run: gh auth login"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login"
  exit 1
fi

if [ ! -d .git ]; then
  git init
fi

git branch -M main
git add .

if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  git commit -m "Initial project plan"
elif ! git diff --cached --quiet; then
  git commit -m "Update project plan"
fi

gh repo create "$repo_name" "--$visibility" --source . --remote origin --push

echo "Created and pushed GitHub repository: $repo_name"
