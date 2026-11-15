# AI Supervisor

An LLM in the loop that reviews the fleet plan, tractor implements and plot validity, and **proposes** fixes. The
operator approves; the backend's optimizer re-plans and the Safety Agent validates (PROJECT.md Change 6: the LLM never
bypasses Safety). Contract: ARCHITECTURE.md §14 (proposal).

```sh
cd ai-supervisor && npm install            # deps: ws only
# a contract backend first, e.g. the mock:  PORT=8000 node mock-backend/server.mjs
AI_PROVIDER=agy API=http://localhost:8000 node ai-supervisor/server.mjs      # :8060 (PORT=)
# dashboard: ?source=live&api=http://localhost:8000&ai=http://localhost:8060
npm test                                   # adapter, crop math, findings lifecycle + block_disabled (no model calls)
```

Reviewers (one LLM call each, strict JSON schema, compact facts, never raw dumps):

- **Plan**: lateness, overtime, idle tractors, travel, weather windows, fairness -> `patch_priority`, `pin_job`, `ban_type`, `off_duty` or advice.
- **Implements**: which implement each tractor should carry for the remaining work -> `set_implements` (re-plans: previewed first).
- **Plots** (vision): crops each block and the depot from `dashboard/public/static/naip.png` (same image and extent as
  `naip.jpg`; PNG because decoding it needs only `node:zlib`) and asks whether it is orchard. Non-orchard blocks ->
  `disable_block` (`POST /api/events {type:"block_disabled"}`). Cached per scenario.

Runs on a new plan version, a fleet up/down/implement change or a spray-permission change: debounced, one at a time,
at least `MIN_GAP_S` (20) apart, plus "Review now".

## Providers (`AI_PROVIDER`)

| provider | how | env |
|---|---|---|
| `agy` (default) | Antigravity CLI: `agy -p ... --output-format json --json-schema <file> --dangerously-skip-permissions --print-timeout 180s`, run in a private temp dir; images are written there and the prompt names the files | `AGY_MODEL` (default `claude-sonnet-5-5-low`), `AGY_BIN` |
| `openai` | Chat Completions, `response_format: json_schema` (strict), image `data:` URLs | `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-5`), `OPENAI_BASE_URL` |
| `anthropic` | Messages API, `output_config.format` json_schema, base64 image blocks | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-opus-5-5`) |
| `rules` | no model; rule-based plan/implements review, no plot review | |

Keys are read from the environment only. Bad JSON is retried once.
