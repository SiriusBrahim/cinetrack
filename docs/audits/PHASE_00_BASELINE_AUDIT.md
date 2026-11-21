# Aşama 0 — Temel Durum Doğrulama ve Denetim

> **Denetim tarihi:** 21 Kasım 2026
> **İncelenen `master` commit:** `c58ec49aef9e309f5a6e673321db387eaa8a3a75`
> **Önceki denetimin commit'i:** `11824de3f283ec9662e6d9a3feea9cbbaf864a4f`
> **Çalışma dalı:** `remediation/full-project-remediation`
> **Kapsam:** Salt okunur inceleme. Uygulama kodu, veri modeli, şema ve kullanıcı verisi değiştirilmedi.
> **Dayanak belge:** [Birleştirilmiş denetim raporu](../../Cinethos_Master_Audit_Consolidated_2026-11-21.md)
> **Plan:** [Geliştirme planı](../DEVELOPMENT_REMEDIATION_PLAN.md)

Bu rapor, önceki denetimdeki 39 bulguyu (B-01…B-39) **doğru kabul etmeden** güncel kod üzerinde tek tek yeniden doğrular. Her bulgu için kanıt, dosya/fonksiyon konumu ve gerçek davranış kaydı verilmiştir. Önceki raporun mekanizma açıklaması ile güncel kodun çeliştiği yerler açıkça işaretlenmiştir.

---

## 1. Başlangıç durumu

| Alan | Değer |
|---|---|
| Varsayılan dal | `master` (korumalı) |
| `master` HEAD | `c58ec49` — *docs: add staged remediation roadmap and clean superseded audit files* |
| Denetim commit'i | `11824de` — *Merge pull request #63 from feat/phase3-data-integrity* |
| Aradaki commit sayısı | 5 (`39cf746`, `b69fef5`, `f87bd9d`, `f689160`, `c58ec49`) |
| Aradaki kod değişikliği | **Yok** — yalnızca doküman (587 + 444 satır) ve `phase-0-findings.md` silmesi |
| Açık PR | **Yok** (GitHub API: `state=open` → 0 sonuç) |
| Mevcut çalışma dalı/PR | Aynı amaçlı dal/PR yok. `chore/remediation-plan-and-repo-cleanup` yalnızca plan dokümanını taşıyor, açık PR'ı bulunmuyor |
| Node / paket yöneticisi | Node 26.13, npm 11.20, `package-lock.json` (npm ci) |
| `engines` | `node >= 22.18.0` |

**Önemli sonuç:** Denetimden bu yana **kaynak kod değişmedi**. Bu nedenle önceki raporun kod konumları büyük ölçüde geçerli; ancak raporun bazı *mekanizma* açıklamaları güncel kodla uyuşmuyor (aşağıda B-01, B-13, B-26, B-34).

### 1.1 Depo ve mimari özeti

- 284 TS/TSX kaynak dosyası (~103.800 satır), 60 ana + 26 taste test dosyası, 5 Playwright spec'i.
- Katmanlar: `core` (saf) → `server` (Express + kalıcılık) → `app` (orkestrasyon) → `components`/`hooks`; `contracts` ve `modules` yan eksen.
- Mimari sınırlar CI'da ölçülüyor (`scripts/maintenance/architecture-rules.json` + `tests/architecture-boundaries.test.mjs`); döngü 0.
- Kalıcılık: atomik JSON yazımı (`.tmp` + `fsync` + `rename`), `.bak` + 7 döner snapshot, `restore-journal`, opsiyonel SQLite birincil kaynak.
- Senkron: GitHub çift yönlü, `runSerialized` + `If-Match`/ETag + yazım sonrası yeniden okuma.

---

## 2. B-01…B-39 durum tablosu

Durum dağılımı: **CONFIRMED 32 · PARTIALLY_FIXED 4 · FIXED 2 · NEEDS_INVESTIGATION 1**.

| ID | P | Başlık (kısa) | Durum |
|---|---|---|---|
| B-01 | P1 | Birleştirmede eylem zamanı kaybı | PARTIALLY_FIXED |
| B-02 | P2 | Merge fonksiyonu için doğrudan test yok | PARTIALLY_FIXED |
| B-03 | P1 | Karesel puanlama maliyeti | CONFIRMED |
| B-04 | P2 | Sessiz kırpma (profil/kayıt) | CONFIRMED |
| B-05 | P1 | Yedekte mezar taşı yok | CONFIRMED |
| B-06 | P1 | Tam belge yedeğinde tek profil | CONFIRMED |
| B-07 | P2 | v4 yedek reddediliyor | CONFIRMED |
| B-08 | P2 | Restore revizyon ön koşulu yok | CONFIRMED |
| B-09 | P2 | `sudden_item_drop` yalnızca toplam sayıya bakıyor | CONFIRMED |
| B-10 | P3 | `rejectIfBusy` kuyruğu görmüyor | CONFIRMED |
| B-11 | P2 | Film/dizi tercih profilleri ortak | CONFIRMED |
| B-12 | P2 | Top-up yolunda filtre atlanıyor | CONFIRMED |
| B-13 | P3 | `serverTaste` açıklamada ağırlıksız görünüyor | PARTIALLY_FIXED |
| B-14 | P1 | Testler gerçek `data/` dizinine yazıyor | CONFIRMED |
| B-15 | P3 | Kaynak metni eşleştiren testler | CONFIRMED |
| B-16 | P2 | Tanrı dosyaları, `any`, kopya yardımcılar | CONFIRMED |
| B-17 | P2 | 5 `core-purity` ihlali | CONFIRMED |
| B-18 | P3 | Kullanılmayan `@respan/respan` | CONFIRMED |
| B-19 | P2 | 26 moderate bağımlılık açığı | CONFIRMED |
| B-20 | P2 | 786,77 kB tek chunk, etkisiz dinamik import | CONFIRMED |
| B-21 | P2 | Her değişimde tam localStorage yazımı + 120 karakter kırpma | CONFIRMED |
| B-22 | P3 | Öneri önbelleği sınırsız | PARTIALLY_FIXED |
| B-23 | P4 | Excel önizleme tüm veri setini döndürüyor | CONFIRMED |
| B-24 | P2 | 1024–1440 sekme şeridi kırpılıyor | CONFIRMED |
| B-25 | P2 | Mobil 218 px yapışkan başlık | CONFIRMED |
| B-26 | P3 | Retry düğmesi geçersiz görevlerde etkin | **FIXED** |
| B-27 | P3 | Rozet/kaydırıcı görsel taşmaları | NEEDS_INVESTIGATION |
| B-28 | P3 | Modal arka planı `inert` değil | CONFIRMED |
| B-29 | P3 | `useKeyboardShortcuts` her render'da yeniden bağlanıyor | CONFIRMED |
| B-30 | P2 | 429'da backoff yok | CONFIRMED |
| B-31 | P2 | PAT `.env`'e atomik olmayan yazım | CONFIRMED |
| B-32 | P3 | Public repo bayrağı ile görünürlük karışıyor | CONFIRMED |
| B-33 | P4 | CSP geniş | CONFIRMED |
| B-34 | P3 | İlişki grafiğinde ham anahtar eşleşmesi | **FIXED** |
| B-35 | P4 | İlişki ağırlıkları sabit | CONFIRMED |
| B-36 | P3 | Restore sonrası tek tık geri alma yok | CONFIRMED |
| B-37 | P3 | `data/exports` retention yok | CONFIRMED |
| B-38 | P3 | Serileştirilmemiş `saveData` dışa açık | CONFIRMED |
| B-39 | P4 | Senkron sayaçları alan düzeyini yansıtmıyor | CONFIRMED |

---

## 3. Bulgu bazında ayrıntılı inceleme

Aşağıdaki her girişte **kanıt** satırı, incelenen güncel kodu ve çalıştırılan ölçümü belirtir. Ölçümler `.audit/phase0-*.mjs` sondalarıyla üretildi ve hiçbir dosyaya yazmadı.

### B-01 — Birleştirmede eylem zamanı (P1) · PARTIALLY_FIXED

- **Konum:** `src/core/user-data-merge.ts:77` `mergeTwoSavedItemsLossless`; zaman çözümleyici `src/core/item-dates.ts`.
- **Güncel kod:** `localTime = ratedAt || completedAt || watchedAt || addedAt || updatedAt`. Yani önceki raporun "`addedAt` önceliği" açıklaması **artık doğru değil**; kod Faz 3 ile yeniden yazılmış ve `personal_rating_cleared` ayrı işaretçisi eklenmiş.
- **Kalan kusur:** `updatedAt` bilinçli olarak `addedAt`'in **altına** alınmış. Kullanıcı yalnızca puanı silerse veya yalnızca durumu geri alırsa (başka etkileşim tarihi üretilmezse) yerel taraf hâlâ "daha eski" görünür.
- **Kanıt (çalıştırıldı, `.audit/phase0-probe.mjs`):**
  - `S1_puan_silme_sadece_updatedAt` → beklenen `rating ''`, gerçek `9`, `cleared=false` → **BAŞARISIZ**
  - `S2_puan_silme_watchedAt_yeni` → geçti
  - `S3_durum_geri_alma_sadece_updatedAt` → beklenen `watchlist`, gerçek `completed` → **BAŞARISIZ**
  - `S4_esit_zaman_farkli_puan` → geçti; `S5_yeni_puan_kazanir` → geçti
- **Etki:** A cihazında puanı silen kullanıcı, B cihazının eski puanını geri alır; `completed → watchlist` geri alması `completed` olarak döner.
- **Çözüm:** Eylem türüne göre zaman çözümleme (`ratingClearedAt`, `statusChangedAt`) veya `updatedAt`'i yalnızca "hiç etkileşim tarihi yok" durumunda değil, **temizleme işaretçisi varsa** öncelikli okumak. Faz 1 / iş 1.2.
- **Test:** Doğrudan `mergeTwoSavedItemsLossless` testleri (S1–S5 aynen regresyon olarak).

### B-02 — Merge testi (P2) · PARTIALLY_FIXED

- **Kanıt:** `grep mergeTwoSavedItemsLossless tests` → 0 doğrudan referans. Ancak `tests/phase3-season-progress.test.mjs:141` `reconcileUserDataDocumentsLossless` üzerinden, `tests/core.test.mjs:328,584` puan temizleme normalizasyonu üzerinden dolaylı kapsama sağlıyor.
- **Kalan:** Fonksiyonun alan düzeyi sözleşmesi (durum, puan, temizleme, eşit/eksik damga) doğrudan test edilmiyor; B-01'in S1/S3 senaryoları bu yüzden yakalanmadı.

### B-03 — Karesel puanlama (P1) · CONFIRMED

- **Konum:** `src/core/loved-similarity.ts:181` `computeLovedSimilarityScore` → her aday için `for (const loved of lovedItems)`.
- **Kanıt (bu turda ölçüldü, `.audit/phase0-perf.mjs`):** 200×200 **59 ms**; 1000×1000 **1.064 ms**; 2000×2000 **4.027 ms**. Adım başına maliyet 295 → 1.064 → 2.014 µs; 10× aday = ~68× süre. Önceki rapordaki 5.000×5.000 (13–29 s) ve 10.000×10.000 (53 s) eğrisiyle tutarlı.
- **Etki:** Ana iş parçacığında donma; keşfet, "Sana Özel", zevk haritası ve ilişki grafiği aynı fonksiyonu çağırır.
- **Çözüm:** Ters indeks (tür/oyuncu/yönetmen/token/yıl/koleksiyon) + `lovedItemFeatures` üst-N sınırı + aday başına token tekrarının kaldırılması. Faz 3.

### B-04 — Sessiz kırpma (P2) · CONFIRMED

- **Konum:** `normalizeDataDocument` (`src/core/cinetrack-core.ts`), limitler `src/core/limits.ts`, `profile-id.ts:39`.
- **Kanıt (ölçüldü):** 22 profil → **20**; 25.010 kayıt → **25.000**; `user-1234` kimlikli profil **tümüyle düşüyor** (`["PROFILE-OK"]` kalıyor).
- **Etki:** Okuma sessiz, sonraki başarılı yazım kırpılmış belgeyi kalıcılaştırır → gerçek veri kaybı.
- **Çözüm:** Limit aşımında reddet/uyar; geçersiz profil kimliğini düşürmek yerine karantinaya al ve kullanıcıya bildir. Faz 1 / 1.3.

### B-05 — Yedekte mezar taşı yok (P1) · CONFIRMED

- **Konum:** `src/app/profile-backup.ts:19-30` `LocalBackupDocument` (alanlar: `items`, `preferences`, `favoriteActors`, `cinemaKunye`, tek `profileId`); `src/hooks/useProfileBackupCoordinator.ts` içe aktarma akışı.
- **Kanıt:** Şemada `deleted_keys` yok; koordinatörde `deleted_keys`/`deletedKeys` yazımı yok (grep 0).
- **Etki:** Sil → yedekle → geri yükle → reconcile zincirinde içerik eski uzak kopyadan geri dirilir.
- **Çözüm:** Faz 1 / 1.4 — yedek şeması v4 (tombstone + tüm profiller + revizyon) veya tam belge içe aktarımının reddi.

### B-06 — Tam belge yedeğinde tek profil (P1) · CONFIRMED

- **Konum:** `src/core/cinetrack-core.ts:685` `parseBackupText`, `profiles[]` dalı.
- **Kanıt:** `backup.profiles.find(p => p.id === activeProfileId) || backup.profiles[0]` — yalnızca tek profil okunur; `activeProfileId`, diğer profiller, `deleted_keys`, `revision` yok sayılır.
- **Etki:** `/api/data` çıktısını yedek sanıp içe aktaran kullanıcı diğer profillerini kaybeder.

### B-07 — v4 yedek reddi (P2) · CONFIRMED

- **Kanıt:** `if (![1, 2, 3].includes(backup.version)) throw 'Bu dosya geçerli bir Cinethos yedeği değil.'` — sürüm bilgisi mesajda yok, ileri sürüm "bozuk" gibi raporlanıyor.

### B-08 — Restore revizyon koruması (P2) · CONFIRMED

- **Konum:** `src/server/app.ts:1988` `POST /api/data/restore`.
- **Kanıt:** Yalnızca `backupId` okunur; `If-Match`/`expectedRevision` yok, 409 akışı yok. Eşzamanlı istemci yazımı restore tarafından ezilir.

### B-09 — Veri kaybı eşiği (P2) · CONFIRMED

- **Konum:** `src/server/storage.ts:517-536`.
- **Kanıt:** `existingItems = countTotalItems(current)`, `incomingItems = countTotalItems(normalized)`; tombstone veya profil kapsamı hesaba katılmaz. 60 sil + 11 ekle senaryosu eşiği atlatır.

### B-10 — Kuyruk durumu (P3) · CONFIRMED

- **Kanıt:** `persistent-store.ts:620 isSyncBusy() → bidirectionalManager.isBusy()`; `app.ts` 5 uçta `rejectIfBusy` yalnızca bu bayrağa bakıyor. Sıraya alınmış bekleyen iş `busy` sayılmıyor; durum modeli `idle/queued/running` ayrımı taşımıyor.

### B-11 — Film/dizi tercih ayrımı (P2) · CONFIRMED

- **Kanıt:** `src/core/taste/profile-aggregator.ts:442 mediaType: "unified"`; ayrım yalnızca `parts.mediaType` ve ağırlığı **0.03** (`cinetrack-core.ts` skor bölümü). Tür/oyuncu/anahtar kelime profilleri ortak.

### B-12 — Top-up filtresi (P2) · CONFIRMED

- **Konum:** `src/modules/recommendations/pipeline.ts:203-222`.
- **Kanıt:** `overflowPool` döngüsünde yalnızca `pickedKeys` kontrolü var; `isCandidateEligibleInPool` ve `filterOutLastRecommendedCandidates` uygulanmıyor. Ana yol korumalı, tamamlama yolu değil.

### B-13 — `serverTaste` sinyali (P3) · PARTIALLY_FIXED

- **Konu:** Önceki rapor "hesaplanıyor ama ağırlığı yok" diyordu.
- **Güncel kod:** `cinetrack-core.ts:3291-3303` — `serverTasteScore` artık `genreScore` içine `0.25 × confidence` ağırlığıyla karışıyor (gerçek katkı var). Ayrıca `context` puanına `moodAffinity` etkisi var (3443-3447).
- **Kalan:** `parts.serverTaste` hâlâ ayrı bir kırılım alanı olarak üretiliyor (3486) fakat `weights` tablosunda karşılığı yok; açıklama katmanı bu alanı bağımsız katkı gibi gösterebilir.
- **Çözüm:** `parts.serverTaste` kaldırılsın veya `weights` içinde tanımlı tek bir sinyal olsun. Faz 3.

### B-14 — Test izolasyonu (P1) · CONFIRMED

- **Konum:** `src/server/storage.ts:125 createDataStorage(options: StorageOptions)`; hatalı çağrılar `tests/cinema-kunye-backup-sync.test.mjs:232,346,507` → `createDataStorage(dataFile, { persistentStore })`.
- **Mekanizma:** İkinci argüman yok sayılır, `options.dataDir` `undefined` → `path.resolve(undefined || cwd/data)` → `process.cwd()/data`.
- **Ampirik kanıt (bu turda):** `npm test` öncesi `data/` için 15 dosyanın sha256 listesi alındı; koşu sonrası `data/cinetrack-data.json`, `.bak`, `profile.json` **değişti** ve `data/backups/` altına `rev2`, `rev3`, `rev4` snapshot'ları **eklendi** (01:29:57). `diff` 15 satır.
- **Ek:** Diğer 13 `createDataStorage` çağrısı doğru imzayı (`{ dataDir: tmpDir }`) kullanıyor; sorun 3 çağrıda lokalize.
- **Etki:** Geliştiricinin gerçek arşivi ezilir, snapshot geçmişi döner, "testler izole" güvencesi çürür.
- **Çözüm:** Üç çağrıyı düzelt + `CINETRACK_DATA_DIR` test guard'ı + CI'da `data/` hash karşılaştırması. Faz 1 / 1.1.

### B-15 — Kaynak metni arayan testler (P3) · CONFIRMED

- **Kanıt:** `readFileSync` 86 kullanım; kaynak metni doğrulayan örnekler: `tests/spec-v7-regressions.test.mjs:467-543`, `tests/phases-all.test.mjs:863-877,1283-1295`, `tests/spec-v2-remaining.test.mjs:246,794-827`, `tests/phase3-ui-write-paths.test.mjs:24,91-182`, `tests/api-auth-coverage.test.mjs:51-75`.
- **Etki:** Refactor'ı engeller, davranışı doğrulamaz; yanlış pozitif/negatif üretir.

### B-16 — Mimari borç (P2) · CONFIRMED

- **Kanıt:** `cinetrack-core.ts` 6.101 · `github-bidirectional-sync.ts` 5.028 · `persistent-store.ts` 4.029 · `app.ts` 2.943 · `App.tsx` 2.372 satır. `any` benzeri kullanım **678**. Kopya güvenlik yardımcıları (`store-types.ts` ↔ `persistent-store-utils.ts`) önceki rapordan bu yana değişmedi.

### B-17 — `core-purity` (P2) · CONFIRMED

- **Kanıt:** `scripts/maintenance/architecture-rules.json` `core-purity` kuralı (`forbidPackages`: react, idb-keyval, exceljs…; `forbidNodeBuiltins: true`) ve `tests/architecture-boundaries.test.mjs:40` "bilinen 5 `core-purity` ihlali" allowlist'i. Test geçiyor → allowlist güncel, yani ihlaller hâlâ mevcut.

### B-18 — `@respan/respan` (P3) · CONFIRMED

- **Kanıt:** Paket yalnızca `src/server/respan-telemetry.ts` içinde (tip importu + `await import('@respan/respan')`); uygulamada hiç model çağrısı yok. 2.5.0 bağımlılığı ve transitive OTel yüzeyi karşılıksız.

### B-19 — Bağımlılık açıkları (P2) · CONFIRMED

- **Kanıt:** `npm audit --omit=dev` → **26 moderate**, 0 high/critical (exceljs→uuid, @respan→@opentelemetry/core).

### B-20 — Bundle (P2) · CONFIRMED

- **Kanıt:** `npm run build` → `dist/assets/index-CXqp80uF.js` **786,77 kB** (gzip 233,54), react-vendor 210,90 kB; 2 × `INEFFECTIVE_DYNAMIC_IMPORT` (`TasteProfileDashboard`, `RelationshipExplorer` hem statik hem dinamik import).

### B-21 — localStorage (P2) · CONFIRMED

- **Konum:** `src/App.tsx:480-512`.
- **Kanıt:** Her efekt çalışmasında `JSON.stringify(savedItems)` yazılıyor; kota hatasında `overview` **120 karaktere** kırpılıp tekrar yazılıyor (sessiz kırpma). Debounce/idle yok.

### B-22 — Öneri önbelleği (P3) · PARTIALLY_FIXED

- **Kanıt:** `RecommendationService.ts:44` sınırsız `Map`; ancak `invalidateProfile(profileId)` (satır 104-110) profil bazlı anahtarları siliyor. Revizyon başına anahtar sınırsız birikmeye devam ediyor; boyut sınırı yok.

### B-23 — Excel önizleme (P4) · CONFIRMED

- **Kanıt:** `app.ts:2767 /api/backup/excel/preview` → `buildProfileBackupDataset` ile tüm veri seti bellekte kurulup tek JSON yanıtı olarak dönüyor; sayfalama yok.

### B-24 — Sekme şeridi (P2) · CONFIRMED

- **Kanıt:** `src/styles/workspace.css:750-760` → `flex-shrink:1; overflow-x:auto; scrollbar-width:none; ::-webkit-scrollbar{display:none}`. Görsel kaydırma ipucu yok. (Genişlik ölçümleri önceki turda: 613 px içerik / 377 px alan @1024, 588 px @1440.)

### B-25 — Mobil yapışkan başlık (P2) · CONFIRMED

- **Kanıt:** `src/styles/components.css:217` `.app-header{position:sticky; top:0}`; mobilde marka + aksiyonlar + arama satırları sarılıyor. Yükseklik bu turda yeniden ölçülmedi; önceki iki bağımsız ölçüm 218 px.

### B-26 — Retry düğmesi (P3) · **FIXED**

- **Kanıt:** `src/modules/operations/OperationsSection.tsx:302` retry bloğu `task.status === 'retry_wait' && task.nextRetryAt` koşuluna bağlanmış; düğme (327-331) yalnızca bu blokta render ediliyor. Geçersiz görevde tıklanabilir "Yeniden dene" kalmamış.

### B-27 — Görsel taşmalar (P3) · NEEDS_INVESTIGATION

- **Gerekçe:** Bu aşamada tarayıcı/ekran görüntüsü koşumu yapılmadı (salt okunur kod incelemesi + ölçüm sondaları). Rozet/poster çakışması ve kaydırıcı son kart kırpılması CSS düzeyinde doğrulanabilir değil; Faz 4'te 6 genişlikte yeniden ölçülmeli.

### B-28 — Modal arka planı (P3) · CONFIRMED

- **Kanıt:** `useDialogAccessibility.ts` odak tuzağı, Escape, odak geri yükleme yapıyor; ancak arka plana `inert`/`aria-hidden` uygulanmıyor (dosyada yalnızca odak filtresinde `hasAttribute('aria-hidden')` var).

### B-29 — Klavye kısayolları (P3) · CONFIRMED

- **Kanıt:** `useKeyboardShortcuts.ts:76` → `}, [handlers]);`. Satır içi nesne verilirse her render'da dinleyici sökülüp yeniden bağlanır.

### B-30 — 429 toparlanması (P2) · CONFIRMED

- **Kanıt:** `src/services/api.ts:224` 429'da doğrudan `throw`; `Retry-After` okunmuyor, backoff/jitter yok, istek eşzamanlılık sınırı yok.

### B-31 — Token dosyası (P2) · CONFIRMED

- **Kanıt:** `src/server/github-token-refresh.ts:123` `writeFileSync(envFilePath, …)`; `.tmp`+`rename`, `fsync`, `0o600` yok. Yarım yazım `.env`'i bozabilir; izinler umask'a bağlı.

### B-32 — Public repo bayrağı (P3) · CONFIRMED

- **Kanıt:** `persistent-store.ts:392 getEffectiveConfiguredIsPublicRepo()` → `isPublicRepo || persistedPublicPersonalConsent === true || allowPublicPersonalSync === true`. Depo görünürlüğü ile kişisel veri paylaşım onayı aynı sonuca katlanıyor.

### B-33 — CSP (P4) · CONFIRMED

- **Kanıt:** `security.ts:66-90` → `connect-src` içinde `ws: wss: https://*.run.app https://*.google.com`; `frame-ancestors` içinde `localhost:*`, `127.0.0.1:*`, `*.googleusercontent.com`.

### B-34 — İlişki grafiği anahtarı (P3) · **FIXED**

- **Kanıt:** `relationship-explorer.ts:248 relationshipNodeKey()` → `makeMediaKey(mediaType, id)` (kanonik). `getStatusVisualSignal` (708+) tercih kümelerini bu kanonik anahtarla karşılaştırıyor; `normalizePreferences` da `disliked`/`hidden` anahtarlarını `makeMediaKey` ile kanonikleştiriyor. Ham anahtar eşleşmesi kalmamış.

### B-35 — İlişki ağırlıkları (P4) · CONFIRMED

- **Kanıt:** İlişki türü katkıları sabit katsayılarla hesaplanıyor; kullanıcıya özel kalibrasyon veya ağırlık konfigürasyonu yok. Tasarım sınırlaması olarak kayıtlı.

### B-36 — Restore geri alma (P3) · CONFIRMED

- **Kanıt:** `app.ts:1988` restore yalnızca snapshot üretip belgeyi döndürüyor; `profile-backup.ts`/`ProfileBackupTab` içinde `undo`/geri alma yolu yok (grep 0).

### B-37 — Export retention (P3) · CONFIRMED

- **Kanıt:** `src/server/excel-profile-backup.ts:355-373` `resolveUniqueExportFileName` çakışmayı önlemek için dosya adı üretiyor; `data/exports` (3264) için yaş/adet/boyut temizliği yok.

### B-38 — Serileştirilmemiş `saveData` (P3) · CONFIRMED

- **Kanıt:** `storage.ts:788` dönen nesnede `saveData` (senkron, 640) ve `saveDataAsync` (656) dışa açık; üretim yolu `saveDataSerialized` (675). Dışa açık senkron yol yalnızca testlerde kullanılıyor.

### B-39 — Senkron sayaçları (P4) · CONFIRMED

- **Kanıt:** `github-bidirectional-sync.ts` içinde `recordsAdded += remoteBeforeInspect.bundle.summary.userUniqueSavedItemsCount` (4548) gibi toplam sayı eklemeleri var; alan düzeyi değişim (puan/durum) sayılmıyor. Rapor "eklenen kayıt" ile "uzak toplam" karışabiliyor.

---

## 4. Yeni bulgular (N-01…N-05)

| ID | P | Başlık | Kanıt | Etki | Çözüm | Aşama |
|---|---|---|---|---|---|---|
| **N-01** | P2 | Plan ile tek-PR talimatı çelişiyor | `docs/DEVELOPMENT_REMEDIATION_PLAN.md` §1.2 "her aşama ayrı dal ve ayrı PR" diyor; yürürlükteki talimat tek uzun ömürlü PR istiyor | İnceleme/geri alma sınırı belirsizleşir, iki kural aynı anda uygulanamaz | Plan §1'i tek PR + aşama commit'i modeline güncelle (bu PR'da yapıldı) | 0 |
| **N-02** | P3 | `npm test` dosya listesi elle yazılmış | `package.json` `test` script'i 60+ dosyayı tek tek sayıyor, glob yok | Yeni test dosyası sessizce hiç çalışmaz; kapsam sanılandan dar kalır | `tests/**/*.test.mjs` glob'una geç veya eksik dosya denetimi ekle | 5 |
| **N-03** | P3 | Kurulumda install-script'ler engelli | `npm ci` → `4 packages have install scripts not yet covered by allowScripts` (esbuild, protobufjs, @openrouter/sdk, @google/genai) | Temiz CI ortamında esbuild postinstall atlanırsa build kırılabilir; yerelde fark edilmez | CI'da `npm ci` sonrası build smoke testi + onaylı allowScripts listesi | 10 |
| **N-04** | P3 | Test eşzamanlılığı açıkça sınırlanmamış | `test` script'inde `--test-concurrency` yok (yalnızca `test:taste` için `=1`) | B-14 ile birleşince paralel suite'ler aynı `data/` üzerinde yarışır | İzolasyon düzeltmesiyle birlikte concurrency'yi açıkça ayarla | 1 |
| **N-05** | P4 | Depo kökünde denetim belgesi birikmesi | Kökte `Cinethos_Master_Audit_Consolidated_2026-11-21.md`, `phase-0-findings.md`, `AUDIT_PLAN.md`; `docs/audits/` altında aynı denetimin 3 türevi | Hangi belgenin otorite olduğu belirsiz; yanlış rapora dayanma riski | Tek otorite belgesi + `docs/audits/README.md` indeksi | 0/5 |

---

## 5. Test ve build sonuçları (bu turda çalıştırıldı)

| Komut | Sonuç | Süre / çıktı |
|---|---|---|
| `npm ci` | ✅ exit 0 | 577 paket kuruldu; 4 install-script uyarısı (N-03) |
| `npm run lint` | ✅ exit 0 | ESLint + 2 × `tsc --noEmit`, 0 hata/uyarı |
| `npm run cycles` | ✅ exit 0 | "Bağımlılık döngüsü bulunmadı" |
| `npm test` | ✅ exit 0 | **608 test / 42 suite / 0 fail / 0 skip**, 91,37 sn |
| `npm run build` | ✅ exit 0 | 1,85 sn; index 786,77 kB (gzip 233,54); 2 × `INEFFECTIVE_DYNAMIC_IMPORT` |
| `npm audit --omit=dev` | ⚠️ 26 moderate | 0 high/critical |
| `npm run test:taste` | ⏸️ **koşulmadı** | Bu aşamada izolasyon riski nedeniyle ertelendi (bkz. TEST_BASELINE) |
| `npm run test:e2e` | ❌ **koşulamadı** | Playwright sistem bağımlılıkları (önceki turda `libnspr4.so` eksik, root yok) |

> Not: `npm test` **bilinçli olarak** yalnızca bu yalıtılmış sandbox'ta koşuldu; öncesinde `data/` dizininin tar yedeği ve sha256 manifesti alındı (`.audit/phase0/data-before.*`). Koşu sonrası fark, B-14'ün kanıtıdır.

---

## 6. Veri güvenliği değerlendirmesi

1. **Kritik:** `npm test` gerçek `data/` dizinini değiştiriyor (B-14, bu turda kanıtlandı). Üretim verisi bulunan bir makinede **koşulmamalı**.
2. Test koşusu `data/backups/` altına yeni snapshot ekledi ve snapshot rotasyonu (maxSnapshots) nedeniyle **eski snapshot'ları silebilir** — yani yalnızca "kirlenme" değil, geri dönüş noktası kaybı riski var.
3. `data/` `.gitignore`'da; bu sandbox'taki içerik önceki denetim koşularının artığıdır, kullanıcı verisi değildir. Yine de yedek alındı.
4. Yedek/geri yükleme zinciri (B-05, B-06, B-07) bugünkü haliyle "tam geri dönüş" garantisi vermiyor.
5. Token yazımı (B-31) ve public repo bayrağı (B-32) veri sızıntısı açısından ikinci derece risk.

---

## 7. Performans başlangıç ölçümleri

| Senaryo | Ölçüm (bu tur) |
|---|---|
| `computeLovedSimilarityScore` 200 aday × 200 sevilen | **59 ms** (295 µs/aday) |
| 1.000 × 1.000 | **1.064 ms** (1.064 µs/aday) |
| 2.000 × 2.000 | **4.027 ms** (2.014 µs/aday) |
| Ana bundle | 786,77 kB (gzip 233,54) |
| Build süresi | 1,85 sn |
| Test suite | 91,37 sn / 608 test |

Ölçüm `tsx`/Node 26 üzerinde, saf fonksiyonla yapıldı. Önceki denetimin 5.000/10.000 ölçümleriyle eğri uyumlu (karesel). Tarayıcı ana iş parçacığında aynı iş yapıldığı için kullanıcı etkisi donma olarak görünür.

---

## 8. Risk değerlendirmesi

| Risk | Olasılık | Etki | Not |
|---|---|---|---|
| Testlerin üretim arşivini ezmesi | Yüksek | Kritik | B-14; tek satırlık imza hatası, 3 çağrı |
| Çok cihazda puan/durum kaybı | Orta | Yüksek | B-01 (S1/S3) |
| Yedek sonrası silinen içeriğin dirilmesi | Orta | Yüksek | B-05/B-06 |
| Büyük arşivde UI donması | Yüksek (5k+) | Orta-Yüksek | B-03 |
| Restore'un eşzamanlı yazımı ezmesi | Düşük | Yüksek | B-08 |
| `.env` bozulması | Düşük | Orta | B-31 |

---

## 9. Aşama 1 için hazır olma

**Hazır.** Aşama 1 kapsamı, bu raporda CONFIRMED/PARTIALLY_FIXED olarak doğrulanan şu işlerle sınırlıdır:

1. B-14 (3 hatalı `createDataStorage` çağrısı + test guard + `data/` hash kontrolü)
2. B-01 + B-02 (eylem zamanı politikası + doğrudan testler; S1/S3 regresyon olarak sabitlenecek)
3. B-05 + B-06 + B-07 (yedek şeması v4 / tam belge içe aktarma kararı)
4. B-04 (sessiz kırpma yerine açık ret/uyarı)
5. B-08 (restore `If-Match` + 409)
6. B-09 (tombstone duyarlı veri kaybı eşiği)
7. B-31 (atomik token yazımı + `0600`)

Aşama 1'e ait olmayan hiçbir kod değişikliği bu PR'da yapılmayacak; her iş kendi commit'i ve regresyon testiyle ilerleyecek.

---

## 10. Aşama 0 kabul kriterleri kontrolü

| Kriter | Durum | Kanıt |
|---|---|---|
| Güncel master commit doğrulandı | ✅ | `c58ec49` |
| Önceki denetim commit'i ile fark incelendi | ✅ | 5 commit, yalnızca doküman |
| B-01–B-39 tamamı yeniden değerlendirildi | ✅ | 39/39 satır, bölüm 3 |
| Her bulgu için kanıt gösterildi | ✅ | dosya/fonksiyon/satır + sonda çıktıları |
| Yeni bulgular araştırıldı | ✅ | N-01…N-05 |
| Test altyapısı incelendi | ✅ | PHASE_00_TEST_BASELINE.md |
| Gerçek kullanıcı verisi riski değerlendirildi | ✅ | Bölüm 6, öncesi/sonrası hash |
| Güvenli testler çalıştırıldı | ✅ | lint, cycles, test, build, audit |
| Build ve lint durumu belirlendi | ✅ | exit 0 / exit 0 |
| Mimari harita oluşturuldu | ✅ | PHASE_00_ARCHITECTURE_MAP.md |
| Performans başlangıç durumu kaydedildi | ✅ | Bölüm 7 |
| Aşama 1 kapsamı güncel bulgularla ilişkilendirildi | ✅ | Bölüm 9 |
| Dört denetim dokümanı oluşturuldu | ✅ | `docs/audits/PHASE_00_*` |
| Geliştirme planı güncellendi | ✅ | `docs/DEVELOPMENT_REMEDIATION_PLAN.md` |
| Hiçbir uygulama kodu değiştirilmedi | ✅ | `git diff --stat` yalnızca doküman |
| Hiçbir kullanıcı verisi değiştirilmedi | ✅ | Yalnızca test koşusunun kendi etkisi; yedek alındı, geri yüklendi |
| `master` dalına commit gönderilmedi | ✅ | Push yalnızca çalışma dalına |
| Tüm değişiklikler aynı PR'da | ✅ | Tek dal/PR |
