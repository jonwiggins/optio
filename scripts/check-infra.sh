#!/usr/bin/env bash
# Lint the infrastructure code (`pnpm check:infra`; CI's Checks job runs it too):
#
#   - shellcheck: every shell script: tracked *.sh, the .husky hooks (run by sh), and every
#     tracked file whose first line is a sh / bash shebang (scripts/optio-*); warnings and
#     errors (-S warning), .shellcheckrc follows sourced files
#   - hadolint: Dockerfile.* at the root and images/*.Dockerfile (.hadolint.yaml)
#   - helm: lint --strict and template, with the chart's defaults and with
#     values.local.yaml; kubeconform validates the rendering when installed
#
# A missing tool is skipped with a note so the script runs on any machine; install them
# with `brew install shellcheck hadolint helm kubeconform`. In GitHub Actions
# (GITHUB_ACTIONS=true), or with OPTIO_INFRA_LINT_STRICT=1, a missing shellcheck / hadolint /
# helm fails instead; kubeconform is optional everywhere. Exit 1 on any finding.
set -euo pipefail
cd "$(dirname "$0")/.."

strict=0
if [ "${OPTIO_INFRA_LINT_STRICT:-}" = 1 ] || [ "${GITHUB_ACTIONS:-}" = true ]; then strict=1; fi
failed=0
ran=()
skipped=()

# have <tool> <optional>: 0 when the tool is on PATH; else notes it and, when it is required
# in strict mode, fails.
have() {
  if command -v "$1" >/dev/null 2>&1; then return 0; fi
  if [ "$strict" = 1 ] && [ "${2:-}" != optional ]; then
    echo "check-infra: $1 is not installed (required here)" >&2
    failed=1
  else
    skipped+=("$1 (not installed${2:+, $2})")
    echo "check-infra: $1 is not installed, skipping" >&2
  fi
  return 1
}

# run <label> <command...>: prints the command, runs it, remembers a failure.
run() {
  local label=$1
  shift
  echo "+ $*"
  if "$@"; then ran+=("$label"); else
    echo "check-infra: $label failed" >&2
    failed=1
  fi
}

# ── shellcheck ────────────────────────────────────────────────────────────────
if have shellcheck; then
  scripts=()
  while IFS= read -r -d '' f; do scripts+=("$f"); done < <(git ls-files -z -- '*.sh')
  # Extensionless scripts: a sh / bash shebang on the first line. apps/android/gradlew is
  # Gradle's own wrapper, kept as upstream ships it.
  while IFS= read -r -d '' f; do
    case "${f##*/}" in *.*) continue ;; esac
    case "$f" in apps/android/gradlew) continue ;; esac
    [ -f "$f" ] || continue
    first=""
    IFS= read -r first <"$f" || true
    if [[ $first =~ ^#!.*/(env[[:space:]]+)?(ba)?sh([[:space:]]|$) ]]; then scripts+=("$f"); fi
  done < <(git ls-files -z)
  echo "shellcheck: ${#scripts[@]} scripts"
  run shellcheck shellcheck -S warning -x "${scripts[@]}"
  # husky runs its hooks with sh and they carry no shebang
  hooks=()
  while IFS= read -r -d '' f; do hooks+=("$f"); done < <(git ls-files -z -- '.husky/*')
  if [ "${#hooks[@]}" -gt 0 ]; then
    run "shellcheck (.husky)" shellcheck -S warning -s sh "${hooks[@]}"
  fi
fi

# ── hadolint ──────────────────────────────────────────────────────────────────
if have hadolint; then
  dockerfiles=()
  while IFS= read -r -d '' f; do dockerfiles+=("$f"); done < <(
    git ls-files -z -- 'Dockerfile*' 'images/*.Dockerfile'
  )
  echo "hadolint: ${#dockerfiles[@]} Dockerfiles"
  run hadolint hadolint "${dockerfiles[@]}"
fi

# ── helm ──────────────────────────────────────────────────────────────────────
if have helm; then
  # Render-only values: the chart refuses weak or missing ones (secrets.yaml).
  key=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  defaults=(
    --set publicUrl=https://optio.example.com
    --set "encryption.key=$key"
    --set postgresql.auth.password=render-only
  )
  local_values=(-f helm/optio/values.local.yaml --set "encryption.key=$key")
  rendered=$(mktemp -d)
  trap 'rm -rf "$rendered"' EXIT
  run "helm lint (defaults)" helm lint helm/optio --strict "${defaults[@]}"
  run "helm lint (values.local.yaml)" helm lint helm/optio --strict "${local_values[@]}"
  template() {
    helm template optio helm/optio --kube-version 1.33.0 "${@:2}" >"$rendered/$1.yaml"
  }
  run "helm template (defaults)" template defaults "${defaults[@]}"
  run "helm template (values.local.yaml)" template local "${local_values[@]}"
  if have kubeconform optional; then
    for name in defaults local; do
      [ -s "$rendered/$name.yaml" ] || continue
      run "kubeconform ($name)" kubeconform -strict -ignore-missing-schemas -summary \
        "$rendered/$name.yaml"
    done
  fi
fi

# ── summary ───────────────────────────────────────────────────────────────────
echo
echo "check-infra: ran ${#ran[@]} check(s)${ran[*]:+: ${ran[*]}}"
if [ "${#skipped[@]}" -gt 0 ]; then echo "check-infra: skipped: ${skipped[*]}"; fi
if [ "$failed" = 1 ]; then
  echo "check-infra: FAILED" >&2
  exit 1
fi
echo "check-infra: OK"
