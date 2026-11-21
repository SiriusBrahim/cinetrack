/**
 * Aşama 1 — Test veri yolu koruması (B-14, N-04).
 *
 * Amaç: test süreci gerçek kullanıcı veri dizinine (`<repo>/data`) yazamaz.
 * Koruma test yazarının iyi niyetine bırakılmaz; dosya sistemine yazan tüm
 * giriş noktaları (`createDataStorage`, taste store) bu modülden geçer.
 *
 * Kurallar:
 * 1. Test ortamında `dataDir` açıkça verilmek zorundadır (sessiz `cwd/data`
 *    varsayılanı yasaktır).
 * 2. Test ortamında çözümlenen yol gerçek `data/` ağacının içinde olamaz.
 * 3. Üretim/CLI çalışmasında bu modül hiçbir şeyi engellemez.
 */

import path from 'node:path';

/** Node test runner alt süreçlerinde ve açıkça işaretlenmiş koşularda true. */
export function isTestEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CINETRACK_TEST_MODE === '1') return true;
  if (env.NODE_ENV === 'test') return true;
  // `node --test` her test dosyasını ayrı alt süreçte çalıştırır ve bu değişkeni set eder.
  if (typeof env.NODE_TEST_CONTEXT === 'string' && env.NODE_TEST_CONTEXT.length > 0) return true;
  return false;
}

/** Test ortamında kullanılacak veri kökü: açık env değeri ya da `data`. */
export function resolveDefaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const envDir = (env.CINETRACK_DATA_DIR || '').trim();
  return envDir || 'data';
}

/** Gerçek kullanıcı veri dizini (repo kökü altındaki `data/`). */
export function realUserDataDir(cwd: string = process.cwd()): string {
  return path.resolve(cwd, 'data');
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

export type DataDirGuardKind = 'data-storage' | 'taste-store';

/**
 * Test ortamında veri dizini politikasını zorunlu kılar.
 * Üretimde no-op'tur; testte ihlalde açık hata fırlatır.
 */
export function assertSafeDataDir(
  dataDir: string | undefined | null,
  kind: DataDirGuardKind
): void {
  if (!isTestEnvironment()) return;

  const raw = typeof dataDir === 'string' ? dataDir.trim() : '';
  if (!raw) {
    throw new Error(
      `[test-guard] ${kind}: test ortamında 'dataDir' zorunludur. ` +
        `Geçici bir dizin verin (ör. fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-'))).`
    );
  }

  const resolved = path.resolve(raw);
  const userDataDir = realUserDataDir();
  if (isInside(userDataDir, resolved)) {
    throw new Error(
      `[test-guard] ${kind}: gerçek kullanıcı veri dizinine (${userDataDir}) test sırasında yazılamaz. ` +
        `Çözümlenen yol: ${resolved}. Geçici bir dizin kullanın.`
    );
  }
}

/** Test yardımcıları için: verilen yol gerçek veri ağacında mı? */
export function isRealUserDataPath(target: string, cwd: string = process.cwd()): boolean {
  return isInside(realUserDataDir(cwd), path.resolve(target));
}
