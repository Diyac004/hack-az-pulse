# Proposal: block_disabled events and AI Supervisor endpoints — for Anay/Diya to accept into ARCHITECTURE.md

_Drafted on the AI Supervisor branch as an ARCHITECTURE.md "§14" section. It lives here instead because ARCHITECTURE.md §14 is Diya's capabilities amendment; the 14.1/14.2 sub-numbers below are kept from the draft and will be renumbered when accepted._

Status: **proposal** from Divi's dashboard work. The mock backend and the dashboard implement it; Anay/Diya decide whether the FastAPI backend adopts it. Nothing here changes §13.

### 14.1 Event `block_disabled` / `block_enabled`

`POST /api/events` gains two types (202 Operation, `kind: "replan"`, `source: "events"`, like every event):

```json
{ "type": "block_disabled", "block": "A", "reason": "Aerial photo shows houses, not orchard (8% trees).", "proposed_by": "ai_supervisor" }
{ "type": "block_enabled",  "block": "A" }
```

- `proposed_by`: optional, `"ai_supervisor" | "operator"` (default operator). Used only for the explanation wording.
- Errors: unknown block -> 404 `NOT_FOUND`; disabling an excluded block (or enabling one that is not) -> 409 `CONFLICT`.
- Effect: the planner never assigns work on an excluded block. Unfinished jobs there become `pending`, `tractor: null`, with `unassigned_reason: "Block A is excluded from planning: <reason>"`, and keep their `progress` (§13.1: not `dropped`). A tractor working there is released. Preview (`/preview`) and Why use the same exclusion, so preview == apply.
- `Scenario` gains `disabled_blocks: [{ "block": "A", "reason": string|null, "t": number|null, "proposed_by": string|null }]` (`[]` when none; already in the contract examples). A new run clears it.
- Log line: `{ "t", "kind": "event", "type": "block_disabled"|"block_enabled", "block", "reason", "proposed_by", "jobs": [ids] }`; clients patch `scenario.disabled_blocks` from it (same pattern as `blocked_cells`).
- Explanation trigger `block_disabled` / `block_enabled`; with `proposed_by: "ai_supervisor"` the text says "AI Supervisor proposed, operator approved, Safety check passed."
- Support is reported through `capabilities.events.block_disabled` (dashboard/src/data/capabilities.js; a backend may also say so in `GET /api/capabilities`). The mock's `/openapi.json` also lists `event_types`.

### 14.2 AI Supervisor service (`ai-supervisor/`, port 8060)

An LLM reviewer beside any contract backend. It subscribes to `/ws`, and after a new plan version, a fleet up/down/implement change or a spray-permission change (debounced, at most one run at a time, at least 20 s apart, plus "Review now") it runs three reviewers: plan, implements, plots (vision on NAIP crops). It **only proposes**; the operator approves; the backend's optimizer and Safety Agent decide via the normal mutation. Actions are a closed set, validated against the snapshot before they are shown and again at approval:

| action kind | request | preview |
|---|---|---|
| `patch_priority` | `PATCH /api/jobs/{id} {priority}` | none in the contract (said so in the UI) |
| `pin_job` | `PATCH /api/jobs/{id} {pinned_to}` | `POST /api/tractors/{t}/preview {control:"pin_job", value:job}` |
| `ban_type`, `off_duty`, `set_implements` | `POST /api/tractors/{t}/control` (`ban_type`, `off_duty_t`, `implements`) | `POST /api/tractors/{t}/preview` |
| `disable_block` | `POST /api/events {type:"block_disabled"}` | none |
| `none` | advisory only | |

Capabilities use the dashboard's detection (`dashboard/src/data/capabilities.js`: `/openapi.json` paths or routes, the bridge profile, side-effect-free GET probes, optional `GET /api/capabilities`). `patch_job` <- `patchJob`, controls and preview <- `controls`, `disable_block` <- `events.block_disabled` (off for FastAPI and the bridge). An unsupported action is shown as advice ("Not supported by this backend"); a 501/405 at approval turns it into advice. Metrics are left out of the model's facts where `metricsMeasured` is false, and weather where `weatherEnforced` is false. A new farm day (snapshot whose clock went backwards) resets open findings and decisions.

Endpoints: `GET /ai/state`, `GET /ai/wording/{explanation_id}` (LLM rewording of one explanation, validated against the template; added after the draft), `POST /ai/review` (202), `POST /ai/findings/{id}/approve` (re-validate, re-preview, apply with an `Idempotency-Key`; 202 `{finding, operation}`, 409 stale/busy, 422 preview refused, 501 unsupported), `POST /ai/findings/{id}/dismiss`, WS `/ai/ws` (`{type:"ai_state", data: AiState}`).

```json
AiState  { "provider": "agy", "model": "claude-sonnet-5-5-low", "label": "...", "status": "idle|reviewing|previewing|error|offline",
           "last_run_at": iso, "latency_ms": 16700, "reviews": { "plan": {...}, "implements": {...}, "plots": {...} },
           "capabilities": { "patch_job", "controls", "preview", "block_disabled", "source" }, "findings": [Finding], "history": [...] }
Finding  { "id": "F1", "key": "...", "reviewer": "plan|implements|plots", "severity": "high|medium|low", "title", "why",
           "action": { "kind", "job", "tractor", "block", "priority", "value", "implements" }, "label", "request": {method,path,body}|null,
           "advisory": bool, "advisory_reason", "status": "open|applying|applied|failed|rejected|stale|dismissed",
           "preview": { "allowed", "refused_reason", "moved", "retimed", "deadlines_missed", "travel_delta_min", "idle_delta_min", "late_jobs_delta", "text" }|null,
           "preview_status": "none|loading|ready|unavailable|error", "preview_note", "operation": Operation|null, "error", "outcome", "plot": {...}|null }
```

The dashboard reads it as `state.ai` (`?ai=http://localhost:8060`); without `?ai=` it runs a small rule-based reviewer in the browser (labelled "rules", no plot review).
