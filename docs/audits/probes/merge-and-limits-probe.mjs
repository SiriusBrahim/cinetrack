/**
 * Aşama 0 — salt okunur kanıt sondası.
 * Hiçbir dosyaya yazmaz; yalnızca saf fonksiyonları çağırır.
 */
import { normalizeSavedItem, normalizeDataDocument } from '../../../src/core/cinetrack-core.ts';
import { mergeTwoSavedItemsLossless } from '../../../src/core/user-data-merge.ts';

const T = (s) => `2025-01-01T00:00:00.000Z`.replace('2025-01-01', s);

function item(over = {}) {
  return normalizeSavedItem({
    id: 550,
    media_type: 'movie',
    title: 'Fight Club',
    status: 'watchlist',
    personal_rating: '',
    addedAt: T('2025-01-01'),
    ...over,
  });
}

function merge(name, local, remote, expect) {
  const { merged } = mergeTwoSavedItemsLossless('p1', local, remote);
  const actual = {
    status: merged.status,
    rating: merged.personal_rating,
    cleared: Boolean(merged.personal_rating_cleared),
  };
  console.log(
    JSON.stringify({
      name,
      expect,
      actual,
      pass:
        actual.status === expect.status &&
        String(actual.rating) === String(expect.rating) &&
        actual.cleared === expect.cleared,
    })
  );
}

// B-01 / S1 — puan silme, yalnızca updatedAt yeni (etkileşim tarihi yok)
merge(
  'S1_puan_silme_sadece_updatedAt',
  item({ personal_rating: '', personal_rating_cleared: true, updatedAt: T('2026-02-01') }),
  item({ personal_rating: 9, ratedAt: T('2025-06-01'), status: 'completed' }),
  { status: 'completed', rating: '', cleared: true }
);

// B-01 / S2 — puan silme + izleme durumu değişikliği (watchedAt yeni)
merge(
  'S2_puan_silme_watchedAt_yeni',
  item({
    personal_rating: '',
    personal_rating_cleared: true,
    status: 'watching',
    watchedAt: T('2026-02-01'),
    updatedAt: T('2026-02-01'),
  }),
  item({ personal_rating: 9, ratedAt: T('2025-06-01'), status: 'completed', completedAt: T('2025-06-01') }),
  { status: 'watching', rating: '', cleared: true }
);

// B-01 / S3 — durum geri alma (completed -> watchlist), yalnızca updatedAt yeni
merge(
  'S3_durum_geri_alma_sadece_updatedAt',
  item({ status: 'watchlist', updatedAt: T('2026-02-01') }),
  item({ status: 'completed', completedAt: T('2025-06-01'), watchedAt: T('2025-06-01') }),
  { status: 'watchlist', rating: '', cleared: false }
);

// B-01 / S4 — aynı zaman damgası, farklı puan
merge(
  'S4_esit_zaman_farkli_puan',
  item({ personal_rating: 7, ratedAt: T('2025-06-01') }),
  item({ personal_rating: 9, ratedAt: T('2025-06-01') }),
  { status: 'watchlist', rating: 7, cleared: false }
);

// B-01 / S5 — yeni puan eski puandan sonra verilmiş
merge(
  'S5_yeni_puan_kazanir',
  item({ personal_rating: 8, ratedAt: T('2026-02-01') }),
  item({ personal_rating: 9, ratedAt: T('2025-06-01') }),
  { status: 'watchlist', rating: 8, cleared: false }
);

// B-04 — profil limiti
const mkProfile = (id, itemCount = 0) => ({
  id,
  name: id,
  items: Array.from({ length: itemCount }, (_, i) =>
    item({ id: 1000 + i, title: `T${i}` })
  ),
});
const manyProfiles = normalizeDataDocument({
  version: 3,
  profiles: Array.from({ length: 22 }, (_, i) => mkProfile(`profile-${i}`)),
});
console.log(
  JSON.stringify({
    name: 'B04_profil_kirpma',
    input: 22,
    output: manyProfiles?.profiles?.length,
  })
);

const manyItems = normalizeDataDocument({
  version: 3,
  profiles: [mkProfile('p1', 25010)],
});
console.log(
  JSON.stringify({
    name: 'B04_kayit_kirpma',
    input: 25010,
    output: manyItems?.profiles?.[0]?.items?.length,
  })
);

const badProfile = normalizeDataDocument({
  version: 3,
  profiles: [mkProfile('user-1234', 3), mkProfile('profile-ok', 2)],
});
console.log(
  JSON.stringify({
    name: 'B04_gecersiz_profil_kimligi',
    inputProfiles: 2,
    outputProfiles: badProfile?.profiles?.map((p) => p.id),
    outputItems: badProfile?.profiles?.reduce((s, p) => s + p.items.length, 0),
  })
);
