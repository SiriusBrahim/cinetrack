# Aşama 0 — Test ve Kalite Altyapısı Temel Durumu

> **Taban commit:** `c58ec49aef9e309f5a6e673321db387eaa8a3a75` · **Tarih:** 21 Kasım 2026
> Bu belge test altyapısının **güvenliğini** ve **kapsamını** kaydeder. Hiçbir test dosyası değiştirilmedi.

## 1. Mevcut komutlar (`package.json`)

| Script | Komut | Kapsam |
|---|---|---|
| `lint` | `eslint src server.ts tests --max-warnings 0 && tsc --noEmit && tsc --noEmit -p tsconfig.tests.json` | ESLint + iki ayrı tip kontrolü |
| `test` | `tsx --test <60+ dosya tek tek listelenmiş>` | 42 suite / 608 test |
| `test:taste` | `tsx --test --test-concurrency=1 <28 dosya>` | Taste alt paketi (önceki turda 440 test) |
| `cycles` | `node scripts/check-cycles.mjs` | Bağımlılık döngüsü |
| `build` | `vite build` | Üretim paketi + PWA |
| `test:e2e` | `playwright test` | 5 spec / 15 test |

> **N-02:** `test` script'i dosyaları glob ile değil **elle** listeliyor. Yeni bir `tests/*.test.mjs` eklendiğinde komuta eklenmezse sessizce hiç çalışmaz. `test:taste` de aynı desende.

## 2. Bu turda çalıştırılan komutlar ve sonuçları

| Komut | Çıkış | Sonuç | Süre |
|---|---|---|---|
| `npm ci` | 0 | 577 paket; 4 install-script uyarısı (N-03) | — |
| `npm run lint` | 0 | 0 hata, 0 uyarı | — |
| `npm run cycles` | 0 | 0 döngü | — |
| `npm test` | 0 | **608 test / 42 suite / 608 pass / 0 fail / 0 skip / 0 todo** | 91,37 sn |
| `npm run build` | 0 | index 786,77 kB (gzip 233,54); 2 × `INEFFECTIVE_DYNAMIC_IMPORT` | 1,85 sn |
| `npm audit --omit=dev` | 1 (bulgu var) | 26 moderate, 0 high/critical | — |

### Çalıştırılmayanlar (başarı sayılmadı)

| Komut | Neden |
|---|---|
| `npm run test:taste` | İzolasyon riski (B-14/N-04) ve süre bütçesi; Aşama 1'de izolasyon düzeltmesinden sonra koşulacak |
| `npm run test:e2e` | Playwright sistem bağımlılıkları eksik (önceki turda `libnspr4.so`, root yok). Bu ortamda kurulum yapılmadı |
| Canlı GitHub / TMDB / TVDB | Token ve API anahtarı yok; gerçek kullanıcı verisiyle test yasak |

## 3. Test dosyası envanteri

- **Ana paket:** 60 dosya, `npm test` içinde açıkça listelenmiş.
- **Taste paketi:** 28 dosya, `tests/taste/`.
- **E2E:** `e2e/` altında 5 spec (responsive, WrappedCard, workspace IA vb.).
- **Yardımcı:** `tests/helpers/`, `e2e/mockApi` (Playwright tarafı).

## 4. Veri izolasyonu — kritik bulgu (B-14)

### 4.1 Statik kanıt

`createDataStorage` imzası **tek parametreli**: `createDataStorage(options: StorageOptions)` (`src/server/storage.ts:125`).

| Dosya:satır | Çağrı | Sonuç |
|---|---|---|
| `tests/cinema-kunye-backup-sync.test.mjs:232` | `createDataStorage(dataFile, { persistentStore })` | İkinci argüman yok sayılır → `cwd/data` |
| `tests/cinema-kunye-backup-sync.test.mjs:346` | aynı | aynı |
| `tests/cinema-kunye-backup-sync.test.mjs:507` | aynı | aynı |
| Diğer 13 çağrı (`persistent-store`, `sqlite-primary-store`, `github-bidirectional-sync`, `mia-phase1-contracts`) | `createDataStorage({ dataDir: tmpDir, … })` | Doğru, izole |

### 4.2 Ampirik kanıt

1. Koşu öncesi `data/` altındaki 15 dosyanın sha256 manifesti alındı (`.audit/phase0/data-before.sha256`) ve tar yedeği (`.audit/phase0/data-before.tgz`).
2. `npm test` koşuldu.
3. Koşu sonrası manifest yeniden alındı; `diff` **15 satır**:
   - `data/cinetrack-data.json` içeriği değişti (`c84f89de…`),
   - `data/cinetrack-data.json.bak` ve `data/profile.json` değişti,
   - `data/backups/` altına `…T01-29-57-024Z-rev2`, `…-rev3`, `…-rev4` snapshot'ları **eklendi**.

Bu, "testler gerçek veri dizinine yazıyor" iddiasını **ölçümle** doğrular. Daha kötüsü: snapshot rotasyonu (`maxSnapshots`) nedeniyle koşu, mevcut geri dönüş noktalarından bazılarını silebilir.

### 4.3 Diğer dosya sistemi erişimleri

- Taste testlerinin büyük çoğunluğu `mkdtemp(tmpdir())` kullanıyor (doğru).
- `tests/taste/taste-store.test.mjs:27` modül düzeyinde `join(tmpdir(), 'ct-taste-store-test-…')` üretiyor; `dataDir` verilmeyen çağrılar varsa varsayılan `data/` yoluna düşme riski sürüyor. Aşama 1'de her çağrıya açık `dataDir` verilmeli.
- `tests/phase3-ui-write-paths`, `api-auth-coverage`, `spec-v7-regressions` gibi testler **kaynak dosya okuyup metin arıyor** (B-15); veri yazmıyorlar ama refactor kırılganlığı üretiyorlar.
- GitHub senkron testleri `fetch` mock'u ve geçici dizin kullanıyor; canlı API'ye çıkmıyor.

## 5. Test kapsamı — güçlü ve zayıf yanlar

**Güçlü:** gerçek Express uygulaması (`createCineTrackApp`), gerçek dosya sistemi, 4.800+ assertion, negatif senaryolar (bozuk JSON, 401/403/404, 409 retry, boyut aşımı, public repo guard, film/dizi ayrımı), SQLite birincil kaynak testleri, taste izolasyonu.

**Zayıf / eksik:**

| # | Eksik | İlgili bulgu |
|---|---|---|
| 1 | Merge fonksiyonu için doğrudan alan düzeyi testleri | B-01, B-02 |
| 2 | 20+ profil / 25.000+ kayıt sınır davranışı | B-04 |
| 3 | v4 yedek / ileri sürüm uyumluluğu | B-07 |
| 4 | Çok profilli tam belge yedeği round-trip | B-06 |
| 5 | Yedek → reconcile → silinen içeriğin dirilmemesi | B-05 |
| 6 | Restore sırasında eşzamanlı istemci yazımı | B-08 |
| 7 | 429/sonrası toparlanma | B-30 |
| 8 | 1k/5k/10k puanlama bütçesi | B-03 |
| 9 | `.env` yarım yazımı | B-31 |
| 10 | Erişilebilirlik (axe/kontrast/klavye) | B-27, B-28 |
| 11 | Gerçek sunucu + gerçek dosya sistemiyle mock'suz e2e | — |

## 6. Kalite kapıları

- `npm run lint` iki ayrı `tsc` projesi koşturuyor; `tests/tsconfig.tests.json` testleri de tip kontrolünden geçiriyor — iyi.
- `eslint-plugin-jsx-a11y` yapılandırılmış; ancak gerçek erişilebilirlik taraması yok.
- `scripts/maintenance/architecture-rules.json` + `tests/architecture-boundaries.test.mjs` katman sınırlarını ve **yalnızca küçülebilen** allowlist'i denetliyor (5 `core-purity` ihlali kayıtlı).
- CI: `.github/workflows` altında doğrulama workflow'u var; bu aşamada CI koşusu tetiklenmedi (push sonrası PR üzerinde görülecek).

## 7. Sonraki aşamalarda kurulması gereken test korumaları

1. `CINETRACK_DATA_DIR` test guard'ı: test ortamında gerçek `data/` yoluna yazım **hata** versin.
2. `data/` öncesi/sonrası sha256 karşılaştırması CI adımı.
3. Her teste açık ve benzersiz `dataDir`; paralel koşumda çakışma yok.
4. `npm test` için glob tabanlı çalıştırma veya "listelenmemiş test dosyası" denetimi (N-02).
5. `--test-concurrency` açıkça belirtilsin (N-04).
6. B-01/B-05/B-06/B-08 için regresyon testleri (Aşama 1).
7. Performans bütçesi testleri (Aşama 3) ve erişilebilirlik taraması (Aşama 4).
8. Playwright bağımlılıklarının CI'da kurulması veya engelin açıkça raporlanması (Aşama 10).
