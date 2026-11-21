import { normalizeProfileId } from './profile-id.ts';
import {
  CURRENT_SCHEMA_VERSION,
  ENGINE_VERSION,
  canonicalizeMediaKeyList,
  dedupeItems,
  makeMediaKey,
  normalizeDeletedKeys,
  normalizeFavoriteActors,
  normalizePreferences,
  type DataDocument,
  type FavoriteActorInfo,
  type Preferences,
  type Profile,
  type SavedItem,
} from './cinetrack-core.ts';
import {
  buildCinemaKunyeContentId,
  extractItemReleaseYear,
  normalizeCinemaKunyeActorList,
  slugifyCinemaKunyeTitle,
} from './cinema-kunye.ts';
import type { UserDataConflictItem } from './sync-display.ts';
import { mergeSeasonProgressLossless } from './season-progress.ts';
import { resolveItemLastKnownTimestampMs } from './item-dates.ts';

function sortKeysDeepPure(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeepPure);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const v = record[key];
      if (v !== undefined) {
        sorted[key] = sortKeysDeepPure(v);
      }
    }
    return sorted;
  }
  return value;
}

export function stringifyUserDataDeterministic(value: unknown): string {
  return JSON.stringify(sortKeysDeepPure(value));
}

function statusProgressionRank(status?: string): number {
  if (status === 'completed') return 3;
  if (status === 'watching') return 2;
  return 1;
}

function pickEarliestIso(candidates: Array<string | undefined>): string | undefined {
  const valid = candidates.filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (valid.length === 0) return undefined;
  return [...valid].sort()[0];
}

function pickLatestIso(candidates: Array<string | undefined>): string | undefined {
  const valid = candidates.filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (valid.length === 0) return undefined;
  return [...valid].sort().slice(-1)[0];
}

/**
 * Mezar taşı karşılaştırması için kaydın "son bilinen" zamanı.
 * Faz 3: öncelik gerçek etkileşim tarihlerindedir; `updatedAt` yalnızca hiçbir
 * etkileşim tarihi olmayan eski kayıtta son çare olarak okunur (not düzenlemesi
 * silinmiş bir kaydı tek başına geri diriltmemelidir).
 */
export function getSavedItemEffectiveTimestampMs(item: SavedItem): number {
  return resolveItemLastKnownTimestampMs(item);
}

/**
 * Aşama 1 — Alan bazlı birleştirme zamanı.
 *
 * Her alan kendi değişiklik zamanıyla yarışır; bir kaydın bütün alanlarını tek
 * bir tarih (`ratedAt`/`updatedAt`) üzerinden birleştirmek puan silmeyi veya
 * durum geri almayı kaybettiriyordu (B-01).
 *
 * Öncelik (puan): `rating_changed_at` → temizleme işaretçisi varsa `updatedAt`
 *   (eski kayıtlarda tek sinyal) → `ratedAt` → `updatedAt`.
 * Öncelik (durum): `status_changed_at` → `updatedAt` (eski kayıtlarda tek sinyal)
 *   → `completedAt` → `watchedAt` → `addedAt`.
 *
 * `status_changed_at`/`rating_changed_at` yazan istemcilerde not düzenlemesi bu
 * alanları değiştirmediği için belirsizlik kalmaz.
 */
function fieldTimeMs(candidates: Array<string | undefined>): number {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    const ms = Date.parse(candidate);
    if (Number.isFinite(ms)) return ms;
  }
  return NaN;
}

function resolveStatusTimeMs(item: SavedItem): number {
  return fieldTimeMs([
    item.status_changed_at,
    item.updatedAt,
    item.completedAt,
    item.watchedAt,
    item.addedAt,
  ]);
}

function resolveRatingTimeMs(item: SavedItem): number {
  const hasRating =
    item.personal_rating !== '' && item.personal_rating != null && Number(item.personal_rating) > 0;
  return fieldTimeMs([
    item.rating_changed_at,
    item.personal_rating_cleared ? item.updatedAt : undefined,
    hasRating ? item.ratedAt : undefined,
    item.updatedAt,
    item.completedAt,
    item.watchedAt,
    item.addedAt,
  ]);
}

function ratingOnly(item: SavedItem): string {
  return item.personal_rating !== '' && item.personal_rating != null
    ? String(item.personal_rating)
    : '';
}

export function mergeTwoSavedItemsLossless(
  profileId: string,
  localItem: SavedItem,
  remoteItem: SavedItem
): {
  merged: SavedItem;
  conflict?: UserDataConflictItem;
  changedLocal: boolean;
  changedRemote: boolean;
} {
  const key = makeMediaKey(localItem);
  // Kaydın genel "son etkileşim" zamanı yalnızca alanların kendi zamanı
  // olmadığında (ör. metadata seçimi) kullanılır.
  const localTime =
    localItem.ratedAt ||
    localItem.completedAt ||
    localItem.watchedAt ||
    localItem.addedAt ||
    localItem.updatedAt ||
    '';
  const remoteTime =
    remoteItem.ratedAt ||
    remoteItem.completedAt ||
    remoteItem.watchedAt ||
    remoteItem.addedAt ||
    remoteItem.updatedAt ||
    '';

  const localStatusMs = resolveStatusTimeMs(localItem);
  const remoteStatusMs = resolveStatusTimeMs(remoteItem);
  const localRatingMs = resolveRatingTimeMs(localItem);
  const remoteRatingMs = resolveRatingTimeMs(remoteItem);

  const statusDiffers = localItem.status !== remoteItem.status;
  const localRatingStr = ratingOnly(localItem);
  const remoteRatingStr = ratingOnly(remoteItem);
  const bothHaveDifferentRatings =
    Boolean(localRatingStr) && Boolean(remoteRatingStr) && localRatingStr !== remoteRatingStr;

  let chosenStatus: SavedItem['status'] = localItem.status;
  let resolutionNote = '';

  if (statusDiffers) {
    if (Number.isFinite(localStatusMs) && Number.isFinite(remoteStatusMs) && localStatusMs !== remoteStatusMs) {
      if (remoteStatusMs > localStatusMs) {
        chosenStatus = remoteItem.status;
        resolutionNote = `Daha güncel alan damgalı uzak durum (${remoteItem.status}) seçildi`;
      } else {
        chosenStatus = localItem.status;
        resolutionNote = `Daha güncel alan damgalı yerel durum (${localItem.status}) korundu`;
      }
    } else {
      // Eşit veya eksik damga: deterministik ve simetrik kural — izleme
      // ilerlemesi daha ileri olan durum korunur (tamamlanma kaybolmaz).
      chosenStatus =
        statusProgressionRank(remoteItem.status) > statusProgressionRank(localItem.status)
          ? remoteItem.status
          : localItem.status;
      resolutionNote = `İzleme ilerlemesi daha ileri olan durum (${chosenStatus}) seçildi`;
    }
  }

  let chosenRating: number | '' = localItem.personal_rating;
  let chosenRatingCleared = Boolean(localItem.personal_rating_cleared);

  // Boş puan her zaman "puanı sildim" demek değildir: yalnızca açık
  // `personal_rating_cleared` işaretçisi olan taraf puan hakkında görüş bildirir.
  const localRatingOpinion = Boolean(localRatingStr) || Boolean(localItem.personal_rating_cleared);
  const remoteRatingOpinion = Boolean(remoteRatingStr) || Boolean(remoteItem.personal_rating_cleared);

  if (localRatingStr !== remoteRatingStr) {
    const localWinsByTime =
      localRatingOpinion &&
      remoteRatingOpinion &&
      Number.isFinite(localRatingMs) &&
      Number.isFinite(remoteRatingMs) &&
      localRatingMs !== remoteRatingMs &&
      localRatingMs > remoteRatingMs;
    const remoteWinsByTime =
      localRatingOpinion &&
      remoteRatingOpinion &&
      Number.isFinite(localRatingMs) &&
      Number.isFinite(remoteRatingMs) &&
      localRatingMs !== remoteRatingMs &&
      remoteRatingMs > localRatingMs;

    if (!remoteRatingOpinion) {
      // Diğer tarafta puan hiç verilmemiş: mevcut görüşü koru.
      chosenRating = localRatingStr ? localItem.personal_rating : '';
      chosenRatingCleared = !localRatingStr && Boolean(localItem.personal_rating_cleared);
    } else if (!localRatingOpinion) {
      chosenRating = remoteRatingStr ? remoteItem.personal_rating : '';
      chosenRatingCleared = !remoteRatingStr && Boolean(remoteItem.personal_rating_cleared);
    } else if (localWinsByTime) {
      chosenRating = localRatingStr ? localItem.personal_rating : '';
      chosenRatingCleared = !localRatingStr && Boolean(localItem.personal_rating_cleared);
      resolutionNote = resolutionNote
        ? `${resolutionNote}; puan alanının güncel değeri (${localRatingStr || 'temizlendi'}) seçildi`
        : `Puan alanının güncel değeri (${localRatingStr || 'temizlendi'}) seçildi`;
    } else if (remoteWinsByTime) {
      chosenRating = remoteRatingStr ? remoteItem.personal_rating : '';
      chosenRatingCleared = !remoteRatingStr && Boolean(remoteItem.personal_rating_cleared);
      resolutionNote = resolutionNote
        ? `${resolutionNote}; puan alanının güncel değeri (${remoteRatingStr || 'temizlendi'}) seçildi`
        : `Puan alanının güncel değeri (${remoteRatingStr || 'temizlendi'}) seçildi`;
    } else if (localRatingStr && remoteRatingStr) {
      // Eşit damga + iki farklı dolu puan: simetrik ve veri kaybını en aza
      // indiren kural — büyük puan korunur (A+B ve B+A aynı sonucu verir).
      const localValue = Number(localItem.personal_rating);
      const remoteValue = Number(remoteItem.personal_rating);
      chosenRating = remoteValue > localValue ? remoteItem.personal_rating : localItem.personal_rating;
      chosenRatingCleared = false;
      resolutionNote = resolutionNote
        ? `${resolutionNote}; eşit damgada daha yüksek puan (${chosenRating}) korundu`
        : `Eşit damgada daha yüksek puan (${chosenRating}) korundu`;
    } else {
      // Eşit/eksik damgada biri dolu biri temiz: puanı sessizce düşürmemek için
      // dolu puan korunur.
      chosenRating = localRatingStr ? localItem.personal_rating : remoteItem.personal_rating;
      chosenRatingCleared = false;
      resolutionNote = resolutionNote
        ? `${resolutionNote}; eşit damgada dolu puan (${chosenRating}) korundu`
        : `Eşit damgada dolu puan (${chosenRating}) korundu`;
    }
  }

  // Faz 3: sezon ilerlemesi sezon bazında deterministik birleştirilir. Bilinçli
  // geri alma (10 → 8) yeni damgayla kazanır; `Math.max` yalnızca hiçbir taraf
  // damga/işaret taşımayan legacy veride devreye girer.
  const seasonMerge = mergeSeasonProgressLossless(localItem, remoteItem);
  const mergedSeasonProgress: Record<number, number> = seasonMerge.season_progress;
  const mergedSeasonTotals: Record<number, number> = {
    ...(localItem.season_episode_counts || {}),
    ...(remoteItem.season_episode_counts || {}),
  };

  const genreSet = new Set<number>([
    ...(localItem.genre_ids || []),
    ...(remoteItem.genre_ids || []),
  ]);
  const richerOverview =
    (remoteItem.overview || '').trim().length > (localItem.overview || '').trim().length
      ? remoteItem.overview
      : localItem.overview || remoteItem.overview;

  const earliestAdded = pickEarliestIso([localItem.addedAt, remoteItem.addedAt]);
  const earliestFirstAdded = pickEarliestIso([
    localItem.firstAddedAt,
    remoteItem.firstAddedAt,
    localItem.addedAt,
    remoteItem.addedAt,
  ]);
  const latestUpdated = pickLatestIso([
    localTime,
    remoteTime,
    localItem.updatedAt,
    remoteItem.updatedAt,
  ]);
  const resolvedStatusChangedAt = pickLatestIso([
    localItem.status_changed_at,
    remoteItem.status_changed_at,
  ]);
  const resolvedRatingChangedAt = pickLatestIso([
    localItem.rating_changed_at,
    remoteItem.rating_changed_at,
  ]);

  const resolvedRatedAt =
    chosenRating !== '' && chosenRating != null
      ? pickLatestIso([localItem.ratedAt, remoteItem.ratedAt])
      : undefined;
  const resolvedWatchedAt = pickLatestIso([localItem.watchedAt, remoteItem.watchedAt]);
  const resolvedCompletedAt =
    chosenStatus === 'completed'
      ? pickEarliestIso([localItem.completedAt, remoteItem.completedAt])
      : undefined;

  const hasWatchMinutes =
    typeof localItem.totalWatchTimeMinutes === 'number' ||
    typeof remoteItem.totalWatchTimeMinutes === 'number';
  const mergedWatchMinutes = hasWatchMinutes
    ? Math.max(localItem.totalWatchTimeMinutes || 0, remoteItem.totalWatchTimeMinutes || 0)
    : undefined;

  const baseWinner = remoteTime > localTime ? remoteItem : localItem;
  const fallbackOther = baseWinner === remoteItem ? localItem : remoteItem;

  const pickBetterReleaseDate = (a?: string, b?: string): string | undefined => {
    const sa = typeof a === 'string' ? a.trim() : '';
    const sb = typeof b === 'string' ? b.trim() : '';
    if (!sa) return sb || undefined;
    if (!sb) return sa;
    if (sa.endsWith('-01-01') && !sb.endsWith('-01-01') && sb.slice(0, 4) === sa.slice(0, 4)) {
      return sb;
    }
    return sa;
  };

  const mergedCast = normalizeCinemaKunyeActorList(
    [...(baseWinner.cast || []), ...(fallbackOther.cast || [])],
    12
  );
  const rawCrew = [...(baseWinner.crew || []), ...(fallbackOther.crew || [])];
  const crewMap = new Map<string, NonNullable<SavedItem['crew']>[number]>();
  for (const member of rawCrew) {
    if (!member || typeof member.name !== 'string' || !member.name.trim()) continue;
    const cKey = `${member.id || member.name.toLowerCase()}:${member.job || ''}`;
    if (!crewMap.has(cKey)) {
      crewMap.set(cKey, {
        id: Number(member.id) || 0,
        name: member.name.trim(),
        job: String(member.job || 'Crew').trim(),
        ...(member.department ? { department: member.department } : {}),
      });
    }
    if (crewMap.size >= 10) break;
  }
  const mergedCrew = Array.from(crewMap.values());

  const resolvedReleaseDate = pickBetterReleaseDate(
    baseWinner.release_date,
    fallbackOther.release_date
  );
  const resolvedFirstAirDate = pickBetterReleaseDate(
    baseWinner.first_air_date,
    fallbackOther.first_air_date
  );

  const merged: SavedItem = {
    ...fallbackOther,
    ...baseWinner,
    id: localItem.id,
    media_type: localItem.media_type,
    title: baseWinner.title || fallbackOther.title,
    ...(resolvedReleaseDate !== undefined ? { release_date: resolvedReleaseDate } : {}),
    ...(resolvedFirstAirDate !== undefined ? { first_air_date: resolvedFirstAirDate } : {}),
    overview: richerOverview,
    poster_path: baseWinner.poster_path || fallbackOther.poster_path,
    poster_url: baseWinner.poster_url || fallbackOther.poster_url,
    backdrop_path: baseWinner.backdrop_path || fallbackOther.backdrop_path,
    genre_ids: Array.from(genreSet).sort((a, b) => a - b),
    status: chosenStatus,
    personal_rating: chosenRating,
    personal_rating_cleared: chosenRatingCleared,
    ...(resolvedStatusChangedAt ? { status_changed_at: resolvedStatusChangedAt } : {}),
    ...(resolvedRatingChangedAt ? { rating_changed_at: resolvedRatingChangedAt } : {}),
    ...(Object.keys(mergedSeasonProgress).length > 0
      ? { season_progress: mergedSeasonProgress }
      : {}),
    ...(Object.keys(seasonMerge.watched_episodes).length > 0
      ? { watched_episodes: seasonMerge.watched_episodes }
      : {}),
    ...(Object.keys(seasonMerge.progress_updated_at).length > 0
      ? { progress_updated_at: seasonMerge.progress_updated_at }
      : {}),
    ...(Object.keys(mergedSeasonTotals).length > 0
      ? { season_episode_counts: mergedSeasonTotals }
      : {}),
    ...(earliestFirstAdded ? { firstAddedAt: earliestFirstAdded } : {}),
    ...(mergedWatchMinutes !== undefined ? { totalWatchTimeMinutes: mergedWatchMinutes } : {}),
    ...(mergedCast.length > 0 ? { cast: mergedCast } : {}),
    ...(mergedCrew.length > 0 ? { crew: mergedCrew } : {}),
    ratedAt: resolvedRatedAt,
    ...(resolvedWatchedAt ? { watchedAt: resolvedWatchedAt } : {}),
    completedAt: resolvedCompletedAt,
    addedAt: earliestAdded || localItem.addedAt || remoteItem.addedAt,
    updatedAt: latestUpdated || localItem.updatedAt || remoteItem.updatedAt,
    isDemo: Boolean(localItem.isDemo && remoteItem.isDemo),
  };

  if (mergedCast.length === 0) {
    delete merged.cast;
  }
  if (mergedCrew.length === 0) {
    delete merged.crew;
  }
  if (!resolvedWatchedAt) {
    delete merged.watchedAt;
  }
  if (!resolvedRatedAt) {
    delete merged.ratedAt;
  }
  if (!resolvedCompletedAt) {
    delete merged.completedAt;
  }

  const itemSem = (it: SavedItem) =>
    stringifyUserDataDeterministic({
      status: it.status,
      rating: it.personal_rating === '' ? '' : Number(it.personal_rating),
      cleared: Boolean(it.personal_rating_cleared),
      statusChangedAt: it.status_changed_at || '',
      ratingChangedAt: it.rating_changed_at || '',
      ratedAt: it.ratedAt || '',
      completedAt: it.completedAt || '',
      watchedAt: it.watchedAt || '',
      progress: it.season_progress || {},
      watchedEpisodes: it.watched_episodes || {},
      overview: it.overview || '',
      poster: it.poster_path || '',
      genres: [...(it.genre_ids || [])].sort((a, b) => a - b),
    });

  const mergedSem = itemSem(merged);
  const changedLocal = itemSem(localItem) !== mergedSem;
  const changedRemote = itemSem(remoteItem) !== mergedSem;

  const conflict: UserDataConflictItem | undefined =
    statusDiffers || bothHaveDifferentRatings
      ? {
          profileId,
          mediaKey: key,
          title: merged.title,
          localStatus: localItem.status,
          remoteStatus: remoteItem.status,
          localRating: localItem.personal_rating,
          remoteRating: remoteItem.personal_rating,
          resolution: resolutionNote || 'Alan düzeyinde kayıpsız birleştirildi',
        }
      : undefined;

  return { merged, conflict, changedLocal, changedRemote };
}

/**
 * Yedek geri yükleme (JSON / CSV) sırasında mevcut liste ile içe aktarılan listeyi
 * hem mediaKey (movie:27205) hem de içerik ID'si (film/dizi adı + yıl, custom-* kayıtlar dahil)
 * üzerinden kayıpsız birleştirir.
 */
export function mergeSavedItemListsLossless(
  existingItems: SavedItem[],
  incomingItems: SavedItem[],
  profileId = 'active'
): SavedItem[] {
  const result = [...(Array.isArray(existingItems) ? existingItems : [])];

  const findMatchIndex = (candidate: SavedItem): number => {
    const candidateType = candidate.media_type === 'tv' ? 'tv' : 'movie';
    const candidateIdStr = String(candidate.id);
    const candidateByKey = result.findIndex(
      (it) =>
        (it.media_type === 'tv' ? 'tv' : 'movie') === candidateType &&
        String(it.id) === candidateIdStr
    );
    if (candidateByKey >= 0) return candidateByKey;

    const candTitle = (candidate.title || candidate.name || '').trim();
    if (!candTitle) return -1;
    const candYear = extractItemReleaseYear(candidate);
    const candContentId = buildCinemaKunyeContentId(candTitle, candYear);
    const candIsCustom = Boolean(candidate.custom || candidateIdStr.startsWith('custom-'));

    return result.findIndex((it) => {
      const itType = it.media_type === 'tv' ? 'tv' : 'movie';
      if (itType !== candidateType) return false;
      const itIsCustom = Boolean(it.custom || String(it.id).startsWith('custom-'));
      if (!candIsCustom && !itIsCustom) return false;
      const itTitle = (it.title || it.name || '').trim();
      if (!itTitle) return false;
      const itYear = extractItemReleaseYear(it);
      if (candYear !== null && itYear !== null) {
        return buildCinemaKunyeContentId(itTitle, itYear) === candContentId;
      }
      return slugifyCinemaKunyeTitle(itTitle) === slugifyCinemaKunyeTitle(candTitle);
    });
  };

  for (const incoming of Array.isArray(incomingItems) ? incomingItems : []) {
    if (!incoming) continue;
    const matchIdx = findMatchIndex(incoming);
    if (matchIdx === -1) {
      result.push(incoming);
      continue;
    }

    const existing = result[matchIdx];
    const existingIsNumeric = typeof existing.id === 'number' && !existing.custom;
    const incomingIsNumeric = typeof incoming.id === 'number' && !incoming.custom;

    const anchorItem = !existingIsNumeric && incomingIsNumeric ? incoming : existing;
    const otherItem = anchorItem === existing ? incoming : existing;

    const { merged } = mergeTwoSavedItemsLossless(profileId, anchorItem, otherItem);
    if (typeof anchorItem.id === 'number' && !anchorItem.custom) {
      merged.custom = false;
    }
    result[matchIdx] = merged;
  }

  return result;
}

export interface ReconcileUserDataOptions {
  /**
   * True when `localDoc` came from an unhydrated client/server session that created
   * a placeholder `profile-default` ("Profilim") before fetching existing remote profiles.
   * Folds those newly added items/tombstones directly into remote's active profile.
   */
  foldUnhydratedDefaultProfile?: boolean;
  /**
   * Controls which side's `activeProfileId` is preferred when both exist in the merged result.
   */
  preferActiveProfileFrom?: 'local' | 'remote';
  /**
   * When `'local'`, profile scalar/set preferences (`disliked`, `hidden`, `providers`, `mood`,
   * `reminders`), `favoriteActors`, `name`, and `isDemo` follow `localDoc` authoritatively
   * (used when client saves at matching server revision so un-disliking/unchecking sticks),
   * while `items` and `deleted_keys` STILL merge non-destructively!
   * Defaults to `'union'`.
   */
  authoritativeScalarSide?: 'local' | 'remote' | 'union';
}

/**
 * Kullanıcı verisini (`cinetrack-data.json`) varsayılan silmesiz (no-deletion) ve
 * `deleted_keys` mezar taşı (tombstone) duyarlı politikayla iki yönlü kayıpsız birleştirir.
 */
export function reconcileUserDataDocumentsLossless(
  localDoc: DataDocument,
  remoteDoc: DataDocument,
  options: ReconcileUserDataOptions = {}
): {
  mergedDoc: DataDocument;
  addedToLocal: number;
  addedToRemote: number;
  updatedItems: number;
  conflicts: UserDataConflictItem[];
} {
  const normalizeProfiles = (profiles: Profile[] | undefined): Profile[] =>
    (Array.isArray(profiles) ? profiles : []).flatMap((profile) => {
      const id = normalizeProfileId(profile?.id);
      return id ? [{ ...profile, id }] : [];
    });
  const localProfilesList = normalizeProfiles(localDoc.profiles);
  const remoteProfilesList = normalizeProfiles(remoteDoc.profiles);
  const remoteById = new Map<string, Profile>();
  for (const profile of remoteProfilesList) {
    remoteById.set(profile.id, profile);
  }
  const localActiveProfileId = normalizeProfileId(localDoc.activeProfileId) ?? '';
  const remoteActiveProfileId = normalizeProfileId(remoteDoc.activeProfileId) ?? '';

  // Unhydrated placeholder 'profile-default' tespiti:
  // Yerel oturum henüz uzak profilleri görmeden otomatik 'profile-default' ("Profilim") oluşturup
  // içine 1-2 yeni içerik eklediyse ve uzakta 'profile-default' olmayıp gerçek profil varsa,
  // yeni eklenen içerikleri uzaktaki aktif profile katla; kullanıcıyı 1 içerikli sahte profilde bırakma.
  const onlyLocalDefault =
    localProfilesList.length === 1 &&
    localProfilesList[0]?.id === 'PROFILE-DEFAULT' &&
    (localProfilesList[0]?.name || 'Profilim') === 'Profilim' &&
    !remoteById.has('PROFILE-DEFAULT') &&
    remoteProfilesList.length > 0;

  const autoHeuristicFold =
    onlyLocalDefault &&
    (localProfilesList[0]?.items?.length || 0) <= 5 &&
    remoteProfilesList.some(
      (rp) => !rp.isDemo && (rp.items?.length || 0) > (localProfilesList[0]?.items?.length || 0)
    );

  const shouldFoldDefault =
    onlyLocalDefault && (Boolean(options.foldUnhydratedDefaultProfile) || autoHeuristicFold);

  const foldedTargetId = shouldFoldDefault
    ? remoteById.has(remoteActiveProfileId)
      ? remoteActiveProfileId
      : remoteProfilesList[0].id
    : null;

  const localById = new Map<string, Profile>();
  for (const p of localProfilesList) {
    if (!p || !p.id) continue;
    const effectiveId =
      foldedTargetId && p.id === 'PROFILE-DEFAULT' ? foldedTargetId : p.id;
    localById.set(effectiveId, effectiveId === p.id ? p : { ...p, id: effectiveId });
  }

  const allProfileIds = Array.from(
    new Set<string>([...localById.keys(), ...remoteById.keys()])
  );

  const mergedProfiles: Profile[] = [];
  const conflicts: UserDataConflictItem[] = [];
  let addedToLocal = 0;
  let addedToRemote = 0;
  let updatedItems = 0;

  const scalarMode = shouldFoldDefault ? 'union' : options.authoritativeScalarSide || 'union';

  for (const profileId of allProfileIds) {
    const lp = localById.get(profileId);
    const rp = remoteById.get(profileId);

    if (lp && !rp) {
      mergedProfiles.push(lp);
      addedToRemote += (lp.items || []).length;
      continue;
    }
    if (rp && !lp) {
      mergedProfiles.push(rp);
      addedToLocal += (rp.items || []).length;
      continue;
    }
    if (!lp || !rp) continue;

    const lpLiveItems = lp.isDemo && !rp.isDemo ? [] : lp.items || [];
    const rpLiveItems = rp.isDemo && !lp.isDemo ? [] : rp.items || [];

    const localItemsMap = new Map<string, SavedItem>();
    for (const it of dedupeItems(lpLiveItems)) {
      localItemsMap.set(makeMediaKey(it), it);
    }
    const remoteItemsMap = new Map<string, SavedItem>();
    for (const it of dedupeItems(rpLiveItems)) {
      remoteItemsMap.set(makeMediaKey(it), it);
    }

    const lpDeleted = normalizeDeletedKeys(lp.deleted_keys);
    const rpDeleted = normalizeDeletedKeys(rp.deleted_keys);
    const mergedDeletedKeys: Record<string, string> = { ...lpDeleted };
    for (const [delKey, delIso] of Object.entries(rpDeleted)) {
      const existingIso = mergedDeletedKeys[delKey];
      if (!existingIso || Date.parse(delIso) > Date.parse(existingIso)) {
        mergedDeletedKeys[delKey] = delIso;
      }
    }

    const allItemKeys = Array.from(
      new Set<string>([...localItemsMap.keys(), ...remoteItemsMap.keys()])
    );

    const combinedItems: SavedItem[] = [];
    for (const key of allItemKeys) {
      const li = localItemsMap.get(key);
      const ri = remoteItemsMap.get(key);
      if (li && !ri) {
        const remoteTombstoneIso = rpDeleted[key];
        if (remoteTombstoneIso) {
          const liMs = getSavedItemEffectiveTimestampMs(li);
          const delMs = Date.parse(remoteTombstoneIso);
          if (Number.isFinite(liMs) && Number.isFinite(delMs) && liMs > delMs) {
            combinedItems.push(li);
            delete mergedDeletedKeys[key];
            addedToRemote++;
          } else {
            mergedDeletedKeys[key] = remoteTombstoneIso;
            updatedItems++;
          }
        } else {
          combinedItems.push(li);
          delete mergedDeletedKeys[key];
          addedToRemote++;
        }
      } else if (ri && !li) {
        const localTombstoneIso = lpDeleted[key];
        if (localTombstoneIso) {
          const riMs = getSavedItemEffectiveTimestampMs(ri);
          const delMs = Date.parse(localTombstoneIso);
          if (Number.isFinite(riMs) && Number.isFinite(delMs) && riMs > delMs) {
            combinedItems.push(ri);
            delete mergedDeletedKeys[key];
            addedToLocal++;
          } else {
            mergedDeletedKeys[key] = localTombstoneIso;
            updatedItems++;
          }
        } else {
          combinedItems.push(ri);
          delete mergedDeletedKeys[key];
          addedToLocal++;
        }
      } else if (li && ri) {
        const res = mergeTwoSavedItemsLossless(profileId, li, ri);
        combinedItems.push(res.merged);
        delete mergedDeletedKeys[key];
        if (res.conflict) conflicts.push(res.conflict);
        if (res.changedLocal || res.changedRemote) updatedItems++;
      }
    }

    let mergedPrefs: Preferences;
    let mergedFavActors: FavoriteActorInfo[];
    let profileName: string;
    let mergedIsDemo: boolean;

    if (scalarMode === 'local') {
      mergedPrefs = normalizePreferences(lp.preferences || {});
      mergedFavActors = normalizeFavoriteActors(lp.favoriteActors || []);
      profileName = lp.name || rp.name || 'Profilim';
      mergedIsDemo = Boolean(lp.isDemo);
    } else if (scalarMode === 'remote') {
      mergedPrefs = normalizePreferences(rp.preferences || {});
      mergedFavActors = normalizeFavoriteActors(rp.favoriteActors || []);
      profileName = rp.name || lp.name || 'Profilim';
      mergedIsDemo = Boolean(rp.isDemo);
    } else {
      const mergedDisliked = Array.from(
        new Set<string>([
          ...canonicalizeMediaKeyList(lp.preferences?.disliked || []),
          ...canonicalizeMediaKeyList(rp.preferences?.disliked || []),
        ])
      );
      const mergedHidden = Array.from(
        new Set<string>([
          ...canonicalizeMediaKeyList(lp.preferences?.hidden || []),
          ...canonicalizeMediaKeyList(rp.preferences?.hidden || []),
        ])
      );
      const mergedProviders = Array.from(
        new Set<string>([
          ...(lp.preferences?.providers || []).map(String),
          ...(rp.preferences?.providers || []).map(String),
        ])
      ).sort();
      const mergedNotified = Array.from(
        new Set<string>([
          ...(lp.preferences?.notified || []),
          ...(rp.preferences?.notified || []),
        ])
      ).slice(-200);

      mergedPrefs = normalizePreferences({
        disliked: mergedDisliked,
        ...(mergedHidden.length > 0 ? { hidden: mergedHidden } : {}),
        providers: mergedProviders,
        mood:
          options.preferActiveProfileFrom === 'remote'
            ? rp.preferences?.mood || lp.preferences?.mood || ''
            : lp.preferences?.mood || rp.preferences?.mood || '',
        reminders: Boolean(lp.preferences?.reminders || rp.preferences?.reminders),
        notified: mergedNotified,
      });

      const actorMap = new Map<number, FavoriteActorInfo>();
      for (const actor of normalizeFavoriteActors([
        ...(lp.favoriteActors || []),
        ...(rp.favoriteActors || []),
      ])) {
        const prev = actorMap.get(actor.id);
        if (!prev) {
          actorMap.set(actor.id, actor);
        } else {
          actorMap.set(actor.id, {
            id: actor.id,
            name: prev.name || actor.name,
            profile_path: prev.profile_path || actor.profile_path || null,
            character: prev.character || actor.character,
          });
        }
      }
      mergedFavActors = Array.from(actorMap.values());

      profileName =
        lp.name && lp.name !== 'Profilim'
          ? lp.name
          : rp.name && rp.name !== 'Profilim'
          ? rp.name
          : lp.name || rp.name || 'Profilim';
      mergedIsDemo = Boolean(lp.isDemo && rp.isDemo);
    }

    const earliestCreated = pickEarliestIso([lp.createdAt, rp.createdAt]) || '';

    mergedProfiles.push({
      id: profileId,
      name: profileName,
      createdAt: earliestCreated,
      preferences: mergedPrefs,
      items: dedupeItems(combinedItems),
      favoriteActors: mergedFavActors,
      ...(Object.keys(mergedDeletedKeys).length > 0 ? { deleted_keys: mergedDeletedKeys } : {}),
      isDemo: mergedIsDemo,
    });
  }

  const effectiveLocalActiveId =
    foldedTargetId && localActiveProfileId === 'PROFILE-DEFAULT'
      ? foldedTargetId
      : localActiveProfileId;

  const preferredActive =
    options.preferActiveProfileFrom === 'remote' || Boolean(foldedTargetId)
      ? mergedProfiles.find((p) => p.id === remoteActiveProfileId)?.id ||
        mergedProfiles.find((p) => p.id === effectiveLocalActiveId)?.id ||
        mergedProfiles[0]?.id ||
        'profile-default'
      : mergedProfiles.find((p) => p.id === effectiveLocalActiveId)?.id ||
        mergedProfiles.find((p) => p.id === remoteActiveProfileId)?.id ||
        mergedProfiles[0]?.id ||
        'profile-default';

  const maxRev = Math.max(localDoc.revision ?? 0, remoteDoc.revision ?? 0);

  return {
    mergedDoc: {
      version: 3,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      activeProfileId: preferredActive,
      profiles: mergedProfiles,
      revision: maxRev + 1,
      updatedAt: new Date().toISOString(),
    },
    addedToLocal,
    addedToRemote,
    updatedItems,
    conflicts,
  };
}

function buildComparableUserDataSnapshot(doc: DataDocument | null | undefined) {
  if (!doc) return null;
  const profiles = [...(doc.profiles || [])]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((p) => {
      const items = dedupeItems(p.items || [])
        .map((it) => ({
          key: makeMediaKey(it),
          title: it.title || '',
          status: it.status,
          personal_rating: it.personal_rating === '' ? '' : Number(it.personal_rating),
          personal_rating_cleared: Boolean(it.personal_rating_cleared),
          status_changed_at: it.status_changed_at || '',
          rating_changed_at: it.rating_changed_at || '',
          season_progress: it.season_progress || {},
          watched_episodes: it.watched_episodes || {},
          progress_updated_at: it.progress_updated_at || {},
          watchedAt: it.watchedAt || '',
          custom: Boolean(it.custom),
          isDemo: Boolean(it.isDemo),
        }))
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
        name: p.name || 'Profilim',
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
        deleted_keys: normalizedTombstones,
        items,
      };
    });

  return {
    activeProfileId: doc.activeProfileId || '',
    profiles,
  };
}

export function areUserDataDocumentsSemanticallyEqual(
  a: DataDocument | null | undefined,
  b: DataDocument | null | undefined
): boolean {
  if (!a || !b) return false;
  return (
    stringifyUserDataDeterministic(buildComparableUserDataSnapshot(a)) ===
    stringifyUserDataDeterministic(buildComparableUserDataSnapshot(b))
  );
}
