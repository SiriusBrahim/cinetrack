/**
 * Aşama 1 — Sır dosyalarının (`.env`) atomik ve güvenli yazımı (B-31).
 *
 * Kurallar:
 * - Aynı dizinde geçici dosya → güvenli izinler → fsync → atomik rename.
 * - Yazma sırasında süreç çökse bile hedef dosya ya eski ya yeni hâlindedir;
 *   yarım içerik görünmez.
 * - POSIX'te izinler `0o600`'dır; mevcut izinler daha kısıtlayıcıysa korunur.
 * - Symlink hedefi sessizce değiştirilmez; symlink algılanırsa yazma reddedilir.
 * - Hata durumunda geçici dosya temizlenir ve mevcut dosya korunur.
 * - Aynı süreç içindeki eşzamanlı yazmalar yol başına sıraya alınır.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

const writeQueues = new Map<string, Promise<unknown>>();

function isPosix(): boolean {
  return process.platform !== 'win32';
}

function desiredMode(targetPath: string): number {
  if (!isPosix()) return 0o600;
  try {
    const stat = fs.lstatSync(targetPath);
    // Mevcut dosya daha kısıtlayıcıysa (ör. 0400) onu koru.
    if (stat.isFile()) return stat.mode & 0o600;
  } catch {
    // Dosya yok: varsayılan güvenli izin.
  }
  return 0o600;
}

async function writeAtomicOnce(targetPath: string, contents: string): Promise<void> {
  const dir = path.dirname(targetPath);

  let existing;
  try {
    existing = await fsp.lstat(targetPath);
  } catch {
    existing = null;
  }
  if (existing && existing.isSymbolicLink()) {
    throw new Error(`${targetPath} bir symlink; güvenlik nedeniyle yazma reddedildi.`);
  }
  if (existing && existing.isDirectory()) {
    throw new Error(`${targetPath} bir dizin; dosya olarak yazılamaz.`);
  }

  await fsp.mkdir(dir, { recursive: true });
  const mode = desiredMode(targetPath);
  const tempPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  );

  let handle: FileHandle | null = null;
  try {
    handle = await fsp.open(tempPath, 'wx', mode);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;

    // Atomik değiştirme (aynı dosya sistemi üzerinde).
    await fsp.rename(tempPath, targetPath);

    if (isPosix()) {
      try {
        await fsp.chmod(targetPath, mode);
      } catch {
        // chmod desteklenmiyorsa izin zaten `open` ile ayarlandı.
      }
      // Dizin metadata'sını senkronize et (best-effort).
      try {
        const dirHandle = await fsp.open(dir, 'r');
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
      } catch {
        // Bazı platformlarda dizin fsync desteklenmez.
      }
    }
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await fsp.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/**
 * `targetPath` dosyasını atomik olarak `contents` ile değiştirir.
 * Aynı yol için eşzamanlı çağrılar sıraya alınır; sıra bozulsa bile dosya
 * bütünlüğü korunur.
 */
export function writeFileAtomicSecure(targetPath: string, contents: string): Promise<void> {
  const key = path.resolve(targetPath);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const run = previous.then(
    () => writeAtomicOnce(targetPath, contents),
    () => writeAtomicOnce(targetPath, contents)
  );
  // Kuyruğu canlı tut ama reddedilen promise'i sızdırma.
  writeQueues.set(
    key,
    run.catch(() => undefined)
  );
  return run;
}
