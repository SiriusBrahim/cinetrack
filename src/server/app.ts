import { normalizeProfileId } from '../core/profile-id.ts';
import crypto from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import {
  dedupeItems,
  normalizeDeletedKeys,
  normalizeDataDocument,
  normalizeFavoriteActors,
  normalizePreferences,
  normalizeSavedItem,
  type DataDocument,
  type Profile,
  type SavedItem,
} from '../core/cinetrack-core.ts';
import { createDataStorage, countTotalItems, type StorageOptions } from './storage.ts';
import {
  createServerPrimaryDataRepository,
  type ServerPrimaryDataRepository,
} from './primary-data-repository.ts';
import { resolveStorageDriver } from './sqlite-primary-store.ts';
import { brandProfileFileName } from '../shared/brand.ts';
import {
  createContentSecurityPolicy,
  createOriginMiddleware,
  createTmdbRateLimitMiddleware,
  createTokenAuthMiddleware,
  isLoopbackHostname,
  type SecurityOptions,
} from './security.ts';
import { createTmdbProxyService, type TmdbProxyServiceOptions } from './tmdb-proxy.ts';
import { createTvdbProxyService } from './tvdb-proxy.ts';
import {
  PersistentDataStore,
  redactSecrets,
  type GitHubTokenCandidateInfo,
  type TokenSourceKind,
} from './persistent-store.ts';
import { CorruptJsonFileError } from './atomic-json.ts';
import { hashDocument } from './archive-integrity.ts';
import { RestoreJournal } from './restore-journal.ts';
import { DEFAULT_MAX_DATA_BYTES, formatMaxDataLimitMb } from '../core/limits.ts';
import { createAppEventBus, type AppEventBus } from '../app/app-event-bus.ts';
import { createModuleRegistry, type ModuleRegistry } from '../app/runtime-module-registry.ts';
import { createProfileContext, type ProfileContext } from '../app/ProfileContext.ts';
import {
  createServerTasteServiceAdapter,
  subscribeTasteAdapterToEventBus,
} from './taste-service-adapter.ts';
import { readTasteManifest } from './taste-store.ts';
import { validateCanonicalProfileId } from './taste-profile-scope.ts';
import { configureTasteHydration } from './taste-rebuild-coordinator.ts';
import {
  createContentProcessingCoordinator,
  type ContentProcessingCoordinator,
} from './content-processing-coordinator.ts';
import { createContentIntelligenceRouter } from './content-intelligence-routes.ts';
import { createLibraryService } from '../modules/library/service.ts';
import { createContentService } from '../modules/content/service.ts';
import { createBackgroundTaskRepository } from './background-task-repository.ts';
import { createBackgroundManager } from '../modules/background/service.ts';
import { createDefaultBackgroundHandlers } from '../modules/background/handlers.ts';
import { createTasteEventSyncHandler } from '../modules/background/taste-handlers.ts';
import {
  BACKGROUND_TASK_STATUSES,
  type BackgroundTaskRecord,
  type BackgroundTaskStatus,
} from '../contracts/background.ts';
import { describeTasteLegacyState } from './taste-legacy-status.ts';
import { diffLibraryEvents, findSavedItemByMediaKey } from './library-event-diff.ts';
import type {
  EventSubscription,
  IApplicationModule,
  ModuleContext,
  ModuleHealth,
} from '../contracts/index.ts';

/** SQLite arşivi yüklemesi: gövde diske akıtılır, bellekte tamponlanmaz (SEC-01). */
export const MAX_SQLITE_ARCHIVE_UPLOAD_BYTES = 256 * 1024 * 1024;

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Keep the runtime profile fence aligned after every durable document write. */
async function synchronizeProfileContext(
  context: ProfileContext,
  document: DataDocument
): Promise<void> {
  // R2-A3 §12.3: ProfileContext'e yalnızca kanonik profil kimliği yazılır;
  // 'default' gibi kanonik olmayan bir değer sessizce context'e taşınmaz.
  const candidateProfileId = String(
    document.activeProfileId || document.profiles?.[0]?.id || ''
  );
  let activeProfileId: string;
  try {
    activeProfileId = validateCanonicalProfileId(candidateProfileId);
  } catch {
    console.warn(
      '[profile-context] Kanonik olmayan aktif profil kimliği; eşitleme atlandı:',
      JSON.stringify(candidateProfileId)
    );
    return;
  }
  // Number.isSafeInteger tip daraltması yapmadığı için açık typeof kontrolü gerekir.
  const revision =
    typeof document.revision === 'number' && Number.isSafeInteger(document.revision)
      ? document.revision
      : 0;
  const current = context.getCurrent();
  if (current.profileId !== activeProfileId) {
    await context.switchProfile(activeProfileId, revision);
  } else {
    context.commitRevision(revision, activeProfileId);
  }
}

/**
 * P0-04: Gövdeyi diske akıtırken yarıda kesilme, soket hatası ve boyut aşımını
 * birlikte yönetir. Fonksiyon HER durumda sonuçlanır; geçici dosya çağıran
 * tarafından silinir, kilit `finally` bloğunda serbest kalır.
 */
function streamRequestBodyToFile(
  req: Request,
  filePath: string,
  maxBytes: number
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let total = 0;
    let settled = false;
    const out = createWriteStream(filePath, { mode: 0o600 });

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      req.pause();
      if (error) {
        out.destroy();
        reject(error);
      } else {
        out.end(() => resolve(total));
      }
    };

    out.on('error', (error) => finish(error));
    req.on('error', (error) => finish(error));
    // İstemci yükleme ortasında bağlantıyı kapatırsa promise asılı kalmasın.
    req.on('aborted', () =>
      finish(Object.assign(new Error('upload_aborted'), { code: 'upload_aborted' }))
    );
    req.on('close', () => {
      if (!req.complete) {
        finish(Object.assign(new Error('upload_aborted'), { code: 'upload_aborted' }));
      }
    });

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        finish(Object.assign(new Error('archive_too_large'), { code: 'archive_too_large' }));
        return;
      }
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => {
          if (!settled) req.resume();
        });
      }
    });

    req.on('end', () => {
      if (settled) return;
      finish();
    });
  });
}

import {
  executeProfileBackupExport,
  buildProfileBackupDataset,
  EXPORT_FILE_NAME_PATTERN,
  getPosterCacheStatsAsync,
} from './excel-profile-backup.ts';
import { createTasteRouter } from './taste-routes.ts';
import { runHybridMerge } from './hybrid-merge.ts';
import {
  isSqliteArchiveAvailable,
  readSqliteArchive,
  restoreArchivePostersToCache,
  writeSqliteArchive,
  SqliteArchiveValidationError,
  SqliteUnavailableError,
  MAX_ARCHIVE_POSTERS,
  SQLITE_ARCHIVE_SCHEMA_VERSION,
  type ArchiveSnapshot,
} from './sqlite-archive.ts';

export interface CineTrackAppOptions extends StorageOptions, SecurityOptions, TmdbProxyServiceOptions {
  dataDir?: string;
  tvdbApiKey?: string;
  persistentStore?: PersistentDataStore;
  security?: SecurityOptions;
  devMode?: boolean;
  maxDataBytes?: number;
  githubToken?: string;
  githubTokenSource?: TokenSourceKind;
  githubTokenCandidates?: GitHubTokenCandidateInfo[];
  getLiveGitHubTokenCandidates?: () => GitHubTokenCandidateInfo[];
  onAuthFailureRefreshToken?: (
    failedToken: string
  ) => Promise<{ token: string; source?: TokenSourceKind } | string | null>;
  onLocalDataMutated?: (reason: string) => void;
  githubOwner?: string;
  githubRepo?: string;
  githubBranch?: string;
  isPublicRepo?: boolean;
  allowPublicPersonalSync?: boolean;
  allowPublicCatalogSync?: boolean;
  processEnvIsPublicRepo?: string | null;
  localEnvIsPublicRepo?: string | null;
  registerCustomRoutes?: (app: Express) => void;
}

const STATIC_ASSET_EXT_PATTERN =
  /\.(?:js|mjs|cjs|css|map|png|jpg|jpeg|gif|svg|ico|webp|avif|woff|woff2|ttf|otf|eot|json|webmanifest|txt|xml|xlsx|wasm)$/i;

export function isStaticAssetRequestPath(reqPath: string): boolean {
  const cleanPath = String(reqPath || '').split('?')[0];
  if (cleanPath.startsWith('/assets/') || cleanPath.startsWith('/workbox-')) {
    return true;
  }
  return STATIC_ASSET_EXT_PATTERN.test(cleanPath);
}

export function createSpaFallbackMiddleware(indexHtmlPath: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path.startsWith('/api/')) {
      next();
      return;
    }
    if (isStaticAssetRequestPath(req.path)) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(404).type('text/plain; charset=utf-8').send('Static asset not found');
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtmlPath);
  };
}

interface ParsedWritePrecondition {
  expectedRevision: number | null;
  hasInvalidIfMatch: boolean;
  forceOverwrite: boolean;
}

function parseWritePrecondition(req: Request): ParsedWritePrecondition {
  const forceHeader = req.headers['x-cinetrack-force-write'];
  let forceOverwrite =
    forceHeader === '1' ||
    forceHeader === 'true' ||
    Boolean(req.body && typeof req.body === 'object' && req.body.forceOverwrite === true);

  const ifMatch = req.headers['if-match'];
  if (typeof ifMatch === 'string' && ifMatch.trim()) {
    const rawTrimmed = ifMatch.trim();
    if (rawTrimmed === '*') {
      forceOverwrite = true;
      return { expectedRevision: null, hasInvalidIfMatch: false, forceOverwrite };
    }
    const cleaned = rawTrimmed.replace(/^W\//i, '').replace(/^"|"$/g, '');
    const revMatch = cleaned.match(/^(?:rev-)?(\d+)$/);
    if (revMatch) {
      return { expectedRevision: Number(revMatch[1]), hasInvalidIfMatch: false, forceOverwrite };
    }
    return { expectedRevision: null, hasInvalidIfMatch: true, forceOverwrite };
  }

  const headerRev = req.headers['x-cinetrack-base-revision'];
  if (typeof headerRev === 'string' && headerRev.trim()) {
    if (/^\d+$/.test(headerRev.trim())) {
      return { expectedRevision: Number(headerRev.trim()), hasInvalidIfMatch: false, forceOverwrite };
    }
    return { expectedRevision: null, hasInvalidIfMatch: true, forceOverwrite };
  }

  if (req.body && typeof req.body === 'object' && typeof req.body.baseRevision === 'number') {
    if (Number.isSafeInteger(req.body.baseRevision) && req.body.baseRevision >= 0) {
      return { expectedRevision: req.body.baseRevision, hasInvalidIfMatch: false, forceOverwrite };
    }
  }

  return { expectedRevision: null, hasInvalidIfMatch: false, forceOverwrite };
}

function isBulkDeleteConfirmed(req: Request): boolean {
  const headerVal = req.headers['x-cinetrack-confirm-drop'];
  if (headerVal === '1' || headerVal === 'true') return true;
  if (req.body && typeof req.body === 'object' && req.body.confirmBulkDelete === true) return true;
  return false;
}

function parseMergeWriteOptions(req: Request): {
  mergeStrategy?: 'lossless';
  foldUnhydratedDefaultProfile: boolean;
} {
  const mergeHeader = String(req.headers['x-cinetrack-merge'] || '').trim().toLowerCase();
  const isLossless =
    mergeHeader === '1' ||
    mergeHeader === 'true' ||
    mergeHeader === 'lossless' ||
    Boolean(req.body && typeof req.body === 'object' && req.body.mergeStrategy === 'lossless');

  const foldHeader = String(req.headers['x-cinetrack-unhydrated-default'] || '')
    .trim()
    .toLowerCase();
  const foldUnhydratedDefaultProfile =
    foldHeader === '1' ||
    foldHeader === 'true' ||
    Boolean(
      req.body &&
        typeof req.body === 'object' &&
        req.body.foldUnhydratedDefaultProfile === true
    );

  return {
    ...(isLossless ? { mergeStrategy: 'lossless' } : {}),
    foldUnhydratedDefaultProfile,
  };
}

async function computeFileSha256Async(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function streamFileDownload(
  res: Response,
  filePath: string,
  headers: Record<string, string>
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    for (const [k, v] of Object.entries(headers)) {
      res.setHeader(k, v);
    }
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    res.on('finish', resolve);
    res.on('close', resolve);
    stream.pipe(res);
  });
}

/**
 * Merges an incoming client `profileSnapshot` with persistent server storage non-destructively.
 * Uses a strict `Profile` field whitelist (BUG-08) and supports explicit `disliked: []` clearing (EXT-12).
 */
export function resolveExportDocument(storedDoc: DataDocument, reqBody: any): DataDocument {
  if (!reqBody?.profileSnapshot || typeof reqBody.profileSnapshot !== 'object') {
    return storedDoc;
  }

  const snap = reqBody.profileSnapshot;
  const snapId =
    normalizeProfileId(snap.id) ?? normalizeProfileId(storedDoc.activeProfileId) ?? '';
  if (!snapId) return storedDoc;

  const snapItemsRaw = Array.isArray(snap.items) ? snap.items : [];
  const snapItems = dedupeItems(
    snapItemsRaw.map((it: any) => normalizeSavedItem(it)).filter(Boolean) as SavedItem[]
  );
  const snapPrefs = normalizePreferences(snap.preferences || {});
  const snapFavActors = normalizeFavoriteActors(snap.favoriteActors || []);
  const snapDeletedKeys = normalizeDeletedKeys(snap.deleted_keys);

  const existing = storedDoc.profiles.find((p) => normalizeProfileId(p.id) === snapId);
  if (!existing) {
    const serverHasData = storedDoc.profiles.some(
      (p) => (p.items?.length || 0) > 0 || (p.preferences?.disliked?.length || 0) > 0
    );
    if (snapItems.length === 0 && snapPrefs.disliked.length === 0 && serverHasData) {
      return storedDoc;
    }
    const createdProfile: Profile = {
      id: snapId,
      name: typeof snap.name === 'string' && snap.name.trim() ? snap.name.trim() : 'Profilim',
      createdAt: typeof snap.createdAt === 'string' ? snap.createdAt : '',
      preferences: snapPrefs,
      items: snapItems,
      favoriteActors: snapFavActors,
      isDemo: Boolean(snap.isDemo),
      ...(Object.keys(snapDeletedKeys).length > 0 ? { deleted_keys: snapDeletedKeys } : {}),
    };
    return {
      ...storedDoc,
      activeProfileId: snapId,
      profiles: [...storedDoc.profiles, createdProfile],
    };
  }

  const existingItems = Array.isArray(existing.items) ? existing.items : [];
  const mergedItems =
    snapItems.length >= existingItems.length
      ? snapItems
      : snapItems.length === 0
        ? existingItems
        : dedupeItems([...existingItems, ...snapItems]);

  const existingFavs = normalizeFavoriteActors(existing.favoriteActors || []);
  const mergedFavActors =
    snap.favoriteActorsCleared === true
      ? snapFavActors
      : snapFavActors.length > 0
        ? snapFavActors.length >= existingFavs.length
          ? snapFavActors
          : normalizeFavoriteActors([...existingFavs, ...snapFavActors])
        : existingFavs;

  const existingPrefs = normalizePreferences(existing.preferences || {});
  const snapHasExplicitDisliked = Boolean(
    snap.preferences &&
      typeof snap.preferences === 'object' &&
      Object.prototype.hasOwnProperty.call(snap.preferences, 'disliked') &&
      Array.isArray(snap.preferences.disliked)
  );
  const mergedPreferences = {
    ...existingPrefs,
    ...snapPrefs,
    disliked: snapHasExplicitDisliked ? snapPrefs.disliked : existingPrefs.disliked,
  };

  const mergedDeletedKeys = normalizeDeletedKeys({
    ...(existing.deleted_keys || {}),
    ...snapDeletedKeys,
  });

  const mergedProfile: Profile = {
    id: snapId,
    name: typeof snap.name === 'string' && snap.name.trim() ? snap.name.trim() : existing.name,
    createdAt: existing.createdAt || (typeof snap.createdAt === 'string' ? snap.createdAt : ''),
    isDemo: typeof snap.isDemo === 'boolean' ? snap.isDemo : Boolean(existing.isDemo),
    items: mergedItems,
    favoriteActors: mergedFavActors,
    preferences: mergedPreferences,
    ...(Object.keys(mergedDeletedKeys).length > 0 ? { deleted_keys: mergedDeletedKeys } : {}),
  };

  return {
    ...storedDoc,
    activeProfileId: snapId,
    profiles: storedDoc.profiles.map((p) => (normalizeProfileId(p.id) === snapId ? mergedProfile : p)),
  };
}

export function createCineTrackApp(options: CineTrackAppOptions): {
  app: Express;
  storage: ReturnType<typeof createDataStorage>;
  primaryRepository: ServerPrimaryDataRepository;
  eventBus: AppEventBus;
  profileContext: ProfileContext;
  moduleRegistry: ModuleRegistry;
  contentIntelligence: ContentProcessingCoordinator;
  /** MIA Faz 3 — merkezi kütüphane yazma hattı (ILibraryService). */
  libraryService: ReturnType<typeof createLibraryService>;
  /** MIA Faz 3 — merkezi ortak içerik okuma hattı (IContentService). */
  contentService: ReturnType<typeof createContentService>;
  /** MIA Faz 4 — kalıcı background görev yöneticisi. */
  backgroundManager: ReturnType<typeof createBackgroundManager>;
  startRuntimeModules: () => Promise<void>;
  stopRuntimeModules: () => Promise<void>;
  tmdbProxy: ReturnType<typeof createTmdbProxyService>;
  tvdbProxy: ReturnType<typeof createTvdbProxyService>;
  persistentStore: PersistentDataStore;
} {
  const resolvedDataDir = path.resolve(options.dataDir || path.join(process.cwd(), 'data'));
  const maxDataBytes = options.maxDataBytes ?? DEFAULT_MAX_DATA_BYTES;
  const storage = createDataStorage({
    ...options,
    dataDir: resolvedDataDir,
    maxDataBytes,
    storageDriver: options.storageDriver ?? resolveStorageDriver(),
  });
  const primaryRepository = createServerPrimaryDataRepository(storage);

  // MIA Faz 4 — Background Manager: kalıcı görev kuyruğu. Mevcut SQLite
  // (`data/cinetrack.db`) ve AppEventBus yeniden kullanılır; paralel sistem yok.
  const backgroundTaskRepository = createBackgroundTaskRepository({ dataDir: resolvedDataDir });
  const backgroundManager = createBackgroundManager({
    repository: backgroundTaskRepository,
    handlers: createDefaultBackgroundHandlers(),
    // Audit işleyicileri bilgi kaydı üretmez; yalnızca uyarı/hata sunucu
    // günlüğüne yazılır (görev başına gürültü yok).
    logger: {
      warn: (message, data) => console.warn(`[BackgroundManager] ${message}`, data ?? ''),
      error: (message, data) => console.error(`[BackgroundManager] ${message}`, data ?? ''),
    },
  });

  // Kalıcılık kancası: olay + görev yazımı başarısızsa publish reddedilir.
  const eventBus = createAppEventBus({
    persistEvent: async (event) => {
      await backgroundManager.acceptEvent(event);
    },
  });
  const profileContext = createProfileContext({
    // R2-A3 §12.3 mekanizma (a): açılış kimliği belge normalizasyonuyla hizalı
    // (kanonik profil kimliği `PROFILE-DEFAULT` olur; `default` geçersizdir).
    initialProfileId: 'profile-default',
    initialRevision: 0,
    eventPublisher: eventBus,
  });
  const tasteAdapter = createServerTasteServiceAdapter({
    dataDir: resolvedDataDir,
    profileContext,
    rebuildOnEvent: true,
  });
  // R2-A4: canlı abonelikte aktif olmayan profile ait olduğu için atlanan
  // olaylar, kalıcı kuyruktan hedef profil aktif olduğunda telafi edilir.
  backgroundManager.registerHandlers([createTasteEventSyncHandler(tasteAdapter)]);
  const tmdbProxy = createTmdbProxyService(options);
  const tvdbProxy = createTvdbProxyService({ tvdbApiKey: options.tvdbApiKey });
  const persistentStore =
    options.persistentStore ??
    new PersistentDataStore({
      dataDir: resolvedDataDir,
      maxDataBytes,
      githubToken: options.githubToken,
      githubTokenSource: options.githubTokenSource,
      githubTokenCandidates: options.githubTokenCandidates,
      getLiveGitHubTokenCandidates: options.getLiveGitHubTokenCandidates,
      onAuthFailureRefreshToken: options.onAuthFailureRefreshToken,
      githubOwner: options.githubOwner,
      githubRepo: options.githubRepo,
      githubBranch: options.githubBranch,
      isPublicRepo: options.isPublicRepo,
      allowPublicPersonalSync: options.allowPublicPersonalSync,
      allowPublicCatalogSync: options.allowPublicCatalogSync,
      processEnvIsPublicRepo: options.processEnvIsPublicRepo,
      localEnvIsPublicRepo: options.localEnvIsPublicRepo,
    });
  persistentStore.attachDataStorage(storage, maxDataBytes);

  // MIA Faz 1 Son Kabul — Adım 5: Sunucu çalışma zamanı ModuleRegistry yaşam döngüsü
  const moduleRegistry = createModuleRegistry();
  let primaryStorageStarted = false;
  let tasteSub: EventSubscription | null = null;
  let tasteErrorCount = 0;
  let tasteSkippedCount = 0;
  let lastTasteError: string | null = null;
  let backupSyncStarted = false;

  const primaryStorageModule: IApplicationModule = {
    id: 'primary-storage',
    version: '1.0.0',
    layer: 'background',
    async initialize() {
      const rawState = await primaryRepository.readRaw();
      if (rawState.document) {
        await synchronizeProfileContext(profileContext, rawState.document);
      }
    },
    async start() {
      primaryStorageStarted = true;
    },
    async stop() {
      primaryStorageStarted = false;
    },
    async healthCheck(): Promise<ModuleHealth> {
      const h = await primaryRepository.getHealth();
      if (!h.available) {
        return {
          moduleId: 'primary-storage',
          status: 'unhealthy',
          detail: h.lastError || `driver=${h.driver}`,
        };
      }
      return {
        moduleId: 'primary-storage',
        status: primaryStorageStarted ? 'healthy' : 'degraded',
        detail: `driver=${h.driver} revision=${h.revision ?? 0}`,
      };
    },
  };

  const tasteEngineModule: IApplicationModule = {
    id: 'taste-engine',
    version: '1.0.0',
    layer: 'background',
    async initialize() {
      configureTasteHydration(resolvedDataDir, options.tmdbApiKey || process.env.TMDB_API_KEY);
    },
    async start() {
      if (!tasteSub) {
        tasteSub = subscribeTasteAdapterToEventBus(
          eventBus,
          tasteAdapter,
          (ev, outcome) => {
            tasteErrorCount += 1;
            lastTasteError =
              (!outcome.ok && outcome.error) || `Olay işlenemedi (${ev.eventType})`;
          },
          (ev, outcome) => {
            // R2-A4: atlanan olay kaybolmaz; kalıcı kuyrukta hedef profil için
            // bekler. Sayaç sağlık raporunda görünür (sessiz kayıp yok).
            tasteSkippedCount += 1;
            backgroundManager.ensureProfileScopedTasks(ev);
            const reason = !outcome.ok ? outcome.error ?? '' : '';
            console.info(
              `[Taste] Aktif olmayan profile ait iç olay kuyruğa bırakıldı: ${ev.eventId} (${ev.profileId}). ${reason}`
            );
          }
        );
      }
    },
    async stop() {
      tasteSub?.unsubscribe();
      tasteSub = null;
    },
    async healthCheck(): Promise<ModuleHealth> {
      try {
        const manifest = await readTasteManifest(resolvedDataDir);
        // R2-A5: legacy veri salt okunur sınıflandırılır; hiçbir profile
        // otomatik bağlanmaz. Sağlık raporunda açıkça görünür.
        const legacy = await describeTasteLegacyState(resolvedDataDir);
        const legacyDetail = legacy.present
          ? `legacy=${legacy.scenario ?? 'unknown'}${legacy.mappingUnreadable ? ' (mapping unreadable)' : ''}`
          : 'legacy=none';
        if (lastTasteError) {
          return {
            moduleId: 'taste-engine',
            status: 'degraded',
            detail: `errors=${tasteErrorCount}; skipped=${tasteSkippedCount}; ${legacyDetail}; ${lastTasteError}`,
          };
        }
        return {
          moduleId: 'taste-engine',
          status: tasteSub ? 'healthy' : 'degraded',
          detail: manifest
            ? `generation=${manifest.generationId}; skipped=${tasteSkippedCount}; ${legacyDetail}`
            : tasteSub
              ? `subscribed (bootstrap pending); skipped=${tasteSkippedCount}; ${legacyDetail}`
              : `stopped; skipped=${tasteSkippedCount}; ${legacyDetail}`,
        };
      } catch (err) {
        return {
          moduleId: 'taste-engine',
          status: 'unhealthy',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  const backupSyncModule: IApplicationModule = {
    id: 'backup-sync',
    version: '1.0.0',
    layer: 'background',
    async initialize() {
      persistentStore.getSyncStatus();
    },
    async start() {
      backupSyncStarted = true;
    },
    async stop() {
      backupSyncStarted = false;
    },
    async healthCheck(): Promise<ModuleHealth> {
      const syncStatus = persistentStore.getSyncStatus();
      if (syncStatus.authFailed) {
        return {
          moduleId: 'backup-sync',
          status: 'degraded',
          detail: 'github_auth_failed',
        };
      }
      return {
        moduleId: 'backup-sync',
        status: backupSyncStarted ? 'healthy' : 'degraded',
        detail: `mode=${syncStatus.mode}`,
      };
    },
  };

  const contentIntelligence = createContentProcessingCoordinator({
    dataDir: resolvedDataDir,
    tmdbApiKey: options.tmdbApiKey || process.env.TMDB_API_KEY,
  });

  // MIA Faz 3 — Kütüphane Yöneticisi: kullanıcı listesi yazımlarının tek hattı.
  // Mevcut PrimaryDataRepository + ProfileContext + AppEventBus yeniden kullanılır;
  // ortak içerik deposuna yazmaz.
  const libraryService = createLibraryService({
    repository: primaryRepository,
    profileContext,
    eventPublisher: eventBus,
  });

  // MIA Faz 3 — İçerik Yöneticisi: mevcut metadata adaptörü, içerik kaydı ve
  // kuyruk portları üzerinden ortak içerik okuması. Yeni bir TMDB istemcisi,
  // repository veya şema oluşturulmaz.
  const contentService = createContentService({
    metadataSource: contentIntelligence.metadataSource,
    getStoredRecord: (mediaKey) => contentIntelligence.getByMediaKey(mediaKey),
    readDocument: async () => {
      const result = await primaryRepository.read();
      return result.document;
    },
    enqueueRawItem: (rawItem) => contentIntelligence.enqueueRawItem(rawItem),
  });

  moduleRegistry.register(primaryStorageModule);
  moduleRegistry.register(tasteEngineModule);
  moduleRegistry.register(backupSyncModule);
  moduleRegistry.register(contentIntelligence);

  // MIA Faz 2 — Adım 2.7 (Dilim G): Başlangıç indekslemesi modülü. Sunucu
  // açılışında PrimaryDataRepository üzerinden tüm profillerin beş liste
  // kapsamını (izledim/izleyeceğim/izliyorum/ilgilenmiyorum/gizlenen) ortak
  // kuyruğa sayfalı olarak verir; normal kullanıcı olaylarıyla idempotent
  // birleşir (aynı media_key için tek iş).
  const initialIndexerModule: IApplicationModule = {
    id: 'initial-indexer',
    version: '1.0.0',
    layer: 'background',
    async initialize() {},
    async start() {
      try {
        const raw = await primaryRepository.readRaw();
        const stats = await contentIntelligence.runInitialIndexing(raw.document, {
          pageSize: 25,
        });
        serverModuleContext.logger.info(
          'initial-indexer',
          `Başlangıç indekslemesi tamamlandı: ${stats.queued} iş kuyruğa alındı (${stats.rejected} reddedildi).`
        );
      } catch (err) {
        // Başlangıç indekslemesi normal kullanıcı olaylarını engellememeli.
        serverModuleContext.logger.warn(
          'initial-indexer',
          `Başlangıç indekslemesi uyarısı: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
    async stop() {},
    async healthCheck(): Promise<ModuleHealth> {
      const stats = contentIntelligence.getInitialIndexStats();
      return {
        moduleId: 'initial-indexer',
        status:
          stats.status === 'completed' ? 'healthy' : stats.status === 'failed' ? 'unhealthy' : 'degraded',
        detail: `status=${stats.status} queued=${stats.queued} rejected=${stats.rejected}`,
      };
    },
  };
  moduleRegistry.register(initialIndexerModule);

  const serverModuleContext: ModuleContext = {
    profile: profileContext,
    events: eventBus,
    subscribe: eventBus,
    logger: {
      info(moduleId, message) {
        console.log(`[Module:${moduleId}] ${message}`);
      },
      warn(moduleId, message) {
        console.warn(`[Module:${moduleId}] ${message}`);
      },
      error(moduleId, message) {
        console.error(`[Module:${moduleId}] ${message}`);
      },
    },
  };

  const startRuntimeModules = async () => {
    await moduleRegistry.startAll(serverModuleContext);
    // Background Manager mevcut yaşam döngüsüne bağlanır. ModuleRegistry'ye ayrı
    // kayıt eklenmez: `/api/health` modül listesi sözleşmesi (ve Agent 1 testleri)
    // mevcut beş modül kimliğini doğrular; yönetici yine ModuleContext ile beslenir.
    await backgroundManager.initialize(serverModuleContext);
    await backgroundManager.start();
  };

  const stopRuntimeModules = async () => {
    await backgroundManager.stop();
    await moduleRegistry.stopAll();
  };

  const notifyLocalMutation = (reason: string) => {
    try {
      options.onLocalDataMutated?.(reason);
    } catch {
      // arka plan bildirim hatası HTTP yanıtını etkilememeli
    }
  };

  const sec: SecurityOptions = { ...options, ...(options.security || {}) };
  const originGuard = createOriginMiddleware(sec);
  const tokenGuard = createTokenAuthMiddleware(sec);
  const syncStatusGuard = createTokenAuthMiddleware({ ...sec, requireTokenForReads: true });
  // Yerel masaüstü kullanımında okumalar açık kalır; sunucu loopback dışına
  // bağlandığında kişisel veri GET'leri de token ister.
  const personalReadGuard = createTokenAuthMiddleware({
    ...sec,
    requireTokenForReads: !isLoopbackHostname((sec.bindHost ?? '127.0.0.1').trim() || '127.0.0.1'),
  });
  const tmdbRateLimiter = createTmdbRateLimitMiddleware(sec);

  const app = express();
  app.disable('x-powered-by');
  if (sec.trustProxy) {
    app.set('trust proxy', true);
  }

  // Temel güvenlik başlıkları (BUG-12.1)
  const contentSecurityPolicy = createContentSecurityPolicy({
    allowInlineScripts: Boolean(options.devMode),
  });
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', contentSecurityPolicy);
    next();
  });

  // SEC-01: /api mutasyonları gövde ayrıştırılmadan önce kaynak + token doğrulamasından
  // geçer. Böylece yetkisiz bir istek büyük gövdeyle belleği şişiremez.
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase())) {
      next();
      return;
    }
    originGuard(req, res, () => tokenGuard(req, res, next));
  });

  app.use(
    express.json({
      limit: maxDataBytes,
      verify: (_req, _res, buf) => {
        if (buf.byteLength > maxDataBytes) {
          const err: any = new Error('Payload too large');
          err.status = 413;
          err.type = 'entity.too.large';
          throw err;
        }
      },
    })
  );

  // Standardized body-parser error handling (413 Payload Too Large & 400 Invalid JSON)
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (!err) {
      next();
      return;
    }
    if (err.type === 'entity.too.large' || err.status === 413) {
      res.status(413).json({
        status_message: `Gönderilen veri boyutu izin verilen sınırı (${formatMaxDataLimitMb(maxDataBytes)}) aşıyor.`,
        code: 'payload_too_large',
      });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({
        status_message: 'Gönderilen JSON gövdesi ayrıştırılamadı.',
        code: 'invalid_json',
      });
      return;
    }
    next(err);
  });

  // Teknik tanılama: kullanıcı arayüzüne açılmayan, token korumalı çalışma zamanı durumu.
  app.get('/api/diagnostics/runtime', personalReadGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const [contentHealth, backgroundHealth] = await Promise.all([
        contentIntelligence.healthCheck(),
        backgroundManager.healthCheck(),
      ]);
      res.json({
        ok: true,
        checkedAt: new Date().toISOString(),
        contentIntelligence: contentIntelligence.getStatus(),
        backgroundManager: backgroundManager.getStatus(),
        health: {
          contentIntelligence: contentHealth,
          backgroundManager: backgroundHealth,
        },
      });
    } catch (err) {
      res.status(503).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Runtime tanılama durumu okunamadı.',
      });
    }
  });

  /**
   * İşlem Merkezi — kalıcı background görev kuyruğu.
   *
   * Güvenlik: yalnızca AKTİF profile ait görevler döner; istemci `profileId`
   * parametresiyle başka profilin kuyruğunu okuyamaz. Dosya yolları, olay
   * payload'ı ve ham hata metinleri istemciye taşınmaz; `lastError` sırlardan
   * arındırılıp kısaltılır.
   */
  const sanitizeBackgroundTask = (task: BackgroundTaskRecord) => ({
    taskId: task.taskId,
    eventId: task.eventId,
    handlerId: task.handlerId,
    profileId: task.profileId,
    status: task.status,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    nextRetryAt: task.nextRetryAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    lastError: task.lastError
      ? redactSecrets(task.lastError, persistentStore.getKnownSecretsForRedaction()).slice(0, 400)
      : null,
  });

  app.get('/api/background/tasks', personalReadGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const activeProfileId = profileContext.getCurrent().profileId;
      const rawStatus = typeof req.query.status === 'string' ? req.query.status.trim() : '';
      if (rawStatus && !BACKGROUND_TASK_STATUSES.includes(rawStatus as BackgroundTaskStatus)) {
        res.status(400).json({ ok: false, code: 'invalid_status', error: 'Geçersiz görev durumu.' });
        return;
      }
      const rawLimit = Number.parseInt(String(req.query.limit ?? '100'), 10);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 100;
      const tasks = backgroundManager
        .listTasks({
          profileId: activeProfileId,
          ...(rawStatus ? { status: rawStatus as BackgroundTaskStatus } : {}),
          limit,
        })
        .map(sanitizeBackgroundTask);
      res.json({
        ok: true,
        checkedAt: new Date().toISOString(),
        activeProfileId,
        stats: backgroundManager.getStats(),
        store: { available: backgroundTaskRepository.getStatus().available },
        tasks,
      });
    } catch (err) {
      res.status(503).json({
        ok: false,
        code: 'background_unavailable',
        error: err instanceof Error ? err.message : 'Görev kuyruğu okunamadı.',
      });
    }
  });

  app.post(
    '/api/background/tasks/:taskId/retry',
    originGuard,
    tokenGuard,
    async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const task = backgroundManager.getTask(String(req.params.taskId || ''));
      if (!task) {
        res.status(404).json({ ok: false, code: 'task_not_found', error: 'Görev bulunamadı.' });
        return;
      }
      if (task.profileId !== profileContext.getCurrent().profileId) {
        res.status(403).json({ ok: false, code: 'profile_mismatch', error: 'Görev aktif profile ait değil.' });
        return;
      }
      if (!backgroundManager.retryTask(task.taskId)) {
        res.status(409).json({
          ok: false,
          code: 'task_not_retryable',
          error: 'Bu görev yeniden denenebilir durumda değil.',
        });
        return;
      }
      const updated = backgroundManager.getTask(task.taskId);
      res.json({ ok: true, task: updated ? sanitizeBackgroundTask(updated) : null });
    }
  );

  app.post(
    '/api/background/tasks/:taskId/cancel',
    originGuard,
    tokenGuard,
    async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const task = backgroundManager.getTask(String(req.params.taskId || ''));
      if (!task) {
        res.status(404).json({ ok: false, code: 'task_not_found', error: 'Görev bulunamadı.' });
        return;
      }
      if (task.profileId !== profileContext.getCurrent().profileId) {
        res.status(403).json({ ok: false, code: 'profile_mismatch', error: 'Görev aktif profile ait değil.' });
        return;
      }
      if (!backgroundManager.cancelTask(task.taskId, 'cancelled-by-user')) {
        res.status(409).json({
          ok: false,
          code: 'task_not_cancellable',
          error: 'Bu görev iptal edilebilir durumda değil.',
        });
        return;
      }
      const updated = backgroundManager.getTask(task.taskId);
      res.json({ ok: true, task: updated ? sanitizeBackgroundTask(updated) : null });
    }
  );

  app.get('/api/health', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const [posterCache, repoHealth, moduleHealth] = await Promise.all([
      getPosterCacheStatsAsync(path.join(resolvedDataDir, 'cache', 'posters')),
      primaryRepository.getHealth(),
      moduleRegistry.healthCheckAll(),
    ]);
    res.json({
      ok: true,
      posterCache,
      storage: {
        ...storage.sqliteStatus(),
        ...repoHealth,
        driver: repoHealth.driver,
      },
      modules: moduleHealth,
      // MIA Faz 2 — Adım 2.7: İlk indeksleme durumu sağlık API'sinde görünür.
      contentIntelligence: {
        initialIndex: contentIntelligence.getInitialIndexStats(),
        queue: contentIntelligence.repository.getQueueStats(),
      },
    });
  });

  // === SQLite arşivi: profil + stok + stok görsellerinin tek dosyalık tam yedeği ===
  app.get('/api/archive/sqlite/status', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      available: await isSqliteArchiveAvailable(),
      schemaVersion: SQLITE_ARCHIVE_SCHEMA_VERSION,
      maxPosters: MAX_ARCHIVE_POSTERS,
    });
  });

  app.post('/api/archive/sqlite', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const snapshot = req.body as ArchiveSnapshot;
      const archiveDir = path.join(resolvedDataDir, 'archives');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `cinethos-archive-${stamp}.sqlite`;
      const filePath = path.join(archiveDir, fileName);
      const result = await writeSqliteArchive(snapshot, filePath);
      res.setHeader('Content-Type', 'application/vnd.sqlite3');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader(
        'X-Archive-Stats',
        JSON.stringify({
          profiles: result.profiles,
          items: result.items,
          tasteMaps: result.tasteMaps,
          stockMovies: result.stockMovies,
          stockTv: result.stockTv,
          postersStored: result.postersStored,
          postersFailed: result.postersFailed,
          posterBytes: result.posterBytes,
          byteLength: result.byteLength,
        })
      );
      res.sendFile(filePath);
    } catch (error: any) {
      if (error instanceof SqliteUnavailableError) {
        res.status(501).json({ status_message: error.message, code: 'sqlite_unavailable' });
        return;
      }
      if (error instanceof SqliteArchiveValidationError) {
        res.status(400).json({ status_message: error.message, code: 'invalid_archive_snapshot' });
        return;
      }
      res.status(500).json({
        status_message: `SQLite arşivi oluşturulamadı: ${redactSecrets(error?.message || String(error), persistentStore.getKnownSecretsForRedaction())}`,
        code: 'archive_write_failed',
      });
    }
  });

  // === P0-01: kalıcı journal + optimistic concurrency + tek güvenli akış ===
  interface PreparedArchiveRestore {
    restoreId: string;
    filePath: string;
    createdAt: number;
    byteLength: number;
    documentHash: string;
    beforeDocumentHash: string;
    beforeRevision: number;
    archive: Awaited<ReturnType<typeof readSqliteArchive>>;
  }

  const preparedRestores = new Map<string, PreparedArchiveRestore>();
  const PREPARED_RESTORE_TTL_MS = 10 * 60_000;
  const RESTORE_JOURNAL_TTL_MS = 30 * 60_000;
  const restoreJournal = new RestoreJournal(path.join(resolvedDataDir, 'restore-journal'));
  let journalReady: Promise<void> | null = null;
  let archiveRestoreInFlight = false;

  const archiveUploadDir = path.join(resolvedDataDir, 'archives');

  function ensureRestoreJournal(): Promise<void> {
    if (!journalReady) journalReady = restoreJournal.init();
    return journalReady;
  }

  async function markJournalRolledBack(restoreId: string, error?: string): Promise<void> {
    try {
      await restoreJournal.update(restoreId, {
        state: 'rolled_back',
        ...(error ? { lastError: error } : {}),
      });
      await restoreJournal.remove(restoreId);
    } catch {
      // journal yazılamazsa veri yolu zaten geri alınmış olabilir
    }
  }

  /**
   * Açılışta yarım kalan restore'ları çöz: commit edilmiş ama istemci tarafından
   * onaylanmamış işlem geri alınır, istemci tamamlamışsa finalized sayılır.
   */
  async function recoverInterruptedRestores(): Promise<void> {
    await ensureRestoreJournal();
    let records: Awaited<ReturnType<RestoreJournal['list']>> = [];
    try {
      records = await restoreJournal.list();
    } catch (error: any) {
      console.warn('[RestoreJournal] Kayıtlar okunamadı:', error?.message || error);
      return;
    }

    for (const record of records) {
      try {
        if (record.state === 'server_committed' || record.state === 'rollback_required') {
          const snapshot = await restoreJournal.readSnapshot(record.restoreId);
          const snapshotDocument = snapshot?.document as DataDocument | undefined;
          const validSnapshot =
            snapshotDocument &&
            Array.isArray(snapshotDocument.profiles) &&
            hashDocument(snapshotDocument) === record.beforeDocumentHash;

          if (!validSnapshot) {
            await restoreJournal.update(record.restoreId, {
              state: 'rollback_required',
              lastError: 'before_snapshot_missing_or_corrupt',
            });
            console.warn(
              '[RestoreJournal] Geri alma snapshot doğrulanamadı; kayıt rollback_required olarak bırakıldı:',
              record.restoreId
            );
            continue;
          }

          const restored = await rollbackArchiveRestore(snapshotDocument);
          if (restored) {
            console.warn('[RestoreJournal] Yarıda kalan restore geri alındı:', record.restoreId);
            await markJournalRolledBack(record.restoreId);
          } else {
            await restoreJournal.update(record.restoreId, {
              state: 'rollback_required',
              lastError: 'startup_rollback_failed',
            });
          }
          continue;
        }

        if (record.state === 'client_committed') {
          await restoreJournal.update(record.restoreId, { state: 'finalized' });
        }
        await restoreJournal.remove(record.restoreId);
      } catch (error: any) {
        console.warn('[RestoreJournal] Kurtarma hatası:', record.restoreId, error?.message || error);
      }
    }
  }

  void ensureRestoreJournal()
    .then(recoverInterruptedRestores)
    .catch((error: any) => {
      console.warn('[RestoreJournal] Başlatma hatası:', error?.message || error);
    });

  /** Yarıda kalmış eski yüklemeleri temizle: disk şişmesin, eski dosya geri yüklenmesin. */
  async function cleanupStaleArchiveUploads(): Promise<void> {
    try {
      const entries = await fsPromises.readdir(archiveUploadDir);
      const cutoff = Date.now() - 60 * 60_000;
      await Promise.all(
        entries
          .filter((name) => /^(restore|prepare)-.+\.sqlite$/.test(name))
          .map(async (name) => {
            const fullPath = path.join(archiveUploadDir, name);
            try {
              const stat = await fsPromises.stat(fullPath);
              if (stat.mtimeMs < cutoff) await fsPromises.rm(fullPath, { force: true });
            } catch {
              // dosya bu arada silinmiş olabilir
            }
          })
      );
    } catch {
      // arşiv klasörü henüz yok
    }
  }

  function prunePreparedRestores(): void {
    const cutoff = Date.now() - PREPARED_RESTORE_TTL_MS;
    for (const [id, entry] of preparedRestores) {
      if (entry.createdAt >= cutoff) continue;
      preparedRestores.delete(id);
      void fsPromises.rm(entry.filePath, { force: true }).catch(() => {
        // geçici dosya zaten silinmiş olabilir
      });
      void restoreJournal
        .update(id, { state: 'rolled_back', lastError: 'prepare_expired' })
        .then(() => restoreJournal.remove(id))
        .catch(() => {
          // journal yazılamazsa TTL temizliği zaten dosyayı siliyor
        });
    }
  }

  void cleanupStaleArchiveUploads();

  const ARCHIVE_CONTENT_TYPES = new Set([
    'application/octet-stream',
    'application/vnd.sqlite3',
    'application/x-sqlite3',
  ]);

  function respondArchiveTooLarge(req: Request, res: Response): void {
    // Gövde akışı yarıda kesildiği için bağlantı tekrar kullanılmamalı; yanıt
    // gönderildikten sonra soket kapatılır (istemci deterministik 413 görür).
    if (!res.headersSent) {
      res.setHeader('Connection', 'close');
      res.status(413).json({
        status_message: `Arşiv dosyası en fazla ${formatMegabytes(MAX_SQLITE_ARCHIVE_UPLOAD_BYTES)} olabilir.`,
        code: 'archive_too_large',
      });
    }
    res.once('finish', () => {
      req.destroy();
    });
  }

  type ArchiveUploadResult =
    | { ok: true; filePath: string; byteLength: number }
    | { ok: false; status: number; code: string; message: string };

  async function receiveArchiveUpload(req: Request): Promise<ArchiveUploadResult> {
    const contentType = String(req.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!ARCHIVE_CONTENT_TYPES.has(contentType)) {
      return {
        ok: false,
        status: 415,
        code: 'unsupported_media_type',
        message: 'SQLite arşivi application/octet-stream olarak gönderilmeli.',
      };
    }

    const declaredBytes = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_SQLITE_ARCHIVE_UPLOAD_BYTES) {
      return {
        ok: false,
        status: 413,
        code: 'archive_too_large',
        message: `Arşiv dosyası en fazla ${formatMegabytes(MAX_SQLITE_ARCHIVE_UPLOAD_BYTES)} olabilir.`,
      };
    }

    await fsPromises.mkdir(archiveUploadDir, { recursive: true });
    const filePath = path.join(
      archiveUploadDir,
      `prepare-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.sqlite`
    );
    let byteLength: number;
    try {
      byteLength = await streamRequestBodyToFile(
        req,
        filePath,
        MAX_SQLITE_ARCHIVE_UPLOAD_BYTES
      );
    } catch (error) {
      // P0-04: yarıda kesilen/boyutu aşan yükleme geçici dosya bırakmaz.
      await fsPromises.rm(filePath, { force: true }).catch(() => {
        // temizlik en iyi çaba
      });
      throw error;
    }

    const headerHandle = await fsPromises.open(filePath, 'r');
    const signature = Buffer.alloc(16);
    try {
      await headerHandle.read(signature, 0, 16, 0);
    } finally {
      await headerHandle.close();
    }
    if (signature.toString('utf8') !== 'SQLite format 3\u0000') {
      await fsPromises.rm(filePath, { force: true });
      return {
        ok: false,
        status: 400,
        code: 'invalid_archive_file',
        message: 'Gönderilen dosya geçerli bir SQLite arşivi değil.',
      };
    }

    return { ok: true, filePath, byteLength };
  }

  /**
   * P0-01: Arşiv belgesinin özeti, yazma yolunun uygulayacağı normalizasyondan
   * geçirilerek hesaplanır. Aksi hâlde normalize edilen belge arşivdeki ham
   * belgeden farklı görünür ve doğrulama yanlış yere kırmızı olur.
   */
  function archiveDocumentHash(document: DataDocument): string {
    const normalized =
      normalizeDataDocument(document, {
        maxProfiles: options.maxProfiles,
        maxItems: options.maxItemsPerProfile,
      }) || document;
    return hashDocument(normalized);
  }

  function describeArchive(entry: PreparedArchiveRestore) {
    const { archive } = entry;
    return {
      schemaVersion: archive.schemaVersion,
      createdAt: archive.createdAt,
      appVersion: archive.appVersion,
      counts: archive.counts,
      documentHash: entry.documentHash,
      byteLength: entry.byteLength,
      profiles: archive.dataDocument.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        items: Array.isArray(profile.items) ? profile.items.length : 0,
      })),
    };
  }

  async function rollbackArchiveRestore(beforeDocument: DataDocument): Promise<boolean> {
    try {
      const restored = await primaryRepository.saveRaw(beforeDocument, {
        forceOverwrite: true,
        confirmBulkDelete: true,
        requirePrecondition: false,
      });
      if (!restored.ok) return false;
      await synchronizeProfileContext(profileContext, restored.document);
      return true;
    } catch {
      return false;
    }
  }

  async function commitArchiveRestore(
    entry: PreparedArchiveRestore,
    res: Response
  ): Promise<void> {
    const { archive } = entry;
    const rawCurrent = await primaryRepository.readRaw();
    const current = rawCurrent.document;

    // P0-01-C: önizleme ile onay arasında veri değiştiyse eski arşiv sessizce yazılmaz.
    const currentHash = hashDocument(current);
    const currentRevision = current.revision ?? 0;
    if (currentHash !== entry.beforeDocumentHash || currentRevision !== entry.beforeRevision) {
      await restoreJournal.update(entry.restoreId, {
        state: 'rolled_back',
        lastError: 'archive_source_changed',
      });
      await restoreJournal.remove(entry.restoreId);
      preparedRestores.delete(entry.restoreId);
      res.status(409).json({
        status_message:
          'Önizlemeden sonra sunucu verisi değişti. Arşivi yeniden seçip onaylayın.',
        code: 'archive_source_changed',
        currentRevision,
        expectedRevision: entry.beforeRevision,
      });
      return;
    }

    // Commit niyeti önce diske yazılır: süreç burada çökerse açılışta geri alınır.
    await restoreJournal.update(entry.restoreId, { state: 'server_committed' });

    const saved = await primaryRepository.saveRaw(archive.dataDocument, {
      forceOverwrite: true,
      confirmBulkDelete: true,
      requirePrecondition: false,
    });
    if (!saved.ok) {
      await markJournalRolledBack(entry.restoreId, saved.code);
      res.status(saved.status).json({ status_message: saved.message, code: saved.code });
      return;
    }
    await synchronizeProfileContext(profileContext, saved.document);

    const writtenProfiles = Array.isArray(saved.document?.profiles) ? saved.document.profiles : [];
    const writtenItems = countTotalItems(saved.document);
    const writtenHash = hashDocument(saved.document);

    if (
      writtenProfiles.length !== archive.counts.profiles ||
      writtenItems !== archive.counts.items ||
      writtenHash !== entry.documentHash
    ) {
      const rolledBack = await rollbackArchiveRestore(current);
      if (rolledBack) {
        await markJournalRolledBack(entry.restoreId, 'verification_failed');
      } else {
        await restoreJournal.update(entry.restoreId, {
          state: 'rollback_required',
          lastError: 'verification_failed_rollback_failed',
        });
      }
      res.status(500).json({
        status_message: rolledBack
          ? 'Arşiv doğrulanamadı (profil/kayıt veya içerik özeti uyuşmuyor); önceki veriler geri yüklendi.'
          : 'Arşiv doğrulanamadı (profil/kayıt veya içerik özeti uyuşmuyor); önceki veriler geri alınamadı.',
        code: 'archive_restore_verification_failed',
        rolledBack,
        expectedHash: entry.documentHash,
        actualHash: writtenHash,
        expectedCounts: archive.counts,
        actualCounts: {
          profiles: writtenProfiles.length,
          items: writtenItems,
        },
      });
      return;
    }

    let posters: { written: number; skipped: number };
    try {
      posters = await restoreArchivePostersToCache(
        archive.posters,
        path.join(resolvedDataDir, 'cache', 'posters')
      );
    } catch (error: any) {
      const rolledBack = await rollbackArchiveRestore(current);
      if (rolledBack) {
        await markJournalRolledBack(entry.restoreId, 'poster_restore_failed');
      } else {
        await restoreJournal.update(entry.restoreId, {
          state: 'rollback_required',
          lastError: 'poster_restore_failed_rollback_failed',
        });
      }
      res.status(500).json({
        status_message: rolledBack
          ? 'Posterler geri yazılamadı; önceki veriler geri yüklendi.'
          : 'Posterler geri yazılamadı; önceki veriler geri alınamadı.',
        code: 'archive_restore_poster_failed',
        rolledBack,
        detail: redactSecrets(
          error?.message || String(error),
          persistentStore.getKnownSecretsForRedaction()
        ),
      });
      return;
    }

    await restoreJournal.update(entry.restoreId, {
      state: 'server_committed',
      committedRevision: saved.document.revision ?? currentRevision + 1,
    });
    // Aynı restoreId ile ikinci commit yapılamaz; finalize/rollback journal üzerinden yürür.
    preparedRestores.delete(entry.restoreId);

    notifyLocalMutation('sqlite-archive-restore');
    res.json({
      ok: true,
      restoreId: entry.restoreId,
      counts: archive.counts,
      documentHash: entry.documentHash,
      postersWritten: posters.written,
      postersSkipped: posters.skipped,
      // P1 ilkesi: kısmi poster geri yüklemesi "tam" gibi gizlenmez.
      postersComplete: posters.skipped === 0,
      dataDocument: saved.document,
      tasteMaps: archive.tasteMaps,
      stock: archive.stock,
      createdAt: archive.createdAt,
    });
  }

  /** inspect + prepare: dosyayı okur, özet döner, HİÇBİR veriyi değiştirmez. */
  app.post(
    '/api/archive/sqlite/prepare',
    originGuard,
    tokenGuard,
    async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      if (archiveRestoreInFlight) {
        res.status(409).json({
          status_message: 'Başka bir arşiv işlemi sürüyor; bitmesini bekleyin.',
          code: 'archive_restore_busy',
        });
        return;
      }

      archiveRestoreInFlight = true;
      let uploadedPath: string | null = null;
      try {
        await ensureRestoreJournal();
        prunePreparedRestores();
        const upload = await receiveArchiveUpload(req);
        if (!upload.ok) {
          if (upload.code === 'archive_too_large') {
            respondArchiveTooLarge(req, res);
            return;
          }
          res.status(upload.status).json({ status_message: upload.message, code: upload.code });
          return;
        }
        uploadedPath = upload.filePath;

        const archive = await readSqliteArchive(upload.filePath);
        // MIA Faz 1 — Adım 1.4: Birincil veri okumaları PrimaryDataRepository üzerinden yapılır.
        const current = (await primaryRepository.readRaw()).document;
        const restoreId = crypto.randomUUID();
        const createdAt = Date.now();
        const beforeDocumentHash = hashDocument(current);
        const beforeRevision = current.revision ?? 0;
        const documentHash = archiveDocumentHash(archive.dataDocument);

        const entry: PreparedArchiveRestore = {
          restoreId,
          filePath: upload.filePath,
          createdAt,
          byteLength: upload.byteLength,
          documentHash,
          beforeDocumentHash,
          beforeRevision,
          archive,
        };
        preparedRestores.set(restoreId, entry);

        const { snapshotSha256 } = await restoreJournal.saveSnapshot(restoreId, current);
        await restoreJournal.write({
          restoreId,
          state: 'prepared',
          createdAt: new Date(createdAt).toISOString(),
          expiresAt: new Date(createdAt + RESTORE_JOURNAL_TTL_MS).toISOString(),
          archiveHash: documentHash,
          beforeDocumentHash,
          beforeRevision,
          beforeSnapshotSha256: snapshotSha256,
          archivePath: upload.filePath,
        });

        res.json({
          ok: true,
          restoreId,
          expiresAt: new Date(createdAt + PREPARED_RESTORE_TTL_MS).toISOString(),
          inspect: describeArchive(entry),
          current: {
            counts: {
              profiles: Array.isArray(current.profiles) ? current.profiles.length : 0,
              items: countTotalItems(current),
              revision: beforeRevision,
            },
            documentHash: beforeDocumentHash,
          },
        });
      } catch (error: any) {
        if (uploadedPath) {
          await fsPromises.rm(uploadedPath, { force: true }).catch(() => {
            // temizlik en iyi çaba
          });
        }
        if (error?.code === 'archive_too_large') {
          respondArchiveTooLarge(req, res);
          return;
        }
        if (error?.code === 'upload_aborted') {
          if (!res.headersSent) {
            res.status(400).json({
              status_message: 'Arşiv yüklemesi yarıda kesildi.',
              code: 'upload_aborted',
            });
          }
          return;
        }
        if (error instanceof SqliteUnavailableError) {
          res.status(501).json({ status_message: error.message, code: 'sqlite_unavailable' });
          return;
        }
        if (error instanceof SqliteArchiveValidationError) {
          res.status(400).json({ status_message: error.message, code: 'invalid_archive_file' });
          return;
        }
        if (!res.headersSent) {
          res.status(500).json({
            status_message: `SQLite arşivi okunamadı: ${redactSecrets(error?.message || String(error), persistentStore.getKnownSecretsForRedaction())}`,
            code: 'archive_inspect_failed',
          });
        }
      } finally {
        archiveRestoreInFlight = false;
      }
    }
  );

  /**
   * P0-01-D: commit yalnızca geçerli `restoreId` ile yapılır. Doğrudan dosya
   * yükleme yolu kapatıldı; arşiv önce prepare ile incelenmek zorunda.
   */
  app.post(
    '/api/archive/sqlite/restore',
    originGuard,
    tokenGuard,
    async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      if (archiveRestoreInFlight) {
        res.status(409).json({
          status_message: 'Başka bir arşiv geri yüklemesi sürüyor; bitmesini bekleyin.',
          code: 'archive_restore_busy',
        });
        return;
      }

      const restoreId =
        req.body && typeof req.body === 'object' && typeof (req.body as any).restoreId === 'string'
          ? String((req.body as any).restoreId)
          : '';

      if (!restoreId) {
        res.status(428).json({
          status_message:
            'Arşiv önce /api/archive/sqlite/prepare ile incelenmeli ve onaylanmalı.',
          code: 'archive_prepare_required',
        });
        return;
      }

      archiveRestoreInFlight = true;
      try {
        await ensureRestoreJournal();
        prunePreparedRestores();
        const entry = preparedRestores.get(restoreId);
        if (!entry) {
          res.status(409).json({
            status_message:
              'Hazırlanan arşiv bulunamadı veya süresi doldu; dosyayı yeniden seçin.',
            code: 'archive_prepare_expired',
          });
          return;
        }
        await commitArchiveRestore(entry, res);
      } catch (error: any) {
        if (!res.headersSent) {
          res.status(500).json({
            status_message: `SQLite arşivi geri yüklenemedi: ${redactSecrets(error?.message || String(error), persistentStore.getKnownSecretsForRedaction())}`,
            code: 'archive_restore_failed',
          });
        }
      } finally {
        archiveRestoreInFlight = false;
      }
    }
  );

  /** P0-01-D: İstemci yan verileri doğruladıktan sonra journal kaydını kapatır. */
  app.post(
    '/api/archive/sqlite/finalize',
    originGuard,
    tokenGuard,
    async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const restoreId =
        req.body && typeof req.body === 'object' && typeof (req.body as any).restoreId === 'string'
          ? String((req.body as any).restoreId)
          : '';
      if (!restoreId) {
        res.status(400).json({
          status_message: 'Finalize için restoreId gerekli.',
          code: 'invalid_finalize_request',
        });
        return;
      }
      await ensureRestoreJournal();
      const record = await restoreJournal.get(restoreId);
      if (!record) {
        res.status(409).json({
          status_message: 'Restore kaydı bulunamadı veya süresi doldu.',
          code: 'restore_not_found',
        });
        return;
      }
      if (record.state !== 'server_committed' && record.state !== 'client_committed') {
        res.status(409).json({
          status_message: `Restore bu aşamada finalize edilemez: ${record.state}`,
          code: 'restore_finalize_invalid_state',
          state: record.state,
        });
        return;
      }
      await restoreJournal.update(restoreId, { state: 'finalized' });
      await restoreJournal.remove(restoreId);
      preparedRestores.delete(restoreId);
      const archivePath = record.archivePath;
      if (archivePath && path.resolve(archivePath).startsWith(path.resolve(archiveUploadDir))) {
        await fsPromises.rm(archivePath, { force: true }).catch(() => {
          // geçici arşiv zaten silinmiş olabilir
        });
      }
      res.json({ ok: true, restoreId, state: 'finalized' });
    }
  );

  /** P0-01-B: İstemci yan verileri yazamazsa sunucu belgesini kalıcı snapshot'tan geri alır. */
  app.post(
    '/api/archive/sqlite/rollback',
    originGuard,
    tokenGuard,
    async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const rawId =
        req.body && typeof req.body === 'object'
          ? String((req.body as any).restoreId || (req.body as any).rollbackId || '')
          : '';
      if (!rawId) {
        res.status(400).json({
          status_message: 'Geri alma kimliği gerekli.',
          code: 'invalid_rollback_request',
        });
        return;
      }
      await ensureRestoreJournal();
      const record = await restoreJournal.get(rawId);
      if (!record) {
        res.status(409).json({
          status_message: 'Geri alma kaydı bulunamadı veya süresi doldu.',
          code: 'rollback_unavailable',
        });
        return;
      }
      const snapshot = await restoreJournal.readSnapshot(record.restoreId);
      const snapshotDocument = snapshot?.document as DataDocument | undefined;
      if (!snapshotDocument || hashDocument(snapshotDocument) !== record.beforeDocumentHash) {
        await restoreJournal.update(record.restoreId, {
          state: 'rollback_required',
          lastError: 'snapshot_missing_or_corrupt',
        });
        res.status(500).json({
          status_message: "Önceki veri snapshot'ı doğrulanamadı; otomatik geri alma yapılamadı.",
          code: 'rollback_snapshot_invalid',
        });
        return;
      }

      const restored = await rollbackArchiveRestore(snapshotDocument);
      if (!restored) {
        await restoreJournal.update(record.restoreId, {
          state: 'rollback_required',
          lastError: 'rollback_failed',
        });
        res.status(500).json({
          status_message: 'Önceki veriler geri yüklenemedi.',
          code: 'rollback_failed',
        });
        return;
      }

      await restoreJournal.update(record.restoreId, { state: 'rolled_back' });
      await restoreJournal.remove(record.restoreId);
      preparedRestores.delete(record.restoreId);
      notifyLocalMutation('sqlite-archive-rollback');
      res.json({
        ok: true,
        dataDocument: snapshotDocument,
        counts: {
          profiles: snapshotDocument.profiles?.length ?? 0,
          items: countTotalItems(snapshotDocument),
        },
      });
    }
  );

  app.get('/api/tmdb-status', tmdbProxy.handleStatus);
  app.get('/api/tmdb', tmdbRateLimiter, tmdbProxy.handleTmdb);
  app.get('/api/tmdb-image', tmdbRateLimiter, tmdbProxy.handleTmdbImage);

  // TVDB proxy: 17a12e8'te eklenen entegrasyon korundu.
  app.get('/api/tvdb-status', tvdbProxy.handleStatus);
  app.get('/api/tvdb', tmdbRateLimiter, tvdbProxy.handleTvdb);
  app.post('/api/tvdb-login', originGuard, tokenGuard, tvdbProxy.handleLogin);

  app.get('/api/data', personalReadGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const rawState = await primaryRepository.readRaw();
    if (rawState.corrupt) {
      res.status(500).json({
        status_message:
          'Mevcut veri dosyası bozuk ve kurtarılabilecek geçerli bir yedek bulunamadı. Veri kaybını önlemek için lütfen sunucu dosyalarını kontrol edin.',
        code: 'corrupt_storage',
      });
      return;
    }
    const doc = rawState.document;
    const rev = doc.revision ?? 0;
    res.setHeader('ETag', `"rev-${rev}"`);
    res.json(doc);
  });

  app.put('/api/data', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { expectedRevision, hasInvalidIfMatch, forceOverwrite } = parseWritePrecondition(req);
      const confirmBulkDelete = isBulkDeleteConfirmed(req);
      const { mergeStrategy, foldUnhydratedDefaultProfile } = parseMergeWriteOptions(req);
      const rawProfileHeader = req.headers['x-cinetrack-profile-id'];
      const expectedProfileId =
        typeof rawProfileHeader === 'string' && rawProfileHeader.trim()
          ? normalizeProfileId(rawProfileHeader)
          : undefined;
      if (typeof rawProfileHeader === 'string' && rawProfileHeader.trim() && !expectedProfileId) {
        res.status(400).json({ ok: false, code: 'invalid_profile_id', message: 'Geçersiz profileId başlığı.' });
        return;
      }
      const strictProfileMatch =
        req.headers['x-cinetrack-strict-profile'] === '1' ||
        req.headers['x-cinetrack-strict-profile'] === 'true';
      // MIA Faz 2 — Adım 2.5 (Dilim F): Gerçek liste olayları için önceki belge
      // diff tabanı olarak okunur (birincil okuma repository üzerinden).
      const beforeDoc = (await primaryRepository.readRaw()).document;
      const result = await primaryRepository.saveRaw(req.body, {
        expectedRevision,
        hasInvalidIfMatch,
        requirePrecondition: !forceOverwrite,
        forceOverwrite,
        confirmBulkDelete,
        mergeStrategy,
        foldUnhydratedDefaultProfile,
        ...(expectedProfileId ? { expectedProfileId } : {}),
        ...(strictProfileMatch ? { strictProfileMatch } : {}),
      });

      if (!result.ok) {
        if (result.currentRevision !== undefined) {
          res.setHeader('ETag', `"rev-${result.currentRevision}"`);
        }
        res.status(result.status).json({
          status_message: result.message,
          code: result.code,
          currentRevision: result.currentRevision,
          expectedRevision: result.expectedRevision,
          existingItems: result.existingItems,
          incomingItems: result.incomingItems,
          serverDocument: result.serverDocument,
        });
        return;
      }

      const rev = result.document.revision ?? 1;
      await synchronizeProfileContext(profileContext, result.document);
      notifyLocalMutation('user-data-save');

      // Kritik domain olaylarını HTTP yanıtından önce teslim et. EventBus artık
      // abone hatalarını publish() çağrısına döndürür; içerik kuyruğu abonesi
      // başarısızsa yalnızca ilgili mediaKey için güvenli bir key-only fallback
      // enqueue edilir (tüm kütüphaneyi her PUT'ta yeniden kuyruğa almıyoruz).
      const libraryEvents = diffLibraryEvents(beforeDoc, result.document);
      for (const ev of libraryEvents) {
        let hintItem: ReturnType<typeof findSavedItemByMediaKey> = undefined;
        try {
          // Plan 2.5 — gerekli kaynak ipuçları: olayı türeten kaydın ortak
          // (allowlist) metaverisi hint olarak kaydedilir; kişisel alanlar
          // registerMetadataHint içinde sanitize edilir. Böylece metadata
          // kaynağı (TMDB/katalog) olmasa bile ortak kayıt doğrulamalı
          // metaveriyle tamamlanabilir.
          const hintMediaKey =
            typeof ev.entityId === 'string' && /^(movie|tv):\d+$/.test(ev.entityId)
              ? ev.entityId
              : typeof (ev.payload as Record<string, unknown> | undefined)?.mediaKey === 'string'
                ? String((ev.payload as Record<string, unknown>).mediaKey)
                : '';
          hintItem =
            findSavedItemByMediaKey(result.document, hintMediaKey) ??
            findSavedItemByMediaKey(beforeDoc, hintMediaKey);
          if (hintItem) {
            contentIntelligence.eventSubscriber.registerMetadataHint(
              ev.eventId,
              hintItem as unknown as Record<string, unknown>
            );
          }
          await eventBus.publish(ev);
        } catch (pubErr) {
          const payload = (ev.payload ?? {}) as Record<string, unknown>;
          const mediaKey =
            typeof payload.mediaKey === 'string'
              ? payload.mediaKey
              : typeof ev.entityId === 'string' && /^(movie|tv):\d+$/.test(ev.entityId)
                ? ev.entityId
                : null;
          if (mediaKey) {
            // Önce olayın türetildiği allowlist metadata ipucunu koru.
            // Yalnızca belge içinde eşleşen kayıt bulunamazsa key-only fallback kullan.
            contentIntelligence.enqueueHiddenOrDislikedItem(
              mediaKey,
              hintItem as unknown as Record<string, unknown> | undefined
            );
          } else {
            console.warn(
              `[Olay] ${ev.eventType} teslim edilemedi (${ev.eventId}):`,
              pubErr instanceof Error ? pubErr.message : pubErr
            );
          }
        }
      }

      const responsePayload = {
        ok: true,
        revision: rev,
        updatedAt: result.document.updatedAt,
        profiles: result.document.profiles.length,
        items: result.totalItems,
        ...(mergeStrategy === 'lossless'
          ? {
              merged: Boolean(result.merged),
              document: result.document,
            }
          : {}),
      };
      res.setHeader('ETag', `"rev-${rev}"`);
      res.json(responsePayload);
    } catch (error: any) {
      if (error instanceof CorruptJsonFileError) {
        res.status(500).json({ status_message: error.message, code: error.code });
        return;
      }
      console.error('Veri kaydedilemedi:', error?.message || error);
      res.status(500).json({ status_message: 'Veri dosyasına yazılamadı.', code: 'storage_write_failed' });
    }
  });

  app.get('/api/isolated/profile', personalReadGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await storage.readIsolatedProfileAsync());
  });

  app.get('/api/isolated/user-lists', personalReadGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await storage.readIsolatedUserListsAsync());
  });

  app.get('/api/data/backups', personalReadGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ backups: await storage.listBackupsAsync() });
  });

  app.post('/api/data/backup-now', originGuard, tokenGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await storage.createSafetySnapshotSerialized();
      const backups = await storage.listBackupsAsync();
      res.json({ ok: true, message: 'Yedek anlık görüntüsü başarıyla alındı.', backups });
    } catch (err: any) {
      res.status(500).json({ ok: false, status_message: err?.message || 'Yedek alınamadı.' });
    }
  });

  app.post('/api/data/restore', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const backupId = typeof req.body?.backupId === 'string' ? req.body.backupId.trim() : '';
    if (!backupId) {
      res.status(400).json({ status_message: 'Geri yüklenecek yedek kimliği (backupId) gerekli.', code: 'missing_backup_id' });
      return;
    }

    // Aşama 1 (B-08) — revizyon korumalı restore: eski revizyona göre hazırlanmış
    // bir yedek, eşzamanlı yeni veriyi sessizce ezemez.
    const { expectedRevision, hasInvalidIfMatch, forceOverwrite } = parseWritePrecondition(req);
    const bodyExpectedRevision =
      req.body &&
      typeof req.body === 'object' &&
      typeof req.body.expectedRevision === 'number' &&
      Number.isSafeInteger(req.body.expectedRevision) &&
      req.body.expectedRevision >= 0
        ? req.body.expectedRevision
        : null;

    const result = await storage.restoreBackupGuarded(backupId, {
      expectedRevision: expectedRevision ?? bodyExpectedRevision,
      hasInvalidIfMatch,
      requirePrecondition: !forceOverwrite,
      forceOverwrite,
    });

    if (!result.ok) {
      if (result.currentRevision !== undefined) {
        res.setHeader('ETag', `"rev-${result.currentRevision}"`);
      }
      res.status(result.status).json({
        ok: false,
        status_message: result.message,
        code: result.code,
        currentRevision: result.currentRevision,
        expectedRevision: result.expectedRevision,
      });
      return;
    }

    const restored = result.document;
    const rev = restored.revision ?? 1;
    res.setHeader('ETag', `"rev-${rev}"`);
    res.json({
      ok: true,
      revision: rev,
      updatedAt: restored.updatedAt,
      profiles: restored.profiles.length,
      items: countTotalItems(restored),
      document: restored,
    });
    notifyLocalMutation('backup-restore');
  });

  // --- Kalıcı Veri Deposu & Çift Yönlü GitHub Senkronizasyonu ---

  app.get('/api/stock', tokenGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const snapshot = persistentStore.readStockSnapshot();
    if (!snapshot) {
      res.json({ ok: true, exists: false, movies: [], tv: [], total: 0, updatedAt: '' });
      return;
    }
    res.json({
      ok: true,
      exists: true,
      schemaVersion: snapshot.schemaVersion,
      updatedAt: snapshot.updatedAt,
      movies: snapshot.movies,
      tv: snapshot.tv,
      total: snapshot.movies.length + snapshot.tv.length,
    });
  });

  app.post('/api/stock/upload', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const movies = req.body?.movies;
    const tv = req.body?.tv;
    if (movies !== undefined && !Array.isArray(movies)) {
      res.status(400).json({ ok: false, status_message: "'movies' alanı dizi olmalı.", code: 'invalid_stock_payload' });
      return;
    }
    if (tv !== undefined && !Array.isArray(tv)) {
      res.status(400).json({ ok: false, status_message: "'tv' alanı dizi olmalı.", code: 'invalid_stock_payload' });
      return;
    }
    if (movies === undefined && tv === undefined) {
      res.status(400).json({ ok: false, status_message: 'movies veya tv alanlarından en az biri gönderilmeli.', code: 'invalid_stock_payload' });
      return;
    }
    try {
      const result = await persistentStore.saveStockSnapshotUpload({ movies, tv });
      res.json(result);
      notifyLocalMutation('stock-upload');
    } catch (err: any) {
      res.status(500).json({ ok: false, status_message: err?.message || 'Stok anlık görüntüsü kaydedilemedi.' });
    }
  });

  app.get('/api/cinema-kunye', personalReadGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const doc = await persistentStore.readCinemaKunyeAsync();
      if (!doc) {
        res.json({
          ok: true,
          exists: false,
          schemaVersion: 1,
          updatedAt: '',
          entries: {},
          entriesCount: 0,
        });
        return;
      }
      res.json({
        ok: true,
        exists: true,
        schemaVersion: doc.schemaVersion,
        updatedAt: doc.updatedAt,
        entries: doc.entries,
        entriesCount: Object.keys(doc.entries).length,
        cinemaKunye: doc,
      });
    } catch (err: any) {
      res.status(500).json({
        ok: false,
        status_message: err?.message || 'Sinema künyesi okunamadı.',
      });
    }
  });

  app.post('/api/cinema-kunye', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({
        ok: false,
        status_message: 'Geçerli bir Sinema Künyesi nesnesi gönderilmelidir.',
        code: 'invalid_cinema_kunye_payload',
      });
      return;
    }
    const mode: 'merge' | 'overwrite' = req.body?.mode === 'overwrite' ? 'overwrite' : 'merge';
    const rawDoc =
      req.body?.cinemaKunye && typeof req.body.cinemaKunye === 'object'
        ? req.body.cinemaKunye
        : req.body?.document && typeof req.body.document === 'object'
          ? req.body.document
          : req.body;
    try {
      const saved = await persistentStore.saveCinemaKunyeSerialized(rawDoc, { mode });
      res.json({
        ok: true,
        mode,
        merged: saved.merged,
        entriesCount: saved.entriesCount,
        document: saved.document,
      });
      notifyLocalMutation('cinema-kunye-save');
    } catch (err: any) {
      res.status(500).json({
        ok: false,
        status_message: err?.message || 'Sinema künyesi kaydedilemedi.',
      });
    }
  });

  app.get('/api/sync/status', syncStatusGuard, (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(persistentStore.getSyncStatus());
  });

  app.post('/api/sync/inspect', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.body?.rejectIfBusy === true && persistentStore.isSyncBusy()) {
      res.status(409).json({
        ok: false,
        operation: 'inspect',
        code: 'sync_in_progress',
        verifiedEqual: false,
        errors: [
          {
            category: 'sync_in_progress',
            message: 'Başka bir GitHub senkronizasyon işlemi devam ediyor.',
          },
        ],
      });
      return;
    }
    try {
      const report = await persistentStore.inspectGitHub();
      res.json(report);
    } catch (e: any) {
      res.status(500).json({
        ok: false,
        operation: 'inspect',
        verifiedEqual: false,
        errors: [
          {
            category: 'http_error',
            message: redactSecrets(e?.message || 'GitHub durum denetimi başarısız oldu.', [
              options.githubToken,
            ]),
          },
        ],
      });
    }
  });

  app.post('/api/sync/pull', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.body?.rejectIfBusy === true && persistentStore.isSyncBusy()) {
      res.status(409).json({
        ok: false,
        operation: 'pull',
        code: 'sync_in_progress',
        verifiedEqual: false,
        errors: [
          {
            category: 'sync_in_progress',
            message: 'Başka bir GitHub senkronizasyon işlemi devam ediyor.',
          },
        ],
      });
      return;
    }
    try {
      const rawStrategy = req.body?.conflictStrategy;
      const conflictStrategy: 'ask' | 'merge' | 'overwrite_with_remote' =
        rawStrategy === 'merge' || rawStrategy === 'overwrite_with_remote' ? rawStrategy : 'ask';
      const report = await persistentStore.pullFromGitHub({ conflictStrategy });
      if (typeof report.serverRevision === 'number') {
        res.setHeader('ETag', `"rev-${report.serverRevision}"`);
      }
      res.json(report);
    } catch (e: any) {
      res.status(500).json({
        ok: false,
        operation: 'pull',
        verifiedEqual: false,
        errors: [
          {
            category: 'http_error',
            message: redactSecrets(e?.message || 'GitHub indirme işlemi başarısız oldu.', [
              options.githubToken,
            ]),
          },
        ],
      });
    }
  });

  app.post('/api/sync/push', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.body?.rejectIfBusy === true && persistentStore.isSyncBusy()) {
      res.status(409).json({
        ok: false,
        operation: 'push',
        code: 'sync_in_progress',
        verifiedEqual: false,
        errors: [
          {
            category: 'sync_in_progress',
            message: 'Başka bir GitHub senkronizasyon işlemi devam ediyor.',
          },
        ],
      });
      return;
    }
    try {
      const report = await persistentStore.pushToGitHub();
      res.json(report);
    } catch (e: any) {
      res.status(500).json({
        ok: false,
        operation: 'push',
        verifiedEqual: false,
        errors: [
          {
            category: 'http_error',
            message: redactSecrets(e?.message || 'GitHub yükleme işlemi başarısız oldu.', [
              options.githubToken,
            ]),
          },
        ],
      });
    }
  });

  app.post('/api/sync/reconcile', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.body?.rejectIfBusy === true && persistentStore.isSyncBusy()) {
      res.status(409).json({
        ok: false,
        operation: 'reconcile',
        code: 'sync_in_progress',
        verifiedEqual: false,
        errors: [
          {
            category: 'sync_in_progress',
            message: 'Başka bir GitHub senkronizasyon işlemi devam ediyor.',
          },
        ],
      });
      return;
    }
    try {
      const report = await persistentStore.reconcileWithGitHub();
      if (typeof report.serverRevision === 'number') {
        res.setHeader('ETag', `"rev-${report.serverRevision}"`);
      }
      res.json(report);
    } catch (e: any) {
      res.status(500).json({
        ok: false,
        operation: 'reconcile',
        verifiedEqual: false,
        errors: [
          {
            category: 'http_error',
            message: redactSecrets(e?.message || 'İki yönlü eşitleme işlemi başarısız oldu.', [
              options.githubToken,
            ]),
          },
        ],
      });
    }
  });

  app.post('/api/sync/trigger', originGuard, tokenGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const syncResult = await persistentStore.syncToGitHub();
      res.json(syncResult);
    } catch (e: any) {
      res.status(500).json({
        ok: false,
        error: redactSecrets(e?.message || 'Sync failed', [options.githubToken]),
      });
    }
  });

  app.post('/api/sync/test-connection', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const forceWriteProbe = Boolean(req.body?.forceWriteProbe);
      const probeResult = await persistentStore.testSafeConnectionAndProbeManifest({
        forceWriteProbe,
      });
      res.json(probeResult);
    } catch (e: any) {
      res.status(500).json({
        ok: false,
        error: redactSecrets(e?.message || 'Bağlantı testi başarısız oldu.', [options.githubToken]),
      });
    }
  });

  app.post('/api/sync/token', originGuard, tokenGuard, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const rawToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!rawToken) {
      res.status(400).json({ ok: false, error: 'Token boş olamaz.' });
      return;
    }
    persistentStore.updateGitHubToken(rawToken, 'env:CINETRACK_GITHUB_PAT');
    res.json({ ok: true, status: persistentStore.getSyncStatus() });
  });

  app.post('/api/sync/public-consent', originGuard, tokenGuard, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const allow =
      typeof req.body?.allowPersonalDataInPublicRepo === 'boolean'
        ? req.body.allowPersonalDataInPublicRepo
        : typeof req.body?.allow === 'boolean'
          ? req.body.allow
          : undefined;
    if (typeof allow !== 'boolean') {
      res.status(400).json({
        ok: false,
        status_message: 'allowPersonalDataInPublicRepo alanı boolean (true/false) olmalıdır.',
      });
      return;
    }
    if (allow && req.body?.confirmPublicVisibility !== true) {
      res.status(400).json({
        ok: false,
        status_message:
          'Açık depoya kişisel veri senkronizasyonu için confirmPublicVisibility=true onayı zorunludur.',
      });
      return;
    }
    const updated = persistentStore.setPublicPersonalSyncConsent(allow);
    res.json({
      ok: true,
      ...updated,
      status: persistentStore.getSyncStatus(),
    });
  });

  app.post('/api/sync/public-catalog-consent', originGuard, tokenGuard, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const allow =
      typeof req.body?.allowCatalogInPublicRepo === 'boolean'
        ? req.body.allowCatalogInPublicRepo
        : typeof req.body?.allow === 'boolean'
          ? req.body.allow
          : undefined;
    if (typeof allow !== 'boolean') {
      res.status(400).json({
        ok: false,
        status_message: 'allowCatalogInPublicRepo alanı boolean (true/false) olmalıdır.',
      });
      return;
    }
    if (allow && req.body?.confirmTmdbAttribution !== true) {
      res.status(400).json({
        ok: false,
        status_message:
          'Açık depoya TMDB katalog verisi yüklemek için confirmTmdbAttribution=true onayı zorunludur.',
      });
      return;
    }
    const updated = persistentStore.setPublicCatalogSyncConsent(allow);
    res.json({
      ok: true,
      ...updated,
      status: persistentStore.getSyncStatus(),
    });
  });

  app.post('/api/sync/staged', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.body?.rejectIfBusy === true && persistentStore.isSyncBusy()) {
      res.status(409).json({
        ok: false,
        code: 'sync_in_progress',
        error: 'Başka bir GitHub senkronizasyon işlemi devam ediyor.',
      });
      return;
    }
    try {
      const forceWriteProbe =
        typeof req.body?.forceWriteProbe === 'boolean' ? req.body.forceWriteProbe : true;
      const allowOverride =
        typeof req.body?.allowPersonalDataInPublicRepo === 'boolean'
          ? req.body.allowPersonalDataInPublicRepo
          : undefined;
      const allowCatalogOverride =
        typeof req.body?.allowCatalogInPublicRepo === 'boolean'
          ? req.body.allowCatalogInPublicRepo
          : undefined;
      const stagedReport = await persistentStore.runStagedFullSync({
        forceWriteProbe,
        ...(allowOverride !== undefined ? { allowPersonalDataInPublicRepo: allowOverride } : {}),
        ...(allowCatalogOverride !== undefined ? { allowCatalogInPublicRepo: allowCatalogOverride } : {}),
      });
      if (typeof stagedReport.bidirectionalReport?.serverRevision === 'number') {
        res.setHeader('ETag', `"rev-${stagedReport.bidirectionalReport.serverRevision}"`);
      }
      res.json(stagedReport);
    } catch (e: any) {
      res.status(500).json({
        ok: false,
        error: redactSecrets(e?.message || 'Aşamalı senkronizasyon başarısız oldu.', [
          options.githubToken,
        ]),
      });
    }
  });

  app.get('/api/catalog', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const type = _req.query.type === 'tv' ? 'tv' : _req.query.type === 'movie' ? 'movie' : 'all';
      if (type === 'all') {
        const movies = await persistentStore.readCatalogAsync('movie');
        const tv = await persistentStore.readCatalogAsync('tv');
        const manifest = await persistentStore.readCatalogManifestAsync();
        res.json({ movies, tv, ...(manifest ? { manifest } : {}) });
      } else {
        res.json(await persistentStore.readCatalogAsync(type));
      }
    } catch (err: any) {
      if (err instanceof CorruptJsonFileError) {
        res.status(500).json({ ok: false, code: err.code, status_message: err.message });
        return;
      }
      res.status(500).json({ ok: false, status_message: 'Katalog okunamadı.' });
    }
  });

  app.post('/api/catalog/upsert', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const raw = req.body;
      const items = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : raw ? [raw] : [];
      const result = await persistentStore.upsertCatalogItemsSerialized(items);
      if (contentIntelligence.queue.isRunning() && items.length > 0) {
        void contentIntelligence
          .enqueueLibraryItemsBatch(items as Record<string, unknown>[])
          .catch(() => undefined);
      }
      res.json({ ok: true, ...result });
    } catch (err: any) {
      if (err instanceof CorruptJsonFileError) {
        res.status(500).json({ ok: false, code: err.code, status_message: err.message });
        return;
      }
      res.status(500).json({ ok: false, status_message: 'Katalog güncellenemedi.' });
    }
  });

  app.get('/api/profiles/derived/:profileId', personalReadGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const profileId = normalizeProfileId(req.params.profileId);
      if (!profileId) {
        res.status(400).json({ ok: false, status_message: 'Geçersiz profil kimliği.' });
        return;
      }
      const expectedFp =
        typeof req.query.profileFingerprint === 'string' ? req.query.profileFingerprint : undefined;
      const expectedAlg =
        typeof req.query.algorithmVersion === 'string' ? req.query.algorithmVersion : undefined;
      const expectedCatHash =
        typeof req.query.sourceCatalogHash === 'string' ? req.query.sourceCatalogHash : undefined;

      if (expectedFp && expectedAlg) {
        const validation = await persistentStore.readValidatedDerivedProfileAsync(profileId, {
          profileFingerprint: expectedFp,
          algorithmVersion: expectedAlg,
          sourceCatalogHash: expectedCatHash,
        });
        if (!validation.valid) {
          const status = validation.reason === 'missing_document' ? 404 : 409;
          res.status(status).json({
            ok: false,
            cacheValid: false,
            reason: validation.reason,
          });
          return;
        }
        res.json(validation.document);
        return;
      }

      const doc = await persistentStore.readDerivedProfileAsync(profileId);
      if (!doc) {
        res.status(404).json({ ok: false, message: 'Belirtilen profile ait işlenmiş veri bulunamadı.' });
        return;
      }
      res.json(doc);
    } catch (err: any) {
      if (err instanceof CorruptJsonFileError) {
        res.status(500).json({ ok: false, code: err.code, status_message: err.message });
        return;
      }
      res.status(500).json({ ok: false, status_message: 'İşlenmiş profil verisi okunamadı.' });
    }
  });

  app.post('/api/profiles/derived/upsert', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { profileId, algorithmVersion, profileFingerprint, sourceCatalogHash, schemaVersion, items } =
        req.body || {};
      const canonicalProfileId = normalizeProfileId(profileId);
      if (!canonicalProfileId) {
        res.status(400).json({ ok: false, message: 'Geçerli profileId zorunludur.' });
        return;
      }
      const result = await persistentStore.upsertDerivedProfileSerialized({
        profileId: canonicalProfileId,
        algorithmVersion: algorithmVersion || '3.0.0',
        profileFingerprint: profileFingerprint || 'default',
        ...(sourceCatalogHash !== undefined ? { sourceCatalogHash: String(sourceCatalogHash) } : {}),
        ...(typeof schemaVersion === 'number' ? { schemaVersion } : {}),
        items: items || {},
      });
      res.json({ ok: true, ...result });
    } catch (err: any) {
      if (err instanceof CorruptJsonFileError) {
        res.status(500).json({ ok: false, code: err.code, status_message: err.message });
        return;
      }
      res.status(500).json({ ok: false, status_message: 'İşlenmiş profil verisi kaydedilemedi.' });
    }
  });

  // --- Hibrit Yedek Birleştirme: CSV + GitHub ile senkron mevcut veri ---
  app.post('/api/backup/hybrid-merge', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const csvText = typeof req.body?.csvText === 'string' ? req.body.csvText : '';
      if (!csvText) {
        res.status(400).json({
          ok: false,
          status_message: 'Birleştirilecek CSV içeriği (csvText) gerekli.',
          code: 'missing_csv_text',
        });
        return;
      }
      if (csvText.length > 4_000_000) {
        res.status(413).json({
          ok: false,
          status_message: 'CSV içeriği 4 MB sınırını aşıyor.',
          code: 'csv_too_large',
        });
        return;
      }

      const dryRun = Boolean(req.body?.dryRun);
      const { document: current } = await primaryRepository.readRaw();
      const { document: mergedDocument, cinemaKunye, report } = runHybridMerge(csvText, current);

      if (dryRun) {
        res.json({ ok: true, dryRun: true, report });
        return;
      }

      const result = await primaryRepository.saveRaw(mergedDocument, {
        expectedRevision: current.revision ?? 0,
        requirePrecondition: true,
        forceOverwrite: false,
      });

      if (!result.ok) {
        if (result.currentRevision !== undefined) {
          res.setHeader('ETag', `"rev-${result.currentRevision}"`);
        }
        res.status(result.status).json({
          ok: false,
          status_message: result.message,
          code: result.code,
          currentRevision: result.currentRevision,
        });
        return;
      }

      await synchronizeProfileContext(profileContext, result.document);

      let savedKunye = cinemaKunye;
      if (Object.keys(cinemaKunye.entries).length > 0) {
        const kunyeSaveRes = await persistentStore.saveCinemaKunyeSerialized(cinemaKunye, {
          mode: 'merge',
        });
        savedKunye = kunyeSaveRes.document;
      }

      const rev = result.document.revision ?? 1;
      res.setHeader('ETag', `"rev-${rev}"`);
      res.json({
        ok: true,
        dryRun: false,
        report,
        revision: rev,
        updatedAt: result.document.updatedAt,
        items: result.totalItems,
        document: result.document,
        cinemaKunye: savedKunye,
      });
      notifyLocalMutation('hybrid-merge');
    } catch (error: any) {
      console.error('Hibrit birleştirme hatası:', error?.message || error);
      res.status(500).json({
        ok: false,
        status_message: redactSecrets(
          error?.message || 'Hibrit birleştirme tamamlanamadı.',
          [options.githubToken, options.tmdbApiKey]
        ),
      });
    }
  });

  // --- Posterli, Sekmeli Excel (.xlsx) & JSON Profil Yedeği Dışa Aktarma ---
  app.post('/api/backup/profile-export', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      // MIA Faz 1 — Adım 1.4: Yedek dışa aktarma okumaları PrimaryDataRepository üzerinden.
      const storedDoc = (await primaryRepository.readRaw()).document;
      const exportDoc = resolveExportDocument(storedDoc, req.body);

      const profileId =
        normalizeProfileId(req.body?.profileId) ?? normalizeProfileId(exportDoc.activeProfileId) ?? '';
      const includeJson = typeof req.body?.includeJson === 'boolean' ? req.body.includeJson : true;
      const includeXlsx = typeof req.body?.includeXlsx === 'boolean' ? req.body.includeXlsx : true;
      const uploadToGithub = Boolean(req.body?.uploadToGithub);
      const allowPersonalDataInPublicRepo =
        typeof req.body?.allowPersonalDataInPublicRepo === 'boolean'
          ? req.body.allowPersonalDataInPublicRepo
          : undefined;
      const dislikedItemsHint = Array.isArray(req.body?.dislikedItemsHint)
        ? req.body.dislikedItemsHint
        : undefined;
      const genresMap =
        req.body?.genresMap && typeof req.body.genresMap === 'object'
          ? req.body.genresMap
          : undefined;

      const includeTasteDnaSheet = Boolean(
        req.body?.includeTasteDnaSheet || req.body?.exportMode === 'xlsx_only'
      );

      const report = await executeProfileBackupExport({
        dataDir: resolvedDataDir,
        document: exportDoc,
        profileId,
        includeJson,
        includeXlsx,
        includeTasteDnaSheet,
        uploadToGithub,
        allowPersonalDataInPublicRepo,
        dislikedItemsHint,
        genresMap,
        persistentStore,
        tmdbApiKey: options.tmdbApiKey,
        githubTokenForRedaction: options.githubToken,
      });

      res.json(report);
    } catch (err: any) {
      res.status(500).json({
        ok: false,
        status_message: redactSecrets(
          err?.message || 'Profil yedeği dışa aktarılamadı.',
          [options.githubToken, options.tmdbApiKey]
        ),
      });
    }
  });

  app.post('/api/backup/profile-export/stream', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      // MIA Faz 1 — Adım 1.4: Yedek dışa aktarma okumaları PrimaryDataRepository üzerinden.
      const storedDoc = (await primaryRepository.readRaw()).document;
      const exportDoc = resolveExportDocument(storedDoc, req.body);
      const profileId =
        normalizeProfileId(req.body?.profileId) ?? normalizeProfileId(exportDoc.activeProfileId) ?? '';
      const dislikedItemsHint = Array.isArray(req.body?.dislikedItemsHint)
        ? req.body.dislikedItemsHint
        : undefined;
      const genresMap =
        req.body?.genresMap && typeof req.body.genresMap === 'object'
          ? req.body.genresMap
          : undefined;

      const includeTasteDnaSheet = Boolean(
        req.body?.includeTasteDnaSheet || req.body?.exportMode === 'xlsx_only'
      );

      const report = await executeProfileBackupExport({
        dataDir: resolvedDataDir,
        document: exportDoc,
        profileId,
        includeJson: false,
        includeXlsx: true,
        includeTasteDnaSheet,
        uploadToGithub: false,
        dislikedItemsHint,
        genresMap,
        persistentStore,
        tmdbApiKey: options.tmdbApiKey,
        githubTokenForRedaction: options.githubToken,
      });

      if (
        !report.excelBackup.ok ||
        !report.excelBackup.absolutePath ||
        !existsSync(report.excelBackup.absolutePath)
      ) {
        res.status(500).json({
          ok: false,
          status_message:
            report.excelBackup.error || 'Excel (.xlsx) ikili akışı oluşturulamadı.',
        });
        return;
      }

      const absPath = report.excelBackup.absolutePath;
      const stat = await fsPromises.stat(absPath);
      const fileName = report.excelBackup.fileName || brandProfileFileName('xlsx');
      const sha256 = report.excelBackup.sha256 || (await computeFileSha256Async(absPath));

      await streamFileDownload(res, absPath, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(stat.size),
        'X-CineTrack-SHA256': sha256,
        'X-CineTrack-Filename': fileName,
        'X-Content-Type-Options': 'nosniff',
      });
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          status_message: redactSecrets(
            err?.message || 'Excel (.xlsx) ikili akışı dışa aktarılamadı.',
            [options.githubToken, options.tmdbApiKey]
          ),
        });
      }
    }
  });

  app.post('/api/backup/excel/preview', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      // MIA Faz 1 — Adım 1.4: Yedek dışa aktarma okumaları PrimaryDataRepository üzerinden.
      const storedDoc = (await primaryRepository.readRaw()).document;
      const exportDoc = resolveExportDocument(storedDoc, req.body);
      const profileId =
        normalizeProfileId(req.body?.profileId) ?? normalizeProfileId(exportDoc.activeProfileId) ?? '';
      const profile = exportDoc.profiles.find((p) => normalizeProfileId(p.id) === profileId) || exportDoc.profiles[0];
      if (!profile) {
        res.status(404).json({ ok: false, status_message: 'Profil bulunamadı.' });
        return;
      }
      const dislikedItemsHint = Array.isArray(req.body?.dislikedItemsHint)
        ? req.body.dislikedItemsHint
        : undefined;
      const genresMap =
        req.body?.genresMap && typeof req.body.genresMap === 'object'
          ? req.body.genresMap
          : undefined;

      const moviesCatalog = (await persistentStore.readCatalogAsync('movie')) || {};
      const tvCatalog = (await persistentStore.readCatalogAsync('tv')) || {};

      const dataset = await buildProfileBackupDataset({
        profile,
        schemaVersion: exportDoc.schemaVersion,
        engineVersion: exportDoc.engineVersion,
        moviesCatalog,
        tvCatalog,
        genresMap,
        dislikedItemsHint,
      });

      res.json({
        ok: true,
        profileId: dataset.profileId,
        profileName: dataset.profileName,
        completeness: {
          rawProfileItemsCount: dataset.rawProfileItemsCount,
          normalizedSavedItemsCount: dataset.normalizedSavedItemsCount,
          rawDislikedCount: dataset.rawDislikedCount,
          uniqueDislikedCount: dataset.uniqueDislikedCount,
          favoriteActorsCount: dataset.favoriteActorsCount,
          customItemsCount: dataset.customItemsCount,
          totalItemsCount: dataset.totalItemsCount,
        },
        sheetCounts: dataset.sheetCounts,
        dataset,
      });
    } catch (err: any) {
      res.status(500).json({
        ok: false,
        status_message: redactSecrets(
          err?.message || 'Önizleme verisi oluşturulamadı.',
          [options.githubToken, options.tmdbApiKey]
        ),
      });
    }
  });

  app.get('/api/backup/exports/:fileName', personalReadGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const rawName = String(req.params.fileName || '').trim();
    if (!EXPORT_FILE_NAME_PATTERN.test(rawName)) {
      res.status(400).json({ ok: false, status_message: 'Geçersiz yedek dosya adı.' });
      return;
    }
    const exportsDir = path.resolve(resolvedDataDir, 'exports');
    const fullPath = path.resolve(exportsDir, rawName);
    if (!fullPath.startsWith(exportsDir + path.sep) || !existsSync(fullPath)) {
      res.status(404).json({ ok: false, status_message: 'Yedek dosyası bulunamadı.' });
      return;
    }

    const stat = await fsPromises.stat(fullPath);
    const sha256 = await computeFileSha256Async(fullPath);
    const contentType = rawName.endsWith('.xlsx')
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'application/json; charset=utf-8';

    await streamFileDownload(res, fullPath, {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${rawName}"`,
      'Content-Length': String(stat.size),
      'X-CineTrack-SHA256': sha256,
      'X-CineTrack-Filename': rawName,
      'X-Content-Type-Options': 'nosniff',
    });
  });

  // Faz 6: Taste Engine HTTP uçları
  app.use(
    '/api/taste',
    personalReadGuard,
    createTasteRouter(resolvedDataDir, {
      profileContext,
      tmdbApiKey: options.tmdbApiKey,
      eventBus,
      tasteAdapter,
      deferAdapterSubscription: true,
      onDomainEvent: async (event, rawMetadata) => {
        if (rawMetadata) {
          contentIntelligence.eventSubscriber.registerMetadataHint(event.eventId, rawMetadata);
        }
        await eventBus.publish(event);
      },
      onRawTasteEvent: async (tasteEvent, rawMetadata) => {
        if (tasteEvent.contentId) {
          contentIntelligence.enqueueHiddenOrDislikedItem(tasteEvent.contentId, rawMetadata);
        }
      },
    })
  );

  // MIA Faz 2: Content Intelligence & Ortak İçerik Veritabanı HTTP uçları
  app.use(
    '/api/content-intelligence',
    personalReadGuard,
    createContentIntelligenceRouter(contentIntelligence)
  );

  if (typeof options.registerCustomRoutes === 'function') {
    options.registerCustomRoutes(app);
  }

  // Unmatched /api/* routes must always return JSON 404 and never fall through to SPA index.html
  app.use('/api', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).json({
      ok: false,
      code: 'api_not_found',
      status_message: 'API uç noktası bulunamadı.',
    });
  });

  // Global error handler (EXT-06): catches uncaught sync/async route errors, redacts secrets, hides stack traces
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const requestId = crypto.randomUUID();
    const rawMsg = err instanceof Error ? err.message : String(err ?? 'Unknown error');
    const safeMsg = redactSecrets(rawMsg, [
      options.githubToken,
      options.tmdbApiKey,
      options.authToken,
    ]);
    console.error(`[API Error ${requestId}]`, safeMsg);
    if (res.headersSent) {
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({
      ok: false,
      error: 'Beklenmeyen bir sunucu hatası oluştu.',
      code: 'internal_error',
      requestId,
      status_message: 'Beklenmeyen bir sunucu hatası oluştu.',
    });
  });

  return {
    app,
    storage,
    primaryRepository,
    eventBus,
    profileContext,
    moduleRegistry,
    contentIntelligence,
    libraryService,
    contentService,
    backgroundManager,
    startRuntimeModules,
    stopRuntimeModules,
    tmdbProxy,
    tvdbProxy,
    persistentStore,
  };
}
