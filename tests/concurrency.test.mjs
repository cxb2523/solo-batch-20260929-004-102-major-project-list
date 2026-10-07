import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeRoot,
  cleanup,
  startService,
  stopService,
  api,
  journalLines,
} from './helpers.mjs';

test('concurrent commits are serialized: single writer, others get 409', async (t) => {
  const files = {};
  for (let i = 0; i < 12; i++) {
    files[`src/entry-${String(i).padStart(2, '0')}.md`] = `# Entry ${i}\n\nBody ${i}\n`;
  }
  const root = makeRoot(files, { sources: ['src'], target: 'site/docs' });
  const svc = await startService(root, { env: { MIGRATE_STEP_DELAY_MS: '40' } });
  t.after(() => {
    stopService(svc);
    cleanup(root);
  });

  const early = await api(svc.base, 'POST', '/commit');
  assert.equal(early.status, 409, 'commit without a plan must be rejected');
  assert.equal(early.json.error, 'no-plan');

  const plan = await api(svc.base, 'POST', '/plan');
  assert.equal(plan.status, 200);
  assert.equal(plan.json.entries.length, 12);
  assert.ok(
    !fs.existsSync(path.join(root, 'site', 'docs')),
    'POST /plan must not write anything to disk',
  );

  const results = await Promise.all(Array.from({ length: 5 }, () => api(svc.base, 'POST', '/commit')));
  const ok = results.filter((r) => r.status === 200);
  const conflict = results.filter((r) => r.status === 409);
  assert.equal(ok.length, 1, 'exactly one commit may win');
  assert.equal(conflict.length, 4, 'concurrent commits must be rejected with 409');
  assert.ok(conflict.every((r) => r.json.error === 'busy' || r.json.error === 'no-plan'));

  const names = fs.readdirSync(path.join(root, 'site', 'docs')).sort();
  assert.equal(names.length, 13, '12 entries + index.json, no interleaved writes');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'site', 'docs', 'index.json'), 'utf8'));
  assert.equal(Object.keys(manifest.entries).length, 12);

  const lines = journalLines(root);
  assert.ok(lines.length >= 13, 'every committed step is journaled');
  for (const l of lines) {
    assert.ok(l.op && l.dest, 'journal lines are well-formed');
  }

  const state = await api(svc.base, 'GET', '/state');
  assert.equal(state.json.phase, 'done');
  assert.equal(state.json.counts.written, 13);
  assert.equal(state.json.counts.duplicates, 0);
  assert.equal(state.json.counts.missing, 0);
});
