#!/usr/bin/env bash
# Verify a commit in a throwaway git worktree: dashboard build + node tests,
# mock-backend smoke, agopenweb-bridge tests. Prints a PASS/FAIL table.
#
# Usage: scripts/verify.sh <commit-ish>      (run from anywhere inside the repo)
# Env:   MAIN_CHECKOUT  checkout holding node_modules (default /Users/divyamkataria/hack-az-pulse)
#        VERIFY_ROOT    where temp worktrees go (default: the scratchpad dir)
#        VERIFY_PORT    mock-backend port (default 8871)
# Exit:  0 = all steps passed or skipped, 1 = any failure.
set -u

REF="${1:-}"
[ -n "$REF" ] || { echo "usage: $0 <commit-ish>" >&2; exit 2; }

MAIN="${MAIN_CHECKOUT:-/Users/divyamkataria/hack-az-pulse}"
ROOT="${VERIFY_ROOT:-/private/tmp/claude-501/-Users-divyamkataria-hack-az-pulse/9bf25f93-9035-4ec5-a3c1-0d5f419db56d/scratchpad}"
PORT="${VERIFY_PORT:-8871}"

SHA="$(git rev-parse --short "$REF^{commit}" 2>/dev/null)" || { echo "cannot resolve '$REF'" >&2; exit 2; }
WT="$ROOT/verify-$SHA"
OUT="$ROOT/verify-$SHA.out"   # step logs live outside the worktree
mkdir -p "$ROOT" "$OUT"

stop_server() {
  local pids
  pids="$(lsof -ti "tcp:$PORT" 2>/dev/null || true)"
  if [ -n "$pids" ]; then echo "$pids" | xargs kill 2>/dev/null; fi
  return 0
}
cleanup() {
  stop_server
  git worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"
  git worktree prune >/dev/null 2>&1
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if [ -n "$(lsof -ti "tcp:$PORT" 2>/dev/null)" ]; then
  echo "port $PORT is already in use; refusing to start (set VERIFY_PORT)" >&2; exit 2
fi

if [ -e "$WT" ]; then git worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"; fi
git worktree add -q --detach "$WT" "$REF" || { echo "worktree add failed" >&2; exit 2; }
echo "verifying $REF ($SHA) in $WT"

for d in dashboard mock-backend agopenweb-bridge; do
  if [ -d "$WT/$d" ] && [ -d "$MAIN/$d/node_modules" ] && [ ! -e "$WT/$d/node_modules" ]; then
    ln -s "$MAIN/$d/node_modules" "$WT/$d/node_modules"
  fi
done

NAMES=(); RESULTS=(); DETAILS=(); FAILED=0
record() { NAMES+=("$1"); RESULTS+=("$2"); DETAILS+=("$3"); if [ "$2" = FAIL ]; then FAILED=1; fi; return 0; }

# run_step <name> <dir> <required-path> <count-regex-or-""> -- cmd...
run_step() {
  local name="$1" dir="$2" need="$3" cre="$4"; shift 5
  local log="$OUT/${name// /_}.log"
  if [ ! -e "$WT/$need" ]; then record "$name" SKIP "missing in commit: $need"; return 0; fi
  ( cd "$WT/$dir" && "$@" ) >"$log" 2>&1
  local rc=$? detail=""
  if [ -n "$cre" ]; then detail="$(grep -Eio "$cre" "$log" | tail -3 | tr '\n' ' ')"; fi
  if [ $rc -eq 0 ]; then
    record "$name" PASS "${detail:-ok}"
  else
    record "$name" FAIL "exit $rc ${detail}(log: $log)"
    echo "--- $name failed; tail of log:"; tail -15 "$log"
  fi
  return 0
}

COUNTS="[0-9]+ (checks|passed|ok)|(# |ℹ )(pass|fail) [0-9]+|[0-9]+ ?/ ?[0-9]+"
run_step "dashboard build" dashboard dashboard/package.json "built in [0-9.]+m?s" -- npx --no-install vite build --outDir "$OUT/build" --emptyOutDir
run_step "selftest"     dashboard dashboard/src/data/selftest.mjs          "$COUNTS" -- node src/data/selftest.mjs
run_step "mockControls" dashboard dashboard/src/data/mockControls.test.mjs "$COUNTS" -- node src/data/mockControls.test.mjs
run_step "mapOverlays"  dashboard dashboard/src/scene/mapOverlays.test.mjs "$COUNTS" -- node src/scene/mapOverlays.test.mjs

# mock-backend smoke: server started by path, stopped by port
if [ -f "$WT/mock-backend/server.mjs" ] && [ -f "$WT/mock-backend/smoke.mjs" ]; then
  PORT=$PORT QUIET=1 node "$WT/mock-backend/server.mjs" >"$OUT/server.log" 2>&1 &
  up=0
  for _ in $(seq 1 50); do
    if curl -sf "http://localhost:$PORT/api/state" >/dev/null 2>&1; then up=1; break; fi
    sleep 0.2
  done
  if [ $up -eq 0 ]; then
    record "mock smoke" FAIL "server did not come up (log: $OUT/server.log)"; tail -10 "$OUT/server.log"
  else
    API="http://localhost:$PORT" node "$WT/mock-backend/smoke.mjs" >"$OUT/smoke.log" 2>&1
    rc=$?
    ok_n="$(grep -c '^  ok ' "$OUT/smoke.log")"; fail_n="$(grep -c '^  FAIL ' "$OUT/smoke.log")"
    if [ $rc -eq 0 ] && [ "$fail_n" -eq 0 ]; then
      record "mock smoke" PASS "$ok_n ok, 0 FAIL"
    else
      record "mock smoke" FAIL "exit $rc, $ok_n ok, $fail_n FAIL (log: $OUT/smoke.log)"
      grep '^  FAIL ' "$OUT/smoke.log" | head -10
    fi
  fi
  stop_server
else
  record "mock smoke" SKIP "mock-backend/server.mjs or smoke.mjs missing in commit"
fi

run_step "bridge npm test" agopenweb-bridge agopenweb-bridge/package.json "(# |ℹ )(pass|fail) [0-9]+" -- npm test --silent

echo
printf '%-18s %-5s %s\n' STEP RESULT DETAIL
printf '%-18s %-5s %s\n' ------------------ ----- ------
for i in "${!NAMES[@]}"; do printf '%-18s %-5s %s\n' "${NAMES[$i]}" "${RESULTS[$i]}" "${DETAILS[$i]}"; done
echo
if [ $FAILED -eq 0 ]; then echo "OVERALL: PASS ($SHA)"; exit 0; else echo "OVERALL: FAIL ($SHA)"; exit 1; fi
