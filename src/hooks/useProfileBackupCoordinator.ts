import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
  CURRENT_SCHEMA_VERSION,
  ENGINE_VERSION,
  normalizeDeletedKeys,
  parseBackupText,
  type FavoriteActorInfo,
  type ParsedBackupDocument,
  type Preferences,
  type Profile,
  type SavedItem,
} from '../core/cinetrack-core.ts';
import { reconcileUserDataDocumentsLossless } from '../core/user-data-merge.ts';
import {
  enrichSavedItemsFromCinemaKunye,
  extractCinemaKunyeFromItems,
  mergeCinemaKunyeDocumentsLossless,
} from '../core/cinema-kunye.ts';
import { buildBackupFileName, buildLocalBackupDocument } from '../app/profile-backup.ts';
import { favActorsStorageKey } from '../app/profile-storage.ts';

export interface UseProfileBackupCoordinatorOptions {
  activeProfileId: string;
  profileName: string;
  savedItems: SavedItem[];
  preferences: Preferences;
  favoriteActors: FavoriteActorInfo[];
  favoriteActorsRef: MutableRefObject<FavoriteActorInfo[] | null>;
  genresMap: Record<number, string>;
  cinemaKunye: any;
  isDemo: boolean;
  pendingBackup: ParsedBackupDocument | null;
  setPendingBackup: Dispatch<SetStateAction<ParsedBackupDocument | null>>;
  setSavedItems: Dispatch<SetStateAction<SavedItem[]>>;
  savedItemsRef: MutableRefObject<SavedItem[] | null>;
  lastForYouQueryKeyRef: MutableRefObject<string | null>;
  setForYouItems: Dispatch<SetStateAction<any[]>>;
  setPreferences: Dispatch<SetStateAction<Preferences>>;
  setFavoriteActors: Dispatch<SetStateAction<FavoriteActorInfo[]>>;
  setProfiles: Dispatch<SetStateAction<Profile[]>>;
  setProfileOpen: Dispatch<SetStateAction<boolean>>;
  confirmNextBulkSyncRef: MutableRefObject<boolean | null>;
  mergeIncomingCinemaKunye: (document: any) => any;
  replaceCinemaKunye: (document: any) => any;
  handleSaveProfileName: (name: string) => void;
  showToast: (message: string) => void;
  // Aşama 1 — tam belge (çoklu profil + tombstone) içe aktarma desteği.
  profiles: Profile[];
  deletedKeys: Record<string, string>;
  setActiveProfileId: (id: string) => void;
  setDeletedKeys: (keys: Record<string, string>) => void;
  setProfileName: (name: string) => void;
  persistProfiles?: (profiles: Profile[]) => void;
  revision?: number;
}

/**
 * Aşama 1 (B-05, B-06, B-07) — yedek içe aktarma artık **tam belge** üzerinden
 * yürür:
 * - v4 ve v3 tam belgelerindeki bütün profiller, tombstone'lar ve aktif profil
 *   korunur; `merge` modunda mevcut veriyle kayıpsız birleştirilir.
 * - Tek profil yedekleri (v1–v3) geriye dönük uyumlu kalır: `overwrite`
 *   yalnızca aktif profili değiştirir, diğer profillere dokunmaz.
 */
export function useProfileBackupCoordinator(options: UseProfileBackupCoordinatorOptions) {
  const {
    activeProfileId, profileName, savedItems, preferences, favoriteActorsRef,
    genresMap, cinemaKunye, isDemo, pendingBackup, setPendingBackup, setSavedItems,
    savedItemsRef, lastForYouQueryKeyRef, setForYouItems, setPreferences, setFavoriteActors,
    setProfiles, setProfileOpen, confirmNextBulkSyncRef, mergeIncomingCinemaKunye,
    replaceCinemaKunye, showToast, profiles, deletedKeys, setActiveProfileId, setDeletedKeys,
    setProfileName, persistProfiles, revision,
  } = options;

  const handleExportBackup = useCallback(() => {
    const nowIso = new Date().toISOString();
    const exportedKunye = mergeCinemaKunyeDocumentsLossless(
      cinemaKunye,
      extractCinemaKunyeFromItems(savedItems, genresMap)
    );
    const enrichedExportItems = enrichSavedItemsFromCinemaKunye(savedItems, exportedKunye);
    const backup = buildLocalBackupDocument({
      profileId: activeProfileId,
      profileName: profileName,
      items: enrichedExportItems,
      cinemaKunye: exportedKunye,
      preferences: preferences,
      favoriteActors: favoriteActorsRef.current || [],
      isDemo: isDemo,
      nowIso,
      profiles,
      deletedKeys,
      ...(typeof revision === 'number' ? { revision } : {}),
    });
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = buildBackupFileName(nowIso);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [
    cinemaKunye,
    savedItems,
    genresMap,
    activeProfileId,
    profileName,
    preferences,
    favoriteActorsRef,
    isDemo,
    profiles,
    deletedKeys,
    revision,
  ]);

  const handleImportBackupFile = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      setPendingBackup(parseBackupText(text));
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Yedek dosyası okunamadı.');
    }
  }, [setPendingBackup, showToast]);

  const handleConfirmImport = useCallback((mode: 'overwrite' | 'merge') => {
    if (!pendingBackup) return;
    if (mode === 'overwrite') confirmNextBulkSyncRef.current = true;

    const nowIso = new Date().toISOString();
    const backupProfiles: Profile[] = pendingBackup.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      createdAt: profile.createdAt || nowIso,
      preferences: profile.preferences,
      items: profile.items,
      favoriteActors: profile.favoriteActors,
      ...(profile.deleted_keys && Object.keys(profile.deleted_keys).length > 0
        ? { deleted_keys: profile.deleted_keys }
        : {}),
      isDemo: profile.isDemo,
    }));

    const backupDoc = {
      version: 3 as const,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      activeProfileId: pendingBackup.activeProfileId,
      profiles: backupProfiles,
      revision: pendingBackup.revision ?? 0,
      updatedAt: nowIso,
    };

    let nextProfiles: Profile[];
    let nextActiveId: string;

    if (!pendingBackup.containsFullDocument && mode === 'overwrite') {
      // Tek profil yedeği: yalnızca aktif profil değişir, diğer profiller korunur.
      const incoming = backupProfiles[0];
      const currentActive = profiles.find((profile) => profile.id === activeProfileId);
      const targetProfile: Profile = {
        ...(currentActive || {
          id: activeProfileId,
          name: 'Profilim',
          createdAt: nowIso,
          preferences: incoming.preferences,
          items: [],
        }),
        ...incoming,
        id: activeProfileId,
        name: incoming.name || currentActive?.name || 'Profilim',
      };
      nextProfiles = [
        ...profiles.filter((profile) => profile.id !== activeProfileId),
        targetProfile,
      ];
      nextActiveId = activeProfileId;
    } else if (mode === 'overwrite') {
      nextProfiles = backupProfiles;
      nextActiveId = pendingBackup.activeProfileId;
    } else {
      const currentDoc = {
        version: 3 as const,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        engineVersion: ENGINE_VERSION,
        activeProfileId,
        profiles,
        revision: revision ?? 0,
        updatedAt: nowIso,
      };
      const { mergedDoc } = reconcileUserDataDocumentsLossless(backupDoc, currentDoc, {
        authoritativeScalarSide: 'local',
      });
      nextProfiles = mergedDoc.profiles;
      nextActiveId = mergedDoc.activeProfileId;
    }

    const active =
      nextProfiles.find((profile) => profile.id === nextActiveId) ?? nextProfiles[0];
    if (!active) {
      showToast('Yedekte içe aktarılabilecek profil bulunamadı.');
      return;
    }

    const effectiveKunye = mode === 'merge'
      ? mergeIncomingCinemaKunye(pendingBackup.cinemaKunye)
      : replaceCinemaKunye(pendingBackup.cinemaKunye);
    const importedItems = enrichSavedItemsFromCinemaKunye(active.items, effectiveKunye);
    const activeDeleted = normalizeDeletedKeys(active.deleted_keys);

    savedItemsRef.current = importedItems;
    setSavedItems(importedItems);
    lastForYouQueryKeyRef.current = '';
    setForYouItems([]);
    setProfiles(nextProfiles);
    persistProfiles?.(nextProfiles);
    setActiveProfileId(active.id);
    setProfileName(active.name || 'Profilim');
    setPreferences(active.preferences);
    setDeletedKeys(activeDeleted);
    setFavoriteActors(active.favoriteActors || []);
    try {
      localStorage.setItem(
        favActorsStorageKey(active.id),
        JSON.stringify(active.favoriteActors || [])
      );
    } catch {}

    setPendingBackup(null);
    setProfileOpen(false);
    showToast(
      `Yedek başarıyla içe aktarıldı (${nextProfiles.length} profil, ${importedItems.length} içerik)!`
    );
  }, [
    pendingBackup,
    confirmNextBulkSyncRef,
    mergeIncomingCinemaKunye,
    replaceCinemaKunye,
    activeProfileId,
    profiles,
    revision,
    savedItemsRef,
    setSavedItems,
    lastForYouQueryKeyRef,
    setForYouItems,
    setProfiles,
    persistProfiles,
    setActiveProfileId,
    setProfileName,
    setPreferences,
    setDeletedKeys,
    setFavoriteActors,
    setPendingBackup,
    setProfileOpen,
    showToast,
  ]);

  return { handleExportBackup, handleImportBackupFile, handleConfirmImport };
}

