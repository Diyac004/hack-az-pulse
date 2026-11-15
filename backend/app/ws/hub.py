"""WebSocket hub: one outgoing queue and one writer task per connection.

REST handlers and the tick loop only enqueue; a single writer per socket
sends, so `seq` is gap-free and message order is preserved (section 13.3).
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Callable

from fastapi import WebSocket, WebSocketDisconnect


class _Client:
    def __init__(self):
        self.queue: asyncio.Queue = asyncio.Queue()
        self.seq = 0


class Hub:
    def __init__(self):
        self._clients: dict[WebSocket, _Client] = {}

    @property
    def count(self) -> int:
        return len(self._clients)

    def broadcast(self, type_: str, t: float, data: Any) -> None:
        for c in self._clients.values():
            c.queue.put_nowait((type_, t, data))

    async def serve(self, ws: WebSocket, first: Callable[[], tuple[str, float, Any]]) -> None:
        """Accept, send `first()` (the snapshot), then stream broadcasts until disconnect."""
        await ws.accept()
        client = _Client()
        client.queue.put_nowait(first())     # built and registered with no await in between
        self._clients[ws] = client
        writer = asyncio.create_task(self._writer(ws, client))
        try:
            while True:
                text = await ws.receive_text()
                try:
                    msg = json.loads(text)
                except ValueError:
                    continue
                if isinstance(msg, dict) and msg.get("type") == "ping":
                    client.queue.put_nowait(("pong", None, None))
        except WebSocketDisconnect:
            pass
        finally:
            self._clients.pop(ws, None)
            writer.cancel()

    @staticmethod
    async def _writer(ws: WebSocket, client: _Client) -> None:
        try:
            while True:
                type_, t, data = await client.queue.get()
                if type_ == "pong":
                    await ws.send_text('{"type":"pong"}')
                    continue
                client.seq += 1
                await ws.send_text(json.dumps({"type": type_, "t": round(t, 3), "seq": client.seq, "data": data}))
        except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
            pass
