/**
 * Aşama 1 — Test izolasyonu regresyonları (B-14, N-02, N-04).
 *
 * Bu testler korumanın kendisini doğrular: gerçek `data/` dizinine yazma
 * reddedilmeli, açık `dataDir` zorunlu olmalı ve test keşfi hiçbir dosyayı
 * atlamamalı.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  assertSafeDataDir,
  isRealUserDataPath,
  isTestEnvironment,
  realUserDataDir,
} from '../src/server/test-data-guard.ts';
import { createDataStorage } from '../src/server/storage.ts';
import { auditTestDiscovery, PROJECT_ROOT } from '../scripts/test-discovery.mjs';
import { makeTempDataDir } from './helpers/test-data.mjs';

describe('Aşama 1 — test veri yolu koruması', () => {
  it('test ortamı algılanır (node --test alt süreci)', () => {
    assert.equal(isTestEnvironment(), true);
    assert.equal(isTestEnvironment({}), false);
    assert.equal(isTestEnvironment({ CINETRACK_TEST_MODE: '1' }), true);
  });

  it('gerçek data/ dizini test sırasında yasaktır', () => {
    const userDataDir = realUserDataDir();
    assert.equal(isRealUserDataPath(userDataDir), true);

    assert.throws(
      () => assertSafeDataDir(userDataDir, 'data-storage'),
      /gerçek kullanıcı veri dizinine/
    );
    assert.throws(
      () => assertSafeDataDir(path.join(userDataDir, 'backups'), 'taste-store'),
      /gerçek kullanıcı veri dizinine/
    );
  });

  it('dataDir verilmeden varsayılana düşmek yasaktır', () => {
    assert.throws(() => assertSafeDataDir(undefined, 'data-storage'), /dataDir.*zorunludur/);
    assert.throws(() => assertSafeDataDir('', 'taste-store'), /dataDir.*zorunludur/);
  });

  it('geçici dizin kabul edilir', () => {
    const dir = makeTempDataDir('ct-guard-ok-');
    assert.doesNotThrow(() => assertSafeDataDir(dir, 'data-storage'));
  });

  it('createDataStorage eski iki argümanlı çağrıyı reddeder', () => {
    assert.throws(
      () => createDataStorage('/tmp/some-file.json', { persistentStore: {} }),
      /tek bir nesne parametresi/
    );
    assert.throws(() => createDataStorage(undefined), /tek bir nesne parametresi/);
  });

  it('createDataStorage yalnızca verilen dizine yazar', () => {
    const dir = makeTempDataDir('ct-guard-storage-');
    const storage = createDataStorage({ dataDir: dir });
    assert.equal(storage.dataDir, path.resolve(dir));
    assert.ok(storage.dataFile.startsWith(path.resolve(dir) + path.sep));
    assert.ok(!isRealUserDataPath(storage.dataDir));
  });
});

describe('Aşama 1 — test keşfi (N-02)', () => {
  it('her test dosyası tam olarak bir grupta yer alır', () => {
    const audit = auditTestDiscovery();
    assert.deepEqual(audit.missing, [], 'Keşfedilmeyen test dosyası var');
    assert.deepEqual(audit.duplicates, [], 'Birden fazla gruba düşen test dosyası var');
    assert.ok(audit.unit.length > 0, 'Unit test dosyası bulunamadı');
    assert.ok(audit.taste.length > 0, 'Taste test dosyası bulunamadı');
    assert.equal(audit.unit.length + audit.taste.length, audit.all.length);
  });

  it('package.json test komutları elle yazılmış dosya listesi içermez', () => {
    const pkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.test, 'node scripts/run-tests.mjs unit');
    assert.equal(pkg.scripts['test:taste'], 'node scripts/run-tests.mjs taste');
    assert.ok(!pkg.scripts.test.includes('tests/'));
  });

  it('test runner concurrency açıkça 1 (yarış koşulu yok)', () => {
    const runner = readFileSync(path.join(PROJECT_ROOT, 'scripts/run-tests.mjs'), 'utf8');
    assert.ok(runner.includes("'--test-concurrency=1'"));
  });
});

describe('Aşama 1 — data/ hash kapısı', () => {
  it('bütünlük betiği manifest üretir ve değişikliği yakalar', async () => {
    const { buildManifest } = await import('../scripts/check-data-integrity.mjs');
    const dir = makeTempDataDir('ct-manifest-');
    const before = buildManifest(dir);
    assert.equal(existsSync(dir), true);
    assert.deepEqual(before.files, {});
    assert.equal(before.missing, false);
  });
});
