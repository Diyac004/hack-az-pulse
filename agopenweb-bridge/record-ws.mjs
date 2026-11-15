// record-ws.mjs: record the bridge's contract-shaped WebSocket stream (what the dashboard sees) to JSONL.
//   node record-ws.mjs [--api=http://localhost:8040] [--seconds=60] [--out=captures/bridge-ws-<stamp>.jsonl]
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import WebSocket from 'ws';
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const api = arg('api', 'http://localhost:8040'), secs = +arg('seconds', 60);
const here = path.dirname(fileURLToPath(import.meta.url));
const out = arg('out', path.join(here, 'captures', `bridge-ws-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jsonl`));
fs.mkdirSync(path.dirname(out), { recursive: true });
const f = fs.createWriteStream(out); const counts = {};
const ws = new WebSocket(api.replace(/^http/, 'ws') + '/ws');
ws.on('message', (m) => { const e = JSON.parse(m); counts[e.type] = (counts[e.type] || 0) + 1; f.write(String(m) + '\n'); });
setTimeout(() => { ws.close(); f.end(() => { console.log(out, counts); process.exit(0); }); }, secs * 1000);
