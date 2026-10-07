import http from 'node:http';
import path from 'node:path';
import {
  loadConfig,
  buildPlan,
  loadJournal,
  appendJournal,
  stepKey,
  verifyStep,
  executeStep,
} from './migrate-core.mjs';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') opts.root = argv[++i];
    else if (argv[i] === '--port') opts.port = Number(argv[++i]);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const root = path.resolve(opts.root || process.cwd());
const config = loadConfig(root);
const envPort = Number(process.env.PORT || 0) || null;
const port = opts.port ?? envPort ?? config.port ?? 8790;
const stepDelay = Number(process.env.MIGRATE_STEP_DELAY_MS || 0);
const quiet = process.env.MIGRATE_QUIET === '1';

const state = {
  phase: 'plan', // plan -> planned -> committing -> done | back to plan on drift
  fingerprint: null,
  current: null,
  counts: { entries: 0, written: 0, skipped: 0, deleted: 0, duplicates: 0, missing: 0 },
  steps: [],
};

let pendingPlan = null;
let committing = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function render() {
  if (quiet || !process.stdout.isTTY) return;
  const c = state.counts;
  const lines = [
    '=== migrate-service ===',
    `phase: ${state.phase}`,
    `fingerprint: ${state.fingerprint ? state.fingerprint.slice(0, 12) : '-'}`,
    state.current
      ? `step ${state.current.seq}/${state.current.total} ${state.current.op} ${state.current.path}`
      : 'step: -',
    state.current && state.current.source ? `source: ${state.current.source}` : 'source: -',
    `entries: ${c.entries}  written: ${c.written}  skipped: ${c.skipped}  deleted: ${c.deleted}`,
    `duplicates: ${c.duplicates}  missing: ${c.missing}`,
  ];
  process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n') + '\n');
}

function publicPlan(plan) {
  return {
    fingerprint: plan.fingerprint,
    target: plan.target,
    entries: plan.entries,
    duplicates: plan.duplicates,
    missing: plan.missing,
    links: plan.links,
    deletes: plan.deletes,
    skippedDeletes: plan.skippedDeletes,
    rejectedAllow: plan.rejectedAllow,
    actions: plan.actions.map((a) => ({ op: a.op, dest: a.dest, source: a.source ?? null, hash: a.hash ?? null })),
  };
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handlePlan(res) {
  const plan = buildPlan(root, config);
  pendingPlan = plan;
  state.phase = 'planned';
  state.fingerprint = plan.fingerprint;
  state.current = null;
  state.counts.entries = plan.entries.length;
  state.counts.duplicates = plan.duplicates.length;
  state.counts.missing = plan.missing.length;
  render();
  send(res, 200, { phase: state.phase, ...publicPlan(plan) });
}

async function handleCommit(res) {
  if (committing) {
    send(res, 409, { error: 'busy', phase: state.phase });
    return;
  }
  if (!pendingPlan) {
    send(res, 409, { error: 'no-plan', phase: state.phase });
    return;
  }
  committing = true;
  state.phase = 'committing';
  try {
    const check = buildPlan(root, config);
    if (check.fingerprint !== pendingPlan.fingerprint) {
      pendingPlan = null;
      state.phase = 'plan';
      state.current = null;
      render();
      send(res, 409, { error: 'drift', phase: state.phase });
      return;
    }
    const journal = loadJournal(root);
    const actions = pendingPlan.actions;
    const total = actions.length;
    state.counts.written = 0;
    state.counts.skipped = 0;
    state.counts.deleted = 0;
    let seq = 0;
    for (const action of actions) {
      seq += 1;
      state.current = { seq, total, op: action.op, path: action.dest, source: action.source ?? null };
      render();
      if (journal.has(stepKey(action)) && verifyStep(root, action)) {
        state.counts.skipped += 1;
        state.steps.push({ ...state.current, status: 'skipped' });
      } else {
        appendJournal(root, { op: action.op, dest: action.dest, hash: action.hash ?? null });
        if (stepDelay > 0) await sleep(stepDelay);
        executeStep(root, config, action, pendingPlan.manifestBuf);
        if (action.op === 'delete') state.counts.deleted += 1;
        else state.counts.written += 1;
        state.steps.push({ ...state.current, status: 'done' });
      }
      if (state.steps.length > 100) state.steps.splice(0, state.steps.length - 100);
      render();
    }
    state.phase = 'done';
    state.current = null;
    pendingPlan = null;
    render();
    send(res, 200, {
      status: 'done',
      written: state.counts.written,
      skipped: state.counts.skipped,
      deleted: state.counts.deleted,
    });
  } catch (err) {
    pendingPlan = null;
    state.current = null;
    if (err && err.code === 'DRIFT') {
      state.phase = 'plan';
      render();
      send(res, 409, { error: 'drift', phase: state.phase });
    } else {
      state.phase = 'plan';
      render();
      send(res, 500, { error: String(err && err.message ? err.message : err), phase: state.phase });
    }
  } finally {
    committing = false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/state') {
      send(res, 200, state);
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/plan' || url.pathname === '/commit')) {
      await readBody(req);
      if (url.pathname === '/plan') await handlePlan(res);
      else await handleCommit(res);
      return;
    }
    send(res, 404, { error: 'not-found' });
  } catch (err) {
    send(res, 500, { error: String(err && err.message ? err.message : err) });
  }
});

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port;
  console.log(JSON.stringify({ type: 'listening', port: actual, root }));
  render();
});
