#!/usr/bin/env node
/**
 * Aşama 1 — Test dosyası keşfi (N-02).
 *
 * Tek kaynak: `npm test` ve `npm run test:taste` bu modülden beslenir. Elle
 * yazılmış dosya listesi yoktur; `tests/**` altındaki her `*.test.mjs` dosyası
 * tam olarak bir gruba düşer. Yeni bir test dosyası sessizce atlanamaz.
 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TESTS_DIR = path.join(PROJECT_ROOT, 'tests');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) out.push(abs);
  }
  return out;
}

export function discoverTests(group) {
  const all = existsSync(TESTS_DIR) ? walk(TESTS_DIR).sort() : [];
  const tasteDir = path.join(TESTS_DIR, 'taste') + path.sep;
  const isTaste = (file) => file.startsWith(tasteDir);
  return group === 'taste' ? all.filter(isTaste) : all.filter((file) => !isTaste(file));
}

/** Her test dosyası tam olarak bir grupta mı? (CI kalite kapısı) */
export function auditTestDiscovery() {
  const unit = discoverTests('unit');
  const taste = discoverTests('taste');
  const all = existsSync(TESTS_DIR) ? walk(TESTS_DIR).sort() : [];
  const seen = new Set();
  const duplicates = [];
  for (const file of [...unit, ...taste]) {
    if (seen.has(file)) duplicates.push(file);
    seen.add(file);
  }
  const missing = all.filter((file) => !seen.has(file));
  return { unit, taste, all, duplicates, missing };
}
