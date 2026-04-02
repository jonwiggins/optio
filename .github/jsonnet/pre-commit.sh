#!/bin/sh

# Usage: sh .github/jsonnet/pre-commit.sh

set -e

if git diff --staged --name-only --quiet -- '*.jsonnet'; then
  echo "No changes detected, not regenerating gh actions yaml";
  exit 0;

else

  echo "Changes detected, rebuilding gh actions yml from jsonnet";

  rm -rf .github/workflows
  mkdir .github/workflows
  jsonnet -m .github/workflows/ -S .github.jsonnet;
  git add .github/workflows/

  echo "Github actions yml rebuild complete"

fi
