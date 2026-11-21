# Cinethos — Teknik Borç Giderme ve Kalite İyileştirme Yol Haritası

> **Durum:** Uygulama planı / PR üzerinden kontrollü yürütme  
> **Plan tarihi:** 21 Kasım 2026  
> **Hedef dal:** `master`  
> **Başlangıç commit'i:** `c58ec49aef9e309f5a6e673321db387eaa8a3a75` (Aşama 0'ın doğruladığı `master` ucu)
> **Çalışma dalı / PR:** `remediation/full-project-remediation` — tek uzun ömürlü PR
> **Dayanak:** [Birleştirilmiş teknik denetim](../Cinethos_Master_Audit_Consolidated_2026-11-21.md) · [Aşama 0 denetimi](audits/PHASE_00_BASELINE_AUDIT.md)  
> **Kapsam:** Denetimdeki B-01…B-39 bulgularının tamamı ve uygulama sırasında doğrulanacak ek kalite kapıları.

Bu belge, bulguları tek seferde büyük bir değişiklik olarak uygulamak yerine **aşama aşama, incelenebilir ve geri alınabilir commit'lere** böler. Yürürlükteki çalışma modeli **tek uzun ömürlü dal + tek PR**'dır: `remediation/full-project-remediation` dalı ve *chore: complete project remediation and quality improvements* PR'ı Aşama 0–10'un tamamını taşır. Her aşama aynı PR'a ayrı commit (veya küçük commit grubu) olarak eklenir; PR açıklamasındaki ilerleme tablosu aşama tamamlandıkça güncellenir. Yeni PR açılmaz, `master`'a doğrudan commit gönderilmez ve kullanıcı açıkça onaylamadan merge yapılmaz. (Bu model, planın ilk sürümündeki "her aşama ayrı PR" kuralının yerini alır — bkz. N-01.)

## 1. Çalışma ve birleştirme kuralları

1. `master` doğrudan değiştirilmez. Tüm çalışma `remediation/full-project-remediation` dalında yürür ve `master` yalnızca kararlı başlangıç noktasıdır.
2. Tek PR kullanılır; her aşama ayrı commit olarak eklenir. Bir aşamanın commit'leri, o aşamanın kabul kriterleri ve testleri tamamlanmadan bir sonraki aşamaya geçilmez. Aşama sınırları commit mesajlarında ve PR ilerleme tablosunda görünür kalır.
3. PR açıklamasında ilgili bulgu ID'leri, değişen davranış, veri geçişi etkisi, test kanıtı, riskler ve geri alma yöntemi yazılır.
4. PR, testler ve kabul kriterleri tamamlanmadan merge edilmez. Veri bütünlüğü aşamasında özellikle canlı kullanıcı verisi üzerinde test yapılmaz.
5. Mevcut dosya/fonksiyon adları ve mimari önce koddan doğrulanır. Denetimde geçen veya örnek olarak önerilen adlar mevcut değilse yeni API/katman uydurulmaz; gerçek kod yapısına uyarlanır.
6. `package.json` içindeki gerçek script'ler esas alınır. Bu tabanda doğrulanan komutlar: `npm run lint`, `npm run build`, `npm test`, `npm run test:taste`, `npm run cycles`, `npm run test:e2e`. Script listesinde olmayan komutlar varmış gibi çalıştırılmaz.
7. Her PR sonunda bulgu durumu `Açık / Kısmen giderildi / Giderildi / Yeniden değerlendirme gerekli` olarak güncellenir. Bir bulgunun kapatılması yalnızca kod değişikliğiyle değil, regresyon testiyle kanıtlanır.
8. Veri modeli, yedek biçimi, senkronizasyon veya kimlik doğrulama değişikliklerinde geriye dönük uyumluluk ve migration planı zorunludur.
9. Bir PR yalnızca kendi kapsamındaki testleri değil, ilgili regresyon paketini de çalıştırır. Tam doğrulama aşamasında tüm kalite kapıları birlikte çalıştırılır.
10. PR birleştirme stratejisi (squash/merge commit) proje geçmişiyle uyumlu seçilir; force-push ile `master` geçmişi değiştirilmez.

### Dal ve commit düzeni (yürürlükteki model)

Tek dal: `remediation/full-project-remediation`. Aşamalar commit ön ekiyle ayrılır:

- `fix(phase-01): …` — veri güvenliği ve bütünlüğü
- `fix(phase-02): …` — senkronizasyon güvenilirliği
- `perf(phase-03): …` — öneri motoru
- `fix(phase-04): …` — UI/UX ve erişilebilirlik
- `refactor(phase-05): …` — mimari ve kod kalitesi
- `perf(phase-06): …` — istemci performansı
- `security(phase-07): …` — güvenlik ve gizlilik
- `feat(phase-08): …` — Zevk Haritası
- `fix(phase-09): …` — yedek/kurtarma deneyimi
- `test(phase-10): …` — sürüm doğrulaması

## 2. Aşama 0 — Başlangıç doğrulaması ve güvenli çalışma zemini

**Durum:** ✅ **Tamamlandı — 21 Kasım 2026** (taban: `c58ec49`).  
**Tür:** Salt okunur inceleme; uygulama kodu değiştirilmedi.  
**Amaç:** Eski denetim ile güncel `master` arasındaki farkı ve uygulama öncesi gerçek durumu sabitlemek.

**Çıktılar:** [PHASE_00_BASELINE_AUDIT.md](audits/PHASE_00_BASELINE_AUDIT.md) · [PHASE_00_FINDING_MATRIX.md](audits/PHASE_00_FINDING_MATRIX.md) · [PHASE_00_TEST_BASELINE.md](audits/PHASE_00_TEST_BASELINE.md) · [PHASE_00_ARCHITECTURE_MAP.md](audits/PHASE_00_ARCHITECTURE_MAP.md)

**Sonuç özeti:** Denetimden bu yana yalnızca doküman değişti. 39 bulgunun 32'si CONFIRMED, 4'ü PARTIALLY_FIXED, 2'si FIXED (B-26, B-34), 1'i NEEDS_INVESTIGATION (B-27). 5 yeni bulgu (N-01…N-05) kaydedildi. `npm test` 608/608 geçti; ancak test koşusunun gerçek `data/` dizinini değiştirdiği hash karşılaştırmasıyla kanıtlandı (B-14).

### Yapılacak işler

1. PR dalının açıldığı anda `master` HEAD SHA'sini kaydet.
2. Denetim raporunun incelediği commit (`11824de3…`) ile güncel HEAD arasındaki commit ve dosya farklarını çıkar.
3. B-01…B-39 bulgularının her birini güncel kaynakta yeniden konumlandır:
   - Dosya ve fonksiyon hâlâ mevcut mu?
   - Satır numarası değişmiş mi?
   - Sorun zaten kısmen/tamamen çözülmüş mü?
   - Denetimden sonra yeni regresyon oluşmuş mu?
4. `package.json`, `tsconfig`, Vite, ESLint, Playwright ve CI yapılandırmalarını incele; gerçek script ve kalite kapılarını listele.
5. Mevcut testlerin hangi dosyalara yazdığını ve gerçek `data/` dizinine dokunma riskini salt okunur yöntemle belirle. Bu aşamada `npm test` ancak güvenli ve izole ortamda çalıştırılabiliyorsa çalıştırılır.
6. Mevcut build çıktısı, ana chunk boyutu, test süreleri, bağımlılık döngüsü ve performans ölçümleri için başlangıç değerlerini kaydet.
7. Canlı GitHub/TMDB/TVDB bağlantısı gerektiren testlerle çevrimdışı testleri ayır.
8. Her bulgu için `başlangıç durumu + kanıt + hedef + test yöntemi + bağımlılık` kaydı oluştur.

### Kabul kriterleri

- Güncel HEAD SHA ve denetim commit'i arasındaki fark raporlanmış olmalı.
- 39 bulgunun her biri güncel kodda yeniden doğrulanmış veya neden artık geçerli olmadığı kanıtlanmış olmalı.
- Çalıştırılacak komutlar mevcut `package.json` ile eşleşmeli.
- Hiçbir kullanıcı verisi, yedek, ortam değişkeni veya uygulama kodu değiştirilmemeli.
- Aşama 1 için açık bir değişiklik listesi ve risk kaydı hazırlanmalı.

**Çıktılar:** Güncel durum matrisi, test/performans başlangıç ölçümleri, aşama 1 kapsamı.

## 3. Aşama 1 — Veri güvenliği, test izolasyonu ve kayıpsız veri modeli

> **Durum: TAMAMLANDI (21 Kasım 2026).** Tüm maddeler ve kabul kriterleri
> karşılandı; kanıt ve sonuçlar §17'de, ayrıntılar
> [PHASE_01_DATA_INTEGRITY.md](audits/PHASE_01_DATA_INTEGRITY.md) ve
> [PHASE_01_DATA_INTEGRITY_TESTS.md](audits/PHASE_01_DATA_INTEGRITY_TESTS.md)
> belgelerinde.

**Öncelik:** P1 / Kritik  
**Amaç:** Testlerin gerçek kullanıcı verisine dokunmasını önlemek; birleştirme, yedek ve geri yükleme akışlarında sessiz veri kaybını ortadan kaldırmak.

### 1.1 Testlerin gerçek veri dizininden ayrılması — B-14

- `createDataStorage` çağrılarını gerçek imzaya göre düzelt; testlerde geçici dizin (`tmpDir`) kullan.
- Taste store/event/profile testlerinin her birine açık ve benzersiz geçici veri dizini ver.
- Test ortamında varsayılan gerçek `data/` dizinine yazmayı reddeden koruma ekle.
- Test başlangıcında ve sonunda gerçek veri dizininin dosya listesi/hash'i karşılaştırılsın; beklenmeyen değişiklik test hatası olsun.
- Testler paralel çalıştığında aynı geçici dosya/dizini paylaşmasın.
- Başarısız testlerin bıraktığı geçici dosyalar kontrollü temizlensin; kullanıcı verisi temizleme kodu test cleanup'ına bağlanmasın.

**Kabul:** Testler izole dizin dışında yazamaz; gerçek `data/` hash'i değişmeden kalır; testler paralel koşumda kararlı çalışır.

### 1.2 Alan düzeyinde kayıpsız birleştirme — B-01, B-02

- `addedAt` alanının kayıt eklenme zamanı olduğu, kullanıcı eyleminin güncelliğini temsil etmediği açıkça kabul edilsin.
- Puan değiştirme/silme, izleme durumu değiştirme/geri alma ve izleme tarihi gibi kullanıcı eylemleri için tek ve tutarlı zaman çözümleme politikası belirle.
- `mergeTwoSavedItemsLossless` ve onu çağıran tüm birleştirme yolları aynı politikayı kullansın.
- Eylem zamanı yoksa eski kayıtlar için deterministik ve kayıp üretmeyen fallback kuralı tanımla; rastgele veya yalnızca `addedAt` temelli karar verme.
- Alan düzeyinde çatışma senaryoları test edilsin: yeni puan, puanı temizleme, completed → watchlist, watching → completed, tarih güncelleme, aynı anda iki cihaz değişikliği.
- Eşit zaman damgası ve eksik zaman damgası senaryoları ayrıca test edilsin.
- Kullanıcının açıkça yaptığı silme/temizleme eylemi boş değer olarak korunmalı; eski dolu değer tarafından geri diriltilmemeli.

**Kabul:** İki cihazlı senaryolarda son kullanıcı eylemi deterministik biçimde korunur; merge fonksiyonu için doğrudan testler bulunur; eski veri uyumluluğu kanıtlanır.

### 1.3 Kayıt/profil sınırlarında sessiz kırpmayı önleme — B-04

- Profil ve kayıt limitleri aşılırken sessiz veri atma yerine açık hata/uyarı ve güvenli işlem reddi kullan.
- Geçersiz profil kimliğinin tüm profil verisini sessizce düşürmesi engellensin.
- Sınırın bir altı, tam sınır ve bir üstü için test ekle.
- Okuma sırasında normalize edilen veri, sonraki yazımda sessiz veri kaybına yol açmasın.
- Kullanıcıya hangi kayıt/profilin neden kabul edilmediği bildirilsin.

**Kabul:** Limit aşımında hiçbir kayıt sessizce silinmez; import/sync işlemi ya tam uygulanır ya da güvenli biçimde reddedilir.

### 1.4 Yedek şemasının eksiksizliği — B-05, B-06, B-07

- Yedek formatının desteklenen sürümlerini ve kapsamını tek şema sözleşmesinde tanımla.
- Profil başına `deleted_keys`/tombstone, tüm profiller, aktif profil, revizyon ve gerekli metadata yedekte korunmalı.
- Tam belge yedeği içe aktarılırken yalnızca aktif/ilk profil değil, belgedeki tüm profiller ele alınmalı.
- Eski yedeklerde alan bulunmuyorsa mevcut veriyi sessizce boşaltma; eksik alanın anlamını açıkça belirle ve kullanıcıya uyarı göster.
- Desteklenmeyen ileri sürüm yedekleri için yanıltıcı genel hata yerine sürüm numarası ve desteklenen sürümlerle açıklayıcı hata göster.
- `merge` ve `overwrite` modlarını ayır. `overwrite` için açık onay ve geri dönüş snapshot'ı zorunlu olsun.
- İçe aktarma öncesi/sonrası profil, kayıt, favori oyuncu ve tombstone sayıları gösterilsin.

**Kabul:** Çok profilli yedek round-trip testi kayıpsız geçer; silinen kayıt geri dirilmez; eski/yeni sürüm davranışı testlerle belgelenir.

### 1.5 Restore revizyon koruması — B-08

- `POST /api/data/restore` mevcut revizyonu/ETag'i doğrulamalı.
- İstemci restore çağrısı güncel revizyonu göndermeli.
- Çakışmada 409 dönmeli; otomatik üzerine yazma yapılmamalı.
- UI, eski revizyon nedeniyle restore'un durduğunu ve yeniden yükleme/karşılaştırma gerektiğini göstermeli.

**Kabul:** Eşzamanlı yazım senaryosu güncel veriyi ezemez; 409 akışı uçtan uca test edilir.

### 1.6 Veri kaybı eşiği ve güvenli kayıt — B-09

- Ani kayıt düşüşü kontrolü yalnızca toplam sayı farkına bakmamalı.
- Silinen kayıtlar, tombstone'lar, eklenen kayıtlar ve profil kapsamı ayrı hesaplanmalı.
- Büyük toplu silme/overwrite için kullanıcı onayı ve snapshot zorunlu olsun.
- Kayıt düşüşü korumasını toplu ekleme ile aşan senaryo test edilsin.

**Kabul:** Büyük veri kaybı koruması tombstone ve eşzamanlı ekleme/silme senaryolarında doğru çalışır.

### 1.7 GitHub token dosyası yazımı — B-31

- PAT/token yenileme dosya yazımını atomik hale getir.
- Dosya izinleri işletim sisteminin desteklediği en kısıtlayıcı seviyede ayarlansın (POSIX'te 0600).
- Geçici dosya, fsync/rename ve hata halinde eski dosyayı koruma davranışı test edilsin.
- Token, log, hata mesajı veya PR çıktısına yazılmasın.

**Kabul:** Kesinti/yarım yazım token dosyasını bozmaz; dosya izinleri ve secret redaction test edilir.

## 4. Aşama 2 — Senkronizasyon güvenilirliği ve işlem tutarlılığı

**Öncelik:** P1/P2/P3  
**Amaç:** Kuyruk, retry, restore ve senkronizasyon raporlarının gerçek durumu yansıtmasını sağlamak.

### Yapılacak işler

1. **Kuyruk durumu — B-10:** Senkronizasyonun `idle / queued / running / failed / completed` durumlarını ayır. `rejectIfBusy` yalnızca aktif işi değil bekleyen işi de hesaba katsın.
2. **İşlem serileştirme — B-38:** Dışarı açık serileştirilmemiş `saveData` kullanımını kaldır veya yalnızca kontrollü test/özel iç API arkasında tut. Üretim yazımları tek serileştirilmiş yoldan geçsin.
3. **Sayaç doğruluğu — B-39:** `recordsAdded`, `recordsUpdated`, `recordsSkipped` ve benzeri sayaçlar kayıt düzeyi ve alan düzeyi değişiklikleri doğru anlatsın. Sayaçların toplamı işlenen kayıt sayısıyla tutarlı olsun.
4. **Kesinti sonrası toparlanma:** Yarım kalan push/pull/reconcile adımlarında işlem günlüğü ve güvenli yeniden başlatma davranışını tanımla. Tekrar çalıştırma idempotent olmalı.
5. **Retry/backoff — B-30:** 429, 5xx ve geçici ağ hatalarında Retry-After başlığını dikkate alan sınırlı exponential backoff + jitter uygula. Kalıcı 4xx hataları tekrar tekrar deneme.
6. **İstek eşzamanlılığı:** Katalog isteklerinde eşzamanlılık sınırı, iptal ve yeniden deneme politikası tanımla; 429 üretimini azalt.
7. **Hata sınıflandırması:** Kimlik doğrulama, kota, ağ, çakışma, geçersiz veri ve sunucu hataları ayrı kullanıcı mesajı ve operasyon koduyla raporlansın.
8. **Gözlemlenebilirlik:** Token/kişisel veri sızdırmadan işlem kimliği, süre, adım ve sonuç kaydedilsin.

### Kabul kriterleri

- Kuyrukta iş varken ikinci işlem yanlışlıkla `idle` veya `busy değil` görünmez.
- Aynı senkronizasyon işlemi tekrar çalıştırıldığında veri çoğaltmaz/kaybettirmez.
- Retry sayısı ve toplam bekleme sınırlandırılmıştır; kullanıcı iptal edebilir.
- Raporlanan sayaçlar test fixture'larıyla doğrulanır.
- Restore ve senkronizasyon aynı revizyon/serileştirme kurallarına uyar.

## 5. Aşama 3 — Öneri motoru doğruluğu ve performansı

**Öncelik:** P1/P2/P3  
**Amaç:** Büyük arşivlerde ana iş parçacığını kilitlemeyen, film/dizi tercihini doğru ayıran ve açıklanabilir öneri üretmek.

### Yapılacak işler

1. **Karesel benzerlik maliyeti — B-03:** Sevilen içerik özelliklerini her aday için yeniden üretmek yerine önceden hesapla; tür/kişi/anahtar kelime ters indekslerini değerlendir. Aday başına tam geçmiş taramasını azalt.
2. **Üst-N ve sınırlandırma:** Ön eleme, üst-N aday seçimi ve gerektiğinde Worker/dilimleme uygula. Sonuç kalitesini düşürmeden işlem miktarını sınırla.
3. **Film/dizi tercih ayrımı — B-11:** Film ve dizi zevk profillerinin hangi sinyalleri paylaşacağı, hangilerinin ayrı hesaplanacağı açıkça tanımlansın. Film ağırlıklı geçmişin dizi önerisini veya tersini bozmadığı test edilsin.
4. **Top-up filtreleri — B-12:** Ana seçim yolundaki uygunluk, tekrar gösterim, gizlenen/izlenen içerik ve ring filtreleri top-up/overflow yolunda da aynen uygulansın.
5. **Ölü sinyal — B-13:** `serverTaste` ya gerçekten skor katkısı yapmalı ya da açıklamalardan ve hesaplamadan kaldırılmalı. UI'da katkı gibi görünen ama ağırlığı olmayan sinyal kalmasın.
6. **Önbellek sınırı — B-22:** Recommendation cache için LRU/TTL veya revizyon bazlı sınırlama uygula. Eski revizyon girdileri temizlensin.
7. **Skor açıklaması:** Performans optimizasyonu sonrası kullanıcıya gösterilen sinyal katkıları gerçek hesapla tutarlı olmalı.
8. **Kalite karşılaştırması:** Eski ve yeni motor aynı veri setinde karşılaştırılsın; öneri sıralaması farkları açıklanabilir olsun.

### Performans test matrisi

- 1.000 / 5.000 / 10.000 aday.
- 500 / 2.000 / 5.000 / 10.000 sevilen/geçmiş kayıt.
- Film ağırlıklı, dizi ağırlıklı ve karma profil.
- Soğuk cache ve sıcak cache.
- Ana iş parçacığı bloklanması, bellek ve toplam süre.

### Kabul kriterleri

- 5.000×5.000 senaryosu denetimde ölçülen 13–29 saniyelik aralığın belirgin biçimde altına iner; hedef ve cihaz sınıfı aşama 0 ölçümlerinden sonra kesinleştirilir.
- Film-only kapsamı TV içeriklerini döndürmez; TV sonuçları film hedef sayısını azaltmaz.
- Top-up yolu ana yol ile aynı eleme kurallarını uygular.
- Cache büyüklüğü sınırlıdır ve skor açıklamaları gerçek skorla tutarlıdır.

## 6. Aşama 4 — UI/UX, responsive düzen ve erişilebilirlik

**Öncelik:** P2/P3  
**Amaç:** Masaüstü ve mobilde gezinme, içerik görünürlüğü ve erişilebilir etkileşimi düzeltmek.

### Yapılacak işler

1. **Sekme şeridi — B-24:** 1024–1440 px aralığında tüm sekmelere erişim sağla. Yatay kaydırma ipucu, fade/ok, taşma menüsü veya ikon-only çözümü tasarla; klavye ve fare ile erişim doğrulansın.
2. **Mobil sticky header — B-25:** Mobilde üst alanı sadeleştir; gereksiz satırları menüye taşı. Sticky alan içerik yüksekliğini gereksiz tüketmesin.
3. **İşlem Merkezi — B-26:** Retry/iptal/yeniden başlat düğmeleri görev durumuna ve hata türüne göre etkinleştirilsin. 409 gibi tekrar denenemeyen durumlarda retry kapalı ve açıklamalı olsun.
4. **Kart ve poster düzeni — B-27:** Rozet/poster çakışmaları, son kart kırpılması ve filtre çubuğu taşması giderilsin.
5. **Modal erişilebilirliği — B-28:** Modal açıkken odak tuzağı, Escape, geri odak, arka plan inert/aria-hidden ve ekran okuyucu duyuruları doğru çalışsın.
6. **Klavye handler performansı — B-29:** Handler referanslarının gereksiz yeniden bağlanması önlensin; kısayollar modal/form odaklarıyla çakışmasın.
7. **Responsive kapsam:** 360, 390, 768, 1024, 1280, 1440 ve 1920 px ölçülerinde ekran görüntüsü/otomatik kontrol.
8. **Erişilebilirlik:** Kontrast, görünür focus, semantik başlıklar, buton adları, reduced-motion ve klavye ile tam kullanım testleri.

### Kabul kriterleri

- Yatay sayfa taşması yok; sekmelerin tamamına fare, dokunma ve klavye ile erişilir.
- Mobilde sticky alan ölçülebilir biçimde küçülür; temel içerik görünürlüğü artar.
- Geçersiz görev eylemleri devre dışıdır.
- Modal açma/kapatma ve odak yönetimi otomatik testlerle doğrulanır.
- axe veya eşdeğer erişilebilirlik taramasında kritik hata kalmaz; istisnalar belgelenir.

## 7. Aşama 5 — Mimari sadeleştirme ve kod kalitesi

**Öncelik:** P2/P3  
**Amaç:** Büyük dosya ve kopya mantıkları azaltmak; çekirdek katman sınırlarını ve tip güvenliğini güçlendirmek.

### Yapılacak işler

1. **Test kalitesi — B-15:** Kaynak dosyada metin/regex arayan testleri davranışsal testlere dönüştür. Testler iç uygulama metnini değil gözlemlenebilir davranışı doğrulasın.
2. **Büyük dosyalar ve tekrar — B-16:** `cinetrack-core`, `github-bidirectional-sync`, `persistent-store`, `App.tsx` ve diğer büyük modülleri sorumluluklarına göre küçük modüllere ayır. Önce gerçek bağımlılık grafiğini çıkar; toplu yeniden adlandırma yapma.
3. **Tek kaynak politikaları:** Merge, normalize, dedupe, secret redaction, deterministic serialization ve hash gibi ortak kuralların tek otoritesi olsun.
4. **Core purity — B-17:** Saf çekirdek katmanın IndexedDB, API client, encoding service ve crypto gibi I/O/ortam bağımlılıklarını port/adaptör sınırına taşı. İzin listesi küçültülmeli; yeni ihlal eklenmemeli.
5. **Tip güvenliği — B-16:** Özellikle API/GitHub/TVDB yanıtlarında `any` yerine doğrulanan alan tipleri ve runtime schema kullan. `noUnusedLocals` ve `noUnusedParameters` kademeli açılabilir.
6. **App kabuğu:** UI orkestrasyonu, profil kalıcılığı, senkronizasyon ve öneri kontrolü gerçek mevcut hook/modül yapısına göre ayrıştırılsın. Örnek isimler ancak gerçekten gerekli ve mevcut mimariye uyuyorsa kullanılsın.
7. **Bağımlılık temizliği — B-18:** `@respan/respan` kullanımını ve ürün gereksinimini doğrula. Kullanılmıyorsa kontrollü kaldır; telemetry gerekiyorsa gerçek ihtiyaca göre koru.
8. **Kod sınırları:** Döngü, istemci-sunucu sınırı, core purity ve modül import kuralları CI'da ölçülsün.

### Kabul kriterleri

- Refactor öncesi/sonrası test davranışı aynı veya açıklanmış ürün kararıyla değişmiş olmalı.
- Mimari sınır kontrollerinde yeni ihlal ve döngü yok.
- Kopya güvenlik/veri birleştirme fonksiyonları tek kaynağa indirilmiş.
- Tip hataları/gevşek sınırlar azaltılmış; public API sözleşmeleri belgelenmiş.
- Büyük refactor tek dev PR yerine mantıksal, geri alınabilir PR'lara bölünmüş.

## 8. Aşama 6 — İstemci performansı, depolama ve bellek

**Öncelik:** P2/P3/P4  
**Amaç:** Başlangıç yükünü, localStorage yazım maliyetini ve büyük dışa aktarmalarda bellek kullanımını azaltmak.

### Yapılacak işler

1. **Bundle — B-20:** Etkisiz dinamik import'ları gerçek lazy boundary haline getir; vendor chunk stratejisini ölçerek düzenle. Sadece uyarıyı susturmak için yapay chunk üretme.
2. **Local persistence — B-21:** Her değişiklikte tam listenin senkron localStorage'a yazılmasını önle. Debounce/idle/IndexedDB geçişini veri kaybı riski olmadan tasarla.
3. **Veri kırpma:** Kota baskısında `overview` gibi kullanıcı verisini sessizce 120 karaktere kesme. Büyük veriyi ayrı depola veya işlemi açık hata ile durdur.
4. **Excel ve önizleme belleği — B-23:** Büyük çalışma kitaplarında streaming veya sayfalı üretim değerlendir; önizlemede tüm veri setini tek JSON yanıtı olarak döndürme.
5. **Cache/retention — B-22, B-37:** Öneri cache sınırı Aşama 3'te tamamlanır; `data/exports` için yaş/adet/boyut tabanlı retention ve kullanıcıya korunan dosyaları gösterme ekle.
6. **Ölçüm:** İlk açılış, etkileşim gecikmesi, local persistence süresi, bellek zirvesi ve dışa aktarma süresi ölçülsün.

### Kabul kriterleri

- Ana bundle ve başlangıç yükü aşama 0 ölçümüne göre iyileşmiş; hedef değer PR'da sayısal olarak yazılmış.
- Büyük arşiv güncellemeleri UI'ı bloke etmez.
- Hiçbir kullanıcı verisi kota nedeniyle sessizce kırpılmaz.
- Büyük Excel/JSON dışa aktarma bellek sınırları ve dosya retention davranışı test edilir.

## 9. Aşama 7 — Güvenlik ve gizlilik sertleştirmesi

**Öncelik:** P2/P3/P4  
**Amaç:** Bağımlılık, token, CSP ve public repository davranışını açık ve dar yetkili hale getirmek.

### Yapılacak işler

1. **Bağımlılık açıkları — B-19:** `npm audit --omit=dev` çıktısını güncel sürümlerde yeniden üret; doğrudan/transitif bağımlılıkları sınıflandır. Körlemesine `npm audit fix --force` çalıştırma. Uyumlu güncelleme veya etkilenmeyen paket kanıtı üret.
2. **Public repo ayrımı — B-32:** Depo görünürlüğü ile kişisel veri paylaşım onayını ayrı kavramlar olarak modelle. Public repo olması, kullanıcının özel profil verisini otomatik paylaşma izni sayılmasın.
3. **CSP — B-33:** `connect-src`, `frame-ancestors`, websocket ve deploy alan adlarını gerçek ihtiyaçlara göre daralt. Gerekli geliştirme/üretim origin'lerini ayrı tanımla.
4. **Secret handling:** Tokenların istemciye, loglara, export'a veya hata mesajına sızmadığını test et.
5. **Girdi doğrulama:** Import, URL, dosya adı, profil ID, API yanıtı ve restore girdileri runtime doğrulamadan geçsin.
6. **Gizlilik:** Public repoda kişisel veri, gerçek profil snapshot'ı, token veya kullanıcıya özel arşiv bulunmadığı CI ile denetlensin.
7. **Güvenlik başlıkları:** CSP, Origin, rate limit ve mevcut SSRF/path traversal korumalarını regresyon testleriyle koru.

### Kabul kriterleri

- Üretim bağımlılık açıkları güncel raporla sınıflandırılmış; high/critical açıklar kapatılmış veya gerekçeli risk kabulü belgelenmiş.
- Public repo ve kişisel veri paylaşımı ayrı onaylarla kontrol edilir.
- CSP yalnızca gerekli origin/protokolleri kapsar.
- Secret ve kişisel veri sızıntısı testleri CI'da çalışır.

## 10. Aşama 8 — Zevk Haritası ve ilişki keşif motoru

**Öncelik:** P3/P4  
**Amaç:** Grafikte kanonik anahtar, durum ve ağırlıkların kullanıcı verisiyle tutarlı olmasını sağlamak.

### Yapılacak işler

1. **Kanonik eşleştirme — B-34:** Film/dizi anahtarlarını normalize eden tek bir resolver kullan. Ham tercih anahtarı, düğüm ID'si ve içerik ID'si doğrudan karşılaştırılmasın.
2. **Durum/renk tutarlılığı:** İzledim, izleyeceğim, izliyorum, ilgilenmiyorum ve gizle durumları aynı canonical key üzerinden çözülsün.
3. **İlişki ağırlıkları — B-35:** Semantik, atmosfer, tema, kişi ve evren bağlantılarının ağırlıkları açıklanabilir ve test edilebilir olsun. Ağırlıklar gelişigüzel kullanıcıya özelmiş gibi sunulmasın.
4. **Graf performansı:** Düğüm/kenar sınırları, indeksleme ve render maliyeti ölçülsün; büyük arşivlerde UI donmasın.
5. **Gerekçe:** Her bağlantı için kullanıcıya neden gösterildiği açıklanabilsin; kanıtı olmayan bağlantı üretilmesin.

### Kabul kriterleri

- Film/dizi aynı sayısal ID çakışması doğru ayrılır.
- Kullanıcı durumu, düğüm rengi ve açıklama aynı kanonik kayıtla eşleşir.
- İlişki ağırlıkları için sabit fixture ve regresyon testleri vardır.
- Büyük grafikte performans bütçesi aşılmaz.

## 11. Aşama 9 — Yedek/geri yükleme deneyimi ve operasyonel geri dönüş

**Öncelik:** P2/P3  
**Amaç:** Kullanıcının yedek, restore, toplu işlem ve dışa aktarma sonrası ne olduğunu görmesini ve güvenli biçimde geri almasını sağlamak.

### Yapılacak işler

1. **Geri alma — B-36:** Toplu restore/overwrite öncesi otomatik snapshot al; işlem sonrası tek adımlı geri alma veya açık restore noktası sun.
2. **Export retention — B-37:** Dışa aktarma dosyaları için retention kuralı; son başarılı yedekleri koruma; silinecek dosyaları önceden raporlama.
3. **Restore önizleme:** Eklenecek, değişecek, silinecek kayıt/profil sayıları ve tombstone farkları gösterilsin.
4. **Restore doğrulaması:** İşlemden sonra dosya sayıları, revizyon ve içerik hash'i kontrol edilsin.
5. **Kurtarma kılavuzu:** Kullanıcıya yerel snapshot, GitHub yedeği ve tam belge yedeği farkları açıklansın.
6. **Hata halinde geri dönüş:** Yarım restore veya bozuk dışa aktarma, önceki geçerli veriyi bozmasın.

### Kabul kriterleri

- Toplu restore öncesi snapshot olmadan işlem yapılamaz.
- Restore önizlemesi gerçek sonuçla tutarlıdır.
- Geri alma testi, çok profilli ve tombstone içeren veriyle geçer.
- Export retention yalnızca belirlenen politikanın dışındaki dosyaları siler.

## 12. Aşama 10 — Uçtan uca doğrulama ve sürüm hazırlığı

**Tür:** Son kalite kapısı; önceki aşamaların yerine geçmez.  
**Amaç:** Tüm düzeltmelerin birlikte çalıştığını ve üretime güvenli çıkabileceğini kanıtlamak.

### Yapılacak işler

1. Güncel `master` üzerinde tüm aşama PR'larının merge edildiğini ve plan bulgularının güncellendiğini doğrula.
2. Temiz checkout + `npm ci` ile doğrulamayı baştan çalıştır.
3. Gerçek `package.json` script'leriyle:
   - `npm run lint`
   - `npm test`
   - `npm run test:taste`
   - `npm run cycles`
   - `npm run build`
   - `npm run test:e2e`
4. E2E için eksik browser/system dependency varsa bunu test başarısı gibi raporlama; CI ortamında browser kurulumunu tamamla veya engeli açıkça kaydet.
5. GitHub/TMDB/TVDB entegrasyonlarını opt-in test hesabı ve izole test deposuyla çalıştır; gerçek kullanıcı verisi veya kişisel token loglama.
6. İki bağımsız profil/cihaz senaryosu: eşzamanlı değişiklik, silme, puan temizleme, durum geri alma, yedek/restore.
7. Veri boyutu testleri: 1k/5k/10k aday ve geçmiş; çok profil, büyük yedek, Excel dışa aktarma.
8. Responsive testleri ve erişilebilirlik taraması.
9. Bağımlılık ve secret taraması; public repo içerik kontrolü.
10. Release notu, bilinen sınırlamalar, migration ve geri dönüş adımlarını hazırla.

### Nihai kabul kriterleri

- P1 bulguların tamamı giderilmiş ve regresyon testleriyle kanıtlanmış olmalı.
- P2 bulguların tamamı giderilmiş veya gerekçeli, açık risk kabulüyle ertelenmiş olmalı.
- P3/P4 maddeleri kapatılmış veya sonraki sürüm backlog'una gerekçesiyle taşınmış olmalı.
- Lint, typecheck, unit/integration, taste, cycle, build ve CI E2E sonuçları raporlanmalı.
- Gerçek kullanıcı verisiyle test yapılmamalı; tüm testler izole fixture/test hesabı kullanmalı.
- Restore ve çok cihazlı senkronizasyon kayıpsızlık senaryoları kanıtlanmalı.
- Performans sonuçları aşama 0 başlangıç değerleriyle karşılaştırılmalı.
- Açık riskler, sürüm notunda ve planın durum tablosunda görünür olmalı.

## 13. Bulgu → aşama eşleştirme matrisi

| Bulgu | Öncelik | Ana aşama | İlgili iş |
|---|---:|---:|---|
| B-01 | P1 | 1 | Alan düzeyinde eylem zamanı ve kayıpsız merge |
| B-02 | P2 | 1 | Merge fonksiyonu doğrudan regresyon testleri |
| B-03 | P1 | 3 | Öneri benzerlik algoritması performansı |
| B-04 | P2 | 1 | Profil/kayıt limitlerinde sessiz kırpmayı önleme |
| B-05 | P1 | 1 | Yedekte tombstone ve silme bilgisini koruma |
| B-06 | P1 | 1 | Çok profilli tam belge yedeği |
| B-07 | P2 | 1 | Yedek sürümü doğrulama ve anlaşılır hata |
| B-08 | P2 | 1 | Restore If-Match/409 |
| B-09 | P2 | 1 | Tombstone duyarlı veri kaybı koruması |
| B-10 | P3 | 2 | Kuyruk durumunun doğru modellenmesi |
| B-11 | P2 | 3 | Film/dizi zevk kapsamlarının ayrıştırılması |
| B-12 | P2 | 3 | Top-up yolunda tüm aday filtreleri |
| B-13 | P3 | 3 | Ölü serverTaste sinyalini düzeltme |
| B-14 | P1 | 1 | Test izolasyonu ve gerçek data/ koruması |
| B-15 | P3 | 5 | Kaynak metni yerine davranışsal test |
| B-16 | P2 | 5 | Büyük dosya, any, kopya helper ve App ayrıştırma |
| B-17 | P2 | 5 | Core purity / port-adaptör sınırı |
| B-18 | P3 | 5 | Kullanılmayan bağımlılık kararının verilmesi |
| B-19 | P2 | 7 | Üretim bağımlılık açıkları |
| B-20 | P2 | 6 | Bundle/chunk/lazy loading |
| B-21 | P2 | 6 | localStorage performansı ve sessiz kırpma |
| B-22 | P3 | 3 | Öneri cache sınırı |
| B-23 | P4 | 6 | Excel/önizleme bellek yönetimi |
| B-24 | P2 | 4 | Masaüstü sekme şeridi erişilebilirliği |
| B-25 | P2 | 4 | Mobil sticky header yüksekliği |
| B-26 | P3 | 4 | İşlem Merkezi görev eylemleri |
| B-27 | P3 | 4 | Poster/kart/filtre görsel düzeni |
| B-28 | P3 | 4 | Modal erişilebilirliği |
| B-29 | P3 | 4 | Klavye handler yeniden bağlama |
| B-30 | P2 | 2 | API 429/5xx retry/backoff |
| B-31 | P2 | 1 | Token dosyası atomik yazım ve izin |
| B-32 | P3 | 7 | Public repo onayı / kişisel veri paylaşımı |
| B-33 | P4 | 7 | CSP daraltma |
| B-34 | P3 | 8 | Zevk Haritası canonical key |
| B-35 | P4 | 8 | İlişki ağırlıkları kalibrasyonu |
| B-36 | P3 | 9 | Restore sonrası geri alma |
| B-37 | P3 | 6 ve 9 | Export retention ve bellek |
| B-38 | P3 | 2 | Serileştirilmemiş saveData yolunu kapatma |
| B-39 | P4 | 2 | Senkron sayaçlarının doğruluğu |

## 14. PR başına zorunlu teslim şablonu

Her aşama PR'ında aşağıdaki başlıklar doldurulmalıdır:

- **Kapsam:** Hangi aşama ve bulgu ID'leri?
- **Güncel taban:** PR'ın açıldığı `master` commit SHA'si.
- **Kök neden:** Sorunun gerçek mekanizması ve kanıtı.
- **Değişiklik:** Hangi dosya/katman değişti, neden?
- **Veri etkisi:** Şema, migration, yedek, senkron veya kullanıcı verisine etkisi var mı?
- **Testler:** Eklenen/değişen testler ve gerçek komut çıktıları.
- **Kalite kapıları:** Lint, typecheck, build, test, cycle, E2E.
- **Geri alma:** Hata halinde güvenli rollback yöntemi.
- **Kalan risk:** Bilinen sınırlamalar ve takip işi.
- **Bulgu durumu:** Her B-ID için önce/sonra durumu.

## 15. Uygulama sırası ve merge politikası

Önerilen sıra:

`0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10`

- **Aşama 0** yalnızca doğrulama yapar; uygulama değişikliği içermez.
- **Aşama 1** veri güvenliği ve test izolasyonu nedeniyle ilk kod değişikliği olmalıdır.
- **Aşama 2** senkronizasyon işlemlerini sağlamlaştırır.
- **Aşama 3** öneri motoru performansını ve doğruluğunu düzeltir.
- **Aşama 4** kullanıcıya görünen UI/UX sorunlarını giderir.
- **Aşama 5–9** mimari, performans, güvenlik, grafik ve kurtarma işlerini tamamlar.
- **Aşama 10** tüm değişikliklerin birlikte doğrulanmasıdır.

Her PR merge edildikten sonra sonraki dal yeni `master` HEAD'inden açılır. Çakışma çözümünde eski dalı zorla `master` üzerine yazma; güncel `master` ile rebase/merge edip testleri tekrar çalıştır. P1 veri kaybı bulguları kapanmadan çok cihazlı senkronizasyon veya tam yedekleme güvenilir kabul edilmemelidir.

---

**İlk uygulanacak iş:** Aşama 1 — veri güvenliği, test izolasyonu ve kayıpsız veri modeli. Aşama 0 tamamlanmış ve doğrulanmıştır; Aşama 1 aynı dal ve aynı PR üzerinde commit olarak ilerler. Bu yol haritası bir uygulama taahhüdü değil; her aşama kendi kanıtı ve kabul kriteriyle tamamlandığında ilerleyen kontrollü bir iş planıdır.

## 16. Aşama 0 sonuçları ve güncel bulgu durumu

**Tarih:** 21 Kasım 2026 · **Taban:** `c58ec49` · **Ayrıntı:** [PHASE_00_BASELINE_AUDIT.md](audits/PHASE_00_BASELINE_AUDIT.md)

### 16.1 Durum değişiklikleri

| Bulgu | Önceki varsayım | Aşama 0 sonucu | Eşleşme değişikliği |
|---|---|---|---|
| B-01 | "`addedAt` önceliği" | PARTIALLY_FIXED — kod `ratedAt → completedAt → watchedAt → addedAt → updatedAt` sırasına geçmiş; kalan kusur **yalnızca `updatedAt`'in `addedAt` altında kalması** (puan silme / durum geri alma tek başına kaybediliyor) | Aşama 1 (değişmedi), kabul kriteri S1/S3 senaryolarıyla netleşti |
| B-02 | Doğrudan test yok | PARTIALLY_FIXED — `reconcileUserDataDocumentsLossless` üzerinden dolaylı kapsama var | Aşama 1 (değişmedi) |
| B-13 | Ölü sinyal | PARTIALLY_FIXED — `serverTaste` artık `genreScore` içine karışıyor; yalnızca `parts` kırılımı ağırlıksız görünüyor | Aşama 3 (değişmedi) |
| B-22 | Sınırsız cache | PARTIALLY_FIXED — `invalidateProfile` var, boyut sınırı yok | Aşama 3 (değişmedi) |
| B-26 | Retry düğmesi etkin | **FIXED** (durum koşuluna bağlanmış) | Aşama 4'ten çıkarıldı; yalnızca regresyon testi kalır |
| B-27 | Görsel taşmalar | NEEDS_INVESTIGATION — bu aşamada görsel koşum yapılmadı | Aşama 4'te ölçümle yeniden açılacak |
| B-34 | Ham anahtar | **FIXED** (`relationshipNodeKey` → `makeMediaKey`, tercihler kanonik) | Aşama 8'den çıkarıldı; regresyon testi kalır |

### 16.2 Yeni bulguların aşama eşleşmesi

| ID | P | Başlık | Aşama |
|---|---|---|---|
| N-01 | P2 | Plan ↔ tek-PR talimatı çelişkisi | 0 (bu güncellemeyle çözüldü) |
| N-02 | P3 | `npm test` dosya listesi elle yazılmış | 5 |
| N-03 | P3 | Kurulumda install-script'ler engelli | 10 |
| N-04 | P3 | Test concurrency belirsiz (B-14 ile birleşik) | 1 |
| N-05 | P4 | Kökte denetim belgesi birikmesi | 0/5 |

### 16.3 Aşama 1 kapsamı (doğrulanmış)

Yalnızca aşağıdaki işler; her biri ayrı commit + regresyon testi:

1. **B-14 + N-04:** `tests/cinema-kunye-backup-sync.test.mjs:232,346,507` çağrılarını `createDataStorage({ dataDir: tmpDir })` yap; taste testlerinde eksik `dataDir` kalmadığını doğrula; `CINETRACK_DATA_DIR` test guard'ı; `data/` öncesi/sonrası hash kontrolü.
2. **B-01 + B-02:** Eylem zamanı politikası (puan temizleme ve durum geri alma `updatedAt` ile kazanabilsin) + `mergeTwoSavedItemsLossless` için S1–S6 doğrudan testleri.
3. **B-05 + B-06 + B-07:** Yedek şeması v4 (tombstone + tüm profiller + aktif profil + revizyon) veya tam belge içe aktarımını açık onayla sınırlama; v4/ileri sürüm için açıklayıcı hata.
4. **B-04:** Limit aşımında sessiz kırpma yerine ret/uyarı; geçersiz profil kimliğini karantinaya al.
5. **B-08:** `POST /api/data/restore` → `If-Match`/`expectedRevision` + 409; istemci revizyon gönderir.
6. **B-09:** `sudden_item_drop` hesabına tombstone ve profil kapsamı ekle.
7. **B-31:** Token dosyasını `.tmp` + `fsync` + `rename` + `0600` ile yaz.

**Aşama 1'e girmeyenler:** B-03 (Aşama 3), B-10/B-30/B-38/B-39 (Aşama 2), UI ve mimari işleri (Aşama 4–8). Kapsam kayması olmayacak.

### 16.4 Aşama 0'da kapatılan konular

- Tek PR modeli plana işlendi (N-01).
- `master`'a doğrudan commit gönderilmedi; tüm çalışma `remediation/full-project-remediation` dalında.
- Uygulama kodu, veri şeması ve kullanıcı verisi değiştirilmedi; test koşusunun `data/` üzerindeki etkisi ölçüldü ve yedek alındı.

## 17. Aşama 1 sonuçları

**Tarih:** 21 Kasım 2026 · **Dal:** `remediation/full-project-remediation` · **PR:** #65
**Taban:** `master` @ `c58ec49` (değişmedi) · **Ayrıntı:** [PHASE_01_DATA_INTEGRITY.md](audits/PHASE_01_DATA_INTEGRITY.md), [PHASE_01_DATA_INTEGRITY_TESTS.md](audits/PHASE_01_DATA_INTEGRITY_TESTS.md)

### 17.1 Kapanan bulgular

| Bulgu | Çözüm özeti | Commit |
|---|---|---|
| B-14, N-02, N-04 | Test veri guard'ı (`dataDir` zorunlu), glob tabanlı test keşfi, `--test-concurrency=1`, `data/` hash kapısı | `3b2df4e` |
| B-01, B-02 | Alan bazlı `status_changed_at`/`rating_changed_at` + kayıpsız merge, boş puan "görüş yok" | `3945592` |
| B-05, B-06, B-07 | Yedek v4 tam belge (tüm profiller, tombstone, revizyon); v5+ açık hata; sessiz düşürme yok | `be36d94` |
| B-08 | Restore `If-Match`/`expectedRevision`, 409/412/428, güvenlik snapshot'ı, atomik yazım | `5e54f7b` |
| B-09, B-04 | Tombstone/profil duyarlı kayıp koruması; limit aşımında sessiz kırpma yerine 409 | `30eb3cb` |
| B-31 | Token dosyası: tmp + fsync + rename, `0600`, symlink reddi, sıralı yazma | `f4cac57` |
| A–G | Uçtan uca entegrasyon testleri (çoklu cihaz, silme, yedek, restore çakışması) | `83ce55f` |

### 17.2 Doğrulama

- `npm run lint`: 0 hata / 0 uyarı
- `npm run cycles`: döngü yok
- `npm test`: **677/677** (69 yeni test)
- `npm run test:taste`: **440/440**
- `npm run build`: başarılı
- `data/` hash'leri ve yedek sayısı Aşama 1 başından beri değişmedi
- `npm run test:e2e`: **koşulamadı** (Playwright sistem bağımlılıkları eksik)

### 17.3 Aşama 2'ye devredilenler

- B-08 kabul kriterinin UI kısmı: restore 409 durumunun kullanıcıya gösterimi (Aşama 4).
- Çok süreçli eşzamanlı yazma senaryosu (Aşama 2, B-38 ile birlikte).
- Aşama 1 kapsamı dışında kalan bulgular plana uygun şekilde sonraki aşamalarda.

**Aşama 1 burada durur; Aşama 2 başlatılmadı.**
