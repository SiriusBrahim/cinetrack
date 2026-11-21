/**
 * Faz 3 / Aşama 1 — Profil yedekleme/geri yükleme saf yardımcıları.
 *
 * Aşama 1 (B-05, B-06): Yerel yedek belgesi artık **v4**'tür ve tam belge
 * kapsamını taşır: bütün profiller, aktif profil, silme işaretleri (tombstone),
 * revizyon ve şema sürümü. Eski okuyucular için aktif profilin alanları üst
 * düzeyde de yazılır (geriye dönük uyumluluk).
 */

import {
  CURRENT_SCHEMA_VERSION,
  ENGINE_VERSION,
  normalizeFavoriteActors,
  type FavoriteActorInfo,
  type Preferences,
  type Profile,
  type SavedItem,
} from '../core/cinetrack-core.ts';
import type { CinemaKunyeDocument } from '../core/cinema-kunye.ts';

/** Yedekteki tek bir profil kaydı (tam belge kapsamı). */
export interface BackupProfileRecord {
  id: string;
  name: string;
  createdAt?: string;
  preferences: Preferences;
  items: SavedItem[];
  favoriteActors: FavoriteActorInfo[];
  deleted_keys?: Record<string, string>;
  isDemo: boolean;
}

export interface LocalBackupDocument {
  /** Aşama 1 — şema sürümü 4: çoklu profil + tombstone + revizyon. */
  version: 4;
  schemaVersion: number;
  engineVersion: string;
  activeProfileId: string;
  profiles: BackupProfileRecord[];
  /** Yedeğin alındığı andaki veri revizyonu (varsa). */
  revision?: number;
  /** Legacy okuyucular için aktif profilin düz kopyası. */
  profileId: string;
  profileName: string;
  items: SavedItem[];
  cinemaKunye: CinemaKunyeDocument;
  preferences: Preferences;
  favoriteActors: FavoriteActorInfo[];
  isDemo: boolean;
  exportedAt: string;
}

export interface BuildLocalBackupInput {
  readonly profileId: string;
  readonly profileName: string;
  readonly items: SavedItem[];
  readonly cinemaKunye: CinemaKunyeDocument;
  readonly preferences: Preferences;
  readonly favoriteActors: FavoriteActorInfo[];
  readonly isDemo: boolean;
  readonly nowIso?: string;
  /** Tüm profiller (aktif profil dahil). Verilmezse yalnızca aktif profil yazılır. */
  readonly profiles?: readonly Profile[];
  /** Aktif profilin silme işaretleri (tombstone). */
  readonly deletedKeys?: Record<string, string>;
  /** Sunucu veri revizyonu (biliniyorsa). */
  readonly revision?: number;
}

/**
 * Yerel yedek belgesini üretir (tek kaynak; iki kopya payload yok).
 *
 * Aktif profilin canlı hali (item/tercih/favori/tombstone) verilen
 * parametrelerden, diğer profiller `profiles` listesinden alınır.
 */
export function buildLocalBackupDocument(input: BuildLocalBackupInput): LocalBackupDocument {
  const activeRecord: BackupProfileRecord = {
    id: input.profileId,
    name: input.profileName,
    preferences: input.preferences,
    items: input.items,
    favoriteActors: input.favoriteActors,
    isDemo: input.isDemo,
    ...(input.deletedKeys && Object.keys(input.deletedKeys).length > 0
      ? { deleted_keys: { ...input.deletedKeys } }
      : {}),
  };

  const otherRecords: BackupProfileRecord[] = (input.profiles || [])
    .filter((profile) => profile && profile.id && profile.id !== input.profileId)
    .map((profile) => ({
      id: profile.id,
      name: profile.name || 'Profilim',
      ...(profile.createdAt ? { createdAt: profile.createdAt } : {}),
      preferences: profile.preferences,
      items: profile.items || [],
      favoriteActors: normalizeFavoriteActors(profile.favoriteActors || []),
      isDemo: Boolean(profile.isDemo),
      ...(profile.deleted_keys && Object.keys(profile.deleted_keys).length > 0
        ? { deleted_keys: { ...profile.deleted_keys } }
        : {}),
    }));

  return {
    version: 4,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    activeProfileId: input.profileId,
    profiles: [activeRecord, ...otherRecords],
    ...(typeof input.revision === 'number' && Number.isSafeInteger(input.revision)
      ? { revision: input.revision }
      : {}),
    // Legacy alanlar (v3 okuyucuları) — aktif profilin kopyası.
    profileId: input.profileId,
    profileName: input.profileName,
    items: input.items,
    cinemaKunye: input.cinemaKunye,
    preferences: input.preferences,
    favoriteActors: input.favoriteActors,
    isDemo: input.isDemo,
    exportedAt: input.nowIso ?? new Date().toISOString(),
  };
}

export function buildBackupFileName(nowIso: string = new Date().toISOString()): string {
  return `cinethos-local-backup-${nowIso.slice(0, 10)}.json`;
}

export type BackupImportMode = 'overwrite' | 'merge';

function unionKeys(current: readonly string[] | undefined, incoming: readonly string[] | undefined): string[] {
  return Array.from(new Set([...(current || []), ...(incoming || [])]));
}

/**
 * İçe aktarılan tercihleri geçerli tercihlerle birleştirir.
 * - `overwrite`: içe aktarılan değerler geçerlidir.
 * - `merge`: küme alanları birleşim, ölçek alanları içe aktarılandan.
 * `reminders`/`notified` içe aktarmada sıfırlanır (mevcut davranış korunur).
 */
export function resolveImportedPreferences(
  current: Preferences,
  incoming: Partial<Preferences> | null | undefined,
  mode: BackupImportMode
): Preferences | null {
  if (!incoming) return null;
  const pickKeys = (field: 'disliked' | 'hidden' | 'providers') => {
    const next = incoming[field];
    if (!Array.isArray(next)) return mode === 'merge' ? current[field] || [] : [];
    return mode === 'merge' ? unionKeys(current[field], next) : next.map(String);
  };
  return {
    ...current,
    ...incoming,
    disliked: pickKeys('disliked'),
    hidden: pickKeys('hidden'),
    providers: pickKeys('providers'),
    reminders: false,
    notified: [],
  };
}

/** İçe aktarılan favori oyuncuları geçerli listeyle birleştirir. */
export function resolveImportedFavoriteActors(
  current: readonly FavoriteActorInfo[],
  incoming: readonly FavoriteActorInfo[] | null | undefined,
  mode: BackupImportMode
): FavoriteActorInfo[] {
  return mode === 'merge'
    ? normalizeFavoriteActors([...(current || []), ...(incoming || [])])
    : normalizeFavoriteActors(incoming || []);
}
