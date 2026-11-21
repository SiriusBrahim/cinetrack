import {
  ALGORITHM_VERSION,
  buildTasteProfileV3,
  computeTasteProfileSignature,
  CURRENT_SCHEMA_VERSION,
  inferLifecycleRing,
  isItemSaved,
  makeMediaKey,
  normalizeDeletedKeys,
  RECOMMENDATION_WEIGHTS_V3,
  scoreCandidatesV3,
  type DataDocument,
  type Profile,
} from '../core/cinetrack-core.ts';
import { canonicalizeMediaKey, canonicalizeMediaKeyList } from '../core/keys.ts';
import {
  computeDerivedProfileContentHash,
  DERIVED_PROFILE_SCHEMA_VERSION,
  normalizeDerivedProfileItem,
} from '../core/derived-profile-cache.ts';
import type { SyncErrorCategory, SyncFileCategory } from '../core/sync-display.ts';
import {
  hashContent,
  stringifyDeterministic,
  toCanonicalKey,
  type CatalogRecord,
  type DerivedProfileDocument,
  type DerivedProfileItem,
} from './persistent-store.ts';

/**
 * Senkronize edilen kalıcı veri envanteri
 */
export const SYNC_STATIC_INVENTORY: ReadonlyArray<{
  repoPath: string;
  category: SyncFileCategory;
  personal: boolean;
  description: string;
}> = Object.freeze([
  {
    repoPath: 'data/catalog/movies.json',
    category: 'catalog_movies',
    personal: false,
    description: 'Ortak film kataloğu metaverileri (movie:<id>)',
  },
  {
    repoPath: 'data/catalog/tv.json',
    category: 'catalog_tv',
    personal: false,
    description: 'Ortak dizi kataloğu metaverileri (tv:<id>)',
  },
  {
    repoPath: 'data/catalog/manifest.json',
    category: 'catalog_manifest',
    personal: false,
    description: 'Katalog film/dizi sayıları ve içerik özeti doğrulaması',
  },
  {
    repoPath: 'data/cinetrack-data.json',
    category: 'user_data',
    personal: true,
    description: 'Kullanıcı profilleri, izleme listeleri, puanlar, tercihler ve favori oyuncular',
  },
  {
    repoPath: 'data/taste/cinetrack-taste-manifest.json',
    category: 'taste_manifest',
    personal: true,
    description: 'Taste Engine veri özeti ve versiyon bilgisi',
  },
  {
    repoPath: 'data/taste/cinetrack-taste-profile.json',
    category: 'taste_profile',
    personal: true,
    description: 'Kullanıcı Taste Engine profili ve metrikler',
  },
  {
    repoPath: 'data/stock.json',
    category: 'stock',
    personal: true,
    description: 'Stok içerik deposu (film + dizi, sınırsız ve media:key tekilleştirmeli)',
  },
  {
    repoPath: 'data/sinema-kunyesi.json',
    category: 'cinema_kunye',
    personal: true,
    description: 'Sinema Künyesi izlenen içerik tür/yıl/oyuncu metaverileri (içerik ID anahtarlı)',
  },
]);

export function computeRawUtf8Hash(rawContent: string): string {
  return hashContent(rawContent);
}

export function classifyGitHubHttpStatus(
  status: number,
  headers: Headers,
  bodyMessage: string
): SyncErrorCategory {
  const remaining = headers.get('x-ratelimit-remaining');
  const lower = (bodyMessage || '').toLowerCase();
  if (
    status === 429 ||
    (status === 403 && (remaining === '0' || lower.includes('rate limit') || lower.includes('secondary rate')))
  ) {
    return 'rate_limit';
  }
  if (status === 401 || status === 403) {
    return 'auth_error';
  }
  if (status === 404) {
    return 'not_found';
  }
  if (status === 409) {
    return 'conflict';
  }
  return 'http_error';
}

export function stripUserDataVolatileFields(doc: DataDocument): Record<string, any> {
  const profiles = [...(doc.profiles || [])]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => {
      const items = [...(p.items || [])]
        .map((it) => {
          const key = makeMediaKey(it);
          return {
            key,
            id: it.id,
            media_type: it.media_type,
            title: it.title,
            status: it.status,
            personal_rating: it.personal_rating === '' ? '' : Number(it.personal_rating),
            personal_rating_cleared: Boolean(it.personal_rating_cleared),
            status_changed_at: it.status_changed_at || '',
            rating_changed_at: it.rating_changed_at || '',
            season_progress: it.season_progress || {},
            season_episode_counts: it.season_episode_counts || {},
            genre_ids: [...(it.genre_ids || [])].sort((a, b) => a - b),
            overview: it.overview || '',
            poster_path: it.poster_path || '',
            backdrop_path: it.backdrop_path || '',
            isDemo: Boolean(it.isDemo),
          };
        })
        .sort((a, b) => a.key.localeCompare(b.key));

      const prefs = p.preferences || {
        disliked: [],
        providers: [],
        mood: '',
        reminders: false,
        notified: [],
      };
      const normalizedTombstones = normalizeDeletedKeys(p.deleted_keys);
      return {
        id: p.id,
        name: p.name,
        isDemo: Boolean(p.isDemo),
        preferences: {
          disliked: canonicalizeMediaKeyList(prefs.disliked || []).sort(),
          hidden: canonicalizeMediaKeyList(prefs.hidden || []).sort(),
          providers: [...(prefs.providers || [])].map(String).sort(),
          mood: prefs.mood || '',
          reminders: Boolean(prefs.reminders),
        },
        favoriteActors: [...(p.favoriteActors || [])]
          .map((a) => ({ id: a.id, name: a.name, profile_path: a.profile_path ?? null }))
          .sort((a, b) => a.id - b.id),
        ...(Object.keys(normalizedTombstones).length > 0
          ? { deleted_keys: normalizedTombstones }
          : {}),
        items,
      };
    });

  return {
    version: 3,
    schemaVersion: doc.schemaVersion || CURRENT_SCHEMA_VERSION,
    activeProfileId: doc.activeProfileId,
    profiles,
  };
}

export function computeUserDataSemanticHash(doc: DataDocument): string {
  return hashContent(stringifyDeterministic(stripUserDataVolatileFields(doc)));
}

/**
 * Kaynak profil ve katalogdan sunucu tarafında güncel türetilmiş profil belgesi üretir.
 */
export function buildFreshDerivedProfileDocumentOnServer(
  profile: Profile,
  movies: Record<string, CatalogRecord>,
  tv: Record<string, CatalogRecord>,
  sourceCatalogHash: string
): DerivedProfileDocument {
  const savedItems = profile.items || [];
  const preferences = profile.preferences || {
    disliked: [],
    providers: [],
    mood: '',
    reminders: false,
    notified: [],
  };
  const favoriteActors = profile.favoriteActors || [];
  const fingerprint = computeTasteProfileSignature(savedItems, preferences, favoriteActors, {
    targetType: 'all',
    algorithmVersion: ALGORITHM_VERSION,
  });

  const candidates: CatalogRecord[] = [...Object.values(movies), ...Object.values(tv)];
  const tasteProfile = buildTasteProfileV3(savedItems, {
    dislikedKeys: preferences.disliked || [],
  });
  const scored = scoreCandidatesV3(candidates, tasteProfile, {
    weights: RECOMMENDATION_WEIGHTS_V3,
    mood: preferences.mood || '',
  });

  const nowIso = new Date().toISOString();
  const items: Record<string, DerivedProfileItem> = {};

  for (const s of scored) {
    const cand = s.candidate || s;
    const key = toCanonicalKey(cand);
    if (!key) continue;
    const tasteScore = Math.max(
      1,
      Math.min(100, Math.round(Number(s.tasteScore ?? s.score ?? 50)))
    );
    const saved = isItemSaved(savedItems, cand, cand.media_type);
    const disliked = Boolean(
      preferences.disliked?.some((k) => canonicalizeMediaKey(k) === key)
    );
    const hidden = Boolean(
      preferences.hidden?.some((k) => canonicalizeMediaKey(k) === key)
    );
    const status: DerivedProfileItem['status'] = saved
      ? 'saved'
      : disliked
      ? 'disliked'
      : hidden
      ? 'hidden'
      : 'active';

    const normalized = normalizeDerivedProfileItem(key, {
      mediaKey: key,
      matchScore: tasteScore,
      tasteScore,
      priorityScore: tasteScore,
      lifecycleRing: inferLifecycleRing(key, { shownCount: 0, skippedCount: 0 }, []),
      signals: s.parts && Object.keys(s.parts).length > 0 ? s.parts : undefined,
      reasons: Array.isArray(s.tags) && s.tags.length > 0 ? s.tags : undefined,
      shownCount: 0,
      skippedCount: 0,
      demotionPenalty: 0,
      status,
      scoreCoverage: 'basic',
      calculatedAt: nowIso,
    });
    if (normalized) {
      items[key] = normalized;
    }
  }

  const contentHash = computeDerivedProfileContentHash({
    schemaVersion: DERIVED_PROFILE_SCHEMA_VERSION,
    profileId: profile.id,
    algorithmVersion: ALGORITHM_VERSION,
    profileFingerprint: fingerprint,
    sourceCatalogHash,
    items,
  });

  return {
    schemaVersion: DERIVED_PROFILE_SCHEMA_VERSION,
    profileId: profile.id,
    algorithmVersion: ALGORITHM_VERSION,
    profileFingerprint: fingerprint,
    sourceCatalogHash,
    contentHash,
    generatedAt: nowIso,
    items,
  };
}
