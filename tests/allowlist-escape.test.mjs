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
} from './helpers.mjs';

test('deletions honor allow.json and never escape the target', async (t) => {
  const root = makeRoot(
    {
      'src/a.md': '# A\n',
      'site/docs/stale.txt': 'stale\n',
      'site/docs/keep.txt': 'keep me\n',
      'site/docs/LICENSE': 'do not touch\n',
      'site/docs/.github/workflows/ci.yml': 'ci\n',
      'outside.txt': 'outside the target\n',
      '.migrate/allow.json': JSON.stringify([
        'stale.txt',
        'LICENSE',
        '.github/workflows/ci.yml',
        '../outside.txt',
      ]),
    },
    { sources: ['src'], target: 'site/docs' },
  );
  const svc = await startService(root);
  t.after(() => {
    stopService(svc);
    cleanup(root);
  });

  const plan = await api(svc.base, 'POST', '/plan');
  assert.equal(plan.status, 200);
  assert.deepEqual(plan.json.deletes, ['stale.txt'], 'only allow-listed, unprotected paths are selected');
  assert.ok(plan.json.rejectedAllow.includes('../outside.txt'), 'escape attempt is rejected');
  assert.ok(plan.json.rejectedAllow.includes('LICENSE'), 'LICENSE is never selected');
  assert.ok(plan.json.rejectedAllow.includes('.github/workflows/ci.yml'), '.github is never selected');

  const commit = await api(svc.base, 'POST', '/commit');
  assert.equal(commit.status, 200);
  assert.equal(commit.json.deleted, 1);

  assert.ok(!fs.existsSync(path.join(root, 'site', 'docs', 'stale.txt')), 'allow-listed stale file deleted');
  assert.ok(fs.existsSync(path.join(root, 'site', 'docs', 'keep.txt')), 'unlisted stale file survives');
  assert.ok(fs.existsSync(path.join(root, 'site', 'docs', 'LICENSE')), 'LICENSE survives even when listed');
  assert.ok(
    fs.existsSync(path.join(root, 'site', 'docs', '.github', 'workflows', 'ci.yml')),
    '.github survives even when listed',
  );
  assert.ok(fs.existsSync(path.join(root, 'outside.txt')), 'out-of-target path is never touched');
});

test('symlinks are never followed; broken links recorded missing and kept', async (t) => {
  const root = makeRoot(
    {
      'src/real.md': '# Real\n',
      'secret/outside.md': 'secret content\n',
    },
    { sources: ['src'], target: 'site/docs' },
  );
  const svc = await startService(root);
  t.after(() => {
    stopService(svc);
    cleanup(root);
  });

  let junctionOk = true;
  try {
    fs.symlinkSync(path.join(root, 'secret'), path.join(root, 'src', 'escape'), 'junction');
    fs.symlinkSync(path.join(root, 'nonexistent-target'), path.join(root, 'src', 'broken'), 'junction');
  } catch (err) {
    junctionOk = false;
    t.diagnostic(`symlink/junction unavailable on this platform: ${err.message}`);
  }
  if (!junctionOk) return;

  const plan = await api(svc.base, 'POST', '/plan');
  assert.equal(plan.status, 200);
  assert.ok(
    !plan.json.entries.some((e) => e.name === 'outside.md'),
    'symlinked directory is not followed, outside content not selected',
  );
  assert.ok(
    plan.json.missing.some((m) => m.kind === 'symlink' && m.path === 'src/broken'),
    'unresolvable link is recorded as missing',
  );

  const commit = await api(svc.base, 'POST', '/commit');
  assert.equal(commit.status, 200);
  assert.ok(!fs.existsSync(path.join(root, 'site', 'docs', 'outside.md')), 'no out-of-bounds copy');
  assert.ok(fs.existsSync(path.join(root, 'src', 'broken')), 'broken link itself is kept');

  const state = await api(svc.base, 'GET', '/state');
  assert.equal(state.json.counts.missing, 1);
});
