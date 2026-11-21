import { useToasts } from './app/useToasts.ts';
import {
  ACTIVE_PROFILE_STORAGE,
  DIRTY_KEY,
  HIDE_LISTED_STORAGE_KEY,
  PROFILES_STORAGE,
  PROFILE_STORAGE,
  deletedKeysStorageKey,
  favActorsStorageKey,
  hasPersistedProfilesInStorage,
  listStorageKey,
  loadActiveProfileId,
  loadDeletedKeys,
  loadDislikedCache,
  loadFavoriteActors,
  loadInitialProfiles,
  loadProfileItems,
  loadProfilePreferences,
  preferencesStorageKey,
} from './app/profile-storage.ts';
import { normalizeProfileId } from './core/profile-id.ts';
import { mergeRemoteDocument } from './app/server-sync.ts';
import React, { useState, useEffect, useRef, useCallback, Suspense, lazy } from 'react';
import { Header } from './components/Header.tsx';
import { Hero } from './components/Hero.tsx';
import { Stats } from './components/Stats.tsx';
import { Controls } from './components/Controls.tsx';
import { MediaGrid } from './components/MediaGrid.tsx';
import { DetailModal } from './components/DetailModal.tsx';
import { QuickSaveModal } from './components/QuickSaveModal.tsx';
import { PersonDrawer } from './components/PersonDrawer.tsx';
import { AddCustomModal } from './components/AddCustomModal.tsx';
import { ProfileModal } from './components/ProfileModal.tsx';
import { ImportChoiceModal } from './components/ImportChoiceModal.tsx';
import { TvdbStockModal } from './components/TvdbStockModal.tsx';
import { Toast } from './components/Toast.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { OfflineIndicator } from './components/OfflineIndicator.tsx';
import { ConflictBanner } from './components/ConflictBanner.tsx';

function lazyWithRetry<T extends React.ComponentType<any>>(
  importer: () => Promise<{ default: T }>
): React.LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      return await importer();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return importer();
    }
  });
}

const TasteMapView = lazyWithRetry(() => import('./components/TasteMapView.tsx'));
const RelationshipExplorer = lazyWithRetry(() => import('./components/RelationshipExplorer.tsx'));
const TasteProfileDashboard = lazyWithRetry(() => import('./components/taste/TasteProfileDashboard.tsx'));

import {
  SavedItem,
  PoolCandidateItem,
  Profile,
  Preferences,
  DataDocument,
  normalizeSavedItem,
  normalizeDataDocument,
  resolveAirDate,
  reminderDaysUntil,
  buildTasteProfileV3,
  findSavedItem,
  makeMediaKey,
  isItemSaved,
  filterHistoryByType,
  TARGET_RECOMMENDATION_COUNT,
  FavoriteActorInfo,
  normalizeFavoriteActors,
  replenishCandidatePool,
  loadPersistentTasteMap,
  PersistentTasteMapData,
  TasteProfileSummary,
  buildTasteProfileSummary,
  matchesSelectedGenre,
  HIDE_LISTED_CATEGORIES,
  filterHiddenUserRegisteredItems,
  normalizeDeletedKeys,
  hydrateDiscoveryHistoryIdb,
  hydrateCandidatePoolsIdb,
} from './core/cinetrack-core.ts';
import {
  fetchTmdb,
  fetchTmdbCached,
  fetchServerData,
  getLastKnownServerRevision,
  subscribeTmdbSource,
  checkServerTmdbStatus,
  TmdbSourceMeta,
  ServerConflictDetail,
} from './services/api.ts';
import {
  areUserDataDocumentsSemanticallyEqual,
  mergeSavedItemListsLossless,
} from './core/user-data-merge.ts';
import { enrichSavedItemsFromCinemaKunye } from './core/cinema-kunye.ts';
import {
  type ServerTasteSignal,
} from './modules/recommendations/index.ts';
import {
  clearServerTasteSignalCache,
  loadServerTasteSignal,
} from './services/taste-signal-service.ts';
import { HomeSection } from './modules/home/HomeSection.tsx';
import { SeriesSection } from './modules/series/SeriesSection.tsx';
import { OperationsSection } from './modules/operations/OperationsSection.tsx';
import type { ModuleId } from './app/module-registry.ts';
import { useHashNavigation } from './app/useHashNavigation.ts';
import { MobileBottomNav } from './presentation/layouts/MobileLayout.tsx';
import { useDiscoverState } from './modules/discover/state.ts';
import { useOfflineSync } from './hooks/useOfflineSync.ts';
import { useServerSyncCoordinator } from './hooks/useServerSyncCoordinator.ts';
import { useProfileBackupCoordinator } from './hooks/useProfileBackupCoordinator.ts';
import { useStockEngine } from './hooks/useStockEngine.ts';
import { useCinemaKunye } from './hooks/useCinemaKunye.ts';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.ts';
import { createCatalogLoader } from './app/catalog-loader.ts';
import { buildUserDataDocument } from './app/user-data-payload.ts';
import { useLibraryController } from './hooks/useLibraryController.ts';
import { hasPendingOfflineSync } from './services/offline-queue.ts';
import {
  saveIsolatedProfileIdb,
  loadUserListsIdb,
  saveUserListsIdb,
  subscribeSeriesIndex,
  loadUiPrefsIdb,
  saveUiPrefsIdb,
  recordSkippedKeysIdb,
  loadStockIdb,
} from './services/storage-idb.ts';
import {
  registerLocalSavedSeriesHints,
  computeUserSeriesUniverses,
} from './services/series-service.ts';
import {
  getStockMovies,
  getStockSeries,
  isCandidateEligibleForStock,
  manualPullStock,
  markItemsAsSurfaced,
  seedCandidatePoolFromStock,
  subscribeStockState,
  syncStockWithUserExclusions,
} from './services/stock-engine.ts';
import {
  enforcePosterCacheQuota,
  requestServiceWorkerPosterPurge,
} from './services/poster-cache-manager.ts';
import { getItemEncodingSync, maintainEncodingsDepot } from './services/encoding-service.ts';
import { runIdbSchemaMigrationsOnce } from './services/idb-schema-version.ts';
import { computeProfileCentroid, cosineSimilarity } from './core/encoding.ts';
import {
  checkWeeklyAutoBackup,
  recordProfileChangeAndMaybeBackup,
} from './services/auto-backup-service.ts';
import { startIdleStockEnrichment } from './services/idle-enrichment-service.ts';
import { displayTitle } from './utils/helpers.ts';
const EMPTY_REASONS_MAP = new Map<string, string>();

export function App() {
  // Profiles and Watchlist State
  const [profiles, setProfiles] = useState<Profile[]>(loadInitialProfiles);
  const [activeProfileId, setActiveProfileId] = useState<string>(() => loadActiveProfileId(profiles));
  const activeProfile = profiles.find((p) => p.id === activeProfileId) || profiles[0];
  const [profileName, setProfileName] = useState<string>(activeProfile.name);
  // loadInitialProfiles legacy anahtarları ham ID üzerinden okur. İlk render'da
  // aynı veriyi kanonik ID anahtarıyla tekrar okumak eski listeleri boşaltır;
  // bu yüzden başlangıç state'i normalize edilmiş profil snapshot'ından alınır.
  const [preferences, setPreferences] = useState<Preferences>(() => activeProfile.preferences);
  const [savedItems, setSavedItems] = useState<SavedItem[]>(() => activeProfile.items);
  const [favoriteActors, setFavoriteActors] = useState<FavoriteActorInfo[]>(
    () => activeProfile.favoriteActors || []
  );
  const [deletedKeys, setDeletedKeys] = useState<Record<string, string>>(
    () => activeProfile.deleted_keys || {}
  );
  const [dislikedItems, setDislikedItems] = useState<any[]>(() => loadDislikedCache());
  const [syncStatus, setSyncStatus] = useState<string>('Kayıt yeri: data/cinetrack-data.json');

  // Discover & Grid State
  const [tab, setTab] = useState<ModuleId>('home');
  // Derin bağlantı: #/discover, #/series … adresleri sekmeyle çift yönlü eşitlenir.
  useHashNavigation(tab, setTab);
  // Sunucu zevk profili (Faz 1/2 metrik motoru) → tek öneri hattının tür/ruh
  // hâli sinyali. Profil veya ruh hâli değişince tazelenir; hata sıralamayı bozmaz.
  useEffect(() => {
    let cancelled = false;
    void loadServerTasteSignal({ profileId: activeProfileId, mood: preferences.mood }).then(
      (signal) => {
        if (!cancelled) setServerTasteSignal(signal);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, preferences.mood]);
  const [tasteMapDisplayMode, setTasteMapDisplayMode] = useState<'poster' | 'graph' | 'identity'>('identity');
  const [tasteMap, setTasteMap] = useState<PersistentTasteMapData>(() => loadPersistentTasteMap(activeProfileId));
  const [serverTasteSignal, setServerTasteSignal] = useState<ServerTasteSignal | null>(null);
  const discoverState = useDiscoverState({
    initialHideListedItems: () => {
      try {
        return localStorage.getItem(HIDE_LISTED_STORAGE_KEY) === '1';
      } catch {
        return false;
      }
    },
  });
  const {
    category, setCategory,
    forYouSubTab, setForYouSubTab,
    selectedGenre, setSelectedGenre,
    selectedType, setSelectedType,
    selectedSort, setSelectedSort,
    selectedProvider, setSelectedProvider,
    hideListedItems, setHideListedItems,
    genresMap, setGenresMap,
    catalogItems, setCatalogItems,
    trendingTop, setTrendingTop,
    catalogPage, setCatalogPage,
    catalogTotalPages, setCatalogTotalPages,
    isLoading, setIsLoading,
    loadingMore, setLoadingMore,
    forYouItems, setForYouItems,
    forYouReasons, setForYouReasons,
    forYouExplanation, setForYouExplanation,
    forYouProgressStep, setForYouProgressStep,
    requestGateRef,
  } = discoverState;
  const [seriesIndexVersion, setSeriesIndexVersion] = useState<number>(0);
  const [listStatus, setListStatus] = useState<string>('all');
  const [query, setQuery] = useState<string>('');
  const [serverConflict, setServerConflict] = useState<ServerConflictDetail | null>(null);
  const [serverSyncReady, setServerSyncReady] = useState(false);
  const [tmdbSourceMeta, setTmdbSourceMeta] = useState<TmdbSourceMeta>({
    source: 'unknown',
    cacheStatus: 'none',
    timestamp: Date.now(),
  });

  const [detailItem, setDetailItem] = useState<any | null>(null);
  const [quickSaveItem, setQuickSaveItem] = useState<any | null>(null);
  const [personId, setPersonId] = useState<number | null>(null);
  const [personName, setPersonName] = useState<string>('');
  const [relationshipInitialSourceKey, setRelationshipInitialSourceKey] = useState<string>('');
  const [addCustomOpen, setAddCustomOpen] = useState<boolean>(false);
  const [profileOpen, setProfileOpen] = useState<boolean>(false);
  const [tvdbModalOpen, setTvdbModalOpen] = useState<boolean>(false);
  const [pendingBackup, setPendingBackup] = useState<any | null>(null);
  const { toasts, showToast, dismissToast } = useToasts();

  const lastForYouQueryKeyRef = useRef<string>('');
  const confirmNextBulkSyncRef = useRef<boolean>(false);
  const selectedTypeRef = useRef<string>(selectedType);
  selectedTypeRef.current = selectedType;
  const selectedGenreRef = useRef<string>(selectedGenre);
  selectedGenreRef.current = selectedGenre;
  const selectedSortRef = useRef<string>(selectedSort);
  selectedSortRef.current = selectedSort;
  const hideListedItemsRef = useRef<boolean>(hideListedItems);
  hideListedItemsRef.current = hideListedItems;
  const profilesRef = useRef<Profile[]>(profiles);
  profilesRef.current = profiles;
  const activeProfileIdRef = useRef<string>(activeProfileId);
  activeProfileIdRef.current = activeProfileId;
  const profileNameRef = useRef<string>(profileName);
  profileNameRef.current = profileName;
  const tasteMapRef = useRef<PersistentTasteMapData>(tasteMap);
  tasteMapRef.current = tasteMap;
  const serverTasteRef = useRef<ServerTasteSignal | null>(null);
  serverTasteRef.current = serverTasteSignal;
  const forYouItemsRef = useRef<any[]>(forYouItems);
  forYouItemsRef.current = forYouItems;
  const hasHydratedLocalEffectRef = useRef(false);
  const applyingRemoteSnapshotRef = useRef(false);
  const localEditedDuringStartupRef = useRef(false);
  const hadStoredProfilesOnBootRef = useRef<boolean | null>(null);
  if (hadStoredProfilesOnBootRef.current === null) {
    hadStoredProfilesOnBootRef.current = hasPersistedProfilesInStorage();
  }
  const localWasDirtyRef = useRef<boolean | null>(null);
  if (localWasDirtyRef.current === null) {
    try {
      localWasDirtyRef.current = localStorage.getItem(DIRTY_KEY) === '1';
    } catch {
      localWasDirtyRef.current = false;
    }
  }
  const isDirtyRef = useRef<boolean>(Boolean(localWasDirtyRef.current));
  const isPushingRef = useRef<boolean>(false);
  const inFlightPushRef = useRef<Promise<void> | null>(null);
  const savedItemsRef = useRef(savedItems);
  savedItemsRef.current = savedItems;
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const genresMapRef = useRef(genresMap);
  genresMapRef.current = genresMap;
  const dislikedItemsRef = useRef(dislikedItems);
  dislikedItemsRef.current = dislikedItems;
  const favoriteActorsRef = useRef<FavoriteActorInfo[]>(favoriteActors);
  favoriteActorsRef.current = favoriteActors;
  const deletedKeysRef = useRef<Record<string, string>>(deletedKeys);
  deletedKeysRef.current = deletedKeys;

  const uiPrefsHydratedProfileRef = useRef<string>('');
  const [stockStats, setStockStats] = useState({ movieCount: 0, tvCount: 0 });
  const [tvdbCount, setTvdbCount] = useState<number>(0);

  const refreshStockStats = useCallback(() => {
    void loadStockIdb().then((stock) => {
      const allM = stock.movies || [];
      const allT = stock.tv || [];
      const cleanMovies = allM.filter((m) =>
        isCandidateEligibleForStock(
          { ...m, media_type: 'movie' },
          savedItemsRef.current,
          preferencesRef.current
        )
      );
      const cleanTv = allT.filter((t) =>
        isCandidateEligibleForStock(
          { ...t, media_type: 'tv' },
          savedItemsRef.current,
          preferencesRef.current
        )
      );
      const tvdbM = allM.filter((m) => m.source === 'tvdb').length;
      const tvdbT = allT.filter((t) => t.source === 'tvdb').length;
      setTvdbCount(tvdbM + tvdbT);
      setStockStats({
        movieCount: cleanMovies.length,
        tvCount: cleanTv.length,
      });
    });
  }, []);

  useEffect(() => {
    refreshStockStats();
    const unsubscribeStock = subscribeStockState(() => {
      const cleanMovies = getStockMovies(savedItemsRef.current, preferencesRef.current);
      const cleanTv = getStockSeries(savedItemsRef.current, preferencesRef.current);
      const tvdbM = cleanMovies.filter((m) => m.source === 'tvdb').length;
      const tvdbT = cleanTv.filter((t) => t.source === 'tvdb').length;
      setTvdbCount(tvdbM + tvdbT);
      setStockStats({
        movieCount: cleanMovies.length,
        tvCount: cleanTv.length,
      });
    });
    return () => {
      unsubscribeStock();
    };
  }, [refreshStockStats]);

  // Sorun 1: Kullanıcı listeleri, disliked veya hidden güncellendiğinde ct:stock deposunu arındır ve gerçek .length değerlerini yansıt
  useEffect(() => {
    void syncStockWithUserExclusions(activeProfileId, savedItems, preferences).then((res) => {
      setStockStats({
        movieCount: res.moviesCount,
        tvCount: res.tvCount,
      });
    });
    if (serverSyncReady || savedItems.length > 0) {
      void saveUserListsIdb(activeProfileId, savedItems);
    }
  }, [activeProfileId, savedItems, preferences, serverSyncReady]);

  // Stok görünümünde listeye eklenen içerik sayaç düşmesine rağmen ekranda kalıyordu; gridi anında arındır
  useEffect(() => {
    if (tab !== 'discover' || category !== 'stock') return;
    setCatalogItems((prev) => {
      const filtered = prev.filter((it) =>
        isCandidateEligibleForStock(it, savedItems, preferences)
      );
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [savedItems, preferences, tab, category, setCatalogItems]);

  // IMP-17 (IDB Schema Migration) + IMP-16 (Weekly Auto-Backup Check) + IMP-11 (Idle Stock Enrichment)
  useEffect(() => {
    void runIdbSchemaMigrationsOnce();
    void checkWeeklyAutoBackup();
    const stopIdleEnrichment = startIdleStockEnrichment();
    return () => {
      stopIdleEnrichment();
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(HIDE_LISTED_STORAGE_KEY, hideListedItems ? '1' : '0');
    } catch {}
  }, [hideListedItems]);

  // Hydrate & persist UI filter/sort preferences in Depo 10 (`ct:ui-prefs`)
  useEffect(() => {
    let active = true;
    uiPrefsHydratedProfileRef.current = '';
    void loadUiPrefsIdb(activeProfileId).then((stored) => {
      if (!active) return;
      if (stored) {
        if (stored.selectedType) {
          setSelectedType(stored.selectedType);
          selectedTypeRef.current = stored.selectedType;
        }
        if (stored.selectedSort) {
          setSelectedSort(stored.selectedSort);
        }
        if (typeof stored.selectedGenre === 'string') {
          setSelectedGenre(stored.selectedGenre);
          selectedGenreRef.current = stored.selectedGenre;
        }
        if (typeof stored.hideListedItems === 'boolean') {
          setHideListedItems(stored.hideListedItems);
          hideListedItemsRef.current = stored.hideListedItems;
        }
        if (stored.forYouSubTab === 'recommendations' || stored.forYouSubTab === 'series') {
          setForYouSubTab(stored.forYouSubTab);
        }
      }
      uiPrefsHydratedProfileRef.current = activeProfileId;
    });
    return () => {
      active = false;
    };
  }, [activeProfileId, setForYouSubTab, setHideListedItems, setSelectedGenre, setSelectedSort, setSelectedType]);

  useEffect(() => {
    if (uiPrefsHydratedProfileRef.current !== activeProfileId) return;
    void saveUiPrefsIdb({
      profileId: activeProfileId,
      selectedType: selectedType === 'movie' || selectedType === 'tv' ? selectedType : 'all',
      selectedSort,
      selectedGenre,
      hideListedItems,
      forYouSubTab,
      updatedAt: new Date().toISOString(),
    });
  }, [activeProfileId, selectedType, selectedSort, selectedGenre, hideListedItems, forYouSubTab]);

  // Global Keyboard Shortcuts (IMP-08 & Section 6.5)
  useKeyboardShortcuts({
    onFocusSearch: () => {
      const searchInput = document.querySelector<HTMLInputElement>('.search-input');
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
    },
    onSelectTab: (targetTab) => {
      setTab(targetTab);
    },
    onQuickSaveOrSync: () => {
      void pushToServer();
      showToast('Değişiklikler kaydedildi ve yerel sunucuyla eşitlendi.');
    },
    onOpenAddCustom: () => {
      setAddCustomOpen(true);
    },
    onOpenSettings: () => {
      setProfileOpen(true);
    },
    onEscape: () => {
      setDetailItem(null);
      setQuickSaveItem(null);
      setPersonId(null);
      setAddCustomOpen(false);
      setProfileOpen(false);
      setPendingBackup(null);
    },
  });

  // Sync to localStorage (quota-safe for >2 MB libraries: metadata-only in PROFILES_STORAGE + isolated watchlist write)
  useEffect(() => {
    try {
      const lightweightProfiles = profiles.map((p) => ({
        id: p.id,
        name: p.id === activeProfileId ? profileName : p.name,
        createdAt: p.createdAt || '',
        isDemo: Boolean(p.isDemo),
        favoriteActors: p.id === activeProfileId ? favoriteActors : p.favoriteActors || [],
        items: [],
      }));
      localStorage.setItem(PROFILES_STORAGE, JSON.stringify(lightweightProfiles));
      localStorage.setItem(ACTIVE_PROFILE_STORAGE, activeProfileId);
      localStorage.setItem(PROFILE_STORAGE, profileName);
      localStorage.setItem(preferencesStorageKey(activeProfileId), JSON.stringify(preferences));
      localStorage.setItem(favActorsStorageKey(activeProfileId), JSON.stringify(favoriteActors));
      localStorage.setItem(deletedKeysStorageKey(activeProfileId), JSON.stringify(deletedKeys));
    } catch (err) {
      console.warn('LocalStorage metadata save warning:', err);
    }

    try {
      localStorage.setItem(listStorageKey(activeProfileId), JSON.stringify(savedItems));
    } catch {
      try {
        const compactSaved = savedItems.map((it) => ({
          ...it,
          overview: typeof it.overview === 'string' ? it.overview.slice(0, 120) : '',
        }));
        localStorage.setItem(listStorageKey(activeProfileId), JSON.stringify(compactSaved));
      } catch {
        // >5 MB yedeklerde tarayıcı localStorage kotası aşılabilir; tam veri React state'te ve data/cinetrack-data.json üzerinde korunur.
      }
    }

    if (!hasHydratedLocalEffectRef.current) {
      hasHydratedLocalEffectRef.current = true;
      return;
    }
    if (applyingRemoteSnapshotRef.current) {
      applyingRemoteSnapshotRef.current = false;
      return;
    }
    isDirtyRef.current = true;
    if (serverSyncReady) {
      try {
        localStorage.setItem(DIRTY_KEY, '1');
      } catch {}
    } else {
      localEditedDuringStartupRef.current = true;
    }
  }, [
    profiles,
    activeProfileId,
    profileName,
    savedItems,
    preferences,
    favoriteActors,
    deletedKeys,
    serverSyncReady,
  ]);

  const persistProfilesBestEffort = useCallback((profilesList: Profile[]) => {
    for (const p of profilesList) {
      if (!p || !p.id) continue;
      try {
        localStorage.setItem(preferencesStorageKey(p.id), JSON.stringify(p.preferences || {}));
        localStorage.setItem(favActorsStorageKey(p.id), JSON.stringify(p.favoriteActors || []));
        localStorage.setItem(
          deletedKeysStorageKey(p.id),
          JSON.stringify(normalizeDeletedKeys(p.deleted_keys))
        );
      } catch {}
      try {
        localStorage.setItem(listStorageKey(p.id), JSON.stringify(p.items || []));
      } catch {
        try {
          const compactSaved = (p.items || []).map((it) => ({
            ...it,
            overview: typeof it.overview === 'string' ? it.overview.slice(0, 120) : '',
          }));
          localStorage.setItem(listStorageKey(p.id), JSON.stringify(compactSaved));
        } catch {}
      }
      void saveUserListsIdb(p.id, p.items || []);
    }
  }, []);

  const buildCurrentLivePayloadFromRefs = useCallback(
    (): DataDocument =>
      buildUserDataDocument({
        profiles: profilesRef.current,
        activeProfileId: activeProfileIdRef.current,
        profileName: profileNameRef.current,
        preferences: preferencesRef.current,
        savedItems: savedItemsRef.current,
        favoriteActors: favoriteActorsRef.current || [],
        deletedKeys: deletedKeysRef.current,
      }),
    []
  );

  const buildCurrentPayload = useCallback(
    (): DataDocument =>
      buildUserDataDocument({
        profiles,
        activeProfileId,
        profileName,
        preferences,
        savedItems,
        favoriteActors: favoriteActorsRef.current || [],
        deletedKeys: deletedKeysRef.current,
        isDemo: Boolean(activeProfile?.isDemo),
      }),
    [profiles, activeProfileId, profileName, preferences, savedItems, activeProfile?.isDemo]
  );

  const handleServerConflict = useCallback((conflict: ServerConflictDetail) => {
    setServerConflict(conflict);
    setSyncStatus(`Çakışma algılandı: ${conflict.message}`);
  }, []);

  const mergeRemoteDocumentIntoState = useCallback(
    (
      rawRemoteDoc: DataDocument,
      options: {
        preferActiveFrom?: 'local' | 'remote';
        foldUnhydrated?: boolean;
        keepDirtyIfLocalAhead?: boolean;
      } = {}
    ): DataDocument | null => {
      const merged = mergeRemoteDocument(buildCurrentLivePayloadFromRefs(), rawRemoteDoc, {
        preferActiveFrom: options.preferActiveFrom,
        foldUnhydrated: options.foldUnhydrated,
        keepDirtyIfLocalAhead: options.keepDirtyIfLocalAhead,
      });
      if (!merged) return null;

      const {
        mergedDoc,
        activeProfile: active,
        favoriteActors: activeFavs,
        deletedKeys: activeDeleted,
        shouldStayDirty,
      } = merged;

      applyingRemoteSnapshotRef.current = true;
      hadStoredProfilesOnBootRef.current = true;

      profilesRef.current = mergedDoc.profiles;
      activeProfileIdRef.current = mergedDoc.activeProfileId;
      profileNameRef.current = active.name;
      preferencesRef.current = active.preferences;
      savedItemsRef.current = active.items;
      favoriteActorsRef.current = activeFavs;
      deletedKeysRef.current = activeDeleted;

      setProfiles(mergedDoc.profiles);
      setActiveProfileId(mergedDoc.activeProfileId);
      setProfileName(active.name);
      setPreferences(active.preferences);
      setSavedItems(active.items);
      setFavoriteActors(activeFavs);
      setDeletedKeys(activeDeleted);

      const loadedMap = loadPersistentTasteMap(active.id);
      tasteMapRef.current = loadedMap;
      setTasteMap(loadedMap);

      persistProfilesBestEffort(mergedDoc.profiles);

      isDirtyRef.current = shouldStayDirty;
      try {
        if (shouldStayDirty) {
          localStorage.setItem(DIRTY_KEY, '1');
        } else {
          localStorage.removeItem(DIRTY_KEY);
        }
      } catch {}

      if (!shouldStayDirty) {
        setServerConflict(null);
      }

      return mergedDoc;
    },
    [buildCurrentLivePayloadFromRefs, persistProfilesBestEffort]
  );

  const handleMergedServerDocument = useCallback(
    (serverDoc: DataDocument) => {
      mergeRemoteDocumentIntoState(serverDoc, {
        preferActiveFrom: 'local',
        keepDirtyIfLocalAhead: true,
      });
    },
    [mergeRemoteDocumentIntoState]
  );

  const {
    isOnline,
    pendingSync,
    unpersistedWarning,
    syncDocument,
    resolveQueuedConflict,
  } = useOfflineSync(handleServerConflict, handleMergedServerDocument);

  // Autonomous 500-movie + 500-TV IndexedDB stock engine & <250 background replenisher (Aşama 2 & 4)
  const stockEngineState = useStockEngine(activeProfileId);

  // Separate persistent Sinema Künyesi store (genre / year / cast keyed by contentId = title + year)
  const {
    cinemaKunye,
    mergeIncomingCinemaKunye,
    replaceCinemaKunye,
    flushCinemaKunyeToServer,
    refreshCinemaKunyeFromServer,
  } = useCinemaKunye({
    savedItems,
    genresMap,
    isDemo: Boolean(activeProfile?.isDemo),
    tmdbSource: tmdbSourceMeta.source,
  });

  // Hydrate discovery-history & candidate-pool from IndexedDB on startup/profile switch (BUG-02)
  useEffect(() => {
    let active = true;
    void Promise.all([
      hydrateDiscoveryHistoryIdb(activeProfileId),
      hydrateCandidatePoolsIdb(activeProfileId),
    ]).then(([hydratedMap]) => {
      if (!active || !hydratedMap) return;
      if ((hydratedMap.updatedAt || '') > (tasteMapRef.current?.updatedAt || '')) {
        tasteMapRef.current = hydratedMap;
        setTasteMap(hydratedMap);
      }
    });
    return () => {
      active = false;
    };
  }, [activeProfileId]);

  // Subscribe to ct:series-index changes & enforce 200 MiB poster LRU quota (EXT-03 & FEAT-01)
  useEffect(() => {
    const unsubSeries = subscribeSeriesIndex(() => {
      setSeriesIndexVersion((v) => v + 1);
    });
    void enforcePosterCacheQuota();
    void maintainEncodingsDepot();
    requestServiceWorkerPosterPurge();
    const quotaInterval = setInterval(() => {
      void enforcePosterCacheQuota();
      void maintainEncodingsDepot();
      requestServiceWorkerPosterPurge();
    }, 5 * 60 * 1000);
    return () => {
      unsubSeries();
      clearInterval(quotaInterval);
    };
  }, []);

  // Register local series hints with 0 network calls on startup/save; network backfill runs lazily ONLY when "Seriler" opens (FEAT-01 #6)
  useEffect(() => {
    if (savedItems.length > 0) {
      void registerLocalSavedSeriesHints(savedItems);
    }
  }, [savedItems]);

  const applyDataDocumentToState = useCallback(
    (rawDoc: DataDocument) => {
      const doc = normalizeDataDocument(rawDoc);
      if (!doc) return;
      applyingRemoteSnapshotRef.current = true;
      hadStoredProfilesOnBootRef.current = true;
      profilesRef.current = doc.profiles;
      setProfiles(doc.profiles);
      setActiveProfileId(doc.activeProfileId);
      activeProfileIdRef.current = doc.activeProfileId;
      const active = doc.profiles.find((p) => p.id === doc.activeProfileId) || doc.profiles[0];
      profileNameRef.current = active.name;
      setProfileName(active.name);
      preferencesRef.current = active.preferences;
      setPreferences(active.preferences);
      savedItemsRef.current = active.items;
      setSavedItems(active.items);
      const activeFavs = normalizeFavoriteActors(active.favoriteActors || []);
      favoriteActorsRef.current = activeFavs;
      setFavoriteActors(activeFavs);
      const activeDeleted = normalizeDeletedKeys(active.deleted_keys);
      deletedKeysRef.current = activeDeleted;
      setDeletedKeys(activeDeleted);
      const loadedMap = loadPersistentTasteMap(active.id);
      tasteMapRef.current = loadedMap;
      setTasteMap(loadedMap);
      persistProfilesBestEffort(doc.profiles);
      isDirtyRef.current = false;
      try {
        localStorage.removeItem(DIRTY_KEY);
      } catch {}
      resolveQueuedConflict();
      setServerConflict(null);
    },
    [persistProfilesBestEffort, resolveQueuedConflict]
  );

  const {
    pushToServer,
    handleKeepLocalOnConflict,
    handleMergeBothOnConflict,
    handleUseServerOnConflict,
  } = useServerSyncCoordinator({
    buildCurrentLivePayloadFromRefs,
    buildCurrentPayload,
    syncDocument,
    serverConflict,
    mergeRemoteDocumentIntoState,
    applyDataDocumentToState,
    resolveQueuedConflict,
    setServerConflict,
    setSyncStatus,
    showToast,
    isDirtyRef,
    isPushingRef,
    inFlightPushRef,
    confirmNextBulkSyncRef,
    hadStoredProfilesOnBootRef,
    serverSyncReady,
    favoriteActors,
    deletedKeys,
  });

  const handleMergeSyncedDocument = useCallback(
    (doc: DataDocument) => {
      mergeRemoteDocumentIntoState(doc, {
        preferActiveFrom: 'local',
        keepDirtyIfLocalAhead: true,
      });
    },
    [mergeRemoteDocumentIntoState]
  );

  // Arka plandaki GitHub otomatik senkronizasyonu (server.ts) revizyonu ilerlettiğinde
  // veya bekleyen yerel değişiklik varsa kayıpsız eşitleme yap
  const pullMergeFromServerIfAdvanced = useCallback(async () => {
    if (isPushingRef.current || !navigator.onLine) return;
    const prevRev = getLastKnownServerRevision();
    const remote = await fetchServerData();
    if (!remote) return;
    if (
      typeof remote.revision === 'number' &&
      (prevRev === null || remote.revision > prevRev)
    ) {
      mergeRemoteDocumentIntoState(remote, {
        preferActiveFrom: 'local',
        keepDirtyIfLocalAhead: true,
      });
      void refreshCinemaKunyeFromServer('merge');
    }
  }, [mergeRemoteDocumentIntoState, refreshCinemaKunyeFromServer]);

  useEffect(() => {
    if (!serverSyncReady) return;
    // Başlangıçtaki 1.5s sunucu-GitHub otomatik senkronunu yakalamak için erken kontrol
    const initialFollowUp = setTimeout(() => {
      void pullMergeFromServerIfAdvanced();
    }, 5000);

    const interval = setInterval(() => {
      let lsDirty = false;
      try {
        lsDirty = localStorage.getItem(DIRTY_KEY) === '1';
      } catch {}
      if (isDirtyRef.current || lsDirty || hasPendingOfflineSync()) {
        void pushToServer();
      } else {
        void pullMergeFromServerIfAdvanced();
      }
    }, 60 * 1000);

    const handleVisibilitySync = () => {
      if (document.visibilityState === 'visible') {
        void pullMergeFromServerIfAdvanced();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilitySync);

    return () => {
      clearTimeout(initialFollowUp);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilitySync);
    };
  }, [pushToServer, pullMergeFromServerIfAdvanced, serverSyncReady]);

  // Initial startup sync with server (always lossless-merged, even if local was dirty or edited during boot!)
  useEffect(() => {
    fetchServerData()
      .then(async (remote) => {
        if (remote) {
          const doc = normalizeDataDocument(remote);
          if (doc) {
            const remoteHasData =
              doc.profiles.some(
                (p) =>
                  p.items.length > 0 ||
                  (p.preferences?.disliked?.length || 0) > 0 ||
                  (p.preferences?.hidden?.length || 0) > 0 ||
                  (p.favoriteActors?.length || 0) > 0
              ) ||
              doc.profiles.length > 1 ||
              (doc.revision ?? 0) > 0;
            const isDirty = Boolean(
              localWasDirtyRef.current || localEditedDuringStartupRef.current || isDirtyRef.current
            );
            if (remoteHasData) {
              const merged = mergeRemoteDocumentIntoState(doc, {
                preferActiveFrom: isDirty ? 'local' : 'remote',
                foldUnhydrated: !hadStoredProfilesOnBootRef.current,
                keepDirtyIfLocalAhead: true,
              });
              if (merged && !areUserDataDocumentsSemanticallyEqual(merged, doc)) {
                resolveQueuedConflict();
              } else {
                resolveQueuedConflict();
              }
            }
          }
          return;
        }

        // Sunucuya ulaşılamadıysa ve localStorage kotadan dolayı boş kaldıysa IndexedDB yedeğinden kurtar
        if (savedItemsRef.current.length === 0) {
          const idbCompact = await loadUserListsIdb(activeProfileIdRef.current);
          if (idbCompact.length > 0 && savedItemsRef.current.length === 0) {
            const recovered = idbCompact
              .map((it) =>
                normalizeSavedItem({
                  ...it,
                  title: `${it.media_type === 'tv' ? 'Dizi' : 'Film'} #${it.id}`,
                })
              )
              .filter(Boolean) as SavedItem[];
            if (recovered.length > 0) {
              applyingRemoteSnapshotRef.current = true;
              savedItemsRef.current = recovered;
              setSavedItems(recovered);
            }
          }
        }
      })
      .catch((error) => console.error('Cinethos: başlangıç verisi eşitlenemedi.', error))
      .finally(() => setServerSyncReady(true));

    // Load genres
    Promise.all([fetchTmdb('/genre/movie/list'), fetchTmdb('/genre/tv/list')])
      .then(([movies, series]) => {
        const map: Record<number, string> = {};
        for (const g of [...(movies.genres || []), ...(series.genres || [])]) {
          map[g.id] = g.name;
        }
        setGenresMap(map);
      })
      .catch((err) => console.warn('Genres fetch error:', err));

    const unsubSource = subscribeTmdbSource(setTmdbSourceMeta);
    checkServerTmdbStatus();

    return () => {
      unsubSource();
    };
  }, [mergeRemoteDocumentIntoState, resolveQueuedConflict, setGenresMap]);

  // Release Reminders check (ref-backed with single batched state update — BUG-13.3)
  const checkReleaseReminders = useCallback(() => {
    const currentPrefs = preferencesRef.current;
    const currentItems = savedItemsRef.current;
    if (!currentPrefs.reminders || !('Notification' in window) || Notification.permission !== 'granted') {
      return;
    }
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const newlyNotified: string[] = [];

    for (const item of currentItems) {
      if (item.status === 'completed') continue;
      const airDate = resolveAirDate(item);
      if (!airDate) continue;
      const days = reminderDaysUntil(airDate, today);
      if (days === null) continue;
      const key = `${item.media_type}:${item.id}:${airDate}`;
      if (currentPrefs.notified.includes(key) || newlyNotified.includes(key)) continue;

      const next = item.next_episode_to_air;
      const episodeTag =
        item.media_type === 'tv' && next?.air_date === airDate && next.season_number
          ? ` (S${next.season_number}B${next.episode_number})`
          : '';
      const when = days === 0 ? 'bugün' : `${days} gün içinde`;

      const notification = new Notification('Cinethos yayın hatırlatıcısı', {
        body: `${displayTitle(item)} ${when} yayınlanıyor${episodeTag}.`,
      });
      notification.onclick = () => {
        window.focus();
        setDetailItem(item);
        notification.close();
      };

      newlyNotified.push(key);
    }

    if (newlyNotified.length > 0) {
      setPreferences((prev) => ({
        ...prev,
        notified: [...prev.notified, ...newlyNotified].slice(-200),
      }));
    }
  }, []);

  useEffect(() => {
    checkReleaseReminders();
    const interval = setInterval(checkReleaseReminders, 60_000);
    const handleVis = () => {
      if (document.visibilityState === 'visible') checkReleaseReminders();
    };
    document.addEventListener('visibilitychange', handleVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVis);
    };
  }, [checkReleaseReminders]);

  // Keşfet/Sana Özel veri toplama ve öneri hattı React dışındaki yükleyicide.
  // App yalnızca durum referanslarını ve setter'ları bağlar.
  const loadCategoryResults = React.useMemo(
    () =>
      createCatalogLoader({
        query,
        selectedProvider,
        showToast,
        requestGateRef,
        selectedTypeRef,
        selectedGenreRef,
        selectedSortRef,
        hideListedItemsRef,
        activeProfileIdRef,
        savedItemsRef,
        preferencesRef,
        genresMapRef,
        tasteMapRef,
        favoriteActorsRef,
        dislikedItemsRef,
        serverTasteRef,
        forYouItemsRef,
        lastForYouQueryKeyRef,
        setIsLoading,
        setLoadingMore,
        setCatalogItems,
        setCatalogPage,
        setCatalogTotalPages,
        setTrendingTop,
        setForYouExplanation,
        setForYouReasons,
        setForYouItems,
        setForYouProgressStep,
        setTasteMap,
        setStockStats,
      }),
    [query, selectedProvider, showToast, requestGateRef, setCatalogItems, setCatalogPage, setCatalogTotalPages, setForYouExplanation, setForYouItems, setForYouProgressStep, setForYouReasons, setIsLoading, setLoadingMore, setTrendingTop]
  );

  const handleRefreshForYou = useCallback(() => {
    const savedSet = new Set(savedItemsRef.current.map((s) => makeMediaKey(s)));
    const skipped = forYouItemsRef.current
      .map((it) => makeMediaKey(it))
      .filter((k) => !savedSet.has(k));
    if (skipped.length > 0) {
      void recordSkippedKeysIdb(activeProfileIdRef.current, skipped);
    }
    loadCategoryResults('for-you', 1, false, '', selectedProvider, true, selectedType, selectedGenre);
  }, [loadCategoryResults, selectedProvider, selectedType, selectedGenre]);

  const handleRefreshTasteMap = useCallback(() => {
    loadCategoryResults('for-you', 1, false, '', selectedProvider, true, selectedType, selectedGenre);
  }, [loadCategoryResults, selectedProvider, selectedType, selectedGenre]);

  const handleLoadRelationshipCandidates = useCallback(
    async (mediaFilter: 'all' | 'movie' | 'tv'): Promise<PoolCandidateItem[]> => {
      const mediaTypes: Array<'movie' | 'tv'> =
        mediaFilter === 'all' ? ['movie', 'tv'] : [mediaFilter];

      const result: PoolCandidateItem[] = [];

      for (const mediaType of mediaTypes) {
        await seedCandidatePoolFromStock(activeProfileId, mediaType, savedItems, preferences);
        const pool = await replenishCandidatePool({
          profileId: activeProfileId,
          mediaType,
          savedItems,
          preferences,
          favoriteActors,
          fetchTmdbFn: fetchTmdbCached,
          force: false,
        });

        result.push(...pool.items);
      }

      return result;
    },
    [activeProfileId, savedItems, preferences, favoriteActors]
  );

  const handleSelectType = useCallback((newType: string) => {
    setSelectedType(newType);
    selectedTypeRef.current = newType;
  }, [setSelectedType]);

  const handleSelectGenre = useCallback((newGenre: string) => {
    setSelectedGenre(newGenre);
    selectedGenreRef.current = newGenre;
  }, [setSelectedGenre]);

  useEffect(() => {
    if (tab === 'taste-map') {
      const stored = loadPersistentTasteMap(activeProfileId);
      if (Object.keys(stored.entries || {}).length < 400 && !isLoading) {
        loadCategoryResults('for-you', 1, false, '', selectedProvider, false, selectedType, selectedGenre);
      }
    }
  }, [tab, activeProfileId, isLoading, loadCategoryResults, selectedProvider, selectedType, selectedGenre]);

  const stockHasItems = stockStats.movieCount + stockStats.tvCount > 0;

  const handleManualStockReplenish = useCallback(() => {
    void manualPullStock(activeProfileId, {
      userListItems: savedItemsRef.current,
      preferences: preferencesRef.current,
    }).then((res) => {
      setStockStats({
        movieCount: res.moviesCount,
        tvCount: res.tvCount,
      });
      if (tab === 'discover' && category === 'stock' && !query.trim()) {
        loadCategoryResults('stock', 1, false, '', selectedProvider, false, selectedType, selectedGenre);
      }
      if (!res.ok && res.error) {
        showToast(`Stok çekilemedi: ${res.error}`);
        return;
      }
      const totalAdded = res.addedMovies + res.addedTv;
      const skippedTotal = res.skippedListedCount + res.skippedDuplicateStockCount;
      if (totalAdded > 0) {
        const skipNote =
          skippedTotal > 0 ? ` (${skippedTotal} mevcut liste/stok kaydı atlandı)` : '';
        showToast(
          `✓ Stoka +${res.addedMovies} film ve +${res.addedTv} dizi eklendi${skipNote}.`
        );
      } else {
        showToast(
          'Yeni stok adayı bulunamadı; çekilen içerikler zaten listenizde veya stok havuzunda kayıtlı.'
        );
      }
    });
  }, [
    activeProfileId,
    tab,
    category,
    query,
    loadCategoryResults,
    selectedProvider,
    selectedType,
    selectedGenre,
    showToast,
  ]);

  useEffect(() => {
    if (tab === 'discover') {
      if (category === 'stock' && !query.trim()) {
        return;
      }
      if (category === 'for-you') {
        // FEAT-01 #11: Switching Tümü / Film / Dizi or genre inside "Seriler" filters from memory with ZERO network calls
        if (forYouSubTab === 'series' && !query.trim()) {
          return;
        }
        const currentForYouKey = `${activeProfileId}|${
          selectedType === 'movie' || selectedType === 'tv' ? selectedType : 'all'
        }|${selectedGenre || ''}|${selectedProvider || ''}`;
        if (
          lastForYouQueryKeyRef.current === currentForYouKey &&
          forYouItemsRef.current.length >= TARGET_RECOMMENDATION_COUNT
        ) {
          return;
        }
        loadCategoryResults(category, 1, false, query, selectedProvider, false, selectedType, selectedGenre);
        return;
      }
      loadCategoryResults(category, 1, false, query, selectedProvider, false, selectedType, selectedGenre);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- bilinçli: aktif profil değişimi bu etkiyi tetiklememeli
  }, [tab, category, forYouSubTab, query, selectedProvider, selectedType, selectedGenre, hideListedItems, loadCategoryResults]);

  useEffect(() => {
    if (tab === 'discover' && category === 'stock' && !query.trim()) {
      loadCategoryResults('stock', 1, false, '', selectedProvider, false, selectedType, selectedGenre);
    }
  }, [selectedSort, hideListedItems, stockHasItems, tab, category, query, selectedProvider, selectedType, selectedGenre, loadCategoryResults]);

  // Load more pagination
  const handleLoadMore = () => {
    if (tab === 'discover' && category !== 'for-you' && catalogPage < catalogTotalPages) {
      loadCategoryResults(category, catalogPage + 1, true, query, selectedProvider, false, selectedType, selectedGenre);
    }
  };

  // Searching
  const handleSearchSubmit = (q: string) => {
    setQuery(q);
    if (q.trim()) {
      setTab('discover');
      setCategory('trending');
    }
  };

  const handleSearchClear = () => {
    setQuery('');
    if (tab === 'discover') {
      loadCategoryResults(category, 1, false, '');
    }
  };

  // Saved items CRUD (V1.5: ratedAt & completedAt zaman damgası altyapısı)
  // Kütüphane yazımları tek denetleyicide; App yalnızca bağlamı verir.
  const {
    handleSaveItem,
    handleQuickAdd,
    handleMarkCompleted,
    handleSetStatus,
    handleToggleFavoriteActor,
    handleIncrementTvEpisode,
    handleMergeDuplicates,
    handleRemoveItem,
    handleToggleDislike,
    handleToggleHide,
  } = useLibraryController({
    activeProfile,
    activeProfileId,
    catalogItems,
    forYouItems,
    savedItems,
    preferences,
    deletedKeys,
    tasteMapRef,
    activeProfileIdRef,
    savedItemsRef,
    preferencesRef,
    deletedKeysRef,
    showToast,
    setProfiles,
    setSavedItems,
    setDeletedKeys,
    setForYouItems,
    setTasteMap,
    setPreferences,
    setDislikedItems,
    setServerTasteSignal,
    setFavoriteActors,
  });

  // Background fetch for any missing disliked items when entering disliked tab
  useEffect(() => {
    if (tab === 'list' && listStatus === 'disliked') {
      const missingKeys = preferences.disliked.filter(
        (key) => !dislikedItems.some((item) => `${item.media_type}:${item.id}` === key)
      );
      if (missingKeys.length > 0) {
        Promise.allSettled(
          missingKeys.map((key) => {
            const [type, id] = key.split(':');
            return fetchTmdb(`/${type}/${id}`).then((res) => ({ ...res, media_type: type }));
          })
        ).then((results) => {
          const newItems = results
            .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && Boolean(r.value))
            .map((r) => r.value);
          if (newItems.length > 0) {
            setDislikedItems((prev) => {
              const combined = [...prev, ...newItems].filter(
                (item, idx, arr) =>
                  arr.findIndex((x) => `${x.media_type}:${x.id}` === `${item.media_type}:${item.id}`) === idx
              );
              try {
                const cache: Record<string, any> = {};
                combined.forEach((item) => {
                  cache[`${item.media_type}:${item.id}`] = item;
                });
                localStorage.setItem('cinetrack_disliked_cache', JSON.stringify(cache));
              } catch {}
              return combined;
            });
          }
        });
      }
    }
  }, [tab, listStatus, preferences.disliked, dislikedItems]);

  // Background enrich TV shows with missing episode count
  useEffect(() => {
    const unhydratedTvShows = savedItems.filter(
      (i) => i.media_type === 'tv' && !i.custom && !i.number_of_episodes
    );
    if (unhydratedTvShows.length > 0) {
      unhydratedTvShows.slice(0, 5).forEach((tv) => {
        fetchTmdb(`/tv/${tv.id}`)
          .then((details) => {
            if (details) {
              setSavedItems((currentList) =>
                currentList.map((entry) => {
                  if (entry.id === tv.id && entry.media_type === 'tv') {
                    return {
                      ...entry,
                      number_of_episodes: Number(details.number_of_episodes) || 10,
                      number_of_seasons: Number(details.number_of_seasons) || 1,
                      episode_run_time: details.episode_run_time || [45],
                      runtime: details.episode_run_time?.[0] || 45,
                    };
                  }
                  return entry;
                })
              );
            }
          })
          .catch(() => {});
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- bilinçli: detay zenginleştirme yalnızca liste uzunluğu değişince çalışmalı
  }, [savedItems.length]);

  // Filter & sort displayed items
  const filterAndSortItems = (items: any[]) => {
    let filtered = items.filter((item) => {
      if (item.media_type !== 'movie' && item.media_type !== 'tv') return false;
      if (selectedType !== 'all' && item.media_type !== selectedType) return false;
      if (selectedGenre && !matchesSelectedGenre(item, selectedGenre)) return false;
      return true;
    });

    if (tab === 'discover' && category !== 'for-you' && selectedSort === 'popular') {
      return filtered;
    }

    if (selectedSort === 'similarity') {
      const savedEncodings = savedItemsRef.current.map((it) => ({
        encoding: getItemEncodingSync(it),
        personal_rating: it.personal_rating,
      }));
      const profileCentroid = computeProfileCentroid(savedEncodings);
      if (profileCentroid.length > 0) {
        const simMap = new Map<string, number>();
        for (const it of filtered) {
          const enc = getItemEncodingSync(it);
          const sim = cosineSimilarity(profileCentroid, enc.denseVector);
          simMap.set(`${it.media_type}:${it.id}`, sim);
        }
        filtered = [...filtered].sort(
          (a, b) =>
            (simMap.get(`${b.media_type}:${b.id}`) ?? 0) -
            (simMap.get(`${a.media_type}:${a.id}`) ?? 0)
        );
      }
    } else if (selectedSort === 'rating') {
      filtered = [...filtered].sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
    } else if (selectedSort === 'title') {
      filtered = [...filtered].sort((a, b) =>
        displayTitle(a).localeCompare(displayTitle(b), 'tr')
      );
    } else if (selectedSort === 'recent') {
      filtered = [...filtered].sort((a, b) =>
        tab === 'list'
          ? (b.addedAt || '').localeCompare(a.addedAt || '')
          : (b.release_date || b.first_air_date || '').localeCompare(
              a.release_date || a.first_air_date || ''
            )
      );
    }
    return filtered;
  };

  // FEAT-01 #10 & #11: Compute missing franchise parts strictly for franchises present in user's savedItems
  const seriesUniverseData = React.useMemo(() => {
    void seriesIndexVersion;
    const effectiveDemo = Boolean(activeProfile?.isDemo || tmdbSourceMeta.source === 'demo');
    const universes = computeUserSeriesUniverses(savedItems, {
      includeStubs: !effectiveDemo,
      dislikedKeys: preferences.disliked,
      hiddenKeys: preferences.hidden,
    });
    const items: any[] = [];
    const reasonsMap = new Map<string, string>();
    const seenKeys = new Set<string>();
    const dislikedSet = new Set(preferences.disliked || []);
    const hiddenSet = new Set(preferences.hidden || []);

    for (const u of universes) {
      const ownedTitles = u.userOwnedParts
        .slice(0, 2)
        .map((p) => p.title || p.name)
        .filter(Boolean)
        .join(', ');
      const reason = ownedTitles
        ? `${u.collection.name} · Listenizdeki "${ownedTitles}" ile aynı seride`
        : `${u.collection.name} serisinin devam halkası`;

      for (const part of u.userMissingParts) {
        const mType = part.media_type === 'tv' ? 'tv' : 'movie';
        const key = makeMediaKey(mType, part.id);
        if (seenKeys.has(key) || dislikedSet.has(key) || hiddenSet.has(key)) continue;
        if (isItemSaved(savedItems, part, mType)) continue;
        seenKeys.add(key);
        items.push({
          ...part,
          media_type: mType,
          belongs_to_collection: mType === 'movie' ? { id: u.collection.id, name: u.collection.name } : undefined,
        });
        reasonsMap.set(key, reason);
      }
    }

    return { items, reasonsMap, universesCount: universes.length };
  }, [savedItems, preferences.disliked, preferences.hidden, seriesIndexVersion, activeProfile?.isDemo, tmdbSourceMeta.source]);

  const displayedItems = React.useMemo(() => {
    if (tab === 'discover') {
      if (category === 'for-you' && forYouSubTab === 'series' && !query.trim()) {
        return filterAndSortItems(seriesUniverseData.items);
      }

      const rawSource = category === 'for-you' ? forYouItems : catalogItems;
      const shouldHideUserRegistered =
        !query.trim() &&
        hideListedItems &&
        (HIDE_LISTED_CATEGORIES as readonly string[]).includes(category);

      const preFiltered = shouldHideUserRegistered
        ? filterHiddenUserRegisteredItems(rawSource, {
            savedItems,
            preferences,
            tasteMap,
            hideListedItems: true,
          })
        : rawSource;

      const filtered = preFiltered.filter((item) => {
        const itemType = item.media_type || (item.title ? 'movie' : 'tv');
        const key = makeMediaKey(itemType, item.id);
        if (preferences.disliked.includes(key)) return false;
        if (preferences.hidden?.includes(key)) return false;

        // In Sana Özel (recommendations), strictly filter out items already in the user's list
        if (category === 'for-you') {
          if (isItemSaved(savedItems, item, itemType)) return false;
        }

        return true;
      });
      return filterAndSortItems(filtered);
    }

    if (listStatus === 'disliked') {
      const activeDisliked = dislikedItems.filter((item) =>
        preferences.disliked.includes(`${item.media_type}:${item.id}`)
      );
      return filterAndSortItems(activeDisliked);
    }

    let list = savedItems;
    if (listStatus === 'upcoming') {
      const todayStr = new Date().toISOString().slice(0, 10);
      list = savedItems
        .filter((item) => {
          const airDate = resolveAirDate(item);
          return airDate && airDate >= todayStr;
        })
        .sort((a, b) => resolveAirDate(a).localeCompare(resolveAirDate(b)));
    } else if (listStatus !== 'all') {
      list = savedItems.filter((item) => item.status === listStatus);
    }
    return filterAndSortItems(list);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- bilinçli: liste filtresi yalnızca tab/listStatus değişiminde yeniden hesaplanmalı
  }, [
    tab,
    category,
    forYouSubTab,
    query,
    seriesUniverseData.items,
    forYouItems,
    catalogItems,
    hideListedItems,
    savedItems,
    preferences.disliked,
    preferences.hidden,
    tasteMap,
    dislikedItems,
    listStatus,
    selectedType,
    selectedGenre,
    selectedSort,
  ]);

  // FEAT-02 #6: Record unsaved items displayed on the Discover tab into ct:surfaced FIFO ring history
  // REG-01: Never mark local ct:stock browsing as surfaced so stock items do not self-poison cooldowns
  useEffect(() => {
    if (tab !== 'discover' || displayedItems.length === 0) return;
    if (category === 'stock') return;
    if (category === 'for-you' && forYouSubTab === 'series' && !query.trim()) return;
    const savedKeySet = new Set(
      savedItems.map((it) => `${it.media_type === 'tv' ? 'tv' : 'movie'}:${it.id}`)
    );
    void markItemsAsSurfaced(displayedItems, savedKeySet);
  }, [tab, category, forYouSubTab, query, displayedItems, savedItems]);

  // Hero Item
  const watchingItem = savedItems.find((item) => item.status === 'watching') || null;
  const currentHeroItem = watchingItem || trendingTop || catalogItems[0] || null;
  const featuredHeroItems = React.useMemo(() => {
    const list: any[] = [];
    if (currentHeroItem) list.push(currentHeroItem);
    if (
      trendingTop &&
      !list.some(
        (it) =>
          `${it.media_type || (it.title ? 'movie' : 'tv')}:${it.id}` ===
          `${trendingTop.media_type || (trendingTop.title ? 'movie' : 'tv')}:${trendingTop.id}`
      )
    ) {
      list.push(trendingTop);
    }
    for (const item of catalogItems) {
      if (list.length >= 3) break;
      const key = `${item.media_type || (item.title ? 'movie' : 'tv')}:${item.id}`;
      if (
        !list.some(
          (existing) =>
            `${existing.media_type || (existing.title ? 'movie' : 'tv')}:${existing.id}` === key
        )
      ) {
        list.push(item);
      }
    }
    return list;
  }, [currentHeroItem, trendingTop, catalogItems]);

  const todayStr = new Date().toISOString().slice(0, 10);
  const upcomingCount = savedItems.filter((item) => {
    const airDate = resolveAirDate(item);
    return airDate && airDate >= todayStr && (selectedType === 'all' || item.media_type === selectedType);
  }).length;
  const watchingCount = savedItems.filter(
    (item) => item.status === 'watching' && (selectedType === 'all' || item.media_type === selectedType)
  ).length;
  const watchlistCount = savedItems.filter(
    (item) => item.status === 'watchlist' && (selectedType === 'all' || item.media_type === selectedType)
  ).length;
  const completedCount = savedItems.filter(
    (item) => item.status === 'completed' && (selectedType === 'all' || item.media_type === selectedType)
  ).length;
  const allListCount = savedItems.filter(
    (item) => selectedType === 'all' || item.media_type === selectedType
  ).length;

  const tasteSummary = React.useMemo<TasteProfileSummary>(() => {
    if (tasteMap.summary && tasteMap.summary.topGenres && tasteMap.summary.topGenres.length > 0) {
      return tasteMap.summary;
    }
    const currentSaved = filterHistoryByType(savedItems, 'all');
    const profile = buildTasteProfileV3(currentSaved, { dislikedKeys: preferences.disliked });
    return buildTasteProfileSummary(profile, tasteMap, genresMap);
  }, [tasteMap, savedItems, preferences.disliked, genresMap]);

  // FEAT-02 #4: Persist isolated ct:profile (Theme, DNA, Preferences) and compact ct:user-lists (IDs & statuses only)
  useEffect(() => {
    const resolvedTheme =
      typeof document !== 'undefined'
        ? document.documentElement.dataset.theme || 'dark-navy'
        : 'dark-navy';
    void saveIsolatedProfileIdb({
      profileId: activeProfileId,
      name: profileName,
      theme: resolvedTheme,
      dna: tasteSummary,
      preferences,
      favoriteActors,
      updatedAt: new Date().toISOString(),
    });
  }, [activeProfileId, profileName, tasteSummary, preferences, favoriteActors]);

  useEffect(() => {
    void saveUserListsIdb(activeProfileId, savedItems);
  }, [activeProfileId, savedItems]);

  // Header and Catalog Section Titles
  const getCatalogTitles = () => {
    if (tab === 'list') {
      const typeLabel =
        selectedType === 'movie'
          ? 'film'
          : selectedType === 'tv'
          ? 'dizi'
          : 'içerik (film + dizi)';
      const statusTitles: Record<string, { title: string; count: number }> = {
        all: { title: 'Tüm takip listem', count: allListCount },
        watching: { title: 'Şu an izlediklerim', count: watchingCount },
        watchlist: { title: 'İzlenecekler listem', count: watchlistCount },
        completed: { title: 'Tamamladıklarım', count: completedCount },
        upcoming: { title: 'Yaklaşan yayınlar', count: upcomingCount },
        actors: { title: 'Favori oyuncularım', count: favoriteActors.length },
        disliked: { title: 'İlgilenmediğim içerikler', count: preferences.disliked.length },
      };
      const info = statusTitles[listStatus] || statusTitles.all;
      if (listStatus === 'actors') {
        return {
          title: `${info.title} (${info.count})`,
          description: `Takip ettiğin ${info.count} favori oyuncu ve senin için kişiselleştirilmiş film & dizi önerileri`,
        };
      }
      return {
        title: `${info.title} (${info.count})`,
        description: `Listenizde toplam ${info.count} kayıtlı ${typeLabel} bulunuyor`,
      };
    }
    if (query) {
      return {
        title: `"${query}" için arama sonuçları`,
        description: 'Sonuçlar doğrudan TMDB arama servisinden alınır',
      };
    }
    const catMap: Record<string, { title: string; description: string }> = {
      trending: { title: 'Güncel trendler', description: 'TMDB\'den canlı olarak yükleniyor' },
      'for-you': {
        title: forYouSubTab === 'series' ? 'Sana özel · Seriler' : 'Sana özel',
        description:
          forYouSubTab === 'series'
            ? 'Listenizdeki film ve dizilerin aynı evrendeki diğer halkaları ve devam yapımları'
            : forYouExplanation ||
              (selectedGenre && genresMap[Number(selectedGenre)]
                ? `${genresMap[Number(selectedGenre)]} türünde zevk profiline göre oluşturulan 20 öneri`
                : selectedType === 'movie'
                ? 'Film izleme geçmişin ve kişisel puanlarından oluşturulan 20 film önerisi'
                : selectedType === 'tv'
                ? 'Dizi izleme geçmişin ve kişisel puanlarından oluşturulan 20 dizi önerisi'
                : 'İzleme listen ve kişisel puanlarından oluşturulan 20 öneri'),
      },
      gems: {
        title: 'Keşfedilmemiş mücevherler',
        description: 'Yüksek puanlı, daha az popüler ve keşfedilmeyi bekleyen film ve diziler',
      },
      upcoming: { title: 'Yakında ve yayında', description: 'Yaklaşan filmler ve yayındaki diziler' },
      'popular-movies': { title: 'Popüler filmler', description: 'TMDB\'de en çok ilgi gören filmler' },
      'popular-tv': { title: 'Popüler diziler', description: 'TMDB\'de en çok ilgi gören diziler' },
      'top-rated': { title: 'Yüksek puanlı filmler', description: 'TMDB puanına göre sıralanır' },
      stock: {
        title: `Keşfet — ${stockStats.movieCount} Film · ${stockStats.tvCount} Dizi${
          tvdbCount > 0 ? ` (TVDB: ${tvdbCount})` : ''
        }`,
        description: `Listenizde olmayan, çevrimdışı erişime hazır kişisel aday havuzu (${
          tvdbCount > 0 ? `${tvdbCount} TVDB yapımı dahil` : 'TMDB ve TVDB kaynaklı'
        }) ve zevk vektörü sıralaması`,
      },
    };
    return catMap[category] || catMap.trending;
  };

  const { title: catalogTitle, description: catalogDescription } = getCatalogTitles();

  // Profile Management
  const handleSaveProfileName = (newName: string) => {
    setProfileName(newName);
    setProfiles((prev) =>
      prev.map((p) => (p.id === activeProfileId ? { ...p, name: newName } : p))
    );
    showToast('Profil kaydedildi.');
  };

  const handleSwitchProfile = (rawNewId: string) => {
    // Profil değişimi: sunucu zevk sinyali de dahil tüm profil kapsamlı
    // önbellekler düşürülür; yeni profilin verisi eskisiyle karışmaz.
    clearServerTasteSignalCache();
    const newId = normalizeProfileId(rawNewId);
    if (!newId || newId === activeProfileId) return;
    const outgoingId = activeProfileId;
    const outgoingDeleted = normalizeDeletedKeys(deletedKeysRef.current);
    const updatedProfiles = profiles.map((p) =>
      p.id === outgoingId
        ? {
            ...p,
            name: profileName,
            items: savedItems,
            preferences,
            favoriteActors: favoriteActorsRef.current || [],
            ...(Object.keys(outgoingDeleted).length > 0 ? { deleted_keys: outgoingDeleted } : {}),
          }
        : p
    );
    profilesRef.current = updatedProfiles;
    setProfiles(updatedProfiles);
    persistProfilesBestEffort(updatedProfiles);

    setActiveProfileId(newId);
    activeProfileIdRef.current = newId;
    const target = updatedProfiles.find((p) => p.id === newId);
    const nextName = target?.name || 'Profilim';
    profileNameRef.current = nextName;
    setProfileName(nextName);
    const items = target?.items?.length ? target.items : loadProfileItems(newId);
    savedItemsRef.current = items;
    setSavedItems(items);
    const nextPrefs =
      target?.preferences &&
      ((target.preferences.disliked?.length || 0) > 0 ||
        (target.preferences.hidden?.length || 0) > 0 ||
        (target.preferences.providers?.length || 0) > 0 ||
        Boolean(target.preferences.mood) ||
        Boolean(target.preferences.reminders))
        ? target.preferences
        : loadProfilePreferences(newId);
    preferencesRef.current = nextPrefs;
    setPreferences(nextPrefs);
    const favs = target?.favoriteActors?.length ? target.favoriteActors : loadFavoriteActors(newId);
    favoriteActorsRef.current = favs;
    setFavoriteActors(favs);
    const targetDeleted = normalizeDeletedKeys(target?.deleted_keys || loadDeletedKeys(newId));
    deletedKeysRef.current = targetDeleted;
    setDeletedKeys(targetDeleted);
    const nextTasteMap = loadPersistentTasteMap(newId);
    tasteMapRef.current = nextTasteMap;
    setTasteMap(nextTasteMap);
    lastForYouQueryKeyRef.current = '';
    setForYouItems([]);
    setForYouReasons(new Map());
    setQuery('');
    setProfileOpen(false);
  };

  const handleCreateProfile = (name: string, isDemo = false) => {
    const outgoingId = activeProfileId;
    const outgoingDeleted = normalizeDeletedKeys(deletedKeysRef.current);
    const newId = normalizeProfileId(`profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)!;
    const newProf: Profile = {
      id: newId,
      name,
      createdAt: new Date().toISOString(),
      preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
      items: [],
      favoriteActors: [],
      isDemo,
    };
    const nextProfiles = [
      ...profiles.map((p) =>
        p.id === outgoingId
          ? {
              ...p,
              name: profileName,
              items: savedItems,
              preferences,
              favoriteActors: favoriteActorsRef.current || [],
              ...(Object.keys(outgoingDeleted).length > 0 ? { deleted_keys: outgoingDeleted } : {}),
            }
          : p
      ),
      newProf,
    ];
    profilesRef.current = nextProfiles;
    setProfiles(nextProfiles);
    persistProfilesBestEffort(nextProfiles);

    setActiveProfileId(newId);
    activeProfileIdRef.current = newId;
    profileNameRef.current = name;
    setProfileName(name);
    savedItemsRef.current = [];
    setSavedItems([]);
    preferencesRef.current = newProf.preferences;
    setPreferences(newProf.preferences);
    favoriteActorsRef.current = [];
    setFavoriteActors([]);
    deletedKeysRef.current = {};
    setDeletedKeys({});
    const nextTasteMap = loadPersistentTasteMap(newId);
    tasteMapRef.current = nextTasteMap;
    setTasteMap(nextTasteMap);
    lastForYouQueryKeyRef.current = '';
    setForYouItems([]);
    setForYouReasons(new Map());
    setProfileOpen(false);
    showToast(`"${name}" profili oluşturuldu.`);
  };

  const handleSavePreferences = (providers: string[], mood: string) => {
    setPreferences((prev) => ({
      ...prev,
      providers,
      mood,
    }));
    showToast('Tercihler kaydedildi.');
  };

  const handleToggleReminders = async () => {
    if (preferences.reminders) {
      setPreferences((prev) => ({ ...prev, reminders: false }));
      showToast('Yayın hatırlatıcıları kapatıldı.');
      return;
    }
    if (!('Notification' in window)) {
      showToast('Bu tarayıcı bildirimleri desteklemiyor.');
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        setPreferences((prev) => ({ ...prev, reminders: true }));
        showToast('Yayın hatırlatıcıları etkinleştirildi.');
        checkReleaseReminders();
      } else {
        showToast('Bildirim izni verilmedi.');
      }
    } catch {
      showToast('Bildirim izni alınamadı.');
    }
  };

  const handleToggleDemoMode = () => {
    const nextState = !activeProfile?.isDemo;
    setProfiles((prev) =>
      prev.map((p) => (p.id === activeProfileId ? { ...p, isDemo: nextState } : p))
    );
    showToast(
      nextState
        ? 'Profil Demo moduna alındı (Örnek havuz kullanılır).'
        : 'Profil Canlı moda alındı (Kişisel verileriniz kullanılır).'
    );
  };

  const {
    handleExportBackup,
    handleImportBackupFile,
    handleConfirmImport,
  } = useProfileBackupCoordinator({
    activeProfileId,
    profileName,
    savedItems,
    preferences,
    favoriteActors,
    favoriteActorsRef,
    genresMap,
    cinemaKunye,
    isDemo: Boolean(activeProfile?.isDemo),
    pendingBackup,
    setPendingBackup,
    setSavedItems,
    savedItemsRef,
    lastForYouQueryKeyRef,
    setForYouItems,
    setPreferences,
    setFavoriteActors,
    setProfiles,
    setProfileOpen,
    confirmNextBulkSyncRef,
    mergeIncomingCinemaKunye,
    replaceCinemaKunye,
    handleSaveProfileName,
    showToast,
    // Aşama 1 — yedek/geri yükleme tam belge kapsamı (B-05, B-06).
    profiles,
    deletedKeys,
    setActiveProfileId,
    setDeletedKeys,
    setProfileName,
    persistProfiles: persistProfilesBestEffort,
    ...(getLastKnownServerRevision() !== null
      ? { revision: getLastKnownServerRevision() as number }
      : {}),
  });

  const handleEmptyAction = (act: string) => {
    switch (act) {
      case 'clear-search':
        handleSearchClear();
        break;
      case 'clear-filters':
        setSelectedGenre('');
        setSelectedType('all');
        setHideListedItems(false);
        break;
      case 'trending':
        setQuery('');
        setCategory('trending');
        break;
      case 'all-items':
        setListStatus('all');
        break;
      case 'discover':
        setTab('discover');
        break;
    }
  };

  return (
    <>
      <OfflineIndicator
        isOnline={isOnline}
        pendingSync={pendingSync}
        unpersistedWarning={unpersistedWarning}
      />
      <Header
        profileName={profileName}
        query={query}
        tab={tab}
        onTabChange={setTab}
        myListCount={allListCount}
        onSearchChange={setQuery}
        onSearchSubmit={handleSearchSubmit}
        onSearchClear={handleSearchClear}
        onOpenProfile={() => setProfileOpen(true)}
        onOpenAdd={() => setAddCustomOpen(true)}
        onSelectItem={(item) => setDetailItem(item)}
        getSaved={(item) => findSavedItem(savedItems, item)}
        tmdbSource={tmdbSourceMeta.source}
        tmdbStaleReason={tmdbSourceMeta.staleReason}
        onOpenTvdbStock={() => setTvdbModalOpen(true)}
        tvdbCount={tvdbCount}
      />
      <ConflictBanner
        conflict={serverConflict}
        onMergeBoth={handleMergeBothOnConflict}
        onKeepLocal={handleKeepLocalOnConflict}
        onUseServer={handleUseServerOnConflict}
        onDismiss={() => setServerConflict(null)}
      />

      <main className="shell">
        {tab === 'discover' && !query && (
          <Hero
            heroItem={currentHeroItem}
            featuredItems={featuredHeroItems}
            isWatching={Boolean(watchingItem)}
            onOpenDetails={(item) => setDetailItem(item)}
          />
        )}

        {tab === 'list' && (
          <Stats
            items={savedItems}
            profileName={profileName}
            favoriteActors={favoriteActors}
            genresMap={genresMap}
            cinemaKunye={cinemaKunye}
            onSelectItem={(id, mediaType) => {
              const found = findSavedItem(savedItems, { id, media_type: mediaType });
              setDetailItem(found || { id, media_type: mediaType });
            }}
            onMergeDuplicates={handleMergeDuplicates}
          />
        )}

        {(tab === 'discover' || tab === 'list') && (
        <Controls
          tab={tab}
          onTabChange={setTab}
          myListCount={allListCount}
          upcomingCount={upcomingCount}
          dislikedCount={preferences.disliked.length}
          favoriteActorsCount={favoriteActors.length}
          watchingCount={watchingCount}
          watchlistCount={watchlistCount}
          completedCount={completedCount}
          genres={genresMap}
          selectedGenre={selectedGenre}
          onGenreChange={handleSelectGenre}
          selectedType={selectedType}
          onTypeChange={handleSelectType}
          selectedCategory={category}
          onCategoryChange={setCategory}
          isSearchActive={Boolean(query.trim())}
          selectedSort={selectedSort}
          onSortChange={setSelectedSort}
          selectedProvider={selectedProvider}
          onProviderChange={setSelectedProvider}
          listStatus={listStatus}
          onListStatusChange={setListStatus}
          hideListedItems={hideListedItems}
          onHideListedItemsChange={setHideListedItems}
          stockStats={stockStats}
          onReplenishStock={handleManualStockReplenish}
          isStockReplenishing={stockEngineState.isReplenishing}
          onOpenTvdbStock={() => setTvdbModalOpen(true)}
          tvdbCount={tvdbCount}
        />
        )}

        {tab === 'home' ? (
          <ErrorBoundary sectionName="Ana Sayfa">
            <HomeSection
              profileName={profileName}
              savedItems={savedItems}
              forYouItems={forYouItems}
              genresMap={genresMap}
              isDemo={Boolean(activeProfile?.isDemo)}
              onOpenDetails={(item) => setDetailItem(item)}
              onQuickSave={(item) => setQuickSaveItem(item)}
              onSetStatus={(item, status) => handleSetStatus(item, status)}
              onIncrementEpisode={(item) => handleIncrementTvEpisode(item)}
              onGoDiscover={() => setTab('discover')}
              onGoTaste={() => setTab('taste-map')}
            />
          </ErrorBoundary>
        ) : tab === 'series' ? (
          <ErrorBoundary sectionName="Seriler ve Evrenler">
            <SeriesSection
              profileId={activeProfileId}
              savedItems={savedItems}
              preferences={preferences}
              favoriteActors={favoriteActors}
              genreNames={genresMap}
              onRefresh={handleLoadRelationshipCandidates}
              onOpenDetails={(item) => setDetailItem(item)}
              onQuickSave={(item) => setQuickSaveItem(item)}
            />
          </ErrorBoundary>
        ) : tab === 'operations' ? (
          <ErrorBoundary sectionName="İşlem Merkezi">
            <OperationsSection
              profileId={activeProfileId}
              onOpenBackup={() => setProfileOpen(true)}
            />
          </ErrorBoundary>
        ) : tab === 'relationships' ? (
          <ErrorBoundary sectionName="İlişki Keşfi">
            <Suspense
              fallback={
                <div className="lazy-tab-fallback" role="status">
                  İlişki Keşfi görünümü yükleniyor…
                </div>
              }
            >
              <RelationshipExplorer
                key={`${activeProfileId}-relationships`}
                mode="relationships"
                profileId={activeProfileId}
                savedItems={savedItems}
                preferences={preferences}
                candidates={[]}
                favoriteActors={favoriteActors}
                genreNames={genresMap}
                onRefresh={handleLoadRelationshipCandidates}
                onOpenDetails={(item) => setDetailItem(item as SavedItem)}
                onQuickSave={(item) => setQuickSaveItem(item as SavedItem)}
                initialSourceKey={relationshipInitialSourceKey}
              />
            </Suspense>
          </ErrorBoundary>
        ) : tab === 'taste-map' ? (
          <div className="taste-map-page">
            <div className="taste-map-view-toggle" role="group" aria-label="Zevk haritası görünüm modu">
              <button
                className={`btn ${tasteMapDisplayMode === 'identity' ? 'btn-primary' : ''}`}
                type="button"
                onClick={() => setTasteMapDisplayMode('identity')}
                aria-pressed={tasteMapDisplayMode === 'identity'}
              >
                Sinema Kimliğim
              </button>
              <button
                className={`btn ${tasteMapDisplayMode === 'poster' ? 'btn-primary' : ''}`}
                type="button"
                onClick={() => setTasteMapDisplayMode('poster')}
                aria-pressed={tasteMapDisplayMode === 'poster'}
              >
                Poster Duvarı
              </button>
              <button
                className={`btn ${tasteMapDisplayMode === 'graph' ? 'btn-primary' : ''}`}
                type="button"
                onClick={() => setTasteMapDisplayMode('graph')}
                aria-pressed={tasteMapDisplayMode === 'graph'}
              >
                Zevk Ağı (Grafik)
              </button>
            </div>

            <ErrorBoundary sectionName="Zevk Haritası">
              <Suspense
                fallback={
                  <div className="lazy-tab-fallback" role="status">
                    Zevk Haritası yükleniyor…
                  </div>
                }
              >
                {tasteMapDisplayMode === 'poster' ? (
                  <TasteMapView
                    tasteMap={tasteMap}
                    summary={tasteSummary}
                    genresMap={genresMap}
                    savedItems={savedItems}
                    onOpenDetails={(item) => setDetailItem(item)}
                    onQuickSave={(item) => setQuickSaveItem(item)}
                    onSetStatus={(item, status) => handleSetStatus(item, status)}
                    onToggleDislike={(key) => handleToggleDislike(key)}
                    onRefreshTasteMap={handleRefreshTasteMap}
                    isLoading={isLoading}
                    isDemo={Boolean(activeProfile?.isDemo)}
                    tmdbSource={tmdbSourceMeta.source}
                    tmdbStaleReason={tmdbSourceMeta.staleReason}
                  />
                ) : tasteMapDisplayMode === 'identity' ? (
                  <TasteProfileDashboard />
                ) : (
                  <RelationshipExplorer
                    key={`${activeProfileId}-taste-map`}
                    mode="taste-map"
                    profileId={activeProfileId}
                    savedItems={savedItems}
                    preferences={preferences}
                    candidates={[]}
                    favoriteActors={favoriteActors}
                    genreNames={genresMap}
                    onRefresh={handleLoadRelationshipCandidates}
                    onOpenDetails={(item) => setDetailItem(item as SavedItem)}
                    onQuickSave={(item) => setQuickSaveItem(item as SavedItem)}
                  />
                )}
              </Suspense>
            </ErrorBoundary>
          </div>
        ) : (
          <ErrorBoundary sectionName="Katalog ve Listem">
            <MediaGrid
              title={catalogTitle}
              description={catalogDescription}
              isLoading={category === 'for-you' && forYouSubTab === 'series' && !query.trim() ? false : isLoading}
              loadingMore={loadingMore}
              items={displayedItems}
              savedItems={savedItems}
              genres={genresMap}
              recommendationReasons={
                category === 'for-you'
                  ? forYouSubTab === 'series' && !query.trim()
                    ? seriesUniverseData.reasonsMap
                    : forYouReasons
                  : EMPTY_REASONS_MAP
              }
              dislikedKeys={preferences.disliked}
              preferredProviders={preferences.providers}
              tab={tab}
              query={query}
              listStatus={listStatus}
              category={category}
              page={catalogPage}
              totalPages={catalogTotalPages}
              hasMore={tab === 'discover' && category !== 'for-you' && catalogPage < catalogTotalPages}
              favoriteActors={favoriteActors}
              onLoadMore={handleLoadMore}
              onOpenDetails={(item) => setDetailItem(item)}
              onQuickAdd={handleQuickAdd}
              onSetStatus={handleSetStatus}
              onQuickSave={(item) => setQuickSaveItem(item)}
              onToggleDislike={handleToggleDislike}
              onEmptyAction={handleEmptyAction}
              onOpenPerson={(id, name) => {
                setPersonId(id);
                setPersonName(name);
              }}
              onToggleFavoriteActor={handleToggleFavoriteActor}
              onRefreshForYou={handleRefreshForYou}
              forYouProgressStep={forYouProgressStep}
              tmdbSource={tmdbSourceMeta.source}
              tmdbStaleReason={tmdbSourceMeta.staleReason}
              selectedType={selectedType}
              onTypeChange={handleSelectType}
              selectedGenre={selectedGenre}
              onGenreChange={handleSelectGenre}
              selectedSort={selectedSort}
              onSortChange={setSelectedSort}
              forYouSubTab={forYouSubTab}
              onForYouSubTabChange={setForYouSubTab}
              seriesCount={seriesUniverseData.universesCount}
              hiddenKeys={preferences.hidden}
              mood={preferences.mood}
              isDemo={Boolean(activeProfile?.isDemo)}
              onIncrementEpisode={handleIncrementTvEpisode}
              stockStats={stockStats}
              isStockReplenishing={stockEngineState.isReplenishing}
              stockReplenishError={stockEngineState.lastError}
              onReplenishStock={handleManualStockReplenish}
              onOpenAddCustom={() => setAddCustomOpen(true)}
            />
          </ErrorBoundary>
        )}
      </main>

      <footer>
        <div className="shell footer-shell">
          <div>
            Cinethos | Kişisel listen bu tarayıcıda saklanır. Katalog kaynağı:{' '}
            <a
              href="https://www.themoviedb.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="footer-link"
            >
              The Movie Database (TMDB)
            </a>
            .
          </div>
          <div className="footer-source-status">
            <span>Veri Durumu:</span>{' '}
            <strong>
              {tmdbSourceMeta.source === 'live'
                ? 'Canlı TMDB API'
                : tmdbSourceMeta.source === 'stale-cache'
                ? 'Eski Önbellek (Offline)'
                : tmdbSourceMeta.source === 'demo'
                ? 'Örnek Katalog'
                : 'Bağlantı Bekleniyor'}
            </strong>
          </div>
          <div className="footer-shortcuts-hint">
            <span>Kısayollar: </span>
            <kbd className="footer-kbd">1-7</kbd> Sekmeler ·{' '}
            <kbd className="footer-kbd">0</kbd> Ayarlar ·{' '}
            <kbd className="footer-kbd">/</kbd> Ara ·{' '}
            <kbd className="footer-kbd">S</kbd> Eşitle ·{' '}
            <kbd className="footer-kbd">N</kbd> Ekle ·{' '}
            <kbd className="footer-kbd">Esc</kbd> Kapat
          </div>
        </div>
      </footer>

      {/* Mobil 56px sticky alt tab bar — kayıt defterinden türetilir (Faz 7) */}
      <MobileBottomNav
        tab={tab}
        myListCount={allListCount}
        onSelectTab={setTab}
        onOpenProfile={() => setProfileOpen(true)}
      />

      {/* Modals & Drawers */}
      <DetailModal
        item={detailItem}
        savedItem={detailItem ? findSavedItem(savedItems, detailItem) : undefined}
        savedItems={savedItems}
        isOpen={Boolean(detailItem)}
        genresMap={genresMap}
        isDisliked={
          detailItem
            ? preferences.disliked.includes(
                `${detailItem.media_type || (detailItem.title ? 'movie' : 'tv')}:${detailItem.id}`
              )
            : false
        }
        isHidden={
          detailItem
            ? Boolean(
                preferences.hidden?.includes(
                  `${detailItem.media_type || (detailItem.title ? 'movie' : 'tv')}:${detailItem.id}`
                )
              )
            : false
        }
        favoriteActors={favoriteActors}
        onClose={() => setDetailItem(null)}
        onSave={handleSaveItem}
        onRemove={handleRemoveItem}
        onToggleDislike={handleToggleDislike}
        onToggleHide={handleToggleHide}
        onToggleFavoriteActor={handleToggleFavoriteActor}
        onSelectMedia={(next) => setDetailItem(next)}
        onOpenPerson={(id, name) => {
          setPersonId(id);
          setPersonName(name);
        }}
      />

      <QuickSaveModal
        item={quickSaveItem}
        savedItem={quickSaveItem ? findSavedItem(savedItems, quickSaveItem) : undefined}
        isOpen={Boolean(quickSaveItem)}
        onClose={() => setQuickSaveItem(null)}
        onSave={(item, status, rating) => {
          handleSaveItem(item, status, rating);
          showToast(`✓ "${displayTitle(item)}" listenize kaydedildi!`);
        }}
        onRemove={handleRemoveItem}
      />

      <PersonDrawer
        personId={personId}
        personName={personName}
        profileId={activeProfileId}
        isOpen={Boolean(personId)}
        savedItems={savedItems}
        isFavoriteActor={favoriteActors.some((a) => a.id === personId)}
        onClose={() => setPersonId(null)}
        onOpenDetails={(item) => setDetailItem(item)}
        onQuickAdd={handleQuickAdd}
        onMarkCompleted={handleMarkCompleted}
        onQuickSave={(item) => setQuickSaveItem(item)}
        onToggleFavoriteActor={handleToggleFavoriteActor}
        onOpenInRelationships={(mediaKey) => {
          setPersonId(null);
          setRelationshipInitialSourceKey(mediaKey);
          setTab('relationships');
        }}
      />

      <AddCustomModal
        isOpen={addCustomOpen}
        onClose={() => setAddCustomOpen(false)}
        onAdd={(item, status) => {
          handleSaveItem(item, status, '');
          showToast(`✓ "${item.title}" listenize eklendi!`);
        }}
      />

      <ProfileModal
        isOpen={profileOpen}
        profiles={profiles}
        activeProfile={activeProfile}
        activeProfileId={activeProfileId}
        activeProfileName={profileName}
        preferences={preferences}
        savedItems={savedItems}
        favoriteActors={favoriteActors}
        dislikedItems={dislikedItems}
        genresMap={genresMap}
        cinemaKunye={cinemaKunye}
        tasteEntries={tasteMap.entries}
        syncStatus={syncStatus}
        onClose={() => setProfileOpen(false)}
        onSaveProfileName={handleSaveProfileName}
        onSwitchProfile={handleSwitchProfile}
        onCreateProfile={handleCreateProfile}
        onSavePreferences={handleSavePreferences}
        onToggleReminders={handleToggleReminders}
        onExportBackup={handleExportBackup}
        onImportBackupFile={handleImportBackupFile}
        onImportCsvItems={(items, importedKunye) => {
          const effectiveKunye = importedKunye
            ? mergeIncomingCinemaKunye(importedKunye)
            : cinemaKunye;
          const merged = enrichSavedItemsFromCinemaKunye(
            mergeSavedItemListsLossless(savedItems, items, activeProfileId),
            effectiveKunye
          );
          savedItemsRef.current = merged;
          setSavedItems(merged);
          void recordProfileChangeAndMaybeBackup();
          showToast(`${items.length} yapım CSV'den listenize kayıpsız birleştirildi.`);
        }}
        onApplyRestoredDocument={(doc) => {
          applyDataDocumentToState(doc);
          void refreshCinemaKunyeFromServer('merge');
          showToast('Sunucu yedeği başarıyla geri yüklendi.');
        }}
        onBeforeSyncFlush={async () => {
          await Promise.all([pushToServer(), flushCinemaKunyeToServer()]);
        }}
        onMergeSyncedDocument={(doc) => {
          handleMergeSyncedDocument(doc);
          void refreshCinemaKunyeFromServer('merge');
        }}
        onCinemaKunyeSynced={(syncMode) => {
          void refreshCinemaKunyeFromServer(syncMode);
        }}
        onMergeDuplicates={handleMergeDuplicates}
        isDemo={Boolean(activeProfile?.isDemo)}
        onToggleDemoMode={handleToggleDemoMode}
      />

      <ImportChoiceModal
        isOpen={Boolean(pendingBackup)}
        onClose={() => setPendingBackup(null)}
        onConfirm={handleConfirmImport}
      />

      <TvdbStockModal
        isOpen={tvdbModalOpen}
        onClose={() => setTvdbModalOpen(false)}
        userListItems={savedItems}
        preferences={preferences}
        profileId={activeProfileId}
        onStockMutated={() => {
          refreshStockStats();
          if (category === 'stock') {
            loadCategoryResults('stock', 1, false, '', selectedProvider, false, selectedType, selectedGenre);
          }
          showToast('✓ TVDB ve stok verileri başarıyla güncellendi!');
        }}
      />

      <Toast toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
export default App;
