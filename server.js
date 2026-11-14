
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ID = process.env.NODE_ID || 'Node Default';

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
      node: NODE_ID,
      message: 'Backend dan database terhubung'
    });
  } catch (error) {
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

// Menambahkan buku baru
app.post('/api/buku', async (req, res) => {
  const { judul, penulis, stok } = req.body;

  const parsedStok = Number(stok);

  if (
    !judul ||
    !String(judul).trim() ||
    !penulis ||
    !String(penulis).trim() ||
    stok === undefined ||
    stok === null ||
    typeof stok === 'boolean' ||
    (typeof stok === 'string' && stok.trim() === '') ||
    !Number.isInteger(parsedStok) ||
    parsedStok < 0
  ) {
    return res.status(400).json({
      message: 'Judul, penulis, dan stok (bilangan bulat non-negatif) wajib diisi'
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO public.buku (judul, penulis, stok)
       VALUES ($1, $2, $3)
       RETURNING id, judul, penulis, stok`,
      [String(judul).trim(), String(penulis).trim(), parsedStok]
    );

    res.status(201).json({
      message: 'Buku berhasil ditambahkan',
      buku: result.rows[0],
      ...result.rows[0]
    });
  } catch (error) {
    console.error('Gagal menambahkan buku:', error.message);

    res.status(500).json({
      message: 'Gagal menambahkan buku'
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

// Menambahkan anggota baru
app.post('/api/anggota', async (req, res) => {
  const { nama, email } = req.body;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (
    !nama ||
    !String(nama).trim() ||
    !email ||
    !String(email).trim()
  ) {
    return res.status(400).json({
      message: 'Nama dan email wajib diisi'
    });
  }

  const cleanNama = String(nama).trim();
  const cleanEmail = String(email).trim().toLowerCase();

  if (!emailRegex.test(cleanEmail)) {
    return res.status(400).json({
      message: 'Format email tidak valid'
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO public.anggota (nama, email)
       VALUES ($1, $2)
       RETURNING id, nama, email`,
      [cleanNama, cleanEmail]
    );

    res.status(201).json({
      message: 'Anggota berhasil ditambahkan',
      anggota: result.rows[0],
      ...result.rows[0]
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        message: 'Email sudah terdaftar'
      });
    }

    console.error('Gagal menambahkan anggota:', error.message);

    res.status(500).json({
      message: 'Gagal menambahkan anggota'
    });
  }
});

// Menampilkan riwayat peminjaman
app.get('/api/peminjaman', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        a.nama AS nama_anggota,
        b.judul AS judul_buku,
        p.cabang,
        p.tanggal_pinjam,
        p.tanggal_kembali,
        p.status
      FROM public.peminjaman p
      JOIN public.anggota a ON p.id_anggota = a.id
      JOIN public.buku b ON p.id_buku = b.id
      ORDER BY p.tanggal_pinjam DESC, p.id DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Gagal mengambil data peminjaman:', error.message);

    res.status(500).json({
      message: 'Gagal mengambil data peminjaman'
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

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    await client.query('BEGIN');
    transactionStarted = true;

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
    if (client && transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Rollback gagal:', rollbackError.message);
      }
    }
    console.error('Peminjaman gagal:', error.message);

    res.status(500).json({
      message: 'Terjadi kesalahan saat meminjam buku'
    });
  } finally {
    if (client) {
      client.release();
    }
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
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`${NODE_ID} berjalan di http://localhost:${PORT}`);
  });
}

module.exports = app;
