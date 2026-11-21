# Veri Birleştirme Politikası (Aşama 1)

> **Kapsam:** `src/core/user-data-merge.ts` — `mergeTwoSavedItemsLossless` ve
> `reconcileUserDataDocumentsLossless`.
> **Bulgu:** B-01 (eylem zamanı kaybı), B-02 (doğrudan test eksikliği).

## 1. İlke: alan bazlı birleştirme

Bir kaydın bütün alanları tek bir tarih üzerinden birleştirilmez. Her alan kendi
değişiklik zamanıyla yarışır. Eski davranış `ratedAt → completedAt → watchedAt →
addedAt → updatedAt` tek zincirini kullanıyordu; yalnızca puan silen veya durumu
geri alan cihaz "daha eski" görünüp eski veriyi kaybediyordu.

## 2. Alan zamanı çözümlemesi

| Alan | Zaman önceliği (ilk geçerli ISO kazanır) | Not |
|---|---|---|
| Durum (`status`) | `status_changed_at` → `updatedAt` → `completedAt` → `watchedAt` → `addedAt` | Yeni istemciler `status_changed_at` yazar; not düzenlemesi bu alanı değiştirmez. |
| Puan (`personal_rating`, `personal_rating_cleared`) | `rating_changed_at` → (temizleme varsa) `updatedAt` → `ratedAt` → `updatedAt` → `completedAt` → `watchedAt` → `addedAt` | Boş puan tek başına "sildim" demek değildir; yalnızca `personal_rating_cleared` görüş bildirir. |

`status_changed_at` ve `rating_changed_at` **geriye dönük uyumlu opsiyonel**
alanlardır. Eski kayıtlarda bulunmazlar ve yukarıdaki yedek zincir kullanılır;
normalizasyon geçersiz damgaları düşürür.

## 3. Karar kuralları

### Durum
1. İki tarafın alan zamanı farklıysa **daha yeni** olan kazanır (ileri ve geri
   alma eşit davranır).
2. Zamanlar eşit veya hesaplanamıyorsa **izleme ilerlemesi daha yüksek** olan
   korunur (`completed` > `watching` > `watchlist`). Deterministik ve simetriktir;
   tamamlanma kaydı sessizce silinmez.
3. Seçilen durum `completed` değilse `completedAt` sonuçtan düşürülür.

### Puan
1. Bir taraf boş ve `personal_rating_cleared` değilse **görüş bildirmemiştir**;
   diğer tarafın puanı korunur.
2. Her iki taraf görüş bildiriyorsa **daha yeni** alan zamanı kazanır (silme dahil).
3. Eşit damgada:
   - iki farklı dolu puan → **daha yüksek puan** korunur (simetrik),
   - biri dolu biri temiz → **dolu puan** korunur (puan sessizce düşmez).
4. Puan temizlendiyse `ratedAt` düşürülür, `personal_rating_cleared=true` kalır.

### Diğer alanlar
- Sezon ilerlemesi: sezon bazında `progress_updated_at` (mevcut politika).
- `addedAt`/`firstAddedAt`: en erken tarih (kayıt kimliği korunur).
- Metadata (özet, poster, tür, kadro): daha zengin/temiz değer korunur.
- `updatedAt`: iki tarafın en yeni damgası.

## 4. Simetri ve determinizm

Her senaryo `A+B` ve `B+A` yönünde aynı sonucu verir; eşit damgalarda seçim
girdi sırasına bağlı değildir. `stringifyUserDataDeterministic` ile iki yönün
sonucu birebir karşılaştırılır (bkz. `tests/phase1-merge-lossless.test.mjs`).

## 5. Silme işaretleri

`reconcileUserDataDocumentsLossless` tombstone'ları korur: tombstone kayıttan
daha yeniyse kayıt geri dirilmez; kayıt tombstone'dan sonra bilinçli olarak
yeniden eklendiyse (daha yeni etkileşim tarihi) kayıt ve tombstone temizliği
korunur.

## 6. Bilinen sınırlar

- Tombstone'lar `normalizeDeletedKeys` ile 30 günden eskiyse düşer
  (`TOMBSTONE_RETENTION_DAYS`). 30 günden uzun süre çevrimdışı kalan bir cihaz
  eski kaydı geri getirebilir; bu davranış Aşama 1 kapsamı dışında bırakıldı ve
  risk olarak kaydedildi.
- `status_changed_at`/`rating_changed_at` taşımayan eski kayıtlarda not
  düzenlemesi (`updatedAt`) durum/puan zamanı olarak okunabilir. Yeni yazımlar
  bu belirsizliği ortadan kaldırır.
