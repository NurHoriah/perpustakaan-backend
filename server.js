
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Halaman utama backend
app.get('/', (req, res) => {
  res.json({
    message: 'Sistem Informasi Perpustakaan',
    status: 'Backend aktif',
    version: '1.0'
  });
});

// Koneksi ke database Supabase
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000,
  ssl: {
    rejectUnauthorized: false
  }
});

// Tes backend dan koneksi database
app.get('/api/status', async (req, res) => {
  try {
    await pool.query('SELECT 1');

    res.json({
      status: 'ok',
      message: 'Backend dan database terhubung'
    });
  }  catch (error) {
  console.error('Koneksi database gagal:', error);

  res.status(500).json({
    status: 'error',
    message: 'Koneksi database gagal',
    detail: error.message,
    code: error.code
  });
}
});

// Menampilkan daftar buku
app.get('/api/buku', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, judul, penulis, stok FROM public.buku ORDER BY id'
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Gagal mengambil data buku:', error.message);

    res.status(500).json({
      message: 'Gagal mengambil data buku'
    });
  }
});

// Menampilkan daftar anggota
app.get('/api/anggota', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, nama, email FROM public.anggota ORDER BY id'
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Gagal mengambil data anggota:', error.message);

    res.status(500).json({
      message: 'Gagal mengambil data anggota'
    });
  }
});


 // Meminjam buku
app.post('/api/pinjam', async (req, res) => {
  const { id_buku, id_anggota, cabang } = req.body;

  if (
    !Number.isInteger(Number(id_buku)) ||
    !Number.isInteger(Number(id_anggota)) ||
    !cabang ||
    !String(cabang).trim()
  ) {
    return res.status(400).json({
      message: 'ID buku, ID anggota, dan cabang wajib diisi dengan benar'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Kunci baris buku agar stok aman saat ada
    // permintaan peminjaman bersamaan dari dua cabang.
    const bukuResult = await client.query(
      'SELECT id, stok FROM public.buku WHERE id = $1 FOR UPDATE',
      [Number(id_buku)]
    );

    if (bukuResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        message: 'Buku tidak ditemukan'
      });
    }

    // Pastikan anggota terdaftar.
    const anggotaResult = await client.query(
      'SELECT id FROM public.anggota WHERE id = $1',
      [Number(id_anggota)]
    );

    if (anggotaResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        message: 'Anggota tidak ditemukan'
      });
    }

    if (bukuResult.rows[0].stok < 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: 'Stok buku habis'
      });
    }

    await client.query(
      'UPDATE public.buku SET stok = stok - 1 WHERE id = $1',
      [Number(id_buku)]
    );

    const pinjamResult = await client.query(
      `INSERT INTO public.peminjaman
       (id_buku, id_anggota, cabang)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [Number(id_buku), Number(id_anggota), String(cabang).trim()]
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Peminjaman berhasil',
      peminjaman: pinjamResult.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Peminjaman gagal:', error.message);

    res.status(500).json({
      message: 'Terjadi kesalahan saat meminjam buku'
    });
  } finally {
    client.release();
  }
});



 // Mengembalikan buku
app.post('/api/kembali', async (req, res) => {
  const id_peminjaman = Number(req.body.id_peminjaman);

  if (
    req.body.id_peminjaman === undefined ||
    !Number.isInteger(id_peminjaman) ||
    id_peminjaman <= 0
  ) {
    return res.status(400).json({
      message: 'ID peminjaman harus berupa bilangan bulat positif'
    });
  }

  let client;

  try {
    client = await pool.connect();

    await client.query('BEGIN');

    // Kunci transaksi agar tidak dikembalikan dua kali
    const pinjamResult = await client.query(
      `SELECT id, id_buku, status
       FROM public.peminjaman
       WHERE id = $1
       FOR UPDATE`,
      [id_peminjaman]
    );

    if (pinjamResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        message: 'Data peminjaman tidak ditemukan'
      });
    }

    const peminjaman = pinjamResult.rows[0];

    if (peminjaman.status === 'dikembalikan') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: 'Buku pada peminjaman ini sudah dikembalikan'
      });
    }

    // Ubah status dan catat waktu pengembalian
    await client.query(
      `UPDATE public.peminjaman
       SET status = 'dikembalikan',
           tanggal_kembali = NOW()
       WHERE id = $1`,
      [id_peminjaman]
    );

    // Tambahkan stok buku kembali
    await client.query(
      `UPDATE public.buku
       SET stok = stok + 1
       WHERE id = $1`,
      [peminjaman.id_buku]
    );

    await client.query('COMMIT');

    res.status(200).json({
      message: 'Pengembalian buku berhasil',
      id_peminjaman: id_peminjaman,
      status: 'dikembalikan'
    });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Rollback gagal:', rollbackError.message);
      }
    }

    console.error('Pengembalian gagal:', error.message);

    res.status(500).json({
      message: 'Terjadi kesalahan saat mengembalikan buku'
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});


// Jalankan server
// Jalankan server lokal
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Backend berjalan di http://localhost:${PORT}`);
  });
}

// Ekspor aplikasi untuk Vercel
module.exports = app;
