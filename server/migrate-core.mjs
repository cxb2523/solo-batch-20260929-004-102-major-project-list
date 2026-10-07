import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PROTECTED_DIRS = new Set(['.git', '.github', '.migrate', 'node_modules']);
export const MANIFEST_NAME = 'index.json';

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

export function isProtectedRel(rel) {
  const segs = rel.split('/');
  if (segs.some((s) => PROTECTED_DIRS.has(s))) return true;
  return /^license(\..*)?$/i.test(segs[segs.length - 1]);
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function readJsonIfExists(abs, fallback) {
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return fallback;
  }
}

export function loadConfig(root) {
  const raw = readJsonIfExists(path.join(root, '.migrate', 'config.json'), {});
  return {
    root,
    sources: Array.isArray(raw.sources) && raw.sources.length ? raw.sources : ['.'],
    target: raw.target || 'site/docs',
    excludes: Array.isArray(raw.excludes) ? raw.excludes : [],
    port: raw.port,
  };
}

export function loadAllow(root) {
  const raw = readJsonIfExists(path.join(root, '.migrate', 'allow.json'), []);
  return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : [];
}

export function loadKeep(root) {
  const raw = readJsonIfExists(path.join(root, '.migrate', 'keep.json'), {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

export function normalizeAllow(list) {
  const allowed = new Set();
  const rejected = [];
  for (const raw of list) {
    const posix = String(raw).replace(/\\/g, '/');
    const norm = path.posix.normalize(posix);
    if (
      norm === '..' ||
      norm.startsWith('../') ||
      norm.startsWith('/') ||
      /^[a-zA-Z]:\//.test(norm) ||
      isProtectedRel(norm)
    ) {
      rejected.push(raw);
      continue;
    }
    allowed.add(norm);
  }
  return { allowed, rejected };
}

export function scan(root, config) {
  const files = new Map();
  const links = [];
  const missing = [];
  const targetRel = toPosix(path.relative(root, path.resolve(root, config.target)));
  const excludes = config.excludes.map((e) => path.posix.normalize(toPosix(e)));

  const skipRel = (rel) => {
    if (rel === targetRel || rel.startsWith(targetRel + '/')) return true;
    for (const ex of excludes) {
      if (rel === ex || rel.startsWith(ex + '/')) return true;
    }
    return false;
  };

  const visitDir = (absDir, relDir) => {
    let dirents;
    try {
      dirents = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of dirents) {
      const abs = path.join(absDir, d.name);
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      if (PROTECTED_DIRS.has(d.name)) continue;
      if (skipRel(rel)) continue;
      if (d.isSymbolicLink()) {
        let target = null;
        try {
          target = fs.readlinkSync(abs);
        } catch {
          target = null;
        }
        let resolved = false;
        if (target != null) {
          try {
            fs.lstatSync(path.resolve(absDir, target));
            resolved = true;
          } catch {
            resolved = false;
          }
        }
        links.push({ path: rel, target });
        if (!resolved) missing.push({ kind: 'symlink', path: rel, target });
        continue; // never follow symlinks
      }
      if (d.isDirectory()) {
        visitDir(abs, rel);
        continue;
      }
      if (d.isFile()) {
        const buf = fs.readFileSync(abs);
        files.set(rel, { rel, abs, size: buf.length, hash: sha256(buf) });
      }
    }
  };

  for (const src of config.sources) {
    const abs = path.resolve(root, src);
    if (!(abs === root || abs.startsWith(root + path.sep))) continue;
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      visitDir(abs, toPosix(path.relative(root, abs)));
      continue;
    }
    if (st.isFile()) {
      const rel = toPosix(path.relative(root, abs));
      if (skipRel(rel) || isProtectedRel(rel)) continue;
      const buf = fs.readFileSync(abs);
      files.set(rel, { rel, abs, size: buf.length, hash: sha256(buf) });
    }
  }
  return { files, links, missing };
}

const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export function findMissingDocLinks(entryRel, content, files, root) {
  const missing = [];
  if (!/\.md$/i.test(entryRel)) return missing;
  const text = content.toString('utf8');
  const dir = path.posix.dirname(entryRel);
  for (const m of text.matchAll(MD_LINK_RE)) {
    let link = m[1].trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('#') || link.startsWith('//')) continue;
    link = link.split('#')[0].split('?')[0];
    if (!link) continue;
    const resolved = path.posix.normalize(path.posix.join(dir, link));
    if (resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
      missing.push({ kind: 'doc-link', entry: entryRel, link });
      continue;
    }
    if (files.has(resolved)) continue;
    let exists = false;
    try {
      fs.lstatSync(path.join(root, resolved));
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) missing.push({ kind: 'doc-link', entry: entryRel, link });
  }
  return missing;
}

function collectTargetFiles(targetAbs) {
  const out = [];
  const walk = (absDir, relDir) => {
    let dirents;
    try {
      dirents = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of dirents) {
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      if (d.isSymbolicLink()) {
        out.push(rel);
        continue;
      }
      if (d.isDirectory()) {
        if (PROTECTED_DIRS.has(d.name)) continue;
        walk(path.join(absDir, d.name), rel);
        continue;
      }
      if (d.isFile()) out.push(rel);
    }
  };
  walk(targetAbs, '');
  return out;
}

export function buildPlan(root, config = loadConfig(root)) {
  const allowRaw = loadAllow(root);
  const keep = loadKeep(root);
  const { allowed, rejected } = normalizeAllow(allowRaw);
  const { files, links, missing: scanMissing } = scan(root, config);

  const byName = new Map();
  for (const f of files.values()) {
    const name = f.rel.split('/').pop();
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(f);
  }

  const entries = [];
  const duplicates = [];
  const missing = [...scanMissing];
  for (const [name, cands] of [...byName.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    cands.sort((a, b) => (a.rel < b.rel ? -1 : 1));
    let winner = cands[0];
    const keepRel = keep[name];
    if (typeof keepRel === 'string') {
      const chosen = cands.find((c) => c.rel === toPosix(keepRel));
      if (chosen) winner = chosen;
    }
    for (const c of cands) {
      if (c !== winner) duplicates.push({ name, kept: winner.rel, dropped: c.rel });
    }
    const content = fs.readFileSync(winner.abs);
    missing.push(...findMissingDocLinks(winner.rel, content, files, root));
    entries.push({ name, source: winner.rel, hash: winner.hash, size: winner.size });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const targetRel = toPosix(path.relative(root, path.resolve(root, config.target)));
  const expected = new Set(entries.map((e) => e.name));
  expected.add(MANIFEST_NAME);
  const stale = collectTargetFiles(path.resolve(root, config.target)).filter(
    (rel) => !expected.has(rel) && !isProtectedRel(rel),
  );
  const deletes = stale.filter((rel) => allowed.has(rel)).sort();
  const skippedDeletes = stale.filter((rel) => !allowed.has(rel)).sort();

  const manifestObj = { entries: {} };
  for (const e of entries) {
    manifestObj.entries[e.name] = { hash: e.hash, source: e.source };
  }
  const manifestBuf = Buffer.from(JSON.stringify(manifestObj, null, 2) + '\n', 'utf8');

  const fileList = [...files.values()].map((f) => [f.rel, f.size, f.hash]).sort();
  const cfgHash = sha256(
    JSON.stringify({
      allow: allowRaw,
      keep,
      sources: config.sources,
      target: config.target,
      excludes: config.excludes,
    }),
  );
  const fingerprint = sha256(JSON.stringify({ files: fileList, cfg: cfgHash }));

  const actions = [];
  for (const e of entries) {
    actions.push({ op: 'write', name: e.name, source: e.source, hash: e.hash, dest: `${targetRel}/${e.name}` });
  }
  for (const d of deletes) {
    actions.push({ op: 'delete', dest: `${targetRel}/${d}` });
  }
  actions.push({ op: 'manifest', hash: sha256(manifestBuf), dest: `${targetRel}/${MANIFEST_NAME}` });

  return {
    fingerprint,
    target: targetRel,
    entries,
    duplicates,
    missing,
    links,
    deletes,
    skippedDeletes,
    rejectedAllow: rejected,
    actions,
    manifestBuf,
  };
}

export function journalPath(root) {
  return path.join(root, '.migrate', 'journal.jsonl');
}

export function stepKey(e) {
  return `${e.op}:${e.dest}:${e.hash || ''}`;
}

export function loadJournal(root) {
  const set = new Set();
  try {
    const lines = fs.readFileSync(journalPath(root), 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        set.add(stepKey(JSON.parse(line)));
      } catch {
        // ignore malformed journal lines
      }
    }
  } catch {
    // no journal yet
  }
  return set;
}

export function appendJournal(root, entry) {
  const p = journalPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(entry) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function verifyStep(root, action) {
  const abs = path.join(root, action.dest);
  if (action.op === 'delete') {
    try {
      fs.lstatSync(abs);
      return false;
    } catch {
      return true;
    }
  }
  try {
    return sha256(fs.readFileSync(abs)) === action.hash;
  } catch {
    return false;
  }
}

export function executeStep(root, config, action, manifestBuf) {
  const abs = path.join(root, action.dest);
  if (action.op === 'delete') {
    const relToTarget = toPosix(path.relative(path.resolve(root, config.target), abs));
    if (relToTarget === '..' || relToTarget.startsWith('../') || path.isAbsolute(relToTarget)) {
      throw new Error(`delete escapes target: ${action.dest}`);
    }
    if (isProtectedRel(relToTarget)) {
      throw new Error(`refusing to delete protected path: ${action.dest}`);
    }
    fs.rmSync(abs, { force: true });
    return;
  }
  let buf;
  if (action.op === 'manifest') {
    buf = manifestBuf;
  } else {
    buf = fs.readFileSync(path.join(root, action.source));
    if (sha256(buf) !== action.hash) {
      const err = new Error(`source drifted during commit: ${action.source}`);
      err.code = 'DRIFT';
      throw err;
    }
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmpDir = path.join(root, '.migrate', 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `w-${action.hash}`);
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, abs);
}
