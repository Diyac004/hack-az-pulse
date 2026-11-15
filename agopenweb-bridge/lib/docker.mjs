// Minimal Docker CLI wrapper for AgOpenWeb tractor containers. execFile (no shell), labelled containers,
// loopback-only port publishing, per-container memory/CPU caps.
import { execFile } from 'node:child_process';

const run = (args, timeoutMs = 60000) => new Promise((resolve, reject) => {
  execFile('docker', args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
    if (err) { err.message = `docker ${args[0]}: ${(stderr || err.message).trim()}`; reject(err); } else resolve(stdout.trim());
  });
});

export const LABEL = 'aow-bridge=1';

export async function dockerAvailable() { try { await run(['info', '--format', '{{.ServerVersion}}'], 8000); return true; } catch { return false; } }

export async function imageExists(image) { try { await run(['image', 'inspect', image], 10000); return true; } catch { return false; } }

/** Start one headless AgOpenWeb container. Returns {name, port, url}. */
export async function startContainer({ name, port, image = 'agopenweb:headless', memory = '512m', cpus = '2', host = '127.0.0.1' }) {
  await run(['rm', '-f', name]).catch(() => {});
  await run(['run', '-d', '--name', name, '--label', LABEL, `--memory=${memory}`, `--cpus=${cpus}`,
    '-p', `${host}:${port}:5174`, image]);
  return { name, port, url: `ws://localhost:${port}/ws` };
}

export async function stopContainer(name) { await run(['rm', '-f', name], 30000).catch(() => {}); }

export async function removeAllLabelled() {
  const ids = (await run(['ps', '-aq', '--filter', `label=${LABEL}`]).catch(() => '')).split('\n').filter(Boolean);
  if (ids.length) await run(['rm', '-f', ...ids], 30000).catch(() => {});
  return ids.length;
}

/** {name: {mem_mib, mem_limit_mib, cpu_pct}} for our labelled containers. */
export async function stats() {
  const ids = (await run(['ps', '-q', '--filter', `label=${LABEL}`]).catch(() => '')).split('\n').filter(Boolean);
  if (!ids.length) return {};
  const out = await run(['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}', ...ids], 20000).catch(() => '');
  const toMiB = (s) => { const m = /([\d.]+)\s*([KMG]i?B)/.exec(s); if (!m) return null; const v = +m[1]; return m[2].startsWith('G') ? v * 1024 : m[2].startsWith('K') ? v / 1024 : v; };
  const res = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const [name, mem, cpu] = line.split('\t');
    const [used, lim] = mem.split('/');
    res[name] = { mem_mib: toMiB(used), mem_limit_mib: toMiB(lim), cpu_pct: parseFloat(cpu) };
  }
  return res;
}
