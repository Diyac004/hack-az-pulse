"""Acceptance check against a running server: run -> breakdown -> re-plan, watched live on /ws.

    # terminal 1
    cd backend && python -m uvicorn app.main:app --port 8000
    # terminal 2
    python backend/scripts/demo_client.py [--url http://127.0.0.1:8000] [--tractor T2]

Prints every non-pose WebSocket message type as it arrives, then the state and
explanation after the breakdown.
"""
import argparse
import asyncio
import json
import urllib.request

import websockets


def call(base, method, path, body=None):
    req = urllib.request.Request(base + path, method=method, headers={"Content-Type": "application/json"},
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req) as r:
        return r.status, json.loads(r.read())


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8000")
    ap.add_argument("--tractor", default="T2", help="tractor to break down by hand")
    ap.add_argument("--speed", type=float, default=30, help="sim minutes per real second")
    args = ap.parse_args()
    base, ws_url = args.url.rstrip("/"), args.url.replace("http", "ws", 1).rstrip("/") + "/ws"

    async with websockets.connect(ws_url) as ws:
        async def listen(seconds):
            end = asyncio.get_running_loop().time() + seconds
            while (left := end - asyncio.get_running_loop().time()) > 0:
                try:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), left))
                except asyncio.TimeoutError:
                    return
                if msg["type"] == "poses":
                    continue
                d = msg["data"]
                extra = {"operation": lambda: f"{d['id']} {d['kind']} {d['status']}: {d['message']}",
                         "plan": lambda: f"v{d['version']} {len(d['entries'])} entries",
                         "explanation": lambda: d["text"][:120],
                         "log": lambda: f"{d['kind']} {d.get('type') or d.get('job') or ''}",
                         "clock": lambda: f"t={d['t']}"}.get(msg["type"], lambda: "")()
                print(f"  ws #{msg['seq']:<4} {msg['type']:12} {extra}")

        print("1. POST /api/run")
        print("  ", call(base, "POST", "/api/run", {"mode": "ours"}))
        await listen(1.0)
        print(f"2. POST /api/clock speed={args.speed}")
        call(base, "POST", "/api/clock", {"speed": args.speed})
        await listen(2.0)
        print(f"3. POST /api/events breakdown {args.tractor}")
        status, op = call(base, "POST", "/api/events", {"type": "breakdown", "tractor": args.tractor, "issue": "demo"})
        print(f"   HTTP {status} -> operation {op['id']} ({op['status']})")
        await listen(1.5)

    _, state = call(base, "GET", "/api/state")
    print("\n4. GET /api/state")
    print(f"   t={state['clock']['t']}  plan v{state['plan']['version']}")
    for t in state["fleet"]:
        print(f"   {t['id']}: {t['status']:9} job={t['current_job']}  fuel={t['fuel_pct']:.1f}%")
    for j in state["jobs"]:
        print(f"   {j['id']:4} {j['label']:12} {j['status']:9} {j['tractor'] or '-':3} {j['progress']:.0%}"
              + (f"  ({j['unassigned_reason']})" if j["unassigned_reason"] else ""))
    print(f"\n   latest explanation ({state['explanations'][0]['trigger']}): {state['explanations'][0]['text']}")


if __name__ == "__main__":
    asyncio.run(main())
