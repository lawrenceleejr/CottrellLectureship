#!/usr/bin/env bash
# Build or serve the static site. Uses Docker (rebuilding the image only when the
# Dockerfile changes) with a host fallback when Hugo is installed.
#   ./run.sh build            # build to ./public
#   ./run.sh serve            # dev server on :1313
#   FORCE_HOST=1 ./run.sh build
set -euo pipefail

cd "$(dirname "$0")"

IMAGE="${IMAGE:-hugo-site:local}"
HASH_FILE=".docker-build-hash"

log() { printf '\033[1;36m[site]\033[0m %s\n' "$*" >&2; }

cmd="${1:-build}"; shift || true

# Build the hugo argument vector for the requested command plus any extra args.
case "$cmd" in
  build) HUGO_ARGV=(--minify --destination public "$@") ;;
  serve) HUGO_ARGV=(server --bind 0.0.0.0 --baseURL http://localhost:1313/ "$@") ;;
  *)     HUGO_ARGV=("$cmd" "$@") ;;
esac

run_host() {
  command -v hugo >/dev/null 2>&1 || { log "ERROR: hugo not installed; use Docker."; exit 1; }
  log "running on host: hugo ${HUGO_ARGV[*]}"
  exec hugo "${HUGO_ARGV[@]}"
}

need_rebuild() {
  [[ "${FORCE_REBUILD:-0}" == "1" ]] && return 0
  docker image inspect "$IMAGE" >/dev/null 2>&1 || return 0
  [[ -f "$HASH_FILE" ]] || return 0
  [[ "$(cat "$HASH_FILE")" != "$1" ]]
}

run_docker() {
  local h; h="$(sha256sum Dockerfile | awk '{print $1}')"
  if need_rebuild "$h"; then
    log "building $IMAGE"
    DOCKER_BUILDKIT=1 docker build -t "$IMAGE" .
    printf '%s' "$h" > "$HASH_FILE"
  fi
  local ports=()
  [[ "$cmd" == "serve" ]] && ports=(-p 1313:1313)
  exec docker run --rm "${ports[@]}" -v "$PWD:/site" -w /site "$IMAGE" "${HUGO_ARGV[@]}"
}

if [[ "${FORCE_HOST:-0}" == "1" ]] || ! command -v docker >/dev/null 2>&1; then
  run_host
else
  run_docker
fi
