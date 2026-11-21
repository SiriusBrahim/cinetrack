// ===========================================================================
// Cinethos Taste Engine — Taste Store (v1.5)
// data/taste/ ağacının sahibi, atomik yazım, manifest (TP-008/TP-027)
// ===========================================================================

import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  CorruptJsonFileError,
  writeJsonFileAtomicAsync,
  readJsonFileWithRecoveryAsync,
} from "./atomic-json.ts";
import {
  TASTE_LOCK_DATA_SCOPE,
  TASTE_SHARED_METADATA_CACHE_SCOPE,
  ensureTasteProfileIdMapEntry,
  resolveTastePathsForProfile,
  withScopedTasteLock,
} from "./taste-profile-scope.ts";
import type { TasteProfileStorePaths } from "./taste-profile-scope.ts";
import { assertSafeDataDir, resolveDefaultDataDir } from "./test-data-guard.ts";

// R2-A1 profil kapsamı yüzeyi (kanonik kimlik, kodlama, eşleme manifesti,
// kapsam kilidi). A2 çağıranları tek giriş noktası olarak buradan kullanabilir.
export {
  TASTE_LOCK_DATA_SCOPE,
  TASTE_LOCK_DEFAULTS,
  TASTE_PROFILE_ID_MAP_FILENAME,
  TASTE_PROFILE_ID_MAP_SCHEME,
  TASTE_PROFILE_ID_MAP_SCOPE,
  TASTE_PROFILE_ID_MAP_VERSION,
  TASTE_PROFILE_ID_MAX_LENGTH,
  TASTE_SHARED_METADATA_CACHE_SCOPE,
  TasteLockError,
  TasteProfileScopeError,
  acquireTasteLock,
  decodeProfileIdSafe,
  encodeProfileIdSafe,
  ensureTasteProfileIdMapEntry,
  isTasteLockOwnedBy,
  isTasteLockProvablyStale,
  parseTasteProfileIdMap,
  readTasteLockState,
  readTasteProfileIdMap,
  readTasteProfileIdMapEntry,
  resolveTasteLockDir,
  resolveTasteLockPath,
  resolveTastePathsForProfile,
  resolveTasteProfileIdMapPath,
  resolveTasteProfilesRoot,
  resolveTasteRoot,
  validateCanonicalProfileId,
  withScopedTasteLock,
  writeTasteProfileIdMap,
} from "./taste-profile-scope.ts";
export type {
  EnsureTasteProfileIdMapResult,
  TasteLockHandle,
  TasteLockRecord,
  TasteLockTimings,
  TasteProfileIdMap,
  TasteProfileIdMapEntry,
  TasteProfileScopePaths,
  TasteProfileStorePaths,
  TasteScopedLockRequest,
} from "./taste-profile-scope.ts";
import type {
  TasteEvent,
  TasteProfile,
  ContentTasteIndex,
  TasteManifest,
  TasteFeatureObjection,
} from "../core/taste/types.ts";
import {
  ALGORITHM_VERSION,
  TAXONOMY_VERSION,
  CONFIG_VERSION,
} from "../core/taste/constants.ts";

export const TASTE_DATA_DIR = "data/taste";
export const TASTE_ARCHIVE_DIR = "data/taste/archive/taste-events";

export interface TasteStorePaths {
  taxonomy: string;
  index: string;
  events: string;
  profile: string;
  manifest: string;
  objections: string;
}

export function resolveTastePaths(dataDir: string = resolveDefaultDataDir()): TasteStorePaths {
  const baseDir = dataDir && dataDir.length > 0 ? dataDir : "data";
  if (baseDir === "data") {
    return {
      taxonomy: `${TASTE_DATA_DIR}/cinetrack-taste-taxonomy.json`,
      index: `${TASTE_DATA_DIR}/cinetrack-taste-index.json`,
      events: `${TASTE_DATA_DIR}/cinetrack-taste-events.json`,
      profile: `${TASTE_DATA_DIR}/cinetrack-taste-profile.json`,
      manifest: `${TASTE_DATA_DIR}/cinetrack-taste-manifest.json`,
      objections: `${TASTE_DATA_DIR}/cinetrack-taste-objections.json`,
    };
  }
  const base = path.join(baseDir, "taste");
  return {
    taxonomy: path.join(base, "cinetrack-taste-taxonomy.json"),
    index: path.join(base, "cinetrack-taste-index.json"),
    events: path.join(base, "cinetrack-taste-events.json"),
    profile: path.join(base, "cinetrack-taste-profile.json"),
    manifest: path.join(base, "cinetrack-taste-manifest.json"),
    objections: path.join(base, "cinetrack-taste-objections.json"),
  };
}

export const TASTE_PATHS: TasteStorePaths = resolveTastePaths("data");

export function tasteProfileLockScope(profileDir: string): string {
  return `profile:${profileDir}`;
}

function backupPathFor(filePath: string): string {
  return `${filePath}.bak`;
}

function isValidTasteEventsArray(raw: unknown): TasteEvent[] | null {
  if (!Array.isArray(raw)) return null;
  for (const entry of raw) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { eventId?: unknown }).eventId !== "string" ||
      typeof (entry as { contentId?: unknown }).contentId !== "string" ||
      typeof (entry as { eventType?: unknown }).eventType !== "string"
    ) {
      return null;
    }
  }
  return raw as TasteEvent[];
}

function isValidTasteObjectionsArray(raw: unknown): TasteFeatureObjection[] | null {
  if (!Array.isArray(raw)) return null;
  for (const entry of raw) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { contentId?: unknown }).contentId !== "string" ||
      typeof (entry as { metricId?: unknown }).metricId !== "string"
    ) {
      return null;
    }
  }
  return raw as TasteFeatureObjection[];
}

function isValidJsonRecord<T extends object>(raw: unknown): T | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as T;
}

// === Yazma Serileştirme Kilidi (R2-A1 — süreç içi FIFO + kapsam kilidi) ===
// Legacy/global taste yazımları `taste-data` kapsamını kullanır. Kilit dosyası
// adı (`<taste-root>/.taste.lock`) geri uyumluluk için korunur; içerik artık
// lockId/ownerToken/hostname/lease alanlı kayıt ve lease/heartbeat denetimiyle
// yönetilir. Canlı kilit çalınmaz; stale devralma atomik ve kanıt koşulludur.
function serializeTasteWrite<T>(dataDir: string, task: () => Promise<T>): Promise<T> {
  // Aşama 1 — test ortamı gerçek `data/` ağacına yazamaz (B-14).
  assertSafeDataDir(dataDir, 'taste-store');
  return withScopedTasteLock({ dataDir, scope: TASTE_LOCK_DATA_SCOPE }, task);
}

// === Profil Kapsamlı Yardımcılar (R2-A2) ===

function serializeTasteWriteForProfile<T>(
  dataDir: string,
  profileDir: string,
  task: () => Promise<T>
): Promise<T> {
  assertSafeDataDir(dataDir, 'taste-store');
  return withScopedTasteLock(
    { dataDir, scope: tasteProfileLockScope(profileDir) },
    task
  );
}

async function resolveProfileTasteStore(
  profileId: string,
  dataDir: string
): Promise<{ profileDir: string; paths: TasteProfileStorePaths }> {
  // Okumalar da eski p1 dizinini p2'ye güvenli biçimde geçirir.
  const ensured = await ensureTasteProfileIdMapEntry(profileId, dataDir);
  const scoped = resolveTastePathsForProfile(ensured.profileId, dataDir);
  return { profileDir: scoped.dir, paths: scoped.paths };
}

async function ensureProfileTasteStoreEntry(
  profileId: string,
  dataDir: string
): Promise<{ profileDir: string; paths: TasteProfileStorePaths }> {
  return resolveProfileTasteStore(profileId, dataDir);
}

async function writeManifestForPathsUnlocked(
  paths: TasteStorePaths | TasteProfileStorePaths,
  dataDir: string,
  eventWatermark?: string
): Promise<void> {
  const previous =
    eventWatermark === undefined
      ? await readTasteManifestFromPaths(paths).catch((err) => {
          if (err instanceof CorruptJsonFileError) return null;
          throw err;
        })
      : null;
  const manifest: TasteManifest = {
    generationId: randomUUID(),
    taxonomyVersion: TAXONOMY_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    configVersion: CONFIG_VERSION,
    asOf: new Date().toISOString(),
    files: {
      taxonomy: paths.taxonomy,
      index: paths.index,
      events: paths.events,
      profile: paths.profile,
    },
    eventWatermark: eventWatermark ?? previous?.eventWatermark ?? "",
  };
  await writeJsonFileAtomicAsync(paths.manifest, JSON.stringify(manifest, null, 2), {
    backupPath: backupPathFor(paths.manifest),
    validateParsed: (raw) => isValidJsonRecord<TasteManifest>(raw) !== null,
  });
}

async function readTasteManifestFromPaths(
  paths: TasteStorePaths | TasteProfileStorePaths
): Promise<TasteManifest | null> {
  const result = await readJsonFileWithRecoveryAsync<TasteManifest>(paths.manifest, {
    backupPaths: [backupPathFor(paths.manifest)],
    validate: isValidJsonRecord<TasteManifest>,
    label: "cinetrack-taste-manifest.json",
  });
  if (result.status === "ok" || result.status === "recovered") {
    return result.data;
  }
  if (result.status === "missing") {
    return null;
  }
  throw new CorruptJsonFileError(paths.manifest, result.error);
}

async function readTasteEventsFromPaths(
  paths: TasteStorePaths | TasteProfileStorePaths
): Promise<TasteEvent[]> {
  const result = await readJsonFileWithRecoveryAsync<TasteEvent[]>(paths.events, {
    backupPaths: [backupPathFor(paths.events)],
    validate: isValidTasteEventsArray,
    label: "cinetrack-taste-events.json",
  });
  if (result.status === "ok" || result.status === "recovered") {
    return Array.isArray(result.data) ? result.data : [];
  }
  if (result.status === "missing") {
    return [];
  }
  throw new CorruptJsonFileError(paths.events, result.error);
}

async function readTasteProfileFromPaths(
  paths: TasteStorePaths | TasteProfileStorePaths
): Promise<TasteProfile | null> {
  const result = await readJsonFileWithRecoveryAsync<TasteProfile>(paths.profile, {
    backupPaths: [backupPathFor(paths.profile)],
    validate: isValidJsonRecord<TasteProfile>,
    label: "cinetrack-taste-profile.json",
  });
  if (result.status === "ok" || result.status === "recovered") {
    return result.data;
  }
  if (result.status === "missing") {
    return null;
  }
  throw new CorruptJsonFileError(paths.profile, result.error);
}

async function readTasteIndexFromPaths(
  paths: TasteStorePaths | TasteProfileStorePaths
): Promise<ContentTasteIndex | null> {
  const result = await readJsonFileWithRecoveryAsync<ContentTasteIndex>(paths.index, {
    backupPaths: [backupPathFor(paths.index)],
    validate: isValidJsonRecord<ContentTasteIndex>,
    label: "cinetrack-taste-index.json",
  });
  if (result.status === "ok" || result.status === "recovered") {
    return result.data;
  }
  if (result.status === "missing") {
    return null;
  }
  throw new CorruptJsonFileError(paths.index, result.error);
}

async function readTasteObjectionsFromPaths(
  paths: TasteStorePaths | TasteProfileStorePaths
): Promise<TasteFeatureObjection[]> {
  const result = await readJsonFileWithRecoveryAsync<TasteFeatureObjection[]>(
    paths.objections,
    {
      backupPaths: [backupPathFor(paths.objections)],
      validate: isValidTasteObjectionsArray,
      label: "cinetrack-taste-objections.json",
    }
  );
  if (result.status === "ok" || result.status === "recovered") {
    return Array.isArray(result.data) ? result.data : [];
  }
  if (result.status === "missing") {
    return [];
  }
  throw new CorruptJsonFileError(paths.objections, result.error);
}

/** Shared metadata cache kilidi (A1 sıra/izolasyon kuralları). */
export function withTasteSharedMetadataCacheLock<T>(
  dataDir: string,
  task: () => Promise<T>
): Promise<T> {
  return withScopedTasteLock(
    { dataDir, scope: TASTE_SHARED_METADATA_CACHE_SCOPE },
    task
  );
}

// === Event Store ===

/**
 * Olay ekle (append-only, idempotent, kilitli — TP-005 / Faz 1B).
 * Yeni eklenip eklenmediğini döndüren ayrıntılı sürüm.
 */
export async function appendTasteEventIdempotent(
  event: TasteEvent,
  dataDir: string = resolveDefaultDataDir()
): Promise<{ added: boolean; total: number }> {
  return serializeTasteWrite(dataDir, async () => {
    const paths = resolveTastePaths(dataDir);
    const events = await readTasteEvents(dataDir);
    if (events.some((e) => e.eventId === event.eventId)) {
      return { added: false, total: events.length };
    }
    events.push(event);
    await writeJsonFileAtomicAsync(paths.events, JSON.stringify(events, null, 2), {
      backupPath: backupPathFor(paths.events),
      validateParsed: (raw) => isValidTasteEventsArray(raw) !== null,
    });
    return { added: true, total: events.length };
  });
}

/**
 * Olay ekle (append-only, idempotent — TP-005)
 */
export async function appendTasteEvent(
  event: TasteEvent,
  dataDir: string = resolveDefaultDataDir()
): Promise<void> {
  await appendTasteEventIdempotent(event, dataDir);
}

/**
 * Olay listesini oku — bozuksa önce `.bak` yedeğinden kurtarır; kurtarılamazsa açık hata fırlatır.
 */
export async function readTasteEvents(dataDir: string = resolveDefaultDataDir()): Promise<TasteEvent[]> {
  return readTasteEventsFromPaths(resolveTastePaths(dataDir));
}

/**
 * Tüm olayları toplu yaz (migration sonrası)
 */
export async function writeTasteEvents(
  events: TasteEvent[],
  dataDir: string = resolveDefaultDataDir()
): Promise<void> {
  return serializeTasteWrite(dataDir, async () => {
    const paths = resolveTastePaths(dataDir);
    await writeJsonFileAtomicAsync(paths.events, JSON.stringify(events, null, 2), {
      backupPath: backupPathFor(paths.events),
      validateParsed: (raw) => isValidTasteEventsArray(raw) !== null,
    });
  });
}

// === Profile Store ===

/**
 * Profili yaz (atomik, kilitli, manifest güncelle)
 */
export async function writeTasteProfile(
  profile: TasteProfile,
  dataDir: string = resolveDefaultDataDir(),
  eventWatermark?: string
): Promise<void> {
  return serializeTasteWrite(dataDir, async () => {
    const paths = resolveTastePaths(dataDir);
    await writeJsonFileAtomicAsync(paths.profile, JSON.stringify(profile, null, 2), {
      backupPath: backupPathFor(paths.profile),
      validateParsed: (raw) => isValidJsonRecord<TasteProfile>(raw) !== null,
    });
    await writeManifestUnlocked(dataDir, eventWatermark);
  });
}

/**
 * Profili oku
 */
export async function readTasteProfile(
  dataDir: string = resolveDefaultDataDir()
): Promise<TasteProfile | null> {
  return readTasteProfileFromPaths(resolveTastePaths(dataDir));
}

// === Index Store ===

/**
 * İndeksi yaz (atomik, kilitli, manifest güncelle)
 */
export async function writeTasteIndex(
  index: ContentTasteIndex,
  dataDir: string = resolveDefaultDataDir()
): Promise<void> {
  return serializeTasteWrite(dataDir, async () => {
    const paths = resolveTastePaths(dataDir);
    await writeJsonFileAtomicAsync(paths.index, JSON.stringify(index, null, 2), {
      backupPath: backupPathFor(paths.index),
      validateParsed: (raw) => isValidJsonRecord<ContentTasteIndex>(raw) !== null,
    });
    await writeManifestUnlocked(dataDir);
  });
}

/**
 * İndeksi oku
 */
export async function readTasteIndex(
  dataDir: string = resolveDefaultDataDir()
): Promise<ContentTasteIndex | null> {
  return readTasteIndexFromPaths(resolveTastePaths(dataDir));
}

// === Manifest ===

/**
 * Manifest'i güncelle (TP-027) — iç yardımcı (kilit altından çağrılır).
 */
async function writeManifestUnlocked(
  dataDir: string = resolveDefaultDataDir(),
  eventWatermark?: string
): Promise<void> {
  const paths = resolveTastePaths(dataDir);
  await writeManifestForPathsUnlocked(paths, dataDir, eventWatermark);
}

/**
 * Manifest'i oku
 */
export async function readTasteManifest(
  dataDir: string = resolveDefaultDataDir()
): Promise<TasteManifest | null> {
  return readTasteManifestFromPaths(resolveTastePaths(dataDir));
}

// === V1.5 İtiraz (Objection) Deposu ===

/**
 * Kullanıcının "Bu içerikte bu özellik yok" itirazlarını oku
 */
export async function readTasteObjections(
  dataDir: string = resolveDefaultDataDir()
): Promise<TasteFeatureObjection[]> {
  return readTasteObjectionsFromPaths(resolveTastePaths(dataDir));
}

/**
 * İtiraz listesini atomik olarak yaz
 */
export async function writeTasteObjections(
  objections: TasteFeatureObjection[],
  dataDir: string = resolveDefaultDataDir()
): Promise<void> {
  return serializeTasteWrite(dataDir, async () => {
    const paths = resolveTastePaths(dataDir);
    await writeJsonFileAtomicAsync(
      paths.objections,
      JSON.stringify(objections, null, 2),
      {
        backupPath: backupPathFor(paths.objections),
        validateParsed: (raw) => isValidTasteObjectionsArray(raw) !== null,
      }
    );
  });
}

// === Profil Kapsamlı Event Store (R2-A2) ===

export async function appendTasteEventIdempotentForProfile(
  profileId: string,
  event: TasteEvent,
  dataDir: string = resolveDefaultDataDir()
): Promise<{ added: boolean; total: number }> {
  const { profileDir, paths } = await ensureProfileTasteStoreEntry(profileId, dataDir);
  return serializeTasteWriteForProfile(dataDir, profileDir, async () => {
    const events = await readTasteEventsFromPaths(paths);
    if (events.some((e) => e.eventId === event.eventId)) {
      return { added: false, total: events.length };
    }
    events.push(event);
    await writeJsonFileAtomicAsync(paths.events, JSON.stringify(events, null, 2), {
      backupPath: backupPathFor(paths.events),
      validateParsed: (raw) => isValidTasteEventsArray(raw) !== null,
    });
    return { added: true, total: events.length };
  });
}

export async function appendTasteEventForProfile(
  profileId: string,
  event: TasteEvent,
  dataDir: string = resolveDefaultDataDir()
): Promise<void> {
  await appendTasteEventIdempotentForProfile(profileId, event, dataDir);
}

export async function readTasteEventsForProfile(
  profileId: string,
  dataDir: string = resolveDefaultDataDir()
): Promise<TasteEvent[]> {
  const { paths } = await resolveProfileTasteStore(profileId, dataDir);
  return readTasteEventsFromPaths(paths);
}

export async function writeTasteEventsForProfile(
  profileId: string,
  events: TasteEvent[],
  dataDir: string = resolveDefaultDataDir()
): Promise<void> {
  const { profileDir, paths } = await ensureProfileTasteStoreEntry(profileId, dataDir);
  return serializeTasteWriteForProfile(dataDir, profileDir, async () => {
    await writeJsonFileAtomicAsync(paths.events, JSON.stringify(events, null, 2), {
      backupPath: backupPathFor(paths.events),
      validateParsed: (raw) => isValidTasteEventsArray(raw) !== null,
    });
  });
}

// === Profil Kapsamlı Profile Store (R2-A2) ===

export async function writeTasteProfileForProfile(
  profileId: string,
  profile: TasteProfile,
  dataDir: string = resolveDefaultDataDir(),
  eventWatermark?: string
): Promise<void> {
  const { profileDir, paths } = await ensureProfileTasteStoreEntry(profileId, dataDir);
  return serializeTasteWriteForProfile(dataDir, profileDir, async () => {
    await writeJsonFileAtomicAsync(paths.profile, JSON.stringify(profile, null, 2), {
      backupPath: backupPathFor(paths.profile),
      validateParsed: (raw) => isValidJsonRecord<TasteProfile>(raw) !== null,
    });
    await writeManifestForPathsUnlocked(paths, dataDir, eventWatermark);
  });
}

export async function readTasteProfileForProfile(
  profileId: string,
  dataDir: string = resolveDefaultDataDir()
): Promise<TasteProfile | null> {
  const { paths } = await resolveProfileTasteStore(profileId, dataDir);
  return readTasteProfileFromPaths(paths);
}

// === Profil Kapsamlı Index Store (R2-A2) ===

export async function writeTasteIndexForProfile(
  profileId: string,
  index: ContentTasteIndex,
  dataDir: string = resolveDefaultDataDir()
): Promise<void> {
  const { profileDir, paths } = await ensureProfileTasteStoreEntry(profileId, dataDir);
  return serializeTasteWriteForProfile(dataDir, profileDir, async () => {
    await writeJsonFileAtomicAsync(paths.index, JSON.stringify(index, null, 2), {
      backupPath: backupPathFor(paths.index),
      validateParsed: (raw) => isValidJsonRecord<ContentTasteIndex>(raw) !== null,
    });
    await writeManifestForPathsUnlocked(paths, dataDir);
  });
}

export async function readTasteIndexForProfile(
  profileId: string,
  dataDir: string = resolveDefaultDataDir()
): Promise<ContentTasteIndex | null> {
  const { paths } = await resolveProfileTasteStore(profileId, dataDir);
  return readTasteIndexFromPaths(paths);
}

// === Profil Kapsamlı Manifest (R2-A2) ===

export async function readTasteManifestForProfile(
  profileId: string,
  dataDir: string = resolveDefaultDataDir()
): Promise<TasteManifest | null> {
  const { paths } = await resolveProfileTasteStore(profileId, dataDir);
  return readTasteManifestFromPaths(paths);
}

// === Profil Kapsamlı İtiraz (R2-A2) ===

export async function readTasteObjectionsForProfile(
  profileId: string,
  dataDir: string = resolveDefaultDataDir()
): Promise<TasteFeatureObjection[]> {
  const { paths } = await resolveProfileTasteStore(profileId, dataDir);
  return readTasteObjectionsFromPaths(paths);
}

export async function writeTasteObjectionsForProfile(
  profileId: string,
  objections: TasteFeatureObjection[],
  dataDir: string = resolveDefaultDataDir()
): Promise<void> {
  const { profileDir, paths } = await ensureProfileTasteStoreEntry(profileId, dataDir);
  return serializeTasteWriteForProfile(dataDir, profileDir, async () => {
    await writeJsonFileAtomicAsync(
      paths.objections,
      JSON.stringify(objections, null, 2),
      {
        backupPath: backupPathFor(paths.objections),
        validateParsed: (raw) => isValidTasteObjectionsArray(raw) !== null,
      }
    );
  });
}
