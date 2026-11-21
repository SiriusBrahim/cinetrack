# Aşama 0 — Mimari Harita

> **Taban commit:** `c58ec49aef9e309f5a6e673321db387eaa8a3a75` · **Tarih:** 21 Kasım 2026
> Kaynak: güncel kod okuması + `scripts/maintenance/architecture-rules.json` + `npm run cycles` (0 döngü).

## 1. Giriş noktaları

| Giriş | Dosya | Görev |
|---|---|---|
| Tarayıcı | `index.html` → `src/main.tsx` → `src/App.tsx` | İstemci kabuğu, modül kayıt defteri, profil durumu |
| Sunucu | `server.ts` → `src/server/app.ts` (`createCineTrackApp`) | Express uygulaması, statik servis, API |
| CLI / dev | `tsx server.ts --dev` | Vite middleware ile geliştirme |
| Test | `tsx --test` / Playwright | Entegrasyon ve E2E |

## 2. Katmanlar

| Katman | Dizin | Sorumluluk | Sınır kuralı |
|---|---|---|---|
| Çekirdek | `src/core` | Saf iş mantığı: normalize, merge, skorlama, tarih çözümleme, yedek ayrıştırma | React/Express/Node builtin yasak (5 allowlist ihlali) |
| Sözleşmeler | `src/contracts`, `src/core/*-types.ts` | Tip ve arayüz sözleşmeleri | UI'a bağımlı olamaz |
| Sunucu | `src/server` | Express uçları, kalıcılık, GitHub senkronu, güvenlik | İstemci arayüzüne bağımlı olamaz |
| Orkestrasyon | `src/app` | Profil yedeği, senkron koordinasyonu, modül kaydı | Sunucu uçlarını doğrudan kullanmaz |
| Modüller | `src/modules` | library, content, recommendations, operations, taste-map, relationships, finder | Core'u kullanır, UI'a bağımlı olmaz |
| İstemci servisleri | `src/services` | API istemcisi, taste API, export | Sunucu koduna bağımlı olamaz |
| UI | `src/components`, `src/hooks`, `src/styles` | React bileşenleri, hook'lar, CSS | İş mantığını çekirdekten alır |

## 3. Veri akışı

```mermaid
flowchart TD
  UI[React UI<br/>App.tsx + components] -->|kullanıcı eylemi| HOOKS[hooks / modules]
  HOOKS -->|saf işlem| CORE[src/core<br/>normalize · merge · scoring]
  HOOKS -->|HTTP| API[src/services/api-client]
  API -->|/api/*| SRV[src/server/app.ts]
  SRV -->|okuma/yazma| STORE[storage.ts<br/>JSON + SQLite + snapshot]
  SRV -->|senkron| GH[github-bidirectional-sync.ts]
  GH -->|REST| GITHUB[(GitHub repo)]
  SRV -->|proxy| TMDB[(TMDB / TVDB)]
  STORE -->|atomik yazım| DISK[(data/cinetrack-data.json<br/>data/backups/*)]
  CORE -->|tip| TYPES[contracts / types]
  UI -.->|localStorage aynası| LS[(localStorage)]
```

### 3.1 Yazma yolu (tek serileştirilmiş hat)

```mermaid
sequenceDiagram
  participant C as İstemci
  participant A as app.ts (/api/data)
  participant S as storage.ts
  participant D as disk
  C->>A: PUT /api/data (If-Match: rev-N)
  A->>S: saveDataSerialized(payload, {expectedRevision})
  S->>S: normalizeDataDocument (limitler, profil kimliği)
  S->>S: revizyon kontrolü + sudden_item_drop eşiği
  S->>S: snapshot (backups/) + .tmp yazımı
  S->>D: fsync + rename
  S-->>A: yeni belge (rev N+1)
  A-->>C: 200 + ETag
```

### 3.2 Senkron yolu

```mermaid
flowchart LR
  LOCAL[(yerel belge)] --> INSPECT[inspect]
  REMOTE[(GitHub dosyaları)] --> INSPECT
  INSPECT --> COMPARE[compareSyncSides<br/>raw + semantik hash]
  COMPARE -->|fark yok| DONE[no-op]
  COMPARE -->|fark var| MERGE[reconcileUserDataDocumentsLossless]
  MERGE --> PUSH[push: dosya başına commit + SHA doğrulama]
  MERGE --> PULL[pull: snapshot + atomik yazım]
  PUSH --> VERIFY[verifiedEqual / yeniden okuma]
  PULL --> VERIFY
```

## 4. Modül haritası

| Modül | Ana dosyalar | Not |
|---|---|---|
| Kütüphane | `modules/library/service.ts`, `operations.ts` | Saf kurallar ↔ I/O ayrımı doğru |
| İçerik | `modules/content/*`, `services/api-client.ts` | TMDB vekili, LRU + in-flight tekilleştirme |
| Öneri | `modules/recommendations/pipeline.ts`, `RecommendationService.ts`, `core/loved-similarity.ts` | Karesel benzerlik darboğazı (B-03) |
| Taste | `core/taste/*` | Deterministik, `now` enjekte edilebilir, 15 sinyal |
| İşlemler | `modules/operations/*` | Görev durumu, retry (B-26 düzeltildi) |
| Zevk Haritası | `modules/taste-map/*`, `core/relationship-explorer.ts` | 90 düğüm / 160 kenar sınırı |
| Keşfet | `modules/discover/state.ts` | Durum sınırı testle korunuyor |
| Yedek | `core/excel/*`, `server/excel-profile-backup.ts`, `app/profile-backup.ts` | Yedek şeması eksik (B-05/B-06) |

## 5. Kritik bağımlılıklar ve riskler

1. **`cinetrack-core.ts` (6.101 satır)** normalize, merge, skorlama, yedek ayrıştırma ve tip tanımlarını birlikte taşıyor. Çekirdeğin en çok çağrılan modülü olması nedeniyle her değişiklik geniş yüzey etkiliyor.
2. **`github-bidirectional-sync.ts` (5.028 satır)** envanter/pull/push/reconcile/verify bloklarını tek dosyada tutuyor; B-10 ve B-39 burada.
3. **`App.tsx` (2.372 satır, 31 `useState`)** profil senkronu, payload üretimi, localStorage aynası ve çakışma kararlarını taşıyor (B-21).
4. **Kopya güvenlik yardımcıları:** `store-types.ts` ↔ `persistent-store-utils.ts` (`redactSecrets`, `stringifyDeterministic`, `hashContent`) — güvenlik kritik fonksiyonun iki kopyası.
5. **`core-purity` ihlalleri (5):** `cinetrack-core.ts` → `idb-keyval`, `services/api-client`; `actor-recommendations.ts` → `api-client`; `relationship-explorer.ts` → `encoding-service`; `taste/migration.ts` → `crypto`. Node'da yalnızca koşullu yükleme sayesinde çalışıyor.

## 6. Test altyapısı (mimari konumu)

```mermaid
flowchart LR
  T[tests/*.test.mjs] -->|doğrudan import| CORE
  T -->|createCineTrackApp| SRV
  T -->|fetch mock| GH
  T -->|mkdtemp| TMP[(geçici dizin)]
  T -.->|3 hatalı çağrı| REAL[(cwd/data — B-14)]
  E[e2e/*.spec.ts] -->|Playwright| BROWSER[tarayıcı]
```

## 7. Olumlu mimari tespitler (korunmalı)

- `architecture-boundaries` testi + yalnızca küçülebilen allowlist.
- `runSerialized` / `FileWriteSerializer` ile yazma serileştirme.
- Atomik yazım + `.bak` + 7 snapshot + `restore-journal` + SHA-256.
- `pickContentFields` allowlist'i ile kullanıcı verisinin ortak kataloğa sızmaması.
- Öneri/taste çekirdeğinin React'ten bağımsız, deterministik ve `now` enjekte edilebilir olması.
- 0 bağımlılık döngüsü.
