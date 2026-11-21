import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeDataDocument,
  buildTasteProfileV3,
  collectDataLimitViolations,
  makeMediaKey,
  normalizeProfileId,
  CURRENT_SCHEMA_VERSION,
  ENGINE_VERSION,
  type DataDocument,
  type SavedItem,
} from '../core/cinetrack-core.ts';
import {
  areUserDataDocumentsSemanticallyEqual,
  reconcileUserDataDocumentsLossless,
} from '../core/user-data-merge.ts';
import {
  DEFAULT_MAX_DATA_BYTES,
  DEFAULT_MAX_ITEMS_PER_PROFILE,
  DEFAULT_MAX_PROFILES,
  DEFAULT_MAX_SNAPSHOTS,
  formatMaxDataLimitMb,
  measureUtf8Bytes,
} from '../core/limits.ts';
import {
  cleanupStaleTempFiles,
  readJsonFileWithRecovery,
  readJsonFileWithRecoveryAsync,
  tryParseValidJson,
  tryParseValidJsonAsync,
  writeJsonFileAtomic,
  writeJsonFileAtomicAsync,
} from './atomic-json.ts';
import {
  createSqlitePrimaryStore,
  resolveStorageDriver,
  type StorageDriver,
} from './sqlite-primary-store.ts';
import { assertSafeDataDir } from './test-data-guard.ts';
export interface StorageOptions {
  dataDir?: string;
  maxDataBytes?: number;
  maxProfiles?: number;
  maxItemsPerProfile?: number;
  maxSnapshots?: number;
  /** 'sqlite' seçildiğinde SQLite asıl kaynak, JSON yedek/taşınabilir kopya olur. */
  storageDriver?: StorageDriver;
}

export interface BackupMetadata {
  id: string;
  createdAt: string;
  revision: number;
  profilesCount: number;
  itemsCount: number;
}

export interface RestoreBackupOptions {
  expectedRevision?: number | null;
  hasInvalidIfMatch?: boolean;
  requirePrecondition?: boolean;
  forceOverwrite?: boolean;
}

export type RestoreBackupResult =
  | { ok: true; document: DataDocument }
  | {
      ok: false;
      status: 400 | 404 | 409 | 412 | 428 | 500;
      code:
        | 'backup_not_found'
        | 'revision_conflict'
        | 'precondition_required'
        | 'restore_failed';
      message: string;
      currentRevision?: number;
      expectedRevision?: number;
    };

export interface SaveDataOptions {
  expectedRevision?: number | null;
  expectedProfileId?: string;
  strictProfileMatch?: boolean;
  confirmBulkDelete?: boolean;
  requirePrecondition?: boolean;
  forceOverwrite?: boolean;
  hasInvalidIfMatch?: boolean;
  mergeStrategy?: 'lossless';
  foldUnhydratedDefaultProfile?: boolean;
}

export type SaveDataResult =
  | {
      ok: true;
      document: DataDocument;
      totalItems: number;
      merged?: boolean;
    }
  | {
      ok: false;
      status: 400 | 409 | 412 | 413 | 428 | 500;
      code:
        | 'invalid_document'
        | 'revision_conflict'
        | 'profile_conflict'
        | 'precondition_required'
        | 'sudden_item_drop'
        | 'profile_drop'
        | 'tombstone_drop'
        | 'limits_exceeded'
        | 'payload_too_large'
        | 'corrupt_storage';
      message: string;
      currentRevision?: number;
      expectedRevision?: number;
      existingItems?: number;
      incomingItems?: number;
      serverDocument?: DataDocument;
    };

export function countTotalItems(doc: DataDocument | null | undefined): number {
  if (!doc || !Array.isArray(doc.profiles)) return 0;
  return doc.profiles.reduce(
    (sum, profile) => sum + (Array.isArray(profile.items) ? profile.items.length : 0),
    0
  );
}

function isWorthKeeping(doc: DataDocument): boolean {
  const profiles = Array.isArray(doc.profiles) ? doc.profiles : [];
  return (
    profiles.length > 0 &&
    (profiles.some((profile) => Array.isArray(profile?.items) && profile.items.length > 0) ||
      profiles.length > 1 ||
      (doc.revision ?? 0) > 0)
  );
}

const SNAPSHOT_FILE_PATTERN = /^cinetrack-[a-zA-Z0-9._-]+\.json$/;

interface DocumentLossStats {
  uniqueItems: number;
  itemKeys: Set<string>;
  tombstones: number;
  profileItemCounts: Map<string, number>;
}

/** Aşama 1 (B-09) — veri kaybı koruması için belge istatistikleri. */
function collectDocumentLossStats(doc: DataDocument | null | undefined): DocumentLossStats {
  const itemKeys = new Set<string>();
  const profileItemCounts = new Map<string, number>();
  let tombstones = 0;
  for (const profile of Array.isArray(doc?.profiles) ? doc.profiles : []) {
    const id = normalizeProfileId(profile?.id) ?? String(profile?.id ?? '');
    const items = Array.isArray(profile?.items) ? profile.items : [];
    profileItemCounts.set(id, (profileItemCounts.get(id) || 0) + items.length);
    for (const item of items) itemKeys.add(makeMediaKey(item));
    tombstones += Object.keys(profile?.deleted_keys || {}).length;
  }
  return { uniqueItems: itemKeys.size, itemKeys, tombstones, profileItemCounts };
}

function formatSnapshotFileName(revision: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(16).slice(2, 6);
  return `cinetrack-${stamp}-rev${revision}-${suffix}.json`;
}

export function createDataStorage(options: StorageOptions) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError(
      "createDataStorage tek bir nesne parametresi bekler: createDataStorage({ dataDir }). " +
        "Eski iki argümanlı çağrı (createDataStorage(dataFile, {...})) artık desteklenmiyor."
    );
  }
  // Aşama 1 — test ortamı gerçek `data/` ağacına yazamaz; `dataDir` zorunludur (B-14).
  assertSafeDataDir(options.dataDir, 'data-storage');
  const resolvedDataDir = path.resolve(options.dataDir || path.join(process.cwd(), 'data'));
  const dataFile = path.join(resolvedDataDir, 'cinetrack-data.json');
  const backupFile = `${dataFile}.bak`;
  const isolatedProfileFile = path.join(resolvedDataDir, 'profile.json');
  const isolatedUserListsFile = path.join(resolvedDataDir, 'user-lists.json');
  const backupsDir = path.join(resolvedDataDir, 'backups');

  const maxDataBytes = options.maxDataBytes ?? DEFAULT_MAX_DATA_BYTES;
  const maxProfiles = options.maxProfiles ?? DEFAULT_MAX_PROFILES;
  const maxItemsPerProfile = options.maxItemsPerProfile ?? DEFAULT_MAX_ITEMS_PER_PROFILE;
  const maxSnapshots = Math.max(1, options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS);

  mkdirSync(resolvedDataDir, { recursive: true });
  mkdirSync(backupsDir, { recursive: true });
  cleanupStaleTempFiles(resolvedDataDir);
  cleanupStaleTempFiles(backupsDir);

  let unrecoverableCorruptionError: string | null = null;
  let writeQueue: Promise<unknown> = Promise.resolve();
  // Aşama 1 (B-04) — diskteki belge limitleri aşıyorsa yazma engellenir.
  let readLimitViolations: string[] = [];

  // Faz 7 — SQLite birincil kaynak (opt-in). JSON her zaman yedek olarak yazılır.
  const primaryStore = createSqlitePrimaryStore({
    dataDir: resolvedDataDir,
    enabled: (options.storageDriver ?? resolveStorageDriver()) === 'sqlite',
  });

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = writeQueue.then(task);
    writeQueue = run.catch(() => undefined);
    return run;
  }

  function emptyDocument(): DataDocument {
    return {
      version: 3,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      activeProfileId: '',
      profiles: [],
      revision: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }

  function validateRawDocument(raw: unknown): DataDocument | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    // B-04: limit aşan belge okunurken kırpılmaz; yüksek limitlerle normalize
    // edilir ve yazma, ihlal giderilene kadar engellenir (`readLimitViolations`).
    const violations = collectDataLimitViolations(raw, {
      maxProfiles,
      maxItems: maxItemsPerProfile,
    });
    if (violations.length > 0) readLimitViolations = violations;

    const rawProfiles = Array.isArray(obj.profiles)
      ? (obj.profiles as unknown[])
      : Array.isArray(obj.items)
      ? [obj]
      : [];
    let rawMaxItems = 0;
    for (const profile of rawProfiles) {
      const items = (profile as Record<string, unknown> | null)?.items;
      if (Array.isArray(items)) rawMaxItems = Math.max(rawMaxItems, items.length);
    }

    const normalized = normalizeDataDocument(raw, {
      maxProfiles: Math.max(maxProfiles, rawProfiles.length),
      maxItems: Math.max(maxItemsPerProfile, rawMaxItems),
    });
    if (!normalized) return null;
    const rawRev = Number(obj.revision);
    normalized.revision = Number.isSafeInteger(rawRev) && rawRev >= 0 ? rawRev : 0;
    normalized.updatedAt =
      typeof obj.updatedAt === 'string' && obj.updatedAt ? obj.updatedAt : undefined;
    return normalized;
  }

  function listDiskSnapshotFilesNewestFirstSync(): string[] {
    if (!existsSync(backupsDir)) return [];
    try {
      return readdirSync(backupsDir)
        .filter((f) => f.startsWith('cinetrack-') && f.endsWith('.json'))
        .sort((a, b) => b.localeCompare(a));
    } catch {
      return [];
    }
  }

  async function listDiskSnapshotFilesNewestFirstAsync(): Promise<string[]> {
    try {
      const entries = await fsPromises.readdir(backupsDir);
      return entries
        .filter((f) => f.startsWith('cinetrack-') && f.endsWith('.json'))
        .sort((a, b) => b.localeCompare(a));
    } catch {
      return [];
    }
  }

  function getDiskRecoveryBackupPathsSync(): string[] {
    const snaps = listDiskSnapshotFilesNewestFirstSync().map((f) => path.join(backupsDir, f));
    return [backupFile, ...snaps];
  }

  async function getDiskRecoveryBackupPathsAsync(): Promise<string[]> {
    const snaps = (await listDiskSnapshotFilesNewestFirstAsync()).map((f) =>
      path.join(backupsDir, f)
    );
    return [backupFile, ...snaps];
  }

  function readJsonData(): DataDocument {
    const recovery = readJsonFileWithRecovery<DataDocument>(dataFile, {
      backupPaths: getDiskRecoveryBackupPathsSync(),
      validate: validateRawDocument,
      label: 'cinetrack-data.json',
    });
    if (recovery.status === 'missing') {
      unrecoverableCorruptionError = null;
      return emptyDocument();
    }
    if (recovery.status === 'corrupt_unrecoverable') {
      unrecoverableCorruptionError = recovery.error;
      return emptyDocument();
    }
    unrecoverableCorruptionError = null;
    return recovery.data;
  }

  async function readJsonDataAsync(): Promise<DataDocument> {
    const recovery = await readJsonFileWithRecoveryAsync<DataDocument>(dataFile, {
      backupPaths: await getDiskRecoveryBackupPathsAsync(),
      validate: validateRawDocument,
      label: 'cinetrack-data.json',
    });
    if (recovery.status === 'missing') {
      unrecoverableCorruptionError = null;
      return emptyDocument();
    }
    if (recovery.status === 'corrupt_unrecoverable') {
      unrecoverableCorruptionError = recovery.error;
      return emptyDocument();
    }
    unrecoverableCorruptionError = null;
    return recovery.data;
  }

  /**
   * JSON ile SQLite arasındaki birincil kaynak seçimi.
   * - SQLite boşsa mevcut JSON dokümanı tek seferlik migrate edilir.
   * - JSON revizyonu daha yüksekse (ör. SQLite silinmişse) JSON kazanır ve SQLite güncellenir.
   * - Aksi halde SQLite asıl kaynak kabul edilir.
   */
  function selectPrimaryDocument(jsonDoc: DataDocument): DataDocument {
    if (!primaryStore.enabled || !primaryStore.available) return jsonDoc;
    const row = primaryStore.read();
    if (!row) {
      if ((jsonDoc.revision ?? 0) > 0 || (jsonDoc.profiles?.length ?? 0) > 0) {
        primaryStore.write(jsonDoc, jsonDoc.revision ?? 0);
      }
      return jsonDoc;
    }
    const sqliteDoc = validateRawDocument(row.document);
    if (!sqliteDoc) return jsonDoc;
    sqliteDoc.revision = row.revision;
    if (row.updatedAt) sqliteDoc.updatedAt = row.updatedAt;
    if ((jsonDoc.revision ?? 0) > row.revision) {
      primaryStore.write(jsonDoc, jsonDoc.revision ?? 0);
      return jsonDoc;
    }
    unrecoverableCorruptionError = null;
    return sqliteDoc;
  }

  function readData(): DataDocument {
    return selectPrimaryDocument(readJsonData());
  }

  async function readDataAsync(): Promise<DataDocument> {
    return selectPrimaryDocument(await readJsonDataAsync());
  }

  function buildIsolatedProfilePayload(doc: DataDocument) {
    const nowIso = doc.updatedAt || new Date().toISOString();
    return {
      schemaVersion: doc.schemaVersion ?? CURRENT_SCHEMA_VERSION,
      activeProfileId: doc.activeProfileId,
      updatedAt: nowIso,
      profiles: (doc.profiles || []).map((p) => {
        const taste = buildTasteProfileV3(p.items || [], {
          dislikedKeys: p.preferences?.disliked || [],
        });
        return {
          profileId: p.id,
          name: p.name,
          theme: 'dark-navy',
          dna: {
            positiveGenres: taste.positiveGenres.slice(0, 6),
            mediaPreference: taste.mediaPreference,
          },
          preferences: p.preferences,
          favoriteActors: p.favoriteActors || [],
          isDemo: Boolean(p.isDemo),
        };
      }),
    };
  }

  function toCompactListItem(it: SavedItem) {
    return {
      id: it.id,
      media_type: it.media_type,
      status: it.status,
      personal_rating: it.personal_rating,
      ...(it.addedAt ? { addedAt: it.addedAt } : {}),
      ...(it.updatedAt ? { updatedAt: it.updatedAt } : {}),
      ...(it.custom ? { custom: true } : {}),
      ...(it.current_season !== undefined ? { current_season: it.current_season } : {}),
      ...(it.episodes_watched !== undefined ? { episodes_watched: it.episodes_watched } : {}),
      ...(it.season_progress ? { season_progress: it.season_progress } : {}),
    };
  }

  function buildIsolatedUserListsPayload(doc: DataDocument) {
    const nowIso = doc.updatedAt || new Date().toISOString();
    const lists: Record<string, ReturnType<typeof toCompactListItem>[]> = {};
    for (const p of doc.profiles || []) {
      lists[p.id] = Array.isArray(p.items) ? p.items.map(toCompactListItem) : [];
    }
    return {
      schemaVersion: doc.schemaVersion ?? CURRENT_SCHEMA_VERSION,
      activeProfileId: doc.activeProfileId,
      updatedAt: nowIso,
      lists,
    };
  }

  async function readIsolatedProfileAsync() {
    return buildIsolatedProfilePayload(await readDataAsync());
  }

  async function readIsolatedUserListsAsync() {
    return buildIsolatedUserListsPayload(await readDataAsync());
  }

  function validateAndPrepareSave(
    current: DataDocument,
    rawPayload: unknown,
    saveOptions: SaveDataOptions
  ):
    | { ok: true; documentToPersist: DataDocument; incomingItems: number; merged: boolean }
    | Extract<SaveDataResult, { ok: false }> {
    if (unrecoverableCorruptionError) {
      return {
        ok: false,
        status: 500,
        code: 'corrupt_storage',
        message: `Mevcut veri bozuk olduğu ve geçerli bir yedek bulunamadığı için üzerine yazma engellendi (${unrecoverableCorruptionError}).`,
      };
    }

    if (readLimitViolations.length > 0) {
      return {
        ok: false,
        status: 409,
        code: 'limits_exceeded',
        message:
          `Diskteki veri yapılandırılmış limitleri aşıyor; kırpılmış bir belge kaydedilmedi: ` +
          `${readLimitViolations.join('; ')}. Veri kaybını önlemek için yazma engellendi.`,
      };
    }

    let rawBytes = 0;
    try {
      rawBytes = measureUtf8Bytes(JSON.stringify(rawPayload ?? null));
    } catch {
      return {
        ok: false,
        status: 400,
        code: 'invalid_document',
        message: 'Veri biçimi geçersiz.',
      };
    }

    if (rawBytes > maxDataBytes) {
      return {
        ok: false,
        status: 413,
        code: 'payload_too_large',
        message: `Gönderilen veri boyutu izin verilen sınırı (${formatMaxDataLimitMb(maxDataBytes)}) aşıyor.`,
      };
    }

    // B-04: gönderilen belge limitleri aşıyorsa sessizce kırpma yerine reddet.
    const incomingLimitViolations = collectDataLimitViolations(rawPayload, {
      maxProfiles,
      maxItems: maxItemsPerProfile,
    });
    if (incomingLimitViolations.length > 0) {
      return {
        ok: false,
        status: 409,
        code: 'limits_exceeded',
        message: `Gönderilen veri limitleri aşıyor ve sessizce kırpılmadı: ${incomingLimitViolations.join('; ')}.`,
      };
    }

    const normalized = normalizeDataDocument(rawPayload, {
      maxProfiles,
      maxItems: maxItemsPerProfile,
    });
    if (!normalized) {
      return {
        ok: false,
        status: 400,
        code: 'invalid_document',
        message: 'Veri biçimi geçersiz.',
      };
    }

    const currentRevision = current.revision ?? 0;
    const expectedRevision = saveOptions.expectedRevision;

    if (saveOptions.strictProfileMatch || saveOptions.expectedProfileId) {
      const expectedPid = typeof saveOptions.expectedProfileId === 'string'
        ? saveOptions.expectedProfileId.trim()
        : '';
      if (!expectedPid || normalized.activeProfileId !== expectedPid) {
        return {
          ok: false,
          status: 409,
          code: 'profile_conflict',
          message: `Profil uyuşmazlığı: beklenen '${expectedPid || 'bilinmiyor'}', gelen '${normalized.activeProfileId || 'bilinmiyor'}'.`,
          currentRevision,
          serverDocument: current,
        };
      }
    }

    if (saveOptions.hasInvalidIfMatch) {
      return {
        ok: false,
        status: 412,
        code: 'revision_conflict',
        message: `Geçersiz If-Match başlığı gönderildi (mevcut rev-${currentRevision}).`,
        currentRevision,
        serverDocument: current,
      };
    }

    const useLosslessMerge =
      saveOptions.mergeStrategy === 'lossless' &&
      !saveOptions.forceOverwrite &&
      !saveOptions.confirmBulkDelete;

    if (useLosslessMerge) {
      let effectiveDoc: DataDocument = normalized;
      let mergedFlag = false;

      if (Array.isArray(current.profiles) && current.profiles.length > 0) {
        const isMatchingRevision =
          expectedRevision !== undefined &&
          expectedRevision !== null &&
          Number.isSafeInteger(expectedRevision) &&
          expectedRevision === currentRevision &&
          !saveOptions.foldUnhydratedDefaultProfile;

        const mergeOutcome = reconcileUserDataDocumentsLossless(normalized, current, {
          foldUnhydratedDefaultProfile: saveOptions.foldUnhydratedDefaultProfile,
          authoritativeScalarSide: isMatchingRevision ? 'local' : 'union',
        });
        effectiveDoc = mergeOutcome.mergedDoc;
        mergedFlag = !areUserDataDocumentsSemanticallyEqual(normalized, effectiveDoc);
      }

      const nextRevision = currentRevision + 1;
      const nowIso = new Date().toISOString();
      const documentToPersist: DataDocument = {
        ...effectiveDoc,
        revision: nextRevision,
        updatedAt: nowIso,
      };

      const persistedBytes = measureUtf8Bytes(JSON.stringify(documentToPersist, null, 2));
      if (persistedBytes > maxDataBytes) {
        return {
          ok: false,
          status: 413,
          code: 'payload_too_large',
          message: `Gönderilen veri boyutu izin verilen sınırı (${formatMaxDataLimitMb(maxDataBytes)}) aşıyor.`,
        };
      }

      return {
        ok: true,
        documentToPersist,
        incomingItems: countTotalItems(documentToPersist),
        merged: mergedFlag,
      };
    }

    if (
      expectedRevision !== undefined &&
      expectedRevision !== null &&
      Number.isSafeInteger(expectedRevision)
    ) {
      if (expectedRevision !== currentRevision) {
        return {
          ok: false,
          status: currentRevision === 0 ? 412 : 409,
          code: 'revision_conflict',
          message: `Sunucuda daha güncel veya farklı bir veri sürümü var (beklenen rev-${expectedRevision}, mevcut rev-${currentRevision}).`,
          currentRevision,
          expectedRevision,
          serverDocument: current,
        };
      }
    } else if (
      saveOptions.requirePrecondition &&
      !saveOptions.forceOverwrite &&
      currentRevision > 0
    ) {
      return {
        ok: false,
        status: 428,
        code: 'precondition_required',
        message: `Mevcut sunucu verisinin (rev-${currentRevision}) üzerine koşulsuz yazma engellendi. If-Match başlığı gönderin veya açık üzerine yazma onayı verin.`,
        currentRevision,
        serverDocument: current,
      };
    }

    const existingItems = countTotalItems(current);
    const incomingItems = countTotalItems(normalized);

    if (!saveOptions.confirmBulkDelete) {
      const before = collectDocumentLossStats(current);
      const after = collectDocumentLossStats(normalized);
      const removedKeys = [...before.itemKeys].filter((key) => !after.itemKeys.has(key));
      const addedKeys = [...after.itemKeys].filter((key) => !before.itemKeys.has(key));
      const droppedProfiles = [...before.profileItemCounts.entries()].filter(
        ([id, count]) => count > 0 && !after.profileItemCounts.has(id)
      );

      // 1) İçinde kayıt bulunan bir profil belgeden tümüyle düşmüşse.
      if (droppedProfiles.length > 0) {
        const detail = droppedProfiles.map(([id, count]) => `${id} (${count} kayıt)`).join(', ');
        return {
          ok: false,
          status: 409,
          code: 'profile_drop',
          message: `Profil kaybı koruması devreye girdi: ${detail} gelen belgede yok. Toplu silmeyi onaylayın veya sunucu verisini yükleyin.`,
          existingItems,
          incomingItems,
          currentRevision,
          serverDocument: current,
        };
      }

      // 2) Tombstone'lar tümüyle kaybolmuşsa silmeler geri dirilebilir.
      if (before.tombstones >= 3 && after.tombstones === 0) {
        return {
          ok: false,
          status: 409,
          code: 'tombstone_drop',
          message: `Silme işaretleri (tombstone) kaybı koruması devreye girdi (${before.tombstones} işaretten 0'a düşüş). Toplu silmeyi onaylayın veya sunucu verisini yükleyin.`,
          existingItems,
          incomingItems,
          currentRevision,
          serverDocument: current,
        };
      }

      // 3) Toplam sayı yanıltıcı olsa bile kaybolan kayıt sayısı büyükse.
      //    (B-09: 60 silme + 61 ekleme toplamı sabit tutabilir.)
      //    Eklenen kayıtlar silinenleri dengeleyip toplam sayıyı sabit tutsa bile
      //    (60 sil + 61 ekle) kütüphanenin yarısının kaybı sessizce kabul edilmez.
      const suddenDrop =
        removedKeys.length >= 3 &&
        removedKeys.length >= before.uniqueItems * 0.5;
      const legacyDrop =
        existingItems >= 5 &&
        existingItems - incomingItems >= 3 &&
        incomingItems < existingItems * 0.5;

      if (suddenDrop || legacyDrop) {
        return {
          ok: false,
          status: 409,
          code: 'sudden_item_drop',
          message: `Ani veri kaybı koruması devreye girdi (${before.uniqueItems} kayıttan ${after.uniqueItems} kayda düşüş; ${removedKeys.length} silindi, ${addedKeys.length} eklendi). Toplu silmeyi onaylayın veya sunucu verisini yükleyin.`,
          existingItems,
          incomingItems: after.uniqueItems,
          currentRevision,
          serverDocument: current,
        };
      }
    }

    const nextRevision = currentRevision + 1;
    const nowIso = new Date().toISOString();
    const documentToPersist: DataDocument = {
      ...normalized,
      revision: nextRevision,
      updatedAt: nowIso,
    };

    const persistedBytes = measureUtf8Bytes(JSON.stringify(documentToPersist, null, 2));
    if (persistedBytes > maxDataBytes) {
      return {
        ok: false,
        status: 413,
        code: 'payload_too_large',
        message: `Gönderilen veri boyutu izin verilen sınırı (${formatMaxDataLimitMb(maxDataBytes)}) aşıyor.`,
      };
    }

    return { ok: true, documentToPersist, incomingItems, merged: false };
  }

  function writeDiskSnapshotSync(doc: DataDocument): void {
    mkdirSync(backupsDir, { recursive: true });
    const snapName = formatSnapshotFileName(doc.revision ?? 0);
    const snapPath = path.join(backupsDir, snapName);
    writeJsonFileAtomic(snapPath, JSON.stringify(doc, null, 2), {
      validateParsed: (p) => validateRawDocument(p) !== null,
    });
    const allSnaps = listDiskSnapshotFilesNewestFirstSync();
    for (const staleName of allSnaps.slice(maxSnapshots)) {
      try {
        unlinkSync(path.join(backupsDir, staleName));
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async function writeDiskSnapshotAsync(doc: DataDocument): Promise<void> {
    await fsPromises.mkdir(backupsDir, { recursive: true });
    const snapName = formatSnapshotFileName(doc.revision ?? 0);
    const snapPath = path.join(backupsDir, snapName);
    await writeJsonFileAtomicAsync(snapPath, JSON.stringify(doc, null, 2), {
      validateParsed: (p) => validateRawDocument(p) !== null,
    });
    const allSnaps = await listDiskSnapshotFilesNewestFirstAsync();
    for (const staleName of allSnaps.slice(maxSnapshots)) {
      try {
        await fsPromises.unlink(path.join(backupsDir, staleName));
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  function persistDocumentDiskSync(current: DataDocument, next: DataDocument): void {
    if (isWorthKeeping(current)) {
      writeDiskSnapshotSync(current);
    }
    writeJsonFileAtomic(dataFile, JSON.stringify(next, null, 2), {
      backupPath: backupFile,
      validateParsed: (p) => validateRawDocument(p) !== null,
    });
    if (primaryStore.enabled) {
      primaryStore.write(next, next.revision ?? 0);
    }
    try {
      writeJsonFileAtomic(
        isolatedProfileFile,
        JSON.stringify(buildIsolatedProfilePayload(next), null, 2)
      );
      writeJsonFileAtomic(
        isolatedUserListsFile,
        JSON.stringify(buildIsolatedUserListsPayload(next), null, 2)
      );
    } catch {
      // Isolated mirror files are best-effort
    }
  }

  async function persistDocument(current: DataDocument, next: DataDocument): Promise<void> {
    if (isWorthKeeping(current)) {
      await writeDiskSnapshotAsync(current);
    }
    await writeJsonFileAtomicAsync(dataFile, JSON.stringify(next, null, 2), {
      backupPath: backupFile,
      validateParsed: (p) => validateRawDocument(p) !== null,
    });
    if (primaryStore.enabled) {
      primaryStore.write(next, next.revision ?? 0);
    }
    try {
      await writeJsonFileAtomicAsync(
        isolatedProfileFile,
        JSON.stringify(buildIsolatedProfilePayload(next), null, 2)
      );
      await writeJsonFileAtomicAsync(
        isolatedUserListsFile,
        JSON.stringify(buildIsolatedUserListsPayload(next), null, 2)
      );
    } catch {
      // Isolated mirror files are best-effort
    }
  }

  function saveData(rawPayload: unknown, saveOptions: SaveDataOptions = {}): SaveDataResult {
    const current = readData();
    const prepared = validateAndPrepareSave(current, rawPayload, saveOptions);
    if (!prepared.ok) {
      return prepared;
    }
    persistDocumentDiskSync(current, prepared.documentToPersist);
    unrecoverableCorruptionError = null;
    readLimitViolations = [];
    return {
      ok: true,
      document: prepared.documentToPersist,
      totalItems: prepared.incomingItems,
      merged: prepared.merged,
    };
  }

  async function saveDataAsync(
    rawPayload: unknown,
    saveOptions: SaveDataOptions = {}
  ): Promise<SaveDataResult> {
    const current = await readDataAsync();
    const prepared = validateAndPrepareSave(current, rawPayload, saveOptions);
    if (!prepared.ok) {
      return prepared;
    }
    await persistDocument(current, prepared.documentToPersist);
    unrecoverableCorruptionError = null;
    readLimitViolations = [];
    return {
      ok: true,
      document: prepared.documentToPersist,
      totalItems: prepared.incomingItems,
      merged: prepared.merged,
    };
  }

  function saveDataSerialized(
    rawPayload: unknown,
    saveOptions: SaveDataOptions = {}
  ): Promise<SaveDataResult> {
    return serialize(() => saveDataAsync(rawPayload, saveOptions));
  }

  async function listBackupsAsync(): Promise<BackupMetadata[]> {
    const files = await listDiskSnapshotFilesNewestFirstAsync();
    const backups: BackupMetadata[] = [];
    for (const fileName of files) {
      const fullPath = path.join(backupsDir, fileName);
      const parsed = await tryParseValidJsonAsync<DataDocument>(fullPath, validateRawDocument);
      if (!parsed.ok) continue;
      let createdAt = parsed.data.updatedAt || '';
      if (!createdAt) {
        try {
          const stat = await fsPromises.stat(fullPath);
          createdAt = stat.mtime.toISOString();
        } catch {
          createdAt = new Date().toISOString();
        }
      }
      backups.push({
        id: fileName,
        createdAt,
        revision: parsed.data.revision ?? 0,
        profilesCount: parsed.data.profiles.length,
        itemsCount: countTotalItems(parsed.data),
      });
    }
    return backups;
  }

  function restoreBackup(backupId: string): DataDocument | null {
    const id = String(backupId || '').trim();
    if (!id || !SNAPSHOT_FILE_PATTERN.test(id)) return null;
    const fullPath = path.resolve(backupsDir, id);
    if (!fullPath.startsWith(backupsDir + path.sep) || !existsSync(fullPath)) return null;

    const parsed = tryParseValidJson<DataDocument>(fullPath, validateRawDocument);
    if (!parsed.ok) return null;

    const current = readData();
    const restoredDoc: DataDocument = {
      ...parsed.data,
      revision: (current.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    persistDocumentDiskSync(current, restoredDoc);
    unrecoverableCorruptionError = null;
    return restoredDoc;
  }

  async function restoreBackupAsync(backupId: string): Promise<DataDocument | null> {
    const id = String(backupId || '').trim();
    if (!id || !SNAPSHOT_FILE_PATTERN.test(id)) return null;
    const fullPath = path.resolve(backupsDir, id);
    if (!fullPath.startsWith(backupsDir + path.sep) || !existsSync(fullPath)) return null;
    const parsed = await tryParseValidJsonAsync<DataDocument>(fullPath, validateRawDocument);
    if (!parsed.ok) return null;

    const current = await readDataAsync();
    const restoredDoc: DataDocument = {
      ...parsed.data,
      revision: (current.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    await persistDocument(current, restoredDoc);
    unrecoverableCorruptionError = null;
    return restoredDoc;
  }

  function restoreBackupSerialized(backupId: string): Promise<DataDocument | null> {
    return serialize(() => restoreBackupAsync(backupId));
  }

  /**
   * Aşama 1 (B-08) — revizyon korumalı, atomik snapshot geri yükleme.
   *
   * Sıra: yedek doğrula → güncel revizyonu oku → ön koşulu karşılaştır →
   * güvenlik snapshot'ı → atomik yazım. Herhangi bir adım başarısızsa mevcut
   * veri korunur (kısmi yazım yok).
   */
  async function restoreBackupGuardedAsync(
    backupId: string,
    restoreOptions: RestoreBackupOptions = {}
  ): Promise<RestoreBackupResult> {
    const id = String(backupId || '').trim();
    if (!id || !SNAPSHOT_FILE_PATTERN.test(id)) {
      return {
        ok: false,
        status: 404,
        code: 'backup_not_found',
        message: 'Belirtilen yedek dosyası bulunamadı veya bozuk.',
      };
    }
    const fullPath = path.resolve(backupsDir, id);
    if (!fullPath.startsWith(backupsDir + path.sep) || !existsSync(fullPath)) {
      return {
        ok: false,
        status: 404,
        code: 'backup_not_found',
        message: 'Belirtilen yedek dosyası bulunamadı veya bozuk.',
      };
    }

    const parsed = await tryParseValidJsonAsync<DataDocument>(fullPath, validateRawDocument);
    if (!parsed.ok) {
      return {
        ok: false,
        status: 404,
        code: 'backup_not_found',
        message: 'Belirtilen yedek dosyası bulunamadı veya bozuk.',
      };
    }

    const current = await readDataAsync();
    const currentRevision = current.revision ?? 0;
    const expectedRevision = restoreOptions.expectedRevision;

    if (restoreOptions.hasInvalidIfMatch) {
      return {
        ok: false,
        status: 412,
        code: 'revision_conflict',
        message: `Geçersiz If-Match başlığı gönderildi (mevcut rev-${currentRevision}).`,
        currentRevision,
      };
    }

    if (typeof expectedRevision === 'number' && Number.isSafeInteger(expectedRevision)) {
      if (expectedRevision !== currentRevision) {
        return {
          ok: false,
          status: currentRevision === 0 ? 412 : 409,
          code: 'revision_conflict',
          message: `Geri yükleme reddedildi: sunucudaki veri revizyonu değişmiş (beklenen rev-${expectedRevision}, mevcut rev-${currentRevision}). Güncel veriyi okuyup tekrar deneyin.`,
          currentRevision,
          expectedRevision,
        };
      }
    } else if (
      restoreOptions.requirePrecondition &&
      !restoreOptions.forceOverwrite &&
      currentRevision > 0
    ) {
      return {
        ok: false,
        status: 428,
        code: 'precondition_required',
        message: `Mevcut sunucu verisinin (rev-${currentRevision}) üzerine koşulsuz geri yükleme engellendi. If-Match başlığı gönderin.`,
        currentRevision,
      };
    }

    const restoredDoc: DataDocument = {
      ...parsed.data,
      revision: currentRevision + 1,
      updatedAt: new Date().toISOString(),
    };

    try {
      // `persistDocument` önce mevcut (sağlam) belgenin snapshot'ını yazar,
      // sonra hedef dosyayı atomik olarak değiştirir.
      await persistDocument(current, restoredDoc);
    } catch (error: any) {
      return {
        ok: false,
        status: 500,
        code: 'restore_failed',
        message: `Geri yükleme yazılamadı; mevcut veri korundu (${error?.message || 'bilinmeyen hata'}).`,
        currentRevision,
      };
    }

    unrecoverableCorruptionError = null;
    return { ok: true, document: restoredDoc };
  }

  function restoreBackupGuarded(
    backupId: string,
    restoreOptions: RestoreBackupOptions = {}
  ): Promise<RestoreBackupResult> {
    return serialize(() => restoreBackupGuardedAsync(backupId, restoreOptions));
  }

  function backupExistingDataAsync(): Promise<void> {
    return serialize(async () => {
      const current = await readDataAsync();
      if (current.profiles.length === 0 && (current.revision ?? 0) === 0) return;
      await writeDiskSnapshotAsync(current);
    });
  }

  function createSafetySnapshotSerialized(): Promise<void> {
    return serialize(async () => {
      const current = await readDataAsync();
      if (!isWorthKeeping(current)) return;
      await writeDiskSnapshotAsync(current);
    });
  }

  function applySyncedDocumentSerialized(rawPayload: unknown): Promise<SaveDataResult> {
    return serialize(() =>
      saveDataAsync(rawPayload, {
        expectedRevision: null,
        confirmBulkDelete: true,
        forceOverwrite: true,
      })
    );
  }

  return {
    dataDir: resolvedDataDir,
    dataFile,
    backupsDir,
    maxDataBytes,
    hasUnrecoverableCorruption: () => Boolean(unrecoverableCorruptionError),
    limitViolations: () => [...readLimitViolations],
    readData,
    readDataAsync,
    readIsolatedProfileAsync,
    readIsolatedUserListsAsync,
    saveData,
    saveDataSerialized,
    backupExistingDataAsync,
    createSafetySnapshotSerialized,
    applySyncedDocumentSerialized,
    listBackupsAsync,
    restoreBackup,
    restoreBackupSerialized,
    restoreBackupGuarded,
    sqliteStatus: () => primaryStore.status(),
    closeSqliteStore: () => primaryStore.close(),
  };
}
