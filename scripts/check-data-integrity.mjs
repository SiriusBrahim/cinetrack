#!/usr/bin/env node
/**
 * Aşama 1 — `data/` bütünlük kapısı (B-14).
 *
 * Test sürecinden önce gerçek kullanıcı veri dizininin manifestini (yol, boyut,
 * sha256) üretir; sonra aynı manifesti karşılaştırır. Herhangi bir ekleme,
 * silme veya değişiklik test sürecini başarısız yapar.
 *
 * Kullanım:
 *   node scripts/check-data-integrity.mjs snapshot <manifest.json> [dataDir]
 *   node scripts/check-data-integrity.mjs verify   <manifest.json> [dataDir]
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function walk(dir, relative = '', out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walk(abs, rel, out);
    } else if (entry.isFile()) {
      out.push({ rel, abs });
    }
  }
  return out;
}

export function buildManifest(dataDir) {
  const files = {};
  const root = path.resolve(dataDir);
  if (!existsSync(root)) return { dataDir: root, missing: true, files };
  for (const { rel, abs } of walk(root)) {
    const stat = statSync(abs);
    const hash = createHash('sha256').update(readFileSync(abs)).digest('hex');
    files[rel] = { size: stat.size, sha256: hash };
  }
  return { dataDir: root, missing: false, files };
}

function diffManifests(before, after) {
  const changes = [];
  for (const [rel, meta] of Object.entries(before.files)) {
    const now = after.files[rel];
    if (!now) {
      changes.push(`silindi: ${rel}`);
    } else if (now.sha256 !== meta.sha256 || now.size !== meta.size) {
      changes.push(`değişti: ${rel} (${meta.size} -> ${now.size} bayt)`);
    }
  }
  for (const rel of Object.keys(after.files)) {
    if (!before.files[rel]) changes.push(`eklendi: ${rel}`);
  }
  return changes;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (!isMain) {
  // Yalnızca modül olarak içe aktarıldı (run-tests.mjs) — CLI çalıştırılmaz.
} else {
const [, , mode, manifestPath, dataDirArg] = process.argv;
const dataDir = path.resolve(dataDirArg || path.join(process.cwd(), 'data'));

if (mode === 'snapshot') {
  if (!manifestPath) {
    console.error('Kullanım: check-data-integrity.mjs snapshot <manifest.json> [dataDir]');
    process.exit(2);
  }
  const manifest = buildManifest(dataDir);
  writeFileSync(path.resolve(manifestPath), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(
    `[data-guard] Manifest yazıldı: ${manifestPath} (${Object.keys(manifest.files).length} dosya, ${dataDir})`
  );
  process.exit(0);
} else if (mode === 'verify') {
  if (!manifestPath) {
    console.error('Kullanım: check-data-integrity.mjs verify <manifest.json> [dataDir]');
    process.exit(2);
  }
  const before = JSON.parse(readFileSync(path.resolve(manifestPath), 'utf8'));
  const after = buildManifest(dataDir);
  const changes = diffManifests(before, after);
  if (changes.length > 0) {
    console.error('[data-guard] HATA: gerçek veri dizini test sırasında değişti:');
    for (const change of changes) console.error(`  - ${change}`);
    process.exit(1);
  }
  console.log(
    `[data-guard] OK: ${dataDir} değişmedi (${Object.keys(after.files).length} dosya).`
  );
  process.exit(0);
} else {
  console.error('Bilinmeyen mod. Kullanım: snapshot|verify');
  process.exit(2);
}
}
