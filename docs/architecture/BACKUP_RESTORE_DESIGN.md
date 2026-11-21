# Yedekleme ve Geri Yükleme Mimarisi — Karar Belgesi (Aşama 1)

> **Kapsam:** Yerel JSON yedek/geri yükleme (`src/app/profile-backup.ts`,
> `src/core/cinetrack-core.ts parseBackupText`, `src/hooks/useProfileBackupCoordinator.ts`)
> ve sunucu snapshot geri yükleme (`src/server/storage.ts restoreBackup`,
> `POST /api/data/restore`).
> **Bulgular:** B-05 (tombstone yok), B-06 (tek profil), B-07 (v4 reddi), B-08 (revizyon).

## 1. Sorun özeti

| # | Mevcut davranış | Sonuç |
|---|---|---|
| B-05 | `LocalBackupDocument` `deleted_keys` taşımıyordu | Sil → yedekle → geri yükle zincirinde içerik eski uzak kopyadan geri diriliyordu |
| B-06 | `parseBackupText` `profiles[]` içinden yalnızca aktif/ilk profili okuyordu | `/api/data` çıktısını yedek sanıp içe aktaran kullanıcı diğer profillerini kaybediyordu |
| B-07 | Sürüm kapısı `[1,2,3]`; ileri sürüm "geçerli yedek değil" diye raporlanıyordu | Yeni sürüm yedeği anlaşılmaz hata ile reddediliyordu |
| B-08 | `POST /api/data/restore` revizyon ön koşulu okumuyordu | Eşzamanlı istemci yazımı restore tarafından sessizce ezilebiliyordu |

## 2. Seçenekler

### Seçenek A — Yedek şemasını v4'e yükselt (SEÇİLDİ)

Yerel yedek belgesi tam belge kapsamı taşır:

- bütün profiller (kimlik, ad, tercihler, kayıtlar, favori oyuncular, `isDemo`),
- aktif profil kimliği,
- profil başına `deleted_keys` (tombstone),
- veri `revision`,
- `schemaVersion` / `engineVersion`,
- dışa aktarma zamanı.

Eski okuyucular için aktif profilin alanları üst düzeyde de yazılır
(`profileId`, `profileName`, `items`, `preferences`, `favoriteActors`,
`cinemaKunye`, `isDemo`).

### Seçenek B — Tam belge içe aktarmayı kısıtla

Mevcut tek profil formatı korunur; `profiles[]` taşıyan belgelerin içe
aktarımı reddedilir.

## 3. Değerlendirme

| Ölçüt | A (v4) | B (kısıtla) |
|---|---|---|
| 1. Veri kaybı riski | Düşük — tüm profiller + tombstone + revizyon taşınır | Orta — kullanıcı `/api/data` çıktısını içe aktaramaz, elle bölmek zorunda |
| 2. Çoklu profil | Tam destek | Yok |
| 3. Tombstone korunumu | Var | Yok (tek profil formatında alan yok) |
| 4. Geriye dönük uyumluluk | v1–v3 okunmaya devam eder; eski okuyucular v4'ün üst düzey alanlarını okuyabilir | Tam (ama işlev kaybı) |
| 5. Mevcut istemci/sunucu davranışı | İstemci yalnızca `parseBackupText` sözleşmesini kullanır; uyumlu | Değişiklik yok |
| 6. Senkronizasyon uyumluluğu | Tam belge `/api/data` ile aynı şekle sahip; reconcile yeniden kullanılır | Kırılır (tam belge reddedilir) |
| 7. Yedek boyutu | Profil sayısıyla doğrusal; üst düzey aktif kopya ~2× aktif profil | Küçük |
| 8. Kullanıcı deneyimi | Tek dosya, tam geri dönüş | Kullanıcı profil profil yedek almak zorunda |
| 9. Geri yükleme güvenliği | Doğrulama + reconcile + tombstone | Doğrulama var, kapsam eksik |
| 10. Gelecekteki şema geçişleri | Açık sürüm kapısı (v5+ reddedilir) | Aynı |

**Karar:** Seçenek A. B, veri kaybı riskini azaltmaz; yalnızca kullanıcıyı
kısıtlar ve mevcut `/api/data` çıktısının içe aktarılmasını engeller.

## 4. v4 şeması (örnek)

```json
{
  "version": 4,
  "schemaVersion": 3,
  "engineVersion": "v3.2.0",
  "activeProfileId": "PROFILE-AAA",
  "profiles": [
    {
      "id": "PROFILE-AAA",
      "name": "Ana Profil",
      "createdAt": "2026-01-01T10:00:00.000Z",
      "preferences": { "disliked": ["movie:99"], "providers": [], "mood": "", "reminders": false, "notified": [] },
      "items": [ { "id": 27205, "media_type": "movie", "status": "completed", "personal_rating": 9 } ],
      "favoriteActors": [],
      "deleted_keys": { "movie:777": "2026-11-21T08:59:00.000Z" },
      "isDemo": false
    },
    { "id": "PROFILE-BBB", "name": "İkinci", "items": [] }
  ],
  "revision": 12,
  "profileId": "PROFILE-AAA",
  "profileName": "Ana Profil",
  "items": [ "…aktif profilin kopyası…" ],
  "cinemaKunye": { "version": 1, "entries": {} },
  "preferences": { "…": "…" },
  "favoriteActors": [],
  "isDemo": false,
  "exportedAt": "2026-11-21T09:00:00.000Z"
}
```

## 5. İçe aktarma politikası

1. **Sürüm kapısı:** `version` sayı olmalı; `1–4` kabul, `v5+` açık hata
   (`daha yeni bir Cinethos sürümüyle (vN)`) ve **hiçbir yazma yapılmaz**.
2. **Tam belge:** `profiles[]` varsa bütün profiller okunur. v4'te `profiles`
   zorunludur.
3. **Tek profil:** `items[]` varsa v1–v3 uyumlu tek profil okunur.
4. **Sessiz düşürme yok:** geçersiz profil kimliği, yinelenen profil kimliği,
   geçersiz kayıt, profil/kayıt limiti aşımı → içe aktarma **durdurulur**.
5. **Birleştirme:** `merge` modunda yedek belgesi mevcut belgeyle
   `reconcileUserDataDocumentsLossless` üzerinden birleştirilir (tombstone
   duyarlı, kayıpsız). `overwrite` modunda tam belge yedeği bütün profilleri
   değiştirir; **tek profil** yedeği yalnızca aktif profili değiştirir, diğer
   profillere dokunmaz (eski davranış korunur).
6. **Aktif profil:** yedekteki `activeProfileId` geçerliyse o, değilse ilk profil.

## 6. Geçiş planı

| Aşama | Değişiklik | Uyumluluk |
|---|---|---|
| 1 | `buildLocalBackupDocument` v4 üretir | Eski istemciler üst düzey alanları okur |
| 2 | `parseBackupText` v1–v4 okur, v5+ reddeder | Eski yedekler aynen çalışır |
| 3 | Koordinatör tam belge birleştirmesi kullanır | Tek profil yedekleri aynı davranır |
| 4 | Sunucu restore revizyon ön koşulu (bkz. §7) | Yeni istemci `If-Match` gönderir; göndermeyen istemci 428 alır |

Veri modeli değişmez: yedek belgesi mevcut `Profile`/`SavedItem` alanlarını
taşır; ek alanlar (`revision`, `activeProfileId`, `deleted_keys`) zaten veri
modelinde vardır.

## 7. Sunucu restore (B-08)

`POST /api/data/restore` artık:

- `If-Match: "rev-N"` veya gövdede `expectedRevision` kabul eder,
- revizyon eşleşmezse **409** (rev>0) / **412** (rev=0) döner ve mevcut veriyi
  korur,
- ön koşul yoksa ve revizyon > 0 ise **428** döner (koşulsuz ezme yok),
- geri yükleme öncesi güvenlik snapshot'ı alır ve yazımı serileştirilmiş
  atomik yol (`persistDocument`) üzerinden yapar.

## 8. Test matrisi

| Senaryo | Test |
|---|---|
| v4 çoklu profil round-trip (yol → yeni ortam → tekrar yedek) | `tests/phase1-backup-roundtrip.test.mjs` |
| v3 `/api/data` çoklu profil içe aktarma | aynı dosya |
| v1/v2/v3 tek profil geriye dönük uyumluluk | aynı dosya + `tests/core.test.mjs` |
| v5+ reddi ve yazmama | aynı dosya |
| Bozuk JSON, eksik alan | aynı dosya |
| Yinelenen profil kimliği / yinelenen kayıt | aynı dosya |
| Boş profil, büyük veri kümesi | aynı dosya |
| Tombstone korunumu | aynı dosya + `tests/phase1-merge-lossless.test.mjs` |
| Restore çakışması (409/412/428), atomiklik | `tests/phase1-restore-conflict.test.mjs` |
| Uçtan uca çoklu cihaz / çoklu profil | `tests/phase1-data-integrity-integration.test.mjs` |

## 9. Bilinen sınırlar

- Tombstone'lar 30 günden eskiyse normalizasyonda düşer
  (`TOMBSTONE_RETENTION_DAYS`). Daha uzun çevrimdışı kalan cihaz eski kaydı geri
  getirebilir; Aşama 1 kapsamı dışında bırakıldı.
- Yedek, `cinemaKunye` belgesini tek bir birleşik belge olarak taşır (profil
  başına ayrı künye veri modelinde yoktur).
- Çok büyük yedekler (profil başına 25.000 kayıt / 25 MiB üstü) fail-safe
  biçimde reddedilir; kısmi içe aktarma yapılmaz.
