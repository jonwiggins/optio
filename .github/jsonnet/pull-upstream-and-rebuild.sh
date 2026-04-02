#!/bin/sh
# Use environment PR_NUMBER to fetch a pull request.
# export PR_NUMBER=12345 sh .github/jsonnet/pull-upstream-and-rebuild.sh
#
# Usage: sh .github/jsonnet/pull-upstream-and-rebuild.sh

set -e

if [ -z "$PR_NUMBER" ]; then
  echo "Fetching production jsonnet"
  TARGET="prod"
else
  echo "PR_NUMBER environment variable is set. Fetching pr: $PR_NUMBER"
  TARGET="pr-$PR_NUMBER"
fi

cd .github || exit
rm -rf workflows
rm -rf jsonnet
mkdir workflows
mkdir jsonnet
curl https://files.gynzy.net/lib-jsonnet/v1/jsonnet-$TARGET.tar.gz | tar xvzf -
cd ..
jsonnet -m .github/workflows/ -S .github.jsonnet;

if [ "$TARGET" != "prod" ]; then
  echo "Jsonnet rebuild complete using pr: $PR_NUMBER"
else
  echo "Jsonnet rebuild complete using production"
fi
