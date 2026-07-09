# Social Post Data Collector

Chrome extension lokal untuk mengambil data dasar post Instagram, TikTok, dan Facebook yang terlihat di browser:

- platform
- caption
- jenis konten
- jumlah media yang terlihat
- jumlah foto yang terlihat
- jumlah video yang terlihat
- jumlah like
- jumlah komen
- jumlah share dan simpan bila tersedia
- tanggal posting
- URL post

Data hanya disimpan di `chrome.storage.local` dan bisa diekspor ke file Excel dari popup.
File Excel berisi sheet **Data Postingan** dan **Ringkasan** untuk analisa cepat.

## Cara pasang

1. Buka Chrome.
2. Masuk ke `chrome://extensions`.
3. Aktifkan **Developer mode**.
4. Klik **Load unpacked**.
5. Pilih folder project extension ini.
6. Refresh halaman Instagram, TikTok, atau Facebook yang sudah terlanjur terbuka.

Setelah file extension diubah, klik tombol reload pada kartu extension di `chrome://extensions`, lalu refresh halaman Instagram, TikTok, atau Facebook.

## Cara pakai

1. Login ke Instagram, TikTok, atau Facebook di Chrome.
2. Buka profil akun yang ingin dibaca.
3. Klik icon extension **Social Collector**.
4. Isi tanggal batas.
5. Pilih platform atau gunakan **Deteksi dari tab aktif**.
6. Klik **Mulai**.
7. Setelah selesai, klik **Export Excel**.

## Catatan penting

Extension ini membaca data dari tampilan halaman Instagram, TikTok, atau Facebook, jadi hasilnya bergantung pada data yang benar-benar muncul untuk akun user. Bila platform menyembunyikan jumlah like, belum memuat semua komentar, atau mengubah struktur halaman, beberapa kolom bisa kosong.

Post yang berada di baris paling atas profil diperlakukan sebagai kandidat post pin. Jika tanggalnya lebih lama dari tanggal batas, post tersebut dilewati dan tidak masuk file export.

Untuk TikTok, extension mencoba membaca data dari state halaman terlebih dahulu, lalu fallback ke teks dan elemen yang terlihat. Karena struktur TikTok sering berubah, kolom tanggal atau statistik tertentu bisa kosong bila tidak muncul di halaman.

Untuk Facebook, extension membaca kartu post yang terlihat di feed tanpa mengklik gambar atau banner halaman. Beberapa angka bisa kosong bila Facebook menyembunyikannya atau menampilkan format berbeda.

Tool ini tidak mengambil password, cookie, token login, atau mengirim data ke server eksternal.
