# Aşama 0 — Bulgu Matrisi

> **Taban commit:** `c58ec49aef9e309f5a6e673321db387eaa8a3a75` · **Tarih:** 21 Kasım 2026
> Durum kodları: `CONFIRMED` (sorun güncel kodda var) · `PARTIALLY_FIXED` (bir kısmı çözülmüş) · `FIXED` (tamamen çözülmüş) · `NEEDS_INVESTIGATION` (kanıt yetersiz) · `NOT_REPRODUCIBLE` · `OBSOLETE`.

## 1. B-01…B-39

| ID | P | Başlık | Güncel durum | Kanıt (dosya / fonksiyon) | Etkilenen modül | Önerilen çözüm | Aşama | Test gereksinimi |
|---|---|---|---|---|---|---|---|---|
| B-01 | P1 | Birleştirmede eylem zamanı kaybı | PARTIALLY_FIXED | `core/user-data-merge.ts:77` `mergeTwoSavedItemsLossless`; `core/item-dates.ts`; sonda S1/S3 başarısız | core/merge, senkron | Eylem türüne göre zaman çözümleme; temizleme işaretçisi önceliği | 1 | `mergeTwoSavedItemsLossless` doğrudan: puan silme, durum geri alma, eşit/eksik damga |
| B-02 | P2 | Merge için doğrudan test yok | PARTIALLY_FIXED | `grep` tests = 0; dolaylı: `phase3-season-progress.test.mjs:141`, `core.test.mjs:328,584` | tests | Alan düzeyi çatışma fixture'ları | 1 | 6 senaryo × local/remote yönü |
| B-03 | P1 | Karesel puanlama | CONFIRMED | `core/loved-similarity.ts:181`; 200/1000/2000 → 59/1064/4027 ms | core/recommendation | Ters indeks + üst-N + token tekrarını kaldırma | 3 | 1k/5k/10k süre bütçesi; puan regresyon anlık görüntüsü |
| B-04 | P2 | Sessiz kırpma | CONFIRMED | `normalizeDataDocument`; sonda 22→20, 25010→25000, geçersiz profil düşüyor | core/normalize | Sınır aşımında ret/uyarı, karantina | 1 | Sınır-1 / sınır / sınır+1 |
| B-05 | P1 | Yedekte tombstone yok | CONFIRMED | `app/profile-backup.ts:19-30`; koordinatörde `deleted_keys` yok | app/backup | Şema v4: tombstone + tüm profiller + revizyon | 1 | Yedek→restore→reconcile dirilmeme testi |
| B-06 | P1 | Tam belgede tek profil | CONFIRMED | `core/cinetrack-core.ts:685` `parseBackupText` | core/backup | Tüm profilleri içe aktar veya tam belgeyi reddet | 1 | Çok profilli round-trip |
| B-07 | P2 | v4 yedek reddi | CONFIRMED | `parseBackupText` sürüm kapısı `[1,2,3]` | core/backup | Sürüm adı + desteklenen sürümlerle açıklayıcı hata | 1 | v4 ve v99 mesaj testi |
| B-08 | P2 | Restore revizyon koruması yok | CONFIRMED | `server/app.ts:1988` | server/restore | `If-Match` + 409 + istemci revizyonu | 1 | Eşzamanlı yazım senaryosu |
| B-09 | P2 | Veri kaybı eşiği zayıf | CONFIRMED | `server/storage.ts:517-536` | server/storage | Tombstone/profil kapsamlı fark hesabı | 1 | 60 sil + 11 ekle atlatma testi |
| B-10 | P3 | Kuyruk durumu görünmüyor | CONFIRMED | `persistent-store.ts:620`; `app.ts:2135,2172,2215,2252,2394` | server/sync | `idle/queued/running/failed` durum modeli | 2 | Kuyrukta iş varken busy |
| B-11 | P2 | Film/dizi tercih sızması | CONFIRMED | `core/taste/profile-aggregator.ts:442`; ağırlık 0.03 | taste | Paylaşılan/ayrı sinyal sözleşmesi | 3 | Film-only profil TV önerisi almamalı |
| B-12 | P2 | Top-up filtresi atlanıyor | CONFIRMED | `modules/recommendations/pipeline.ts:203-222` | recommendations | Top-up'ta eligibility + lastRecommended | 3 | Tamamlama yolunda gizlenen/izlenen sızması |
| B-13 | P3 | `serverTaste` ağırlıksız görünüyor | PARTIALLY_FIXED | `cinetrack-core.ts:3291-3303` (gerçek katkı), `3486` (parts'ta ayrı) | taste/scoring | `parts` kırılımını tek sinyale indir | 3 | Açıklama toplamı = gerçek ağırlık |
| B-14 | P1 | Testler `data/` dizinine yazıyor | CONFIRMED | `storage.ts:125`; `tests/cinema-kunye-backup-sync.test.mjs:232,346,507`; hash diff 15 satır | tests/server | Doğru imza + `tmpDir` + test guard | 1 | `data/` hash değişmemeli |
| B-15 | P3 | Kaynak metni arayan testler | CONFIRMED | `spec-v7-regressions:467-543`, `phases-all:863-877`, `spec-v2-remaining:246,794-827`, `phase3-ui-write-paths:24,91-182` | tests | Davranışsal testlere dönüştür | 5 | Refactor sonrası testler ayakta |
| B-16 | P2 | Tanrı dosyaları / `any` / kopya | CONFIRMED | 6101/5028/4029/2943/2372 satır; 678 `any` | core, server, app | Modül ayrıştırma, tek kaynak helper, tipler | 5 | Sınır + tip kapıları |
| B-17 | P2 | 5 `core-purity` ihlali | CONFIRMED | `scripts/maintenance/architecture-rules.json`; `tests/architecture-boundaries.test.mjs:40` | core | Port/adaptör sınırı | 5 | Allowlist küçülmeli |
| B-18 | P3 | Kullanılmayan `@respan/respan` | CONFIRMED | `src/server/respan-telemetry.ts:1,59` | server | Kaldır veya gerçek telemetri kararı | 5 | Bağımlılık grafiği |
| B-19 | P2 | 26 moderate açık | CONFIRMED | `npm audit --omit=dev` | deps | Uyumlu güncelleme / gerekçeli kabul | 7 | Audit raporu |
| B-20 | P2 | Bundle 786,77 kB | CONFIRMED | build log; 2 × `INEFFECTIVE_DYNAMIC_IMPORT` | client | Gerçek lazy boundary + vendor stratejisi | 6 | Chunk bütçesi |
| B-21 | P2 | localStorage tam yazım + kırpma | CONFIRMED | `App.tsx:480-512` | app | Debounce/idle; kırpmayı kaldır | 6 | Kota senaryosu |
| B-22 | P3 | Öneri cache sınırsız | PARTIALLY_FIXED | `RecommendationService.ts:44,104` | recommendations | LRU/TTL | 3 | Cache büyüme testi |
| B-23 | P4 | Excel önizleme tüm set | CONFIRMED | `app.ts:2767` | server/excel | Sayfalama/streaming | 6 | Büyük set bellek |
| B-24 | P2 | Sekme şeridi kırpılıyor | CONFIRMED | `styles/workspace.css:750-760` | UI | Taşma menüsü/ipucu | 4 | 1024–1440 tüm sekmeler erişilebilir |
| B-25 | P2 | Mobil 218 px başlık | CONFIRMED | `styles/components.css:217` | UI | Mobil başlığı sadeleştir | 4 | Header yüksekliği ölçümü |
| B-26 | P3 | Retry düğmesi | **FIXED** | `modules/operations/OperationsSection.tsx:302,327` | UI | — (doğrulandı) | 4 | Regresyon: 409 görevde düğme yok |
| B-27 | P3 | Rozet/kaydırıcı taşmaları | NEEDS_INVESTIGATION | Bu aşamada görsel koşum yapılmadı | UI | Faz 4'te ölç | 4 | 6 genişlik ekran görüntüsü |
| B-28 | P3 | Modal arka planı `inert` değil | CONFIRMED | `hooks/useDialogAccessibility.ts` | UI/a11y | `inert` + `aria-hidden` | 4 | Odak/AT testi |
| B-29 | P3 | Klavye handler yeniden bağlama | CONFIRMED | `hooks/useKeyboardShortcuts.ts:76` | UI | Ref/memo stratejisi | 4 | Render sayısı testi |
| B-30 | P2 | 429 backoff yok | CONFIRMED | `services/api.ts:224` | client/api | Retry-After + backoff + eşzamanlılık | 2 | 429 fixture |
| B-31 | P2 | PAT atomik olmayan yazım | CONFIRMED | `server/github-token-refresh.ts:123` | server/security | `.tmp`+`rename`+`fsync`+`0600` | 1 | Yarım yazım testi |
| B-32 | P3 | Public repo bayrağı | CONFIRMED | `persistent-store.ts:392` | server/security | Görünürlük ve onayı ayır | 7 | Bayrak matrisi |
| B-33 | P4 | CSP geniş | CONFIRMED | `server/security.ts:66-90` | server/security | Origin/protokol daraltma | 7 | CSP snapshot testi |
| B-34 | P3 | İlişki anahtarı | **FIXED** | `core/relationship-explorer.ts:248,708+` | core/relationships | — (doğrulandı) | 8 | Kanonik anahtar regresyonu |
| B-35 | P4 | İlişki ağırlıkları sabit | CONFIRMED | `relationship-explorer.ts` ağırlık katsayıları | core/relationships | Açıklanabilir kalibrasyon | 8 | Sabit fixture |
| B-36 | P3 | Restore sonrası geri alma yok | CONFIRMED | `app.ts:1988`; `profile-backup.ts` (undo yok) | app/backup | Snapshot + tek adım geri alma | 9 | Çok profilli geri alma |
| B-37 | P3 | Export retention yok | CONFIRMED | `server/excel-profile-backup.ts:355-373,3264` | server/export | Yaş/adet/boyut retention | 6/9 | Retention testi |
| B-38 | P3 | Serileştirilmemiş `saveData` | CONFIRMED | `storage.ts:640,788` | server/storage | Dışa açık yolu kapat | 2 | Üretim yolu tek kapı |
| B-39 | P4 | Senkron sayaçları yanıltıcı | CONFIRMED | `github-bidirectional-sync.ts:4548` vb. | server/sync | Alan düzeyi sayaç | 2 | Sayaç fixture'ı |

## 2. Yeni bulgular

| ID | P | Başlık | Güncel durum | Kanıt | Etkilenen modül | Önerilen çözüm | Aşama | Test gereksinimi |
|---|---|---|---|---|---|---|---|---|
| N-01 | P2 | Plan ↔ tek-PR talimatı çelişkisi | CONFIRMED | `docs/DEVELOPMENT_REMEDIATION_PLAN.md` §1.2 | süreç | Plan §1'i tek PR modeline güncelle | 0 | — (doküman) |
| N-02 | P3 | `npm test` dosya listesi elle | CONFIRMED | `package.json` `scripts.test` | tests | Glob veya eksik dosya denetimi | 5 | Yeni test dosyası otomatik koşar |
| N-03 | P3 | Install-script'ler engelli | CONFIRMED | `npm ci` uyarısı (4 paket) | build/CI | CI'da smoke build + allowScripts | 10 | Temiz CI koşusu |
| N-04 | P3 | Test concurrency belirsiz | CONFIRMED | `scripts.test` (concurrency yok) | tests | Açık concurrency + izolasyon | 1 | Paralel koşumda `data/` değişmez |
| N-05 | P4 | Kökte denetim belgesi birikmesi | CONFIRMED | Kök + `docs/audits/` üç türev | docs | Tek otorite + indeks | 0/5 | — (doküman) |

## 3. Özet

| Durum | Adet |
|---|---|
| CONFIRMED | 32 |
| PARTIALLY_FIXED | 4 (B-01, B-02, B-13, B-22) |
| FIXED | 2 (B-26, B-34) |
| NEEDS_INVESTIGATION | 1 (B-27) |
| **Toplam** | **39** |
| Yeni bulgu | 5 (N-01…N-05) |

**Öncelik dağılımı (B):** P1 = 5 (B-01, B-03, B-05, B-06, B-14) · P2 = 16 · P3 = 14 · P4 = 4.
**Aşama 1'e düşen doğrulanmış iş:** B-01, B-02, B-04, B-05, B-06, B-07, B-08, B-09, B-14, B-31 (+ N-04).
