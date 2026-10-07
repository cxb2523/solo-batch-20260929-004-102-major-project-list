import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  makeRoot,
  cleanup,
  startService,
  stopService,
  waitForExit,
  api,
  journalLines,
  snapshotTree,
  assertTreesEqual,
  waitFor,
} from './helpers.mjs';

test('kill -9 mid-commit: restart resumes from journal and converges', async (t) => {
  const files = {};
  for (let i = 0; i < 25; i++) {
    files[`src/doc-${String(i).padStart(2, '0')}.md`] = `# Doc ${i}\n\n${'body line\n'.repeat(5)}`;
  }
  const config = { sources: ['src'], target: 'site/docs' };
  const rootA = makeRoot(files, config);
  const rootB = makeRoot(files, config);
  t.after(() => {
    cleanup(rootA);
    cleanup(rootB);
  });

  // Crashed run: slow steps, kill -9 after a few journal entries land.
  let svc = await startService(rootA, { env: { MIGRATE_STEP_DELAY_MS: '120' } });
  await api(svc.base, 'POST', '/plan');
  const commitPromise = api(svc.base, 'POST', '/commit').catch((err) => ({ status: 0, error: String(err) }));
  await waitFor(() => journalLines(rootA).length >= 4, 15000);
  svc.proc.kill('SIGKILL');
  await commitPromise;
  await waitForExit(svc.proc);
  assert.ok(svc.proc.exitCode !== 0 || svc.proc.signalCode, 'process was really killed');

  // Resume: same root, fresh service must skip journaled steps.
  svc = await startService(rootA);
  t.after(() => stopService(svc));
  const plan2 = await api(svc.base, 'POST', '/plan');
  assert.equal(plan2.status, 200);
  const commit2 = await api(svc.base, 'POST', '/commit');
  assert.equal(commit2.status, 200);
  assert.ok(commit2.json.skipped >= 3, `journal skips committed steps, got ${commit2.json.skipped}`);

  // Reference: clean run on an identical root, no crash.
  const svcB = await startService(rootB);
  t.after(() => stopService(svcB));
  await api(svcB.base, 'POST', '/plan');
  const ref = await api(svcB.base, 'POST', '/commit');
  assert.equal(ref.status, 200);

  assertTreesEqual(
    t,
    snapshotTree(path.join(rootA, 'site', 'docs')),
    snapshotTree(path.join(rootB, 'site', 'docs')),
    'crash-resumed output vs clean run',
  );

  const state = await api(svc.base, 'GET', '/state');
  assert.equal(state.json.phase, 'done');
});
