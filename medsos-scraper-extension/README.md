# Social Post Data Collector

Versi saat ini: `1.0.0`

Chrome extension lokal berbentuk side panel untuk mengambil data postingan yang terlihat dari:

- Instagram
- TikTok
- Facebook

Data yang dicoba diambil:

- platform
- caption
- jenis konten
- jumlah media
- jumlah gambar
- jumlah video
- jumlah like
- jumlah komen
- jumlah share
- jumlah simpan bila tersedia
- tanggal posting
- URL postingan

Semua hasil disimpan lokal di `chrome.storage.local` lalu bisa diekspor ke file Excel `.xls` dengan 2 sheet:

- `Data Postingan`
- `Ringkasan`

## Fitur utama

- Side panel di kanan browser agar halaman target tetap terlihat saat scraping berjalan.
- Deteksi platform otomatis dari tab aktif, dengan opsi pilih manual.
- `Tanggal batas` wajib.
- `Tanggal mulai` opsional untuk membatasi hanya rentang tanggal tertentu.
- Validasi form langsung di panel, termasuk pesan merah bila `Tanggal batas` kosong.
- Nama file export mengikuti platform hasil scrape, misalnya `facebook-post-data-2026-07-10.xls`.
- Hasil lokal bisa dibersihkan tanpa menghapus extension.

## Cara pasang

1. Buka Chrome.
2. Masuk ke `chrome://extensions`.
3. Aktifkan **Developer mode**.
4. Klik **Load unpacked**.
5. Pilih folder project extension ini.
6. Reload extension bila ada perubahan file.
7. Refresh halaman Instagram, TikTok, atau Facebook yang sedang dibuka.

## Cara pakai

1. Login ke Instagram, TikTok, atau Facebook di Chrome.
2. Buka profil atau halaman yang ingin dibaca.
3. Klik ikon extension untuk membuka side panel.
4. Pilih platform atau biarkan **Deteksi dari tab aktif**.
5. Isi `Tanggal batas`.
6. Isi `Tanggal mulai` bila ingin membatasi rentang yang lebih sempit.
7. Atur `Maks. post` dan `Jeda` bila perlu.
8. Klik `Mulai`.
9. Setelah proses selesai, klik `Export Excel`.

## Perilaku filter tanggal

- `Tanggal batas` adalah batas paling lama yang masih boleh disimpan.
- `Tanggal mulai` adalah batas paling baru yang masih boleh disimpan.
- Jika `Tanggal mulai` kosong, scraper akan mengambil semua postingan sampai mencapai `Tanggal batas`.

## Catatan per platform

### Instagram

Scraper membaca postingan profil yang terlihat lalu membuka detail post untuk mengambil caption, tanggal, dan statistik yang muncul.

### TikTok

Scraper diprioritaskan ke grid profil aktif dan menghindari kartu rekomendasi seperti `You may like`. Data statistik dan tanggal diambil dari state halaman bila tersedia, lalu dilengkapi dari elemen yang terlihat.

### Facebook

Scraper membaca kartu post langsung dari feed halaman, membuka caption penuh bila perlu, menstabilkan area header untuk mengambil tanggal posting, dan membaca metrik dari area bawah post. Angka tertentu bisa tetap kosong bila Facebook menyembunyikannya.

## Batasan

- Extension hanya bisa membaca data yang benar-benar dimuat dan terlihat untuk akun yang sedang login.
- Jika platform mengubah struktur halaman, beberapa kolom bisa kosong sampai selector diperbarui.
- Post pin atau rekomendasi platform bisa dilewati bila terdeteksi bukan bagian dari alur post biasa.
- File export bisa bernama `social-post-data-...` bila hasil lokal berisi campuran beberapa platform.

## Privasi

Tool ini tidak mengambil password, cookie, token login, atau mengirim data ke server eksternal.
