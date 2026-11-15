"""Operation registry (ARCHITECTURE.md section 13.2 / 13.3).

In-memory for the server session. IDs are unique across resets. Every change
goes through the Pydantic Operation model, which enforces terminal-state
consistency (succeeded <-> result, failed <-> error).
"""
from __future__ import annotations

import hashlib
import json

from app import models as m

from .state import WorldError

ACTIVE = {"queued", "running"}


class Operations:
    def __init__(self):
        self._ops: dict[str, m.Operation] = {}
        self._n = 0
        self._keys: dict[str, tuple[str, str]] = {}      # Idempotency-Key -> (fingerprint, op id)

    def create(self, kind: str, source: str, t: float, message: str) -> m.Operation:
        self._n += 1
        op = m.Operation(id=f"O{self._n}", kind=kind, status="queued", source=source,
                         created_t=t, updated_t=t, message=message, plan_version=None,
                         solver_status=None, result=None, error=None)
        self._ops[op.id] = op
        return op

    def update(self, op_id: str, t: float, **changes) -> m.Operation:
        op = m.Operation.model_validate({**self._ops[op_id].model_dump(), **changes, "updated_t": t})
        self._ops[op_id] = op
        return op

    def get(self, op_id: str) -> m.Operation:
        if op_id not in self._ops:
            raise WorldError(404, "NOT_FOUND", f"There is no operation called {op_id}.")
        return self._ops[op_id]

    def active(self) -> list[m.Operation]:
        return [o for o in self._ops.values() if o.status in ACTIVE]

    def listing(self) -> list[m.Operation]:
        """All active operations plus the 20 most recent terminal ones, newest first."""
        newest = list(reversed(self._ops.values()))
        return [o for o in newest if o.status in ACTIVE] + [o for o in newest if o.status not in ACTIVE][:20]

    # ------------------------------------------------------------ idempotency

    @staticmethod
    def fingerprint(scope: str, body) -> str:
        raw = json.dumps({"scope": scope, "body": body}, sort_keys=True, default=str)
        return hashlib.sha256(raw.encode()).hexdigest()

    def replay(self, key: str | None, fingerprint: str) -> m.Operation | None:
        """Same key + same request -> the original operation. Same key, different request -> 409."""
        if not key or key not in self._keys:
            return None
        fp, op_id = self._keys[key]
        if fp != fingerprint:
            raise WorldError(409, "CONFLICT", "This Idempotency-Key was already used for a different request.")
        return self._ops[op_id]

    def remember(self, key: str | None, fingerprint: str, op_id: str) -> None:
        if key:
            self._keys[key] = (fingerprint, op_id)
