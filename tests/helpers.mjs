import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server/migrate-service.mjs', import.meta.url));

export function makeRoot(files = {}, config = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
  writeFiles(root, files);
  if (config) writeFiles(root, { '.migrate/config.json': JSON.stringify(config) });
  return root;
}

export function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

export function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // best effort
  }
}

export function startService(root, { env = {}, args = [] } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER, '--root', root, '--port', '0', ...args], {
      env: { ...process.env, MIGRATE_QUIET: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      reject(new Error(`service start timeout, stderr:\n${stderr}`));
    }, 15000);
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        let msg = null;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg && msg.type === 'listening') {
          clearTimeout(timer);
          resolve({
            proc,
            port: msg.port,
            base: `http://127.0.0.1:${msg.port}`,
            stderr: () => stderr,
          });
        }
      }
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function stopService(svc) {
  try {
    svc.proc.kill('SIGKILL');
  } catch {}
}

export function waitForExit(proc, timeout = 5000) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode) return resolve();
    const timer = setTimeout(resolve, timeout);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function api(base, method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

export function snapshotTree(dir) {
  const map = new Map();
  const walk = (abs, rel) => {
    let ents;
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const a = path.join(abs, e.name);
      if (e.isDirectory()) walk(a, r);
      else if (e.isFile()) map.set(r, fs.readFileSync(a));
    }
  };
  walk(dir, '');
  return map;
}

export function assertTreesEqual(t, a, b, label = '') {
  assert.deepStrictEqual([...a.keys()].sort(), [...b.keys()].sort(), `${label} file lists differ`);
  for (const [k, buf] of a) {
    assert.ok(buf.equals(b.get(k)), `${label} bytes differ: ${k}`);
  }
}

export function journalLines(root) {
  try {
    return fs
      .readFileSync(path.join(root, '.migrate', 'journal.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(cond, timeout = 10000, interval = 25) {
  const start = Date.now();
  for (;;) {
    if (await cond()) return true;
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await sleep(interval);
  }
}
