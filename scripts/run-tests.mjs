#!/usr/bin/env node
/**
 * Aşama 1 — Güvenli test çalıştırıcısı (N-02, N-04, B-14).
 *
 * - Test dosyaları elle listelenmez; `tests/**` altından glob tabanlı keşfedilir,
 *   böylece yeni bir test dosyası sessizce atlanamaz.
 * - Testler tek sıra hâlinde (`--test-concurrency=1`) çalışır: ortak bir kaynağa
 *   yazan suite'ler arasında yarış koşulu oluşmaz.
 * - Koşu öncesi/sonrası gerçek `data/` dizininin sha256 manifesti karşılaştırılır.
 *   Herhangi bir değişiklik testi başarısız yapar (CI kalite kapısı).
 *
 * Kullanım:
 *   node scripts/run-tests.mjs unit|taste [--list] [-- <ek tsx argümanları>]
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildManifest } from './check-data-integrity.mjs';
import { PROJECT_ROOT as ROOT, auditTestDiscovery, discoverTests } from './test-discovery.mjs';

const argv = process.argv.slice(2);
const group = argv[0];
const rest = argv.slice(1).filter((arg) => arg !== '--list');
const listOnly = argv.includes('--list');
const passthrough = rest.includes('--') ? rest.slice(rest.indexOf('--') + 1) : [];

if (group !== 'unit' && group !== 'taste') {
  console.error('Kullanım: node scripts/run-tests.mjs unit|taste [--list] [-- <tsx argümanları>]');
  process.exit(2);
}

const files = discoverTests(group);
const discovery = auditTestDiscovery();
if (discovery.missing.length > 0 || discovery.duplicates.length > 0) {
  console.error('[test-runner] HATA: test keşfi bütün dosyaları kapsamıyor.');
  for (const file of discovery.missing) console.error(`  - atlanmış: ${path.relative(ROOT, file)}`);
  for (const file of discovery.duplicates) console.error(`  - yinelenmiş: ${path.relative(ROOT, file)}`);
  process.exit(1);
}

if (listOnly) {
  console.log(`[test-runner] ${group}: ${files.length} dosya`);
  for (const file of files) console.log(path.relative(ROOT, file));
  process.exit(0);
}

if (files.length === 0) {
  console.error(`[test-runner] HATA: ${group} grubunda hiç test dosyası bulunamadı.`);
  process.exit(1);
}

const dataDir = path.resolve(ROOT, 'data');
const before = buildManifest(dataDir);

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cinethos-test-run-'));
const isWin = process.platform === 'win32';
const tsxBin = path.join(ROOT, 'node_modules', '.bin', isWin ? 'tsx.cmd' : 'tsx');

let status = 0;
try {
  const result = spawnSync(
    tsxBin,
    ['--test', '--test-concurrency=1', ...passthrough, ...files],
    {
      cwd: ROOT,
      stdio: 'inherit',
      shell: isWin,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        CINETRACK_TEST_MODE: '1',
        // Testler kendi geçici dizinini vermek zorunda; bu değişken yalnızca
        // açıkça dizin vermeyen yardımcılar için güvenli varsayılan sağlar.
        CINETRACK_TEST_RUN_ROOT: tmpRoot,
      },
    }
  );
  status = result.status ?? 1;
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

const after = buildManifest(dataDir);
const changes = [];
for (const [rel, meta] of Object.entries(before.files)) {
  const now = after.files[rel];
  if (!now) changes.push(`silindi: ${rel}`);
  else if (now.sha256 !== meta.sha256 || now.size !== meta.size) changes.push(`değişti: ${rel}`);
}
for (const rel of Object.keys(after.files)) {
  if (!before.files[rel]) changes.push(`eklendi: ${rel}`);
}

if (changes.length > 0) {
  console.error('[data-guard] HATA: testler gerçek veri dizinini değiştirdi:');
  for (const change of changes) console.error(`  - ${change}`);
  console.error('[data-guard] Testler başarısız sayıldı. Veri otomatik geri yüklenmedi.');
  process.exit(1);
}

console.log(
  `[data-guard] OK: ${path.relative(ROOT, dataDir) || 'data'}/ değişmedi ` +
    `(${Object.keys(after.files).length} dosya, ${files.length} test dosyası).`
);
process.exit(status === 0 ? 0 : 1);
