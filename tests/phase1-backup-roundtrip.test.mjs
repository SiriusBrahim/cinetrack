/**
 * Aşama 1 — Yedekleme bütünlüğü (B-05, B-06, B-07).
 *
 * v4 tam belge round-trip'i, çoklu profil, tombstone, aktif profil, sürüm
 * kapısı ve bozuk/eksik yedek davranışı doğrudan doğrulanır.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  LATEST_BACKUP_VERSION,
  normalizeSavedItem,
  parseBackupText,
} from '../src/core/cinetrack-core.ts';
import {
  buildLocalBackupDocument,
  buildBackupFileName,
} from '../src/app/profile-backup.ts';

const T1 = '2026-01-01T10:00:00.000Z';
const T2 = '2026-02-01T10:00:00.000Z';
const NOW = '2026-11-21T09:00:00.000Z';
// Tombstone'lar 30 günden eskiyse normalizasyonda düşer; gerçekçi yeni damga kullanılır.
const RECENT_TOMBSTONE = new Date(Date.now() - 60_000).toISOString();

function item(id, overrides = {}) {
  const normalized = normalizeSavedItem({
    id,
    media_type: 'movie',
    title: `Film ${id}`,
    status: 'completed',
    personal_rating: 8,
    ratedAt: T1,
    completedAt: T1,
    addedAt: T1,
    updatedAt: T1,
    ...overrides,
  });
  assert.ok(normalized);
  return normalized;
}

function emptyPrefs() {
  return { disliked: [], providers: [], mood: '', reminders: false, notified: [] };
}

function makeProfiles() {
  const profileA = {
    id: 'PROFILE-AAA',
    name: 'Ana Profil',
    createdAt: T1,
    preferences: { ...emptyPrefs(), disliked: ['movie:99'] },
    items: [item(1), item(2)],
    favoriteActors: [],
    deleted_keys: { 'movie:777': RECENT_TOMBSTONE },
    isDemo: false,
  };
  const profileB = {
    id: 'PROFILE-BBB',
    name: 'İkinci Profil',
    createdAt: T1,
    preferences: emptyPrefs(),
    items: [item(3, { media_type: 'tv', first_air_date: '2020-01-01' })],
    favoriteActors: [],
    isDemo: false,
  };
  return { profileA, profileB };
}

function exportAll(profiles, activeId, revision) {
  const active = profiles.find((profile) => profile.id === activeId);
  return buildLocalBackupDocument({
    profileId: active.id,
    profileName: active.name,
    items: active.items,
    cinemaKunye: { version: 1, entries: {} },
    preferences: active.preferences,
    favoriteActors: active.favoriteActors,
    isDemo: active.isDemo,
    nowIso: NOW,
    profiles,
    deletedKeys: active.deleted_keys,
    ...(revision !== undefined ? { revision } : {}),
  });
}

describe('Aşama 1 — yedek belgesi v4 kapsamı', () => {
  it('bütün profilleri, aktif profili, tombstone ve revizyonu yazar', () => {
    const { profileA, profileB } = makeProfiles();
    const backup = exportAll([profileA, profileB], 'PROFILE-AAA', 12);

    assert.equal(backup.version, 4);
    assert.equal(backup.activeProfileId, 'PROFILE-AAA');
    assert.equal(backup.profiles.length, 2);
    assert.equal(backup.revision, 12);
    assert.deepEqual(backup.profiles[0].deleted_keys, { 'movie:777': RECENT_TOMBSTONE });
    assert.equal(backup.profiles[1].id, 'PROFILE-BBB');
    // Legacy alanlar hâlâ aktif profili taşır.
    assert.equal(backup.profileId, 'PROFILE-AAA');
    assert.equal(backup.items.length, 2);
    assert.match(buildBackupFileName(NOW), /^cinethos-local-backup-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it('v4 round-trip bütün profilleri ve alanları korur', () => {
    const { profileA, profileB } = makeProfiles();
    const first = exportAll([profileA, profileB], 'PROFILE-BBB', 7);
    const parsed = parseBackupText(JSON.stringify(first, null, 2));

    assert.equal(parsed.version, 4);
    assert.equal(parsed.containsFullDocument, true);
    assert.equal(parsed.activeProfileId, 'PROFILE-BBB');
    assert.equal(parsed.revision, 7);
    assert.deepEqual(
      parsed.profiles.map((profile) => profile.id).sort(),
      ['PROFILE-AAA', 'PROFILE-BBB']
    );

    const a = parsed.profiles.find((profile) => profile.id === 'PROFILE-AAA');
    assert.deepEqual(a.deleted_keys, { 'movie:777': RECENT_TOMBSTONE });
    assert.deepEqual(a.preferences.disliked, ['movie:99']);
    assert.equal(a.items.length, 2);
    assert.equal(a.items[0].personal_rating, 8);

    // Yeni ortamda tekrar yedek → anlamsal eşitlik.
    const second = exportAll(parsed.profiles, parsed.activeProfileId, parsed.revision);
    assert.equal(second.profiles.length, first.profiles.length);
    assert.equal(second.activeProfileId, first.activeProfileId);
    for (const original of first.profiles) {
      const roundTripped = second.profiles.find((profile) => profile.id === original.id);
      assert.ok(roundTripped, `${original.id} round-trip sonrası kayboldu`);
      assert.equal(roundTripped.items.length, original.items.length);
      assert.deepEqual(roundTripped.deleted_keys, original.deleted_keys);
      assert.deepEqual(roundTripped.preferences.disliked, original.preferences.disliked);
    }
  });
});

describe('Aşama 1 — B-06: tam belge çoklu profil', () => {
  it('v3 /api/data çıktısındaki bütün profiller içe aktarılır', () => {
    const { profileA, profileB } = makeProfiles();
    const apiDocument = {
      version: 3,
      schemaVersion: 3,
      engineVersion: 'v3.2.0',
      activeProfileId: 'PROFILE-AAA',
      profiles: [profileA, profileB],
      revision: 5,
      updatedAt: T2,
    };
    const parsed = parseBackupText(JSON.stringify(apiDocument));
    assert.equal(parsed.profiles.length, 2);
    assert.equal(parsed.containsFullDocument, true);
    assert.equal(parsed.activeProfileId, 'PROFILE-AAA');
    assert.equal(
      parsed.profiles.find((profile) => profile.id === 'PROFILE-AAA').items.length,
      2
    );
  });

  it('tek profil yedeği geriye dönük uyumludur', () => {
    const { profileA } = makeProfiles();
    const legacy = {
      version: 3,
      schemaVersion: 3,
      engineVersion: 'v3.2.0',
      profileId: 'PROFILE-AAA',
      profileName: 'Ana Profil',
      items: profileA.items,
      preferences: profileA.preferences,
      favoriteActors: [],
      isDemo: false,
      exportedAt: NOW,
    };
    const parsed = parseBackupText(JSON.stringify(legacy));
    assert.equal(parsed.containsFullDocument, false);
    assert.equal(parsed.profiles.length, 1);
    assert.equal(parsed.profiles[0].id, 'PROFILE-AAA');
    assert.equal(parsed.items.length, 2);
  });

  it('v1 ve v2 yedekler kabul edilir', () => {
    const { profileA } = makeProfiles();
    for (const version of [1, 2]) {
      const legacy = {
        version,
        profileName: 'Eski Profil',
        items: profileA.items,
      };
      const parsed = parseBackupText(JSON.stringify(legacy));
      assert.equal(parsed.version, version);
      assert.equal(parsed.profiles.length, 1);
      assert.equal(parsed.profiles[0].items.length, 2);
    }
  });
});

describe('Aşama 1 — B-07: sürüm kapısı', () => {
  it('gelecek sürüm açık hata ile reddedilir', () => {
    const future = JSON.stringify({
      version: LATEST_BACKUP_VERSION + 1,
      profiles: [],
    });
    assert.throws(
      () => parseBackupText(future),
      /daha yeni bir Cinethos sürümüyle \(v5\)/
    );
  });

  it('sürüm bilgisi olmayan dosya reddedilir', () => {
    assert.throws(() => parseBackupText(JSON.stringify({ items: [] })), /sürüm bilgisi/);
  });
});

describe('Aşama 1 — bozuk ve eksik yedekler', () => {
  it('bozuk JSON net hata verir', () => {
    assert.throws(() => parseBackupText('{ bozuk'), /bozuk JSON/);
  });

  it('profil/kayıt içermeyen belge reddedilir', () => {
    assert.throws(() => parseBackupText(JSON.stringify({ version: 4 })), /geçerli bir Cinethos yedeği/);
  });

  it('yinelenen profil kimliği sessizce birleştirilmez, reddedilir', () => {
    const { profileA } = makeProfiles();
    const doc = {
      version: 4,
      activeProfileId: 'PROFILE-AAA',
      profiles: [profileA, { ...profileA, name: 'Kopya' }],
    };
    assert.throws(() => parseBackupText(JSON.stringify(doc)), /yinelenen profil kimliği/);
  });

  it('geçersiz profil kimliği sessizce düşürülmez, reddedilir', () => {
    const { profileA } = makeProfiles();
    const doc = {
      version: 4,
      activeProfileId: 'PROFILE-AAA',
      profiles: [profileA, { id: 'geçersiz kimlik!', name: 'X', items: [] }],
    };
    assert.throws(() => parseBackupText(JSON.stringify(doc)), /kimliği geçersiz/);
  });

  it('geçersiz kayıt kimliği içe aktarmayı durdurur', () => {
    const doc = {
      version: 4,
      activeProfileId: 'PROFILE-AAA',
      profiles: [
        {
          id: 'PROFILE-AAA',
          name: 'A',
          items: [{ id: 'abc', media_type: 'movie', title: 'Bozuk' }],
        },
      ],
    };
    assert.throws(() => parseBackupText(JSON.stringify(doc)), /geçersiz içerik kimliği/);
  });
});

describe('Aşama 1 — yinelenen ve boş kayıtlar', () => {
  it('yinelenen kayıtlar çoğaltılmaz, tekilleştirilir', () => {
    const duplicate = item(42);
    const doc = {
      version: 4,
      activeProfileId: 'PROFILE-AAA',
      profiles: [
        {
          id: 'PROFILE-AAA',
          name: 'A',
          items: [duplicate, { ...duplicate }],
        },
      ],
    };
    const parsed = parseBackupText(JSON.stringify(doc));
    assert.equal(parsed.profiles[0].items.length, 1);
  });

  it('boş profil korunur', () => {
    const doc = {
      version: 4,
      activeProfileId: 'PROFILE-EMPTY',
      profiles: [{ id: 'PROFILE-EMPTY', name: 'Boş', items: [] }],
    };
    const parsed = parseBackupText(JSON.stringify(doc));
    assert.equal(parsed.profiles.length, 1);
    assert.equal(parsed.profiles[0].items.length, 0);
    assert.equal(parsed.activeProfileId, 'PROFILE-EMPTY');
  });

  it('büyük veri kümesi kayıpsız taşınır', () => {
    const items = Array.from({ length: 500 }, (_, index) => item(1000 + index));
    const doc = {
      version: 4,
      activeProfileId: 'PROFILE-AAA',
      profiles: [{ id: 'PROFILE-AAA', name: 'Büyük', items }],
    };
    const parsed = parseBackupText(JSON.stringify(doc));
    assert.equal(parsed.profiles[0].items.length, 500);
  });
});
