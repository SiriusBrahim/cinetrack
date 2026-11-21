/**
 * Aşama 1 — Uçtan uca veri bütünlüğü entegrasyon testleri (Senaryo A–G).
 *
 * Gerçek Express uygulaması ve gerçek HTTP uçları üzerinden çalışır; her test
 * kendi geçici veri dizinini kullanır (gerçek `data/` dizinine dokunulmaz).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createCineTrackApp } from '../src/server/app.ts';
import { parseBackupText } from '../src/core/cinetrack-core.ts';

const TOKEN = 'asama1-integration-token';
const T1 = '2026-01-01T10:00:00.000Z';
const T2 = '2026-02-01T10:00:00.000Z';
const T3 = '2026-03-01T10:00:00.000Z';
const T4 = '2026-04-01T10:00:00.000Z';

function emptyPrefs() {
  return { disliked: [], providers: [], mood: '', reminders: false, notified: [] };
}

function makeProfile(id, items, extra = {}) {
  return {
    id,
    name: `Profil ${id}`,
    createdAt: T1,
    preferences: emptyPrefs(),
    items,
    favoriteActors: [],
    isDemo: false,
    ...extra,
  };
}

function makeDoc(profiles, revision = 0) {
  return {
    version: 3,
    schemaVersion: 3,
    engineVersion: 'test',
    activeProfileId: profiles[0]?.id ?? 'PROFILE-DEFAULT',
    profiles,
    revision,
    updatedAt: T1,
  };
}

function fightClub(overrides = {}) {
  return {
    id: 550,
    media_type: 'movie',
    title: 'Dövüş Kulübü',
    release_date: '1999-10-15',
    status: 'watching',
    personal_rating: '',
    addedAt: T1,
    updatedAt: T1,
    status_changed_at: T1,
    ...overrides,
  };
}

async function startApp(dataDir) {
  const { app, storage } = createCineTrackApp({ dataDir, authToken: TOKEN });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    storage,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-CineTrack-Token': TOKEN,
    ...extra,
  };
}

async function readDoc(baseUrl) {
  const response = await fetch(`${baseUrl}/api/data`, { headers: headers() });
  assert.equal(response.status, 200);
  return response.json();
}

async function writeDoc(baseUrl, doc, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}/api/data`, {
    method: 'PUT',
    headers: headers(extraHeaders),
    body: JSON.stringify(doc),
  });
  return { status: response.status, body: await response.json() };
}

describe('Aşama 1 — uçtan uca veri bütünlüğü', () => {
  let dataDir;
  let server;

  beforeEach(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'ct-integration-'));
    server = await startApp(dataDir);
  });

  afterEach(async () => {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('Senaryo A — iki cihazın farklı alan değişiklikleri birlikte korunur', async () => {
    const seeded = await writeDoc(
      server.baseUrl,
      makeDoc([makeProfile('PROFILE-DEFAULT', [fightClub()])]),
      { 'X-CineTrack-Force-Write': '1' }
    );
    assert.equal(seeded.status, 200);

    const base = await readDoc(server.baseUrl);
    const baseRev = base.revision;

    // Cihaz A: puan verir (puan alanı + rating_changed_at).
    const deviceA = {
      ...base,
      profiles: [
        {
          ...base.profiles[0],
          items: [
            fightClub({
              personal_rating: 9,
              ratedAt: T2,
              rating_changed_at: T2,
              updatedAt: T2,
            }),
          ],
        },
      ],
    };

    // Cihaz B: yalnızca durumu tamamlar (durum alanı + status_changed_at).
    const deviceB = {
      ...base,
      profiles: [
        {
          ...base.profiles[0],
          items: [
            fightClub({
              status: 'completed',
              completedAt: T3,
              status_changed_at: T3,
              updatedAt: T3,
            }),
          ],
        },
      ],
    };

    const writeA = await writeDoc(server.baseUrl, deviceA, {
      'If-Match': `"rev-${baseRev}"`,
      'X-CineTrack-Merge': 'lossless',
    });
    assert.equal(writeA.status, 200);

    // Cihaz B eski revizyondan yazar; kayıpsız birleştirme yeni puanı korumalı.
    const writeB = await writeDoc(server.baseUrl, deviceB, {
      'If-Match': `"rev-${baseRev}"`,
      'X-CineTrack-Merge': 'lossless',
    });
    assert.equal(writeB.status, 200);

    const finalDoc = await readDoc(server.baseUrl);
    const item = finalDoc.profiles[0].items.find((entry) => entry.id === 550);
    assert.equal(item.personal_rating, 9, 'puan kayboldu');
    assert.equal(item.status, 'completed', 'durum kayboldu');
    assert.equal(item.rating_changed_at, T2);
    assert.equal(item.status_changed_at, T3);
  });

  it('Senaryo B — puan silme eski cihazdan geri gelmez', async () => {
    const base = await (async () => {
      await writeDoc(
        server.baseUrl,
        makeDoc([
          makeProfile('PROFILE-DEFAULT', [
            fightClub({
              status: 'completed',
              personal_rating: 9,
              ratedAt: T2,
              completedAt: T2,
              rating_changed_at: T2,
              updatedAt: T2,
            }),
          ]),
        ]),
        { 'X-CineTrack-Force-Write': '1' }
      );
      return readDoc(server.baseUrl);
    })();

    const cleared = {
      ...base,
      profiles: [
        {
          ...base.profiles[0],
          items: [
            fightClub({
              status: 'completed',
              personal_rating: '',
              personal_rating_cleared: true,
              completedAt: T2,
              rating_changed_at: T4,
              updatedAt: T4,
            }),
          ],
        },
      ],
    };
    const clearedWrite = await writeDoc(server.baseUrl, cleared, {
      'If-Match': `"rev-${base.revision}"`,
      'X-CineTrack-Merge': 'lossless',
    });
    assert.equal(clearedWrite.status, 200);

    // Eski cihaz hâlâ 9 puanlı belgeyi gönderir.
    const stale = {
      ...base,
      profiles: [
        {
          ...base.profiles[0],
          items: [
            fightClub({
              status: 'completed',
              personal_rating: 9,
              ratedAt: T2,
              completedAt: T2,
              rating_changed_at: T2,
              updatedAt: T2,
            }),
          ],
        },
      ],
    };
    const staleWrite = await writeDoc(server.baseUrl, stale, {
      'If-Match': `"rev-${base.revision}"`,
      'X-CineTrack-Merge': 'lossless',
    });
    assert.equal(staleWrite.status, 200);

    const finalDoc = await readDoc(server.baseUrl);
    const item = finalDoc.profiles[0].items.find((entry) => entry.id === 550);
    assert.equal(item.personal_rating, '', 'silinen puan geri geldi');
    assert.equal(item.personal_rating_cleared, true);
  });

  it('Senaryo C — silinen kayıt eski cihazdan geri dirilmez', async () => {
    // Tombstone'lar 30 günden eskiyse düşürüldüğü için taze damgalar kullanılır.
    const itemUpdatedAt = new Date(Date.now() - 120_000).toISOString();
    const deletedAt = new Date(Date.now() - 60_000).toISOString();

    const base = await (async () => {
      await writeDoc(
        server.baseUrl,
        makeDoc([
          makeProfile('PROFILE-DEFAULT', [
            fightClub({ updatedAt: itemUpdatedAt, status_changed_at: itemUpdatedAt }),
          ]),
        ]),
        { 'X-CineTrack-Force-Write': '1' }
      );
      return readDoc(server.baseUrl);
    })();

    const deleted = {
      ...base,
      profiles: [
        {
          ...base.profiles[0],
          items: [],
          deleted_keys: { 'movie:550': deletedAt },
        },
      ],
    };
    const deletedWrite = await writeDoc(server.baseUrl, deleted, {
      'If-Match': `"rev-${base.revision}"`,
      'X-CineTrack-Merge': 'lossless',
    });
    assert.equal(deletedWrite.status, 200);

    const stale = {
      ...base,
      profiles: [
        {
          ...base.profiles[0],
          items: [fightClub({ updatedAt: itemUpdatedAt, status_changed_at: itemUpdatedAt })],
        },
      ],
    };
    const staleWrite = await writeDoc(server.baseUrl, stale, {
      'If-Match': `"rev-${base.revision}"`,
      'X-CineTrack-Merge': 'lossless',
    });
    assert.equal(staleWrite.status, 200);

    const finalDoc = await readDoc(server.baseUrl);
    const profile = finalDoc.profiles[0];
    assert.equal(
      profile.items.some((item) => item.id === 550),
      false,
      'silinen kayıt geri geldi'
    );
    assert.ok(profile.deleted_keys?.['movie:550'], 'tombstone kayboldu');
  });

  it('Senaryo D — çoklu profil yedeği yeni ortama kayıpsız taşınır', async () => {
    const profiles = [
      makeProfile('PROFILE-AAA', [
        fightClub({ personal_rating: 8, ratedAt: T2, rating_changed_at: T2 }),
      ]),
      makeProfile('PROFILE-BBB', [
        {
          id: 1399,
          media_type: 'tv',
          title: 'Game of Thrones',
          first_air_date: '2011-04-17',
          status: 'completed',
          personal_rating: 7,
          addedAt: T1,
          updatedAt: T1,
        },
      ]),
    ];
    profiles[0].deleted_keys = { 'movie:999': new Date(Date.now() - 60_000).toISOString() };
    profiles[0].preferences.disliked = ['movie:42'];

    const seeded = await writeDoc(server.baseUrl, makeDoc(profiles), {
      'X-CineTrack-Force-Write': '1',
    });
    assert.equal(seeded.status, 200);

    const exported = await readDoc(server.baseUrl);
    const parsed = parseBackupText(JSON.stringify(exported));
    assert.equal(parsed.profiles.length, 2, 'yedekte profil kaybı');

    // Yeni ortam: aynı belgeyi sıfırdan yaz.
    const secondDir = mkdtempSync(path.join(os.tmpdir(), 'ct-integration-restore-'));
    const second = await startApp(secondDir);
    try {
      const restored = await writeDoc(
        second.baseUrl,
        makeDoc(parsed.profiles, 0),
        { 'X-CineTrack-Force-Write': '1' }
      );
      assert.equal(restored.status, 200);

      const restoredDoc = await readDoc(second.baseUrl);
      assert.equal(restoredDoc.profiles.length, 2);
      const a = restoredDoc.profiles.find((profile) => profile.id === 'PROFILE-AAA');
      const b = restoredDoc.profiles.find((profile) => profile.id === 'PROFILE-BBB');
      assert.equal(a.items.length, 1);
      assert.equal(a.items[0].personal_rating, 8);
      assert.deepEqual(a.preferences.disliked, ['movie:42']);
      assert.ok(a.deleted_keys?.['movie:999']);
      assert.equal(b.items.length, 1);
      assert.equal(b.items[0].title, 'Game of Thrones');
    } finally {
      await second.close();
      rmSync(secondDir, { recursive: true, force: true });
    }
  });

  it('Senaryo E/F — restore çakışması ve bozuk yedek mevcut veriyi bozmaz', async () => {
    await writeDoc(
      server.baseUrl,
      makeDoc([makeProfile('PROFILE-DEFAULT', [fightClub(), fightClub({ id: 551, title: 'X' })])]),
      { 'X-CineTrack-Force-Write': '1' }
    );
    const base = await readDoc(server.baseUrl);
    await server.storage.createSafetySnapshotSerialized();
    const backups = await server.storage.listBackupsAsync();
    assert.ok(backups.length >= 1);

    // Başka istemci yeni veri yazar.
    const newer = {
      ...base,
      profiles: [
        {
          ...base.profiles[0],
          items: [
            ...base.profiles[0].items,
            fightClub({ id: 552, title: 'Yeni Kayıt', updatedAt: T3 }),
          ],
        },
      ],
    };
    const newerWrite = await writeDoc(server.baseUrl, newer, { 'If-Match': `"rev-${base.revision}"` });
    assert.equal(newerWrite.status, 200);

    // Eski revizyonla restore reddedilir.
    const staleRestore = await fetch(`${server.baseUrl}/api/data/restore`, {
      method: 'POST',
      headers: headers({ 'If-Match': `"rev-${base.revision}"` }),
      body: JSON.stringify({ backupId: backups[0].id }),
    });
    assert.equal(staleRestore.status, 409);

    // Bozuk yedek mevcut veriyi değiştirmez.
    const brokenRestore = await fetch(`${server.baseUrl}/api/data/restore`, {
      method: 'POST',
      headers: headers({ 'If-Match': `"rev-${newerWrite.body.revision}"` }),
      body: JSON.stringify({ backupId: 'cinetrack-yok-rev1-0000.json' }),
    });
    assert.equal(brokenRestore.status, 404);

    const afterDoc = await readDoc(server.baseUrl);
    assert.equal(afterDoc.profiles[0].items.length, 3, 'mevcut veri bozuldu');
    assert.equal(afterDoc.revision, newerWrite.body.revision);
  });

  it('Senaryo G — bütün HTTP akışı gerçek data/ dizinini değiştirmez', async () => {
    const realDataDir = path.resolve(process.cwd(), 'data');
    assert.ok(!path.resolve(dataDir).startsWith(realDataDir + path.sep));
    assert.ok(server.storage.dataDir.startsWith(path.resolve(dataDir)));
  });
});
