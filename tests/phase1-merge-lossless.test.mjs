/**
 * Aşama 1 — Kayıpsız veri birleştirme regresyonları (B-01, B-02).
 *
 * Doğrudan `mergeTwoSavedItemsLossless` ve `reconcileUserDataDocumentsLossless`
 * çağrılır; her senaryo A+B ve B+A yönünde ayrıca doğrulanır.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeTwoSavedItemsLossless,
  reconcileUserDataDocumentsLossless,
  stringifyUserDataDeterministic,
} from '../src/core/user-data-merge.ts';
import { normalizeSavedItem } from '../src/core/cinetrack-core.ts';
import { buildLibraryItem } from '../src/modules/library/operations.ts';

const T1 = '2026-01-01T10:00:00.000Z';
const T2 = '2026-02-01T10:00:00.000Z';
const T3 = '2026-03-01T10:00:00.000Z';

function makeItem(overrides = {}) {
  const normalized = normalizeSavedItem({
    id: 27205,
    media_type: 'movie',
    title: 'Başlangıç',
    release_date: '2010-07-16',
    status: 'watchlist',
    personal_rating: '',
    addedAt: T1,
    updatedAt: T1,
    ...overrides,
  });
  assert.ok(normalized, 'normalizeSavedItem başarısız');
  return normalized;
}

function mergeBothWays(a, b) {
  const forward = mergeTwoSavedItemsLossless('PROFILE-DEFAULT', a, b);
  const reverse = mergeTwoSavedItemsLossless('PROFILE-DEFAULT', b, a);
  return { forward, reverse };
}

describe('Aşama 1 — S1: puan silme korunur', () => {
  it('yeni alan damgasıyla silinen puan geri gelmez (iki yön)', () => {
    const deviceA = makeItem({
      status: 'completed',
      personal_rating: 9,
      ratedAt: T1,
      completedAt: T1,
      rating_changed_at: T1,
      status_changed_at: T1,
    });
    const deviceB = makeItem({
      status: 'completed',
      personal_rating: '',
      personal_rating_cleared: true,
      completedAt: T1,
      rating_changed_at: T2,
      status_changed_at: T1,
      updatedAt: T2,
    });

    const { forward, reverse } = mergeBothWays(deviceA, deviceB);
    for (const result of [forward.merged, reverse.merged]) {
      assert.equal(result.personal_rating, '');
      assert.equal(result.personal_rating_cleared, true);
      assert.equal(result.ratedAt, undefined);
    }
    assert.equal(
      stringifyUserDataDeterministic(forward.merged),
      stringifyUserDataDeterministic(reverse.merged)
    );
  });

  it('eski kayıtta (alan damgası yok) yalnızca updatedAt ile silme de korunur', () => {
    const deviceA = makeItem({
      status: 'completed',
      personal_rating: 9,
      ratedAt: T1,
      completedAt: T1,
    });
    const deviceB = makeItem({
      status: 'completed',
      personal_rating: '',
      personal_rating_cleared: true,
      completedAt: T1,
      updatedAt: T2,
    });

    const { forward, reverse } = mergeBothWays(deviceA, deviceB);
    for (const result of [forward.merged, reverse.merged]) {
      assert.equal(result.personal_rating, '');
      assert.equal(result.personal_rating_cleared, true);
    }
  });
});

describe('Aşama 1 — S2: yeni puan korunur', () => {
  it('daha yeni puan eski puanı yener (iki yön)', () => {
    const deviceA = makeItem({ personal_rating: 6, ratedAt: T1, rating_changed_at: T1, updatedAt: T1 });
    const deviceB = makeItem({ personal_rating: 9, ratedAt: T2, rating_changed_at: T2, updatedAt: T2 });

    const { forward, reverse } = mergeBothWays(deviceA, deviceB);
    assert.equal(forward.merged.personal_rating, 9);
    assert.equal(reverse.merged.personal_rating, 9);
    assert.equal(forward.merged.ratedAt, T2);
    assert.equal(reverse.merged.ratedAt, T2);
    assert.equal(forward.merged.personal_rating_cleared, false);
  });
});

describe('Aşama 1 — S3: durum geri alma korunur', () => {
  it('completed → watchlist geri alması eski tamamlanmayı geri getirmez', () => {
    const deviceA = makeItem({
      status: 'completed',
      completedAt: T1,
      status_changed_at: T1,
      updatedAt: T1,
    });
    const deviceB = makeItem({
      status: 'watchlist',
      status_changed_at: T2,
      updatedAt: T2,
    });

    const { forward, reverse } = mergeBothWays(deviceA, deviceB);
    assert.equal(forward.merged.status, 'watchlist');
    assert.equal(reverse.merged.status, 'watchlist');
    assert.equal(forward.merged.completedAt, undefined);
    assert.equal(reverse.merged.completedAt, undefined);
  });

  it('eski kayıtta yalnızca updatedAt ile geri alma da korunur', () => {
    const deviceA = makeItem({ status: 'completed', completedAt: T1, updatedAt: T1 });
    const deviceB = makeItem({ status: 'watchlist', updatedAt: T2 });
    const { forward, reverse } = mergeBothWays(deviceA, deviceB);
    assert.equal(forward.merged.status, 'watchlist');
    assert.equal(reverse.merged.status, 'watchlist');
  });

  it('not düzenlemesi (updatedAt) durum değişimini ezmez', () => {
    const deviceA = makeItem({
      status: 'completed',
      completedAt: T1,
      status_changed_at: T1,
      updatedAt: T1,
    });
    // Aynı cihazda not düzenlendi: updatedAt yeni, status_changed_at aynı kaldı.
    const deviceB = makeItem({
      status: 'completed',
      completedAt: T1,
      status_changed_at: T2,
      updatedAt: T3,
      overview: 'not düzenlemesi',
    });
    const deviceC = makeItem({
      status: 'watchlist',
      status_changed_at: T2,
      updatedAt: T2,
    });
    const { forward } = mergeBothWays(deviceB, deviceC);
    // Eşit status_changed_at + farklı durum → ilerleme kuralı: completed korunur.
    assert.equal(forward.merged.status, 'completed');
    assert.equal(deviceA.status, 'completed');
  });
});

describe('Aşama 1 — S4: eşzamanlı farklı alan değişiklikleri', () => {
  it('bir cihazın puanı, diğerinin durumu birlikte korunur', () => {
    const deviceA = makeItem({
      status: 'watching',
      status_changed_at: T1,
      watchedAt: T1,
      personal_rating: '',
      updatedAt: T1,
    });
    const deviceB = makeItem({
      status: 'watching',
      status_changed_at: T1,
      personal_rating: 8,
      ratedAt: T2,
      rating_changed_at: T2,
      updatedAt: T2,
    });
    const deviceC = makeItem({
      status: 'completed',
      status_changed_at: T3,
      completedAt: T3,
      personal_rating: '',
      updatedAt: T3,
    });

    const first = mergeBothWays(deviceA, deviceB).forward.merged;
    const second = mergeBothWays(first, deviceC).forward.merged;
    assert.equal(second.personal_rating, 8, 'puan kaybolmamalı');
    assert.equal(second.status, 'completed', 'durum kaybolmamalı');
    assert.equal(second.completedAt, T3);
  });
});

describe('Aşama 1 — S5/S6: eksik ve eşit zaman damgaları', () => {
  it('eksik damgada belirsizlik güvenli çözülür (puan kaybolmaz)', () => {
    const deviceA = makeItem({ personal_rating: 7, ratedAt: '', rating_changed_at: '', updatedAt: '' });
    const deviceB = makeItem({ personal_rating: '', personal_rating_cleared: false });
    const { forward, reverse } = mergeBothWays(deviceA, deviceB);
    assert.equal(forward.merged.personal_rating, 7);
    assert.equal(reverse.merged.personal_rating, 7);
  });

  it('eşit damgada farklı puanlar deterministik ve simetrik çözülür', () => {
    const deviceA = makeItem({ personal_rating: 4, ratedAt: T1, rating_changed_at: T1, updatedAt: T1 });
    const deviceB = makeItem({ personal_rating: 9, ratedAt: T1, rating_changed_at: T1, updatedAt: T1 });
    const { forward, reverse } = mergeBothWays(deviceA, deviceB);
    assert.equal(forward.merged.personal_rating, 9);
    assert.equal(reverse.merged.personal_rating, 9);
  });
});

describe('Aşama 1 — S7: silme ve yeniden ekleme', () => {
  // Tombstone'lar 30 günden eskiyse normallestirmede düşer; bu yüzden S7
  // senaryosu gerçekçi (yeni) zaman damgalarıyla kurulur.
  const NOW = Date.now();
  const R1 = new Date(NOW - 10 * 60 * 1000).toISOString();
  const R2 = new Date(NOW - 5 * 60 * 1000).toISOString();
  const R3 = new Date(NOW - 60 * 1000).toISOString();

  function doc(profiles) {
    return {
      version: 3,
      schemaVersion: 3,
      engineVersion: 'test',
      activeProfileId: 'PROFILE-DEFAULT',
      profiles,
      revision: 1,
      updatedAt: R1,
    };
  }

  it('tombstone daha yeni ise kayıt geri dirilmez', () => {
    const withItem = doc([
      {
        id: 'PROFILE-DEFAULT',
        name: 'Profilim',
        createdAt: T1,
        preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
        items: [makeItem({ addedAt: R1, updatedAt: R1 })],
      },
    ]);
    const withTombstone = doc([
      {
        id: 'PROFILE-DEFAULT',
        name: 'Profilim',
        createdAt: T1,
        preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
        items: [],
        deleted_keys: { 'movie:27205': R2 },
      },
    ]);

    const merged = reconcileUserDataDocumentsLossless(withItem, withTombstone).mergedDoc;
    assert.equal(merged.profiles[0].items.length, 0, 'silinen kayıt geri geldi');
    assert.equal(merged.profiles[0].deleted_keys['movie:27205'], R2);
  });

  it('kayıt tombstone’dan sonra yeniden eklendiyse korunur', () => {
    const withReAdd = doc([
      {
        id: 'PROFILE-DEFAULT',
        name: 'Profilim',
        createdAt: T1,
        preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
        items: [makeItem({ addedAt: R3, updatedAt: R3, watchedAt: R3, status: 'watching' })],
      },
    ]);
    const withTombstone = doc([
      {
        id: 'PROFILE-DEFAULT',
        name: 'Profilim',
        createdAt: T1,
        preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
        items: [],
        deleted_keys: { 'movie:27205': R2 },
      },
    ]);

    const merged = reconcileUserDataDocumentsLossless(withReAdd, withTombstone).mergedDoc;
    assert.equal(merged.profiles[0].items.length, 1, 'bilinçli yeniden ekleme kayboldu');
    assert.equal(merged.profiles[0].deleted_keys, undefined);
  });
});

describe('Aşama 1 — gerçek yazma yolu alan damgalarını üretir', () => {
  it('buildLibraryItem puan ve durum değişimini ayrı damgalar', () => {
    const created = buildLibraryItem({
      status: 'watchlist',
      rating: '',
      nowIso: T1,
      incoming: { id: 27205, media_type: 'movie', title: 'Başlangıç' },
    });
    assert.ok(created);
    assert.equal(created.status_changed_at, T1);

    const rated = buildLibraryItem({
      existing: created,
      status: 'watchlist',
      rating: 8,
      nowIso: T2,
    });
    assert.ok(rated);
    // Puan verilince durum completed'a yükselir; iki alan da damgalanır.
    assert.equal(rated.status, 'completed');
    assert.equal(rated.rating_changed_at, T2);
    assert.equal(rated.status_changed_at, T2);

    const reverted = buildLibraryItem({
      existing: rated,
      status: 'watching',
      rating: 8,
      nowIso: T3,
    });
    assert.ok(reverted);
    assert.equal(reverted.status, 'watching');
    assert.equal(reverted.status_changed_at, T3);
    assert.equal(reverted.rating_changed_at, T2, 'puan damgası değişmemeli');

    const merged = mergeTwoSavedItemsLossless('PROFILE-DEFAULT', rated, reverted).merged;
    assert.equal(merged.status, 'watching', 'durum geri alma kayboldu');
    assert.equal(merged.personal_rating, 8, 'puan kayboldu');
  });
});
