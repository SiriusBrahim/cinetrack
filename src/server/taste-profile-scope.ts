// ===========================================================================
// Cinethos Taste Engine — Profil Kapsamı (Faz 5 / R2-A1)
//
// Bu modül R2-A1'in üç altyapı parçasını tek sorumluluklu bir yerde toplar:
//   1. Kanonik `profileId` doğrulama/normalizasyon ve `p2-hex` profil dizini
//      kodlaması.
//   2. Profil id eşleme manifesti (`_profile-id-map.json`) okuma/doğrulama/
//      atomik yazma; `entries` ↔ `byDir` birebir tutarlılık denetimi.
//   3. Kapsam bazlı kilit altyapısı: atomik sahiplenme, lease + heartbeat,
//      yalnızca kanıtlanabilir stale devralma ve sahiplik doğrulamalı bırakma.
//
// A2–A5 kapsamı profil store ve servis katmanlarında tamamlanır; burada yalnızca
// kimlik, manifest ve güvenli p1 → p2 partition geçişi yönetilir.
// ===========================================================================

import { createHash, randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeProfileId } from "../core/profile-id.ts";
import { assertSafeDataDir, resolveDefaultDataDir } from "./test-data-guard.ts";
import { writeJsonFileAtomicAsync } from "./atomic-json.ts";

// === Sabitler ===

/** Profil id eşleme manifestinin dosya adı (profil kökü altında). */
export const TASTE_PROFILE_ID_MAP_FILENAME = "_profile-id-map.json";
/** Profil dizini kodlama şeması kimliği. */
export const TASTE_PROFILE_ID_MAP_SCHEME = "p2-hex";
const LEGACY_PROFILE_ID_MAP_SCHEME = "p1-b64url";
/** Desteklenen manifest sürümü. Bilinmeyen sürüm fail-fast reddedilir. */
export const TASTE_PROFILE_ID_MAP_VERSION = 2;
/** Kanonik profil kimliği için üst sınır (trim sonrası). */
export const TASTE_PROFILE_ID_MAX_LENGTH = 128;

/** Legacy/global taste yazım kapsamı (`.taste.lock` geri uyumluluğu). */
export const TASTE_LOCK_DATA_SCOPE = "taste-data";
/** Global mapping-manifest kilidi kapsamı (PR #32 §2.1). */
export const TASTE_PROFILE_ID_MAP_SCOPE = "__profile-id-map__";
/** Shared metadata cache kilidi kapsamı (A2'de kullanılacak; sıra kuralı). */
export const TASTE_SHARED_METADATA_CACHE_SCOPE = "shared-metadata-cache";

export interface TasteLockTimings {
  /** Bekleyen prosesin kilit edinme toplam süresi. */
  acquireTimeoutMs: number;
  /** İlk yeniden deneme beklemesi. */
  backoffInitialMs: number;
  /** Backoff üst sınırı. */
  backoffMaxMs: number;
  /** Kilit lease süresi (expiresAt = heartbeat + lease). */
  leaseDurationMs: number;
  /** Sahip yenileme aralığı (lease/3). */
  heartbeatIntervalMs: number;
}

export const TASTE_LOCK_DEFAULTS: TasteLockTimings = {
  acquireTimeoutMs: 10_000,
  backoffInitialMs: 50,
  backoffMaxMs: 500,
  leaseDurationMs: 30_000,
  heartbeatIntervalMs: 10_000,
};

const TASTE_FILE_NAMES = {
  taxonomy: "cinetrack-taste-taxonomy.json",
  index: "cinetrack-taste-index.json",
  events: "cinetrack-taste-events.json",
  profile: "cinetrack-taste-profile.json",
  manifest: "cinetrack-taste-manifest.json",
  objections: "cinetrack-taste-objections.json",
} as const;

// === Hatalar ===

export type TasteProfileScopeErrorCode =
  | "invalid_profile_id"
  | "invalid_profile_dir"
  | "profile_id_map_corrupt"
  | "profile_id_map_conflict"
  | "profile_path_escape";

export class TasteProfileScopeError extends Error {
  public readonly code: TasteProfileScopeErrorCode;

  constructor(code: TasteProfileScopeErrorCode, message: string) {
    super(message);
    this.name = "TasteProfileScopeError";
    this.code = code;
  }
}

export type TasteLockErrorCode =
  | "taste_lock_timeout"
  | "taste_lock_corrupt"
  | "taste_lock_lost"
  | "taste_lock_invalid_scope";

export class TasteLockError extends Error {
  public readonly code: TasteLockErrorCode;
  public readonly lockPath?: string;

  constructor(code: TasteLockErrorCode, message: string, lockPath?: string) {
    super(message);
    this.name = "TasteLockError";
    this.code = code;
    this.lockPath = lockPath;
  }
}

// === 1. Kanonik profil kimliği ve kodlama ===

/**
 * Kanonik `profileId` doğrulaması (fail-fast).
 *
 * Tek merkezli Latin/ASCII normalizasyonu uygulanır. Türkçe ve Latin aksanları
 * temel harflere dönüştürülür; desteklenmeyen Unicode alfabeleri reddedilir.
 * Geçersiz kimlik sessizce silinmez veya yeniden adlandırılmaz.
 */

export function validateCanonicalProfileId(raw: unknown): string {
  const canonical = normalizeProfileId(raw);
  if (!canonical) {
    throw new TasteProfileScopeError(
      "invalid_profile_id",
      "Profil kimliği geçerli bir Latin profil kimliği olmalıdır; desteklenmeyen Unicode alfabeleri kabul edilmez."
    );
  }
  if (canonical.length > TASTE_PROFILE_ID_MAX_LENGTH) {
    throw new TasteProfileScopeError(
      "invalid_profile_id",
      `Profil kimliği en fazla ${TASTE_PROFILE_ID_MAX_LENGTH} karakter olabilir.`
    );
  }
  return canonical;
}

/** Yeni kanonik kimliği yalnızca küçük harfli hex içeren p2 dizinine çevirir. */
export function encodeProfileIdSafe(rawProfileId: unknown): string {
  const canonical = validateCanonicalProfileId(rawProfileId);
  return `p2-hex-${Buffer.from(canonical, "utf8").toString("hex")}`;
}

function encodeLegacyProfileId(rawProfileId: string): string {
  return `${LEGACY_PROFILE_ID_MAP_SCHEME}-${Buffer.from(rawProfileId, "utf8").toString("base64url")}`;
}

/**
 * Hem eski p1-b64url hem yeni p2-hex dizinlerini çözer.
 * p1 round-trip'i ham eski kimlikle; p2 round-trip'i kanonik kimlikle doğrulanır.
 */
export function decodeProfileIdSafe(dir: unknown): string {
  if (typeof dir !== "string") {
    throw new TasteProfileScopeError("invalid_profile_dir", "Profil dizin adı metin olmalıdır.");
  }

  if (dir.startsWith(`${LEGACY_PROFILE_ID_MAP_SCHEME}-`)) {
    const encoded = dir.slice(LEGACY_PROFILE_ID_MAP_SCHEME.length + 1);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
      throw new TasteProfileScopeError("invalid_profile_dir", "Eski profil dizini geçersiz Base64URL alfabesi içeriyor.");
    }
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (encodeLegacyProfileId(decoded) !== dir) {
      throw new TasteProfileScopeError("invalid_profile_dir", "Eski profil dizini Base64URL round-trip doğrulamasından geçemedi.");
    }
    try {
      return validateCanonicalProfileId(decoded);
    } catch (err) {
      throw new TasteProfileScopeError(
        "invalid_profile_dir",
        `Eski profil dizini kanonik kimliğe çözülemedi: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const match = /^p2-hex-([0-9a-f]+)$/.exec(dir);
  if (!match || match[1]!.length % 2 !== 0) {
    throw new TasteProfileScopeError("invalid_profile_dir", "Profil dizini p2-hex biçiminde değil.");
  }
  const encoded = match[1]!;
  const decoded = Buffer.from(encoded, "hex").toString("utf8");
  let canonical: string;
  try {
    canonical = validateCanonicalProfileId(decoded);
  } catch (err) {
    throw new TasteProfileScopeError(
      "invalid_profile_dir",
      `Profil dizini kanonik kimliğe çözülemedi: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (canonical !== decoded || encodeProfileIdSafe(canonical) !== dir) {
    throw new TasteProfileScopeError("invalid_profile_dir", "Profil dizini kanonik p2-hex round-trip doğrulamasından geçemedi.");
  }
  return canonical;
}

// === 2. Yol çözümleme ===

/** Taste kök dizini (`resolveTastePaths` ile birebir uyumlu). */
export function resolveTasteRoot(dataDir: string = resolveDefaultDataDir()): string {
  const base = dataDir && dataDir.length > 0 ? dataDir : "data";
  return base === "data" ? "data/taste" : path.join(base, "taste");
}

/** Profil partition kökü: `<taste-root>/profiles`. */
export function resolveTasteProfilesRoot(dataDir: string = resolveDefaultDataDir()): string {
  return path.join(resolveTasteRoot(dataDir), "profiles");
}

/** Profil id eşleme manifesti yolu. */
export function resolveTasteProfileIdMapPath(dataDir: string = resolveDefaultDataDir()): string {
  return path.join(resolveTasteProfilesRoot(dataDir), TASTE_PROFILE_ID_MAP_FILENAME);
}

/** Kapsam kilidi dizini (legacy `.taste.lock` bu dizinin dışında kalır). */
export function resolveTasteLockDir(dataDir: string = resolveDefaultDataDir()): string {
  return path.join(resolveTasteRoot(dataDir), ".locks");
}

export interface TasteProfileStorePaths {
  taxonomy: string;
  index: string;
  events: string;
  profile: string;
  manifest: string;
  objections: string;
}

export interface TasteProfileScopePaths {
  profileId: string;
  dir: string;
  root: string;
  paths: TasteProfileStorePaths;
}

function assertInsideTasteRoot(rootDir: string, targetPath: string): void {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new TasteProfileScopeError(
      "profile_path_escape",
      `Profil yolu taste kökünün dışına çıkıyor: ${targetPath}`
    );
  }
}

/**
 * Profil kapsamlı taste yollarını çözer (uyumluluk yüzeyi; A2'de IO'ya bağlanır).
 * Dönen yollar taste kökü içinde kalır; escape fail-fast reddedilir.
 */
export function resolveTastePathsForProfile(
  profileId: unknown,
  dataDir: string = resolveDefaultDataDir()
): TasteProfileScopePaths {
  const canonical = validateCanonicalProfileId(profileId);
  const dir = encodeProfileIdSafe(canonical);
  const profilesRoot = resolveTasteProfilesRoot(dataDir);
  const root = path.join(profilesRoot, dir);
  const paths: TasteProfileStorePaths = {
    taxonomy: path.join(root, TASTE_FILE_NAMES.taxonomy),
    index: path.join(root, TASTE_FILE_NAMES.index),
    events: path.join(root, TASTE_FILE_NAMES.events),
    profile: path.join(root, TASTE_FILE_NAMES.profile),
    manifest: path.join(root, TASTE_FILE_NAMES.manifest),
    objections: path.join(root, TASTE_FILE_NAMES.objections),
  };
  assertInsideTasteRoot(profilesRoot, root);
  for (const filePath of Object.values(paths)) {
    assertInsideTasteRoot(profilesRoot, filePath);
  }
  return { profileId: canonical, dir, root, paths };
}

// === 3. Profil id eşleme manifesti ===

export interface TasteProfileIdMapEntry {
  dir: string;
  createdAt: string;
}

export interface TasteProfileIdMap {
  version: number;
  scheme: string;
  entries: Record<string, TasteProfileIdMapEntry>;
  byDir: Record<string, string>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseIsoTimestamp(value: unknown, field: string): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TasteProfileScopeError(
      "profile_id_map_corrupt",
      `Profil id eşleme manifestinde '${field}' ISO-8601 metin olmalıdır.`
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TasteProfileScopeError(
      "profile_id_map_corrupt",
      `Profil id eşleme manifestinde '${field}' geçerli ISO-8601 değil: ${JSON.stringify(value)}`
    );
  }
  return parsed;
}

/**
 * Manifesti şema + bütünlük açısından doğrular.
 * `entries` ↔ `byDir` birebir eşleşmezse, şema/sürüm uyumsuzsa veya dizin
 * kanonik kimliğe çözülmezse fail-fast hata üretir (otomatik onarım yok).
 */
export function parseTasteProfileIdMap(raw: unknown): TasteProfileIdMap {
  if (!isPlainRecord(raw)) {
    throw new TasteProfileScopeError(
      "profile_id_map_corrupt",
      "Profil id eşleme manifesti JSON nesnesi olmalıdır."
    );
  }
  const legacyManifest = raw.version === 1 && raw.scheme === LEGACY_PROFILE_ID_MAP_SCHEME;
  const currentManifest = raw.version === TASTE_PROFILE_ID_MAP_VERSION && raw.scheme === TASTE_PROFILE_ID_MAP_SCHEME;
  if (!legacyManifest && !currentManifest) {
    throw new TasteProfileScopeError(
      "profile_id_map_corrupt",
      `Desteklenmeyen profil id eşleme manifesti: version=${JSON.stringify(raw.version)}, scheme=${JSON.stringify(raw.scheme)}.`
    );
  }
  const rawEntries = raw.entries;
  const rawByDir = raw.byDir;
  if (!isPlainRecord(rawEntries) || !isPlainRecord(rawByDir)) {
    throw new TasteProfileScopeError(
      "profile_id_map_corrupt",
      "Profil id eşleme manifestinde 'entries' ve 'byDir' nesne olmalıdır."
    );
  }

  const entries: Record<string, TasteProfileIdMapEntry> = {};
  for (const [rawProfileId, entry] of Object.entries(rawEntries)) {
    const profileId = validateCanonicalProfileId(rawProfileId);
    if (entries[profileId]) {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `Birden fazla eski profil kimliği aynı kanonik kimliğe dönüşüyor (${JSON.stringify(rawProfileId)} → ${profileId}).`
      );
    }
    if (!isPlainRecord(entry)) {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `'entries.${profileId}' nesne olmalıdır.`
      );
    }
    let dirProfileId: string;
    try {
      dirProfileId = decodeProfileIdSafe(entry.dir);
    } catch (err) {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `'entries.${profileId}.dir' çözümlenemedi: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    if (dirProfileId !== profileId) {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `'entries.${profileId}.dir' farklı bir kanonik kimliğe çözülüyor (${dirProfileId}).`
      );
    }
    parseIsoTimestamp(entry.createdAt, `entries.${profileId}.createdAt`);
    entries[profileId] = {
      dir: entry.dir as string,
      createdAt: entry.createdAt as string,
    };
  }

  const byDir: Record<string, string> = {};
  for (const [dir, profileId] of Object.entries(rawByDir)) {
    if (typeof profileId !== "string") {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `'byDir.${dir}' kanonik kimlik metni olmalıdır.`
      );
    }
    const canonical = validateCanonicalProfileId(profileId);
    let dirProfileId: string;
    try {
      dirProfileId = decodeProfileIdSafe(dir);
    } catch (err) {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `'byDir' anahtarı çözümlenemedi (${dir}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    if (dirProfileId !== canonical) {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `'byDir.${dir}' ile dizin adının çözümü uyuşmuyor (${dirProfileId}).`
      );
    }
    const entry = entries[canonical];
    if (!entry) {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `'byDir.${dir}' için 'entries' kaydı yok.`
      );
    }
    if (entry.dir !== dir) {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `'byDir.${dir}' ile 'entries.${profileId}.dir' (${entry.dir}) uyuşmuyor.`
      );
    }
    if (byDir[dir] !== undefined) {
      throw new TasteProfileScopeError("profile_id_map_corrupt", `'byDir.${dir}' yinelenen dizin kaydı içeriyor.`);
    }
    byDir[dir] = canonical;
  }

  const entryDirs = Object.values(entries).map((entry) => entry.dir);
  if (entryDirs.length !== Object.keys(byDir).length) {
    throw new TasteProfileScopeError(
      "profile_id_map_corrupt",
      `'entries' (${entryDirs.length}) ve 'byDir' (${Object.keys(byDir).length}) kardinalitesi uyuşmuyor.`
    );
  }
  for (const dir of entryDirs) {
    if (!byDir[dir]) {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `'entries' içindeki '${dir}' için 'byDir' ters kaydı yok.`
      );
    }
  }

  return {
    version: TASTE_PROFILE_ID_MAP_VERSION,
    scheme: TASTE_PROFILE_ID_MAP_SCHEME,
    entries,
    byDir,
  };
}

function createEmptyTasteProfileIdMap(): TasteProfileIdMap {
  return {
    version: TASTE_PROFILE_ID_MAP_VERSION,
    scheme: TASTE_PROFILE_ID_MAP_SCHEME,
    entries: {},
    byDir: {},
  };
}

function sortTasteProfileIdMap(map: TasteProfileIdMap): TasteProfileIdMap {
  const entries: Record<string, TasteProfileIdMapEntry> = {};
  for (const profileId of Object.keys(map.entries).sort()) {
    entries[profileId] = map.entries[profileId]!;
  }
  const byDir: Record<string, string> = {};
  for (const dir of Object.keys(map.byDir).sort()) {
    byDir[dir] = map.byDir[dir]!;
  }
  return { ...map, entries, byDir };
}

export type TasteProfileIdMapReadResult =
  | { status: "missing"; data: null }
  | { status: "ok"; data: TasteProfileIdMap };

/**
 * Manifesti okur. Dosya yoksa `missing` döner; bozuk/uyumsuz içerik fail-fast
 * hata üretir. Hiçbir onarım/yeniden eşleme/yazma yapmaz.
 */
export async function readTasteProfileIdMap(
  dataDir: string = resolveDefaultDataDir()
): Promise<TasteProfileIdMapReadResult> {
  const filePath = resolveTasteProfileIdMapPath(dataDir);
  let text: string;
  try {
    text = await fsPromises.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") {
      return { status: "missing", data: null };
    }
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new TasteProfileScopeError(
      "profile_id_map_corrupt",
      `Profil id eşleme manifesti geçerli JSON değil: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  return { status: "ok", data: parseTasteProfileIdMap(raw) };
}

export interface TasteProfileIdMapLookupResult {
  profileId: string;
  dir: string;
  createdAt: string;
}

/** Kanonik kimliğin manifest kaydını döner (salt okuma, yazma yok). */
export async function readTasteProfileIdMapEntry(
  profileId: unknown,
  dataDir: string = resolveDefaultDataDir()
): Promise<TasteProfileIdMapLookupResult | null> {
  const canonical = validateCanonicalProfileId(profileId);
  const current = await readTasteProfileIdMap(dataDir);
  if (current.status === "missing") return null;
  const entry = current.data.entries[canonical];
  if (!entry) return null;
  return { profileId: canonical, dir: entry.dir, createdAt: entry.createdAt };
}

async function writeTasteProfileIdMapUnlocked(
  map: TasteProfileIdMap,
  dataDir: string
): Promise<void> {
  const filePath = resolveTasteProfileIdMapPath(dataDir);
  const payload = `${JSON.stringify(sortTasteProfileIdMap(map), null, 2)}\n`;
  await writeJsonFileAtomicAsync(filePath, payload, {
    validateParsed: (raw) => {
      try {
        parseTasteProfileIdMap(raw);
        return true;
      } catch {
        return false;
      }
    },
  });
}

/**
 * Manifesti doğrulayıp global manifest kilidi altında atomik yazar.
 * `entries`/`byDir` tutarsızsa yazım hiç başlamaz.
 */
export async function writeTasteProfileIdMap(
  map: TasteProfileIdMap,
  dataDir: string = resolveDefaultDataDir()
): Promise<TasteProfileIdMap> {
  const validated = parseTasteProfileIdMap(map);
  return withScopedTasteLock(
    { dataDir, scope: TASTE_PROFILE_ID_MAP_SCOPE },
    async () => {
      await writeTasteProfileIdMapUnlocked(validated, dataDir);
      return validated;
    }
  );
}


async function directoryExists(directory: string): Promise<boolean> {
  try {
    const stat = await fsPromises.lstat(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") return false;
    throw err;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const bytes = await fsPromises.readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

async function copyDirectoryContents(source: string, target: string): Promise<void> {
  const sourceStat = await fsPromises.lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new TasteProfileScopeError("profile_id_map_conflict", `Eski profil kaynağı güvenli bir dizin değil: ${source}`);
  }
  await fsPromises.mkdir(target, { recursive: false });
  const entries = await fsPromises.readdir(source, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const stat = await fsPromises.lstat(from);
    if (stat.isSymbolicLink()) {
      throw new TasteProfileScopeError("profile_id_map_conflict", `Profil verisi sembolik bağlantı içeriyor; geçiş durduruldu: ${from}`);
    }
    if (stat.isDirectory()) {
      await copyDirectoryContents(from, to);
    } else if (stat.isFile()) {
      await fsPromises.copyFile(from, to);
      if (await hashFile(from) !== await hashFile(to)) {
        throw new TasteProfileScopeError("profile_id_map_conflict", `Profil dosyası kopya doğrulamasından geçemedi: ${entry.name}`);
      }
    } else {
      throw new TasteProfileScopeError("profile_id_map_conflict", `Desteklenmeyen profil dosya türü: ${from}`);
    }
  }
}

async function directoriesHaveSameContents(left: string, right: string): Promise<boolean> {
  if (!(await directoryExists(left)) || !(await directoryExists(right))) return false;
  const leftEntries = await fsPromises.readdir(left, { withFileTypes: true });
  const rightEntries = await fsPromises.readdir(right, { withFileTypes: true });
  const leftNames = leftEntries.map((entry) => entry.name).sort();
  const rightNames = rightEntries.map((entry) => entry.name).sort();
  if (leftNames.length !== rightNames.length || leftNames.some((name, index) => name !== rightNames[index])) return false;
  for (const name of leftNames) {
    const leftPath = path.join(left, name);
    const rightPath = path.join(right, name);
    const leftStat = await fsPromises.lstat(leftPath);
    const rightStat = await fsPromises.lstat(rightPath);
    if (leftStat.isSymbolicLink() || rightStat.isSymbolicLink()) return false;
    if (leftStat.isDirectory() !== rightStat.isDirectory() || leftStat.isFile() !== rightStat.isFile()) return false;
    if (leftStat.isDirectory()) {
      if (!(await directoriesHaveSameContents(leftPath, rightPath))) return false;
    } else if (leftStat.isFile()) {
      if (await hashFile(leftPath) !== await hashFile(rightPath)) return false;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * p1 -> p2 geçişi kopya-doğrula-manifesti-değiştir sırasını izler.
 * Kaynak, hedef kopya ve manifest doğrulanmadan silinmez.
 */
async function migrateLegacyProfileDirectory(
  legacyDir: string,
  currentDir: string,
  dataDir: string
): Promise<void> {
  if (legacyDir === currentDir) return;
  const profilesRoot = resolveTasteProfilesRoot(dataDir);
  const source = path.join(profilesRoot, legacyDir);
  const target = path.join(profilesRoot, currentDir);

  await withScopedTasteLock({ dataDir, scope: `profile:${legacyDir}` }, async () => {
    const sourceExists = await directoryExists(source);
    const targetExists = await directoryExists(target);
    if (!sourceExists) return;

    if (targetExists) {
      if (!(await directoriesHaveSameContents(source, target))) {
        throw new TasteProfileScopeError(
          "profile_id_map_conflict",
          `Eski ve yeni profil dizinleri farklı içerik taşıyor; otomatik birleştirme yapılmadı (${legacyDir} / ${currentDir}).`
        );
      }
      return;
    }

    const staging = path.join(profilesRoot, `.${currentDir}.migration-tmp`);
    await fsPromises.rm(staging, { recursive: true, force: true });
    try {
      await copyDirectoryContents(source, staging);
      if (!(await directoriesHaveSameContents(source, staging))) {
        throw new TasteProfileScopeError("profile_id_map_conflict", "Profil geçiş kopyası bütünlük doğrulamasından geçemedi.");
      }
      await fsPromises.rename(staging, target);
      if (!(await directoriesHaveSameContents(source, target))) {
        throw new TasteProfileScopeError("profile_id_map_conflict", "Yeni profil dizini kaynakla eşleşmiyor; eski veri korundu.");
      }
    } catch (error) {
      await fsPromises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
}

async function findLegacyProfileDirectory(
  canonicalProfileId: string,
  dataDir: string
): Promise<string | null> {
  const profilesRoot = resolveTasteProfilesRoot(dataDir);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsPromises.readdir(profilesRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") return null;
    throw err;
  }
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${LEGACY_PROFILE_ID_MAP_SCHEME}-`)) continue;
    try {
      if (decodeProfileIdSafe(entry.name) === canonicalProfileId) matches.push(entry.name);
    } catch {
      // Geçersiz/yarım kalmış başka bir profil dizini bu profile atanmaz.
    }
  }
  if (matches.length > 1) {
    throw new TasteProfileScopeError(
      "profile_id_map_conflict",
      `Aynı kanonik profile ait birden fazla eski dizin bulundu (${matches.join(", ")}); veri birleştirilmedi.`
    );
  }
  return matches[0] ?? null;
}

export interface EnsureTasteProfileIdMapResult extends TasteProfileIdMapLookupResult {
  /** Bu çağrı yeni kayıt oluşturduysa true. */
  created: boolean;
}

/**
 * Kanonik kimlik için eşleme kaydını garanti eder.
 *
 * Global manifest kilidi altında `oku → doğrula → hesapla → atomik yaz`
 * sırası uygulanır; eşzamanlı ilk erişimde tek yazar/yarışsız oluşturma
 * sağlanır. Çakışma tespit edilirse hiçbir yazma yapılmaz (fail-fast).
 */
export async function ensureTasteProfileIdMapEntry(
  profileId: unknown,
  dataDir: string = resolveDefaultDataDir()
): Promise<EnsureTasteProfileIdMapResult> {
  const canonical = validateCanonicalProfileId(profileId);
  const currentDir = encodeProfileIdSafe(canonical);

  return withScopedTasteLock(
    { dataDir, scope: TASTE_PROFILE_ID_MAP_SCOPE },
    async () => {
      const current = await readTasteProfileIdMap(dataDir);
      const map = current.status === "ok" ? current.data : createEmptyTasteProfileIdMap();
      const existing = map.entries[canonical];
      const legacyDir = existing?.dir.startsWith(`${LEGACY_PROFILE_ID_MAP_SCHEME}-`)
        ? existing.dir
        : existing
          ? null
          : await findLegacyProfileDirectory(canonical, dataDir);

      if (legacyDir) {
        await migrateLegacyProfileDirectory(legacyDir, currentDir, dataDir);
      }

      if (existing && existing.dir === currentDir && map.version === TASTE_PROFILE_ID_MAP_VERSION) {
        return {
          profileId: canonical,
          dir: currentDir,
          createdAt: existing.createdAt,
          created: false,
        };
      }

      const ownerOfDir = map.byDir[currentDir];
      if (ownerOfDir !== undefined && ownerOfDir !== canonical) {
        throw new TasteProfileScopeError(
          "profile_id_map_conflict",
          `'${currentDir}' dizini başka bir kanonik kimliğe kayıtlı (${ownerOfDir}).`
        );
      }

      const createdAt = existing?.createdAt ?? new Date().toISOString();
      const entries = { ...map.entries };
      const byDir = { ...map.byDir };
      if (existing && existing.dir !== currentDir) {
        delete byDir[existing.dir];
      }
      entries[canonical] = { dir: currentDir, createdAt };
      byDir[currentDir] = canonical;

      const next = sortTasteProfileIdMap({
        version: TASTE_PROFILE_ID_MAP_VERSION,
        scheme: TASTE_PROFILE_ID_MAP_SCHEME,
        entries,
        byDir,
      });
      await writeTasteProfileIdMapUnlocked(next, dataDir);

      // Manifest yeni dizini işaret ediyor ve hedefin bütünlüğü doğrulandı.
      // Kaynak ancak bu noktadan sonra kaldırılır; başarısız cleanup güvenlidir.
      if (legacyDir && legacyDir !== currentDir) {
        const profilesRoot = resolveTasteProfilesRoot(dataDir);
        const source = path.join(profilesRoot, legacyDir);
        const target = path.join(profilesRoot, currentDir);
        if (await directoriesHaveSameContents(source, target)) {
          await fsPromises.rm(source, { recursive: true, force: true }).catch(() => undefined);
        }
      }

      return {
        profileId: canonical,
        dir: currentDir,
        createdAt,
        created: !existing,
      };
    }
  );
}

// === 4. Kapsam kilidi (lease + heartbeat) ===

export interface TasteLockRecord {
  lockId: string;
  scope: string;
  pid: number;
  hostname: string;
  createdAt: string;
  expiresAt: string;
  heartbeatAt: string;
  ownerToken: string;
  /** Eski (`pid:ts:uuid`) `.taste.lock` biçiminden okunduysa true — lease yok. */
  legacy?: boolean;
}

/** Eski sürümün `.taste.lock` token biçimi: `pid:timestamp:uuid`. */
const LEGACY_LOCK_TOKEN_PATTERN = /^(\d+):(\d+):([0-9a-fA-F-]{8,64})$/;

export interface TasteScopedLockRequest {
  dataDir?: string;
  scope: string;
  timings?: Partial<TasteLockTimings>;
}

export interface TasteLockHandle {
  readonly record: TasteLockRecord;
  readonly lockPath: string;
  /** Sahiplik heartbeat ile doğrulanamadıysa true (fail-safe sonlandırma). */
  readonly lost: boolean;
  renew(): Promise<void>;
  release(): Promise<void>;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as { code?: string })?.code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function backoffDelay(attempt: number, timings: TasteLockTimings): number {
  const base = Math.min(
    timings.backoffMaxMs,
    Math.round(timings.backoffInitialMs * 2 ** Math.min(attempt, 10))
  );
  const jitter = Math.round(base * 0.25 * Math.random());
  return Math.max(1, base + jitter);
}

function sanitizeScopeForFileName(scope: string): string {
  if (typeof scope !== "string" || scope.trim().length === 0) {
    throw new TasteLockError(
      "taste_lock_invalid_scope",
      "Taste kilidi için kapsam adı zorunludur."
    );
  }
  const readable = scope.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64) || "scope";
  const digest = createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 12);
  return `${readable}-${digest}`;
}

/**
 * Kilit dosyası yolu. Legacy global yazım kapsamı geri uyumluluk için
 * `<taste-root>/.taste.lock` kullanır; diğer kapsamlar ayrı `.locks/` altındadır.
 */
export function resolveTasteLockPath(
  dataDir: string = resolveDefaultDataDir(),
  scope: string = TASTE_LOCK_DATA_SCOPE
): string {
  if (scope === TASTE_LOCK_DATA_SCOPE) {
    return path.join(resolveTasteRoot(dataDir), ".taste.lock");
  }
  return path.join(resolveTasteLockDir(dataDir), `${sanitizeScopeForFileName(scope)}.lock`);
}

function parseTasteLockRecord(raw: unknown, lockPath: string): TasteLockRecord {
  if (!isPlainRecord(raw)) {
    throw new TasteLockError(
      "taste_lock_corrupt",
      `Kilit dosyası bozuk (JSON nesnesi bekleniyordu): ${lockPath}`,
      lockPath
    );
  }
  const record = raw as Partial<TasteLockRecord>;
  const stringFields: Array<keyof TasteLockRecord> = [
    "lockId",
    "scope",
    "hostname",
    "ownerToken",
    "createdAt",
    "expiresAt",
    "heartbeatAt",
  ];
  for (const field of stringFields) {
    const value = record[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TasteLockError(
        "taste_lock_corrupt",
        `Kilit dosyasında '${field}' alanı eksik/geçersiz: ${lockPath}`,
        lockPath
      );
    }
  }
  if (!Number.isInteger(record.pid) || (record.pid as number) <= 0) {
    throw new TasteLockError(
      "taste_lock_corrupt",
      `Kilit dosyasında 'pid' alanı geçersiz: ${lockPath}`,
      lockPath
    );
  }
  for (const field of ["createdAt", "expiresAt", "heartbeatAt"] as const) {
    if (!Number.isFinite(Date.parse(record[field] as string))) {
      throw new TasteLockError(
        "taste_lock_corrupt",
        `Kilit dosyasında '${field}' geçerli ISO-8601 değil: ${lockPath}`,
        lockPath
      );
    }
  }
  return record as TasteLockRecord;
}

/**
 * Eski token biçimini kayda çevirir (yalnızca geri uyumluluk okuması).
 * Bu kayıtta lease/hostname yoktur; bu nedenle yaş bazlı stale kararı
 * **verilmez** — stale yalnızca PID ölüyse kabul edilir.
 */
function parseLegacyLockToken(text: string): TasteLockRecord | null {
  const match = LEGACY_LOCK_TOKEN_PATTERN.exec(text.trim());
  if (!match) return null;
  const pid = Number(match[1]);
  const createdAtMs = Number(match[2]);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(createdAtMs)) {
    return null;
  }
  const createdAt = new Date(createdAtMs).toISOString();
  return {
    lockId: `legacy-${pid}-${createdAtMs}`,
    scope: TASTE_LOCK_DATA_SCOPE,
    pid,
    hostname: os.hostname(),
    createdAt,
    expiresAt: createdAt,
    heartbeatAt: createdAt,
    ownerToken: match[3]!,
    legacy: true,
  };
}

function parseTasteLockContent(text: string, lockPath: string): TasteLockRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const legacy = parseLegacyLockToken(text);
    if (legacy) return legacy;
    throw new TasteLockError(
      "taste_lock_corrupt",
      `Kilit dosyası geçerli JSON/eski token biçiminde değil: ${lockPath}`,
      lockPath
    );
  }
  return parseTasteLockRecord(raw, lockPath);
}

/**
 * Kilit kaydını okur. Yoksa null; bozuksa fail-closed hata (stale sayılmaz,
 * otomatik silme/onarım yok).
 */
export async function readTasteLockState(
  dataDir: string = resolveDefaultDataDir(),
  scope: string = TASTE_LOCK_DATA_SCOPE
): Promise<TasteLockRecord | null> {
  const lockPath = resolveTasteLockPath(dataDir, scope);
  let text: string;
  try {
    text = await fsPromises.readFile(lockPath, "utf8");
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") return null;
    throw err;
  }
  return parseTasteLockContent(text, lockPath);
}

function makeTasteLockRecord(
  scope: string,
  nowMs: number,
  timings: TasteLockTimings
): TasteLockRecord {
  const nowIso = new Date(nowMs).toISOString();
  return {
    lockId: randomUUID(),
    scope,
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: nowIso,
    expiresAt: new Date(nowMs + timings.leaseDurationMs).toISOString(),
    heartbeatAt: nowIso,
    ownerToken: randomUUID(),
  };
}

/** Kilit kaydının sahibi bu süreç mi? */
export function isTasteLockOwnedBy(record: TasteLockRecord | null, owner: {
  lockId: string;
  ownerToken: string;
  scope: string;
}): boolean {
  return (
    !!record &&
    record.lockId === owner.lockId &&
    record.ownerToken === owner.ownerToken &&
    record.scope === owner.scope
  );
}

/**
 * Stale kararı yalnızca kanıtlanabilir koşullarda verilir:
 * lease dolmuş olmalı **ve** sahiplik doğrulanamamalı (aynı host'ta PID ölü;
 * farklı host'ta PID sinyali yok → lease dolumu tek kanıt).
 * Lease dolmadıysa kilit canlıdır ve asla stale sayılmaz.
 */
export function isTasteLockProvablyStale(
  record: TasteLockRecord,
  nowMs: number = Date.now()
): boolean {
  if (record.legacy) {
    // Eski token biçiminde lease yok: yaş asla tek başına stale kanıtı değildir,
    // yalnızca PID'in ölü olduğu kanıtı devralmaya izin verir.
    if (record.pid === process.pid) return true;
    return !isProcessAlive(record.pid);
  }
  const expiresAtMs = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs > nowMs) return false;
  if (record.hostname !== os.hostname()) return true;
  if (record.pid === process.pid) return true;
  return !isProcessAlive(record.pid);
}

async function tryCreateLockFile(
  lockPath: string,
  record: TasteLockRecord
): Promise<boolean> {
  const dir = path.dirname(lockPath);
  await fsPromises.mkdir(dir, { recursive: true });
  const tempPath = `${lockPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const handle = await fsPromises.open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // link() atomik "varsa oluşturma" garantisi verir; içerik tam yazılmış olur.
    await fsPromises.link(tempPath, lockPath);
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code === "EEXIST") return false;
    throw err;
  } finally {
    await fsPromises.unlink(tempPath).catch(() => undefined);
  }
}

async function restoreQuarantinedLock(
  quarantinePath: string,
  lockPath: string
): Promise<void> {
  try {
    await fsPromises.link(quarantinePath, lockPath);
  } catch {
    // Kilit yolu yeniden doldurulduysa taşınan kayıt zaten geçersizdir.
  }
  await fsPromises.unlink(quarantinePath).catch(() => undefined);
}

/**
 * Kanıtlanabilir stale kilidi atomik devralır.
 *
 * Kilit dosyası önce benzersiz bir karantina adına `rename` edilir (atomik,
 * tek kazanan). Taşınan kaydın `lockId`'si doğrulanır: beklediğimiz stale kayıt
 * değilse canlı bir kilit taşınmış olabilir → kayıt geri konur ve devralma
 * yapılmaz. Böylece "stale okuma → koşulsuz unlink" yarışı ortadan kalkar.
 */
async function reclaimProvablyStaleTasteLock(
  lockPath: string,
  expectedLockId: string
): Promise<boolean> {
  const quarantinePath = `${lockPath}.stale.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await fsPromises.rename(lockPath, quarantinePath);
  } catch (err) {
    // Başka bir bekleyen kilidi bizden önce devraldı/aldı: yeniden dene.
    if ((err as { code?: string })?.code === "ENOENT") return true;
    throw err;
  }

  let moved: TasteLockRecord | null;
  try {
    moved = await readTasteLockRecordAt(quarantinePath);
  } catch (err) {
    await restoreQuarantinedLock(quarantinePath, lockPath).catch(() => undefined);
    throw err;
  }

  if (!moved || moved.lockId !== expectedLockId) {
    await restoreQuarantinedLock(quarantinePath, lockPath).catch(() => undefined);
    return false;
  }

  await fsPromises.unlink(quarantinePath).catch(() => undefined);
  return true;
}

async function readTasteLockRecordAt(lockPath: string): Promise<TasteLockRecord | null> {
  let text: string;
  try {
    text = await fsPromises.readFile(lockPath, "utf8");
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") return null;
    throw err;
  }
  return parseTasteLockContent(text, lockPath);
}

function resolveTimings(overrides?: Partial<TasteLockTimings>): TasteLockTimings {
  const merged: TasteLockTimings = { ...TASTE_LOCK_DEFAULTS, ...overrides };
  if (merged.heartbeatIntervalMs > merged.leaseDurationMs) {
    throw new Error("Taste kilidi heartbeat aralığı lease süresini aşamaz.");
  }
  return merged;
}

/**
 * Kapsam kilidini edinir.
 *
 * - Canlı kilit (lease dolmamış) asla çalınmaz; timeout ile teşhis edilebilir
 *   hata döner.
 * - Stale devralma yalnızca `isTasteLockProvablyStale` kanıtıyla ve atomik
 *   karantina + `lockId` doğrulamasıyla yapılır.
 * - Bozuk kilit fail-closed'dur.
 */
export async function acquireTasteLock(
  request: TasteScopedLockRequest
): Promise<TasteLockHandle> {
  const scope = request.scope;
  const dataDir = request.dataDir ?? "data";
  const timings = resolveTimings(request.timings);
  const lockPath = resolveTasteLockPath(dataDir, scope);
  const deadline = Date.now() + timings.acquireTimeoutMs;
  let attempt = 0;

  while (true) {
    const record = makeTasteLockRecord(scope, Date.now(), timings);
    if (await tryCreateLockFile(lockPath, record)) {
      return createTasteLockHandle(lockPath, record, timings);
    }

    // Bozuk kilit fail-closed: hata yukarı taşınır, stale sayılmaz.
    const existing = await readTasteLockRecordAt(lockPath);

    if (existing && isTasteLockProvablyStale(existing)) {
      const reclaimed = await reclaimProvablyStaleTasteLock(lockPath, existing.lockId);
      if (reclaimed) continue;
    }

    if (Date.now() >= deadline) {
      throw new TasteLockError(
        "taste_lock_timeout",
        `Taste kilidi zaman aşımına uğradı (kapsam: ${scope}, dosya: ${lockPath}).` +
          (existing
            ? ` Mevcut sahip pid=${existing.pid}, host=${existing.hostname}, expiresAt=${existing.expiresAt}.`
            : ""),
        lockPath
      );
    }
    await sleep(backoffDelay(attempt, timings));
    attempt += 1;
  }
}

function createTasteLockHandle(
  lockPath: string,
  record: TasteLockRecord,
  timings: TasteLockTimings
): TasteLockHandle {
  let current: TasteLockRecord = record;
  let lost = false;
  let released = false;
  let heartbeat: NodeJS.Timeout | null = null;
  let renewalChain: Promise<void> = Promise.resolve();

  const renewOnce = async (): Promise<void> => {
    if (released) return;
    const onDisk = await readTasteLockRecordAt(lockPath);
    if (
      !onDisk ||
      onDisk.lockId !== current.lockId ||
      onDisk.ownerToken !== current.ownerToken ||
      onDisk.scope !== current.scope
    ) {
      lost = true;
      throw new TasteLockError(
        "taste_lock_lost",
        `Taste kilidi sahipliği kaybedildi (kapsam: ${current.scope}, dosya: ${lockPath}).`,
        lockPath
      );
    }
    const nowMs = Date.now();
    const next: TasteLockRecord = {
      ...current,
      heartbeatAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + timings.leaseDurationMs).toISOString(),
    };
    await writeJsonFileAtomicAsync(lockPath, `${JSON.stringify(next, null, 2)}\n`, {
      validateParsed: (raw) => {
        try {
          parseTasteLockRecord(raw, lockPath);
          return true;
        } catch {
          return false;
        }
      },
    });
    current = next;
  };

  const renew = (): Promise<void> => {
    const next = renewalChain.catch(() => undefined).then(() => renewOnce());
    renewalChain = next.catch(() => undefined);
    return next;
  };

  heartbeat = setInterval(() => {
    void renew().catch(() => undefined);
  }, timings.heartbeatIntervalMs);
  heartbeat.unref?.();

  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    const releasePath = `${lockPath}.release.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    try {
      await fsPromises.rename(lockPath, releasePath);
    } catch (err) {
      // Kilit zaten yok: bırakma tamam.
      if ((err as { code?: string })?.code === "ENOENT") return;
      return;
    }

    let moved: TasteLockRecord | null = null;
    try {
      moved = await readTasteLockRecordAt(releasePath);
    } catch {
      await restoreQuarantinedLock(releasePath, lockPath).catch(() => undefined);
      return;
    }

    if (
      moved &&
      moved.lockId === current.lockId &&
      moved.ownerToken === current.ownerToken &&
      moved.scope === current.scope
    ) {
      await fsPromises.unlink(releasePath).catch(() => undefined);
      return;
    }
    // Sahibimiz olmayan (canlı) bir kayıt taşındı: geri bırak, devretme.
    await restoreQuarantinedLock(releasePath, lockPath).catch(() => undefined);
  };

  return {
    get record() {
      return current;
    },
    lockPath,
    get lost() {
      return lost;
    },
    renew,
    release,
  };
}

// === 5. Süreç içi FIFO + kapsam kilidi sarmalayıcısı ===

const scopedLockChains = new Map<string, Promise<unknown>>();

function enqueueScopedLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = scopedLockChains.get(key) ?? Promise.resolve();
  const run = (): Promise<T> => task();
  const next = previous.then(run, run);
  const settled = next.then(
    () => undefined,
    () => undefined
  );
  scopedLockChains.set(key, settled);
  void settled.finally(() => {
    if (scopedLockChains.get(key) === settled) {
      scopedLockChains.delete(key);
    }
  });
  return next;
}

/**
 * Kapsam kilidi altında görev çalıştırır (süreç içi FIFO + süreçler arası
 * lease/heartbeat'li kilit). Heartbeat sahipliği kaybederse görev sonucu
 * başarı sayılmaz: `taste_lock_lost` fırlatılır (fail-safe).
 */
export async function withScopedTasteLock<T>(
  request: TasteScopedLockRequest,
  task: () => Promise<T>
): Promise<T> {
  // Aşama 1 — test ortamı gerçek `data/` ağacına yazamaz (B-14).
  assertSafeDataDir(request.dataDir ?? "data", "taste-store");
  const key = `${path.resolve(request.dataDir ?? "data")}::${request.scope}`;
  return enqueueScopedLock(key, async () => {
    const handle = await acquireTasteLock(request);
    let taskError: unknown;
    let result: T | undefined;
    let succeeded = false;
    try {
      result = await task();
      succeeded = true;
    } catch (err) {
      taskError = err;
    } finally {
      await handle.release().catch(() => undefined);
    }
    if (handle.lost) {
      throw new TasteLockError(
        "taste_lock_lost",
        `Taste kilidi kritik bölüm sırasında kaybedildi (kapsam: ${request.scope}); sonuç güvenilir değil.`,
        handle.lockPath
      );
    }
    if (!succeeded) throw taskError;
    return result as T;
  });
}
