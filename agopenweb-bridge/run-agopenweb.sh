#!/usr/bin/env bash
# Build (once) and run ONE headless AgOpenWeb tractor container.
#   ./run-agopenweb.sh                 # build if missing, run on host port 5174
#   PORT=5175 NAME=aow-t2 ./run-agopenweb.sh
#   AOW_SRC=/path/to/AgOpenWeb ./run-agopenweb.sh   # where the AgOpenWeb checkout lives
#   REBUILD=1 ./run-agopenweb.sh       # force a rebuild of the image
#   ./run-agopenweb.sh stop            # stop + remove the container (image is kept)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${IMAGE:-agopenweb:headless}"
NAME="${NAME:-aow-t1}"
PORT="${PORT:-5174}"
AOW_SRC="${AOW_SRC:-${HERE}/.agopenweb-src}"
AOW_REF="${AOW_REF:-}"          # optional commit to pin; default = default-branch HEAD
DATA_DIR="${DATA_DIR:-}"        # optional host folder mounted at /data (shared Fields/)

if [[ "${1:-}" == "stop" ]]; then
  docker stop "$NAME" >/dev/null 2>&1 || true
  docker rm "$NAME" >/dev/null 2>&1 || true
  echo "stopped $NAME"; exit 0
fi

docker info >/dev/null 2>&1 || { echo "Docker daemon not running (start Docker Desktop)"; exit 1; }

if [[ -n "${REBUILD:-}" ]] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  if [[ ! -d "$AOW_SRC/.git" ]]; then
    echo "==> cloning AgOpenWeb into $AOW_SRC"
    git clone --depth 1 https://github.com/AgOpenGPS-Official/AgOpenWeb "$AOW_SRC"
  fi
  if [[ -n "$AOW_REF" ]]; then (cd "$AOW_SRC" && git fetch --depth 1 origin "$AOW_REF" && git checkout -q FETCH_HEAD); fi
  echo "==> building $IMAGE from $AOW_SRC ($(cd "$AOW_SRC" && git rev-parse --short HEAD))"
  docker build -f "$HERE/Dockerfile" -t "$IMAGE" "$AOW_SRC"
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true
MOUNT=()
if [[ -n "$DATA_DIR" ]]; then mkdir -p "$DATA_DIR"; MOUNT=(-v "$(cd "$DATA_DIR" && pwd):/data"); fi
# Own bridge network per container (UDP 9999/8888 + single-instance lock stay private);
# only the web/WS port is published, and only on loopback.
docker run -d --name "$NAME" --memory=2g --cpus=2 \
  -p "127.0.0.1:${PORT}:5174" "${MOUNT[@]}" "$IMAGE" >/dev/null

echo -n "==> waiting for http://localhost:${PORT} "
for _ in $(seq 1 60); do
  if curl -fs -o /dev/null "http://localhost:${PORT}/"; then echo " up"; break; fi
  echo -n "."; sleep 1
done
docker logs "$NAME" 2>&1 | tail -n 5
echo "WebSocket: ws://localhost:${PORT}/ws   stop: $0 stop"
