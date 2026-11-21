import test from 'node:test';
import assert from 'node:assert/strict';

import { findImportCycles } from '../scripts/check-cycles.mjs';
import { mergeRemoteDocument } from '../src/app/server-sync.ts';
import {
  buildBackupFileName,
  buildLocalBackupDocument,
  resolveImportedFavoriteActors,
  resolveImportedPreferences,
} from '../src/app/profile-backup.ts';
import { normalizeDataDocument } from '../src/core/cinetrack-core.ts';

const BASELINE_CYCLES = 0; // sync/store runtime cycle was extracted into shared contracts and utilities.

test('Faz 3 · 8 — Yeni modüller bağımlılık döngüsü oluşturmaz', () => {
  const cycles = findImportCycles();
  assert.ok(
    cycles.length <= BASELINE_CYCLES,
    `döngü sayısı artmamalı (${cycles.length} > ${BASELINE_CYCLES}): ${JSON.stringify(cycles)}`
  );
  const NEW_MODULES = [
    'src/core/item-dates.ts',
    'src/core/season-progress.ts',
    'src/core/item-effective-state.ts',
    'src/core/semantic-ranking.ts',
    'src/core/recommendation-comparison.ts',
    'src/core/relationship-types.ts',
    'src/server/github-request.ts',
    'src/app/server-sync.ts',
    'src/app/profile-backup.ts',
    'src/server/persistent-store-types.ts',
    'src/server/persistent-store-utils.ts',
  ];
  for (const cycle of cycles) {
    for (const modulePath of NEW_MODULES) {
      assert.ok(!cycle.includes(modulePath), `yeni modül döngüde olmamalı: ${modulePath}`);
    }
  }
});

function doc(items, overrides = {}) {
  return normalizeDataDocument({
    version: 3,
    schemaVersion: 3,
    activeProfileId: 'PROFILE-DEFAULT',
    profiles: [
      {
        id: 'PROFILE-DEFAULT',
        name: 'Profilim',
        createdAt: '2024-01-01T00:00:00.000Z',
        preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
        items,
      },
    ],
    ...overrides,
  });
}

function item(id, overrides = {}) {
  return {
    id,
    media_type: 'movie',
    title: `İçerik ${id}`,
    vote_average: 7,
    vote_count: 100,
    popularity: 20,
    genre_ids: [18],
    status: 'watchlist',
    personal_rating: '',
    addedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('Faz 3 · 6/14 — Sunucu birleştirmesi yerel ve uzak kayıtları korur', () => {
  const local = doc([item(1), item(2)]);
  const remote = doc([item(2), item(3)]);

  const merged = mergeRemoteDocument(local, remote, { preferActiveFrom: 'local' });
  assert.ok(merged);
  assert.deepEqual(
    merged.mergedDoc.profiles[0].items.map((it) => it.id).sort((a, b) => a - b),
    [1, 2, 3],
    'iki taraftaki kayıtlar da korunur'
  );
  assert.equal(merged.activeProfile.id, 'PROFILE-DEFAULT');
  assert.equal(merged.shouldStayDirty, true, 'uzakta olmayan yerel kayıt kirli sayılır');

  const equal = mergeRemoteDocument(local, doc([item(1), item(2)]));
  assert.equal(equal.shouldStayDirty, false, 'içerik eşitse gereksiz push yok');
  assert.equal(mergeRemoteDocument(local, null), null, 'geçersiz uzak belge yerel durumu bozmaz');
});

test('Faz 3 · 14 — Profil yedeği tek kaynaktan üretilir', () => {
  const backup = buildLocalBackupDocument({
    profileId: 'PROFILE-DEFAULT',
    profileName: 'Profilim',
    items: [item(1)],
    cinemaKunye: { entries: {}, updatedAt: '2024-01-01T00:00:00.000Z' },
    preferences: { disliked: ['movie:9'], providers: ['netflix'], mood: 'huzurlu', reminders: false, notified: [] },
    favoriteActors: [{ id: 500, name: 'Oyuncu' }],
    isDemo: false,
    nowIso: '2026-03-04T10:00:00.000Z',
  });
  // Aşama 1 (B-05/B-06): yerel yedek artık v4 tam belge.
  assert.equal(backup.version, 4);
  assert.equal(backup.profiles.length, 1);
  assert.equal(backup.activeProfileId, 'PROFILE-DEFAULT');
  assert.equal(backup.profileId, 'PROFILE-DEFAULT');
  assert.equal(backup.items.length, 1);
  assert.deepEqual(backup.preferences.disliked, ['movie:9']);
  assert.equal(backup.exportedAt, '2026-03-04T10:00:00.000Z');
  assert.equal(buildBackupFileName('2026-03-04T10:00:00.000Z'), 'cinethos-local-backup-2026-03-04.json');
});

test('Faz 3 · 14 — İçe aktarma birleştirme/üzerine yazma kuralları korunur', () => {
  const current = { disliked: ['movie:1'], hidden: [], providers: ['netflix'], mood: 'huzurlu', reminders: true, notified: ['x'] };
  const incoming = { disliked: ['movie:2'], hidden: ['tv:3'], providers: ['prime'], mood: 'gergin' };

  const merged = resolveImportedPreferences(current, incoming, 'merge');
  assert.deepEqual(merged.disliked.sort(), ['movie:1', 'movie:2']);
  assert.deepEqual(merged.hidden, ['tv:3']);
  assert.deepEqual(merged.providers.sort(), ['netflix', 'prime']);
  assert.equal(merged.mood, 'gergin');
  assert.equal(merged.reminders, false);
  assert.deepEqual(merged.notified, []);

  const overwritten = resolveImportedPreferences(current, incoming, 'overwrite');
  assert.deepEqual(overwritten.disliked, ['movie:2']);
  assert.deepEqual(overwritten.providers, ['prime']);
  assert.equal(resolveImportedPreferences(current, null, 'merge'), null);

  const actors = resolveImportedFavoriteActors(
    [{ id: 500, name: 'A' }],
    [{ id: 500, name: 'A' }, { id: 600, name: 'B' }],
    'merge'
  );
  assert.equal(actors.length, 2);
  assert.deepEqual(
    resolveImportedFavoriteActors([{ id: 500, name: 'A' }], [{ id: 600, name: 'B' }], 'overwrite').map((a) => a.id),
    [600]
  );
});
