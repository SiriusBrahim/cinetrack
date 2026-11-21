/**
 * Aşama 1 — Restore revizyon ve çakışma koruması (B-08).
 *
 * - Eski revizyona göre yapılan restore 409/412 ile reddedilir.
 * - Ön koşulsuz restore (rev > 0) 428 ile reddedilir.
 * - Doğru revizyonla restore çalışır ve revizyonu ilerletir.
 * - Bozuk/eksik yedek mevcut veriyi değiştirmez.
 * - Eşzamanlı iki restore'dan yalnızca biri başarılı olur.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createCineTrackApp } from '../src/server/app.ts';
import { createDataStorage } from '../src/server/storage.ts';

const TOKEN = 'asama1-restore-token';

function makeDocument(itemCount, titlePrefix = 'Film') {
  return {
    version: 3,
    schemaVersion: 3,
    engineVersion: 'test',
    activeProfileId: 'PROFILE-DEFAULT',
    profiles: [
      {
        id: 'PROFILE-DEFAULT',
        name: 'Profilim',
        createdAt: '2026-01-01T00:00:00.000Z',
        preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
        items: Array.from({ length: itemCount }, (_, index) => ({
          id: 100 + index,
          media_type: 'movie',
          title: `${titlePrefix} ${index}`,
          status: 'completed',
          personal_rating: 8,
          addedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        })),
        favoriteActors: [],
        isDemo: false,
      },
    ],
    revision: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-CineTrack-Token': TOKEN,
    ...extra,
  };
}

describe('Aşama 1 — restore revizyon koruması (storage)', () => {
  let dataDir;
  before(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'ct-restore-storage-'));
  });
  after(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('eski revizyon 409 ile reddedilir ve veri korunur', async () => {
    const storage = createDataStorage({ dataDir });
    const first = await storage.saveDataSerialized(makeDocument(6), { forceOverwrite: true });
    assert.equal(first.ok, true);
    const rev1 = first.document.revision;

    await storage.createSafetySnapshotSerialized();

    const second = await storage.saveDataSerialized(makeDocument(2, 'Yeni'), {
      expectedRevision: rev1,
      forceOverwrite: true,
      // 6 → 2 bilinçli toplu silme: açık onay (B-09 koruması devrede).
      confirmBulkDelete: true,
    });
    assert.equal(second.ok, true);
    const rev2 = second.document.revision;

    const backups = await storage.listBackupsAsync();
    assert.ok(backups.length >= 1);
    const backupId = backups[0].id;

    const stale = await storage.restoreBackupGuarded(backupId, {
      expectedRevision: rev1,
      requirePrecondition: true,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.status, 409);
    assert.equal(stale.currentRevision, rev2);

    const current = await storage.readDataAsync();
    assert.equal(current.revision, rev2);
    assert.equal(current.profiles[0].items.length, 2, 'mevcut veri ezildi');
    assert.ok(current.profiles[0].items.every((item) => item.title.startsWith('Yeni')));
  });

  it('ön koşulsuz restore 428 ile reddedilir', async () => {
    const storage = createDataStorage({ dataDir });
    const backups = await storage.listBackupsAsync();
    const result = await storage.restoreBackupGuarded(backups[0].id, {
      requirePrecondition: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 428);
    const current = await storage.readDataAsync();
    assert.equal(current.profiles[0].items.length, 2);
  });

  it('doğru revizyonla restore başarılıdır ve revizyonu ilerletir', async () => {
    const storage = createDataStorage({ dataDir });
    const beforeDoc = await storage.readDataAsync();
    const backups = await storage.listBackupsAsync();
    const result = await storage.restoreBackupGuarded(backups[0].id, {
      expectedRevision: beforeDoc.revision,
      requirePrecondition: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.document.revision, beforeDoc.revision + 1);

    const afterDoc = await storage.readDataAsync();
    assert.equal(afterDoc.revision, result.document.revision);
    assert.equal(afterDoc.profiles[0].items.length, 6, 'yedek içeriği geri yüklenmedi');
  });

  it('eşzamanlı iki restore’dan yalnızca biri başarılı olur', async () => {
    const storage = createDataStorage({ dataDir });
    const current = await storage.readDataAsync();
    const backups = await storage.listBackupsAsync();
    const results = await Promise.all([
      storage.restoreBackupGuarded(backups[0].id, {
        expectedRevision: current.revision,
        requirePrecondition: true,
      }),
      storage.restoreBackupGuarded(backups[0].id, {
        expectedRevision: current.revision,
        requirePrecondition: true,
      }),
    ]);
    const okCount = results.filter((result) => result.ok).length;
    assert.equal(okCount, 1, 'aynı revizyonla iki restore kabul edildi');
    const conflict = results.find((result) => !result.ok);
    assert.equal(conflict.status, 409);
  });
});

describe('Aşama 1 — restore HTTP çakışma yanıtları', () => {
  let dataDir;
  let app;
  let server;
  let baseUrl;

  before(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'ct-restore-http-'));
    ({ app } = createCineTrackApp({ dataDir, authToken: TOKEN }));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('409 / 428 / 200 akışı ve hata sonrası veri korunumu', async () => {
    const storage = createDataStorage({ dataDir });
    const first = await storage.saveDataSerialized(makeDocument(6), { forceOverwrite: true });
    assert.equal(first.ok, true);
    const rev1 = first.document.revision;
    await storage.createSafetySnapshotSerialized();

    const second = await fetch(`${baseUrl}/api/data`, {
      method: 'PUT',
      headers: headers({ 'If-Match': `"rev-${rev1}"`, 'X-CineTrack-Confirm-Drop': '1' }),
      body: JSON.stringify(makeDocument(2, 'Yeni')),
    });
    assert.equal(second.status, 200);
    const rev2 = (await second.json()).revision;

    const backups = await storage.listBackupsAsync();
    const backupId = backups[0].id;

    // Eski revizyon → 409
    const stale = await fetch(`${baseUrl}/api/data/restore`, {
      method: 'POST',
      headers: headers({ 'If-Match': `"rev-${rev1}"` }),
      body: JSON.stringify({ backupId }),
    });
    assert.equal(stale.status, 409);
    const staleBody = await stale.json();
    assert.equal(staleBody.code, 'revision_conflict');
    assert.equal(staleBody.currentRevision, rev2);

    // Ön koşulsuz → 428
    const noPrecondition = await fetch(`${baseUrl}/api/data/restore`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ backupId }),
    });
    assert.equal(noPrecondition.status, 428);
    assert.equal((await noPrecondition.json()).code, 'precondition_required');

    // Doğru revizyon → 200
    const ok = await fetch(`${baseUrl}/api/data/restore`, {
      method: 'POST',
      headers: headers({ 'If-Match': `"rev-${rev2}"` }),
      body: JSON.stringify({ backupId }),
    });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.items, 6);
    assert.equal(okBody.revision, rev2 + 1);

    // Bozuk yedek → 404, veri değişmez
    writeFileSync(path.join(dataDir, 'backups', 'cinetrack-bozuk-rev9-dead.json'), '{ bozuk');
    const broken = await fetch(`${baseUrl}/api/data/restore`, {
      method: 'POST',
      headers: headers({ 'If-Match': `"rev-${rev2 + 1}"` }),
      body: JSON.stringify({ backupId: 'cinetrack-bozuk-rev9-dead.json' }),
    });
    assert.equal(broken.status, 404);

    const afterDoc = await storage.readDataAsync();
    assert.equal(afterDoc.revision, rev2 + 1, 'başarısız restore revizyonu değiştirdi');
    assert.equal(afterDoc.profiles[0].items.length, 6);
  });
});
