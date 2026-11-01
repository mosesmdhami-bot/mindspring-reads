'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const multer = require('multer');
const rateLimitPackage = require('express-rate-limit');
const pdfParse = require('pdf-parse');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'mindspring-books';

// Required environment variables.
for (const key of [
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SESSION_SECRET',
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD'
]) {
  if (!process.env[key]) {
    console.error(`SETUP ERROR: Missing required environment variable ${key}.`);
    process.exit(1);
  }
}

if (process.env.SESSION_SECRET.length < 32) {
  console.error('SETUP ERROR: SESSION_SECRET must be at least 32 characters.');
  process.exit(1);
}

if (process.env.ADMIN_PASSWORD.startsWith('CHANGE-')) {
  console.error('SETUP ERROR: Change ADMIN_PASSWORD in Render Environment.');
  process.exit(1);
}

// PostgreSQL connection.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});

pool.on('error', error => {
  console.error('Unexpected PostgreSQL pool error:', error.message);
});

// Supabase Storage connection.
// The service-role key must remain on the server.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  }
);

const categories = [
  'Self-help',
  'Finance',
  'Spirituality',
  'Academic',
  'Technology',
  'Other'
];

const allowedManuscripts = new Set([
  '.txt', '.md', '.pdf', '.doc', '.docx', '.rtf', '.odt', '.epub',
  '.ppt', '.pptx', '.xls', '.xlsx', '.csv', '.ods', '.odp'
]);

const allowedCovers = new Set([
  '.jpg', '.jpeg', '.png', '.webp'
]);

// Keep uploaded files in memory temporarily.
// They are uploaded to Supabase Storage, not Render's local disk.
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 2
  },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();

    if (file.fieldname === 'cover') {
      return allowedCovers.has(ext)
        ? cb(null, true)
        : cb(new Error('Cover must be JPG, JPEG, PNG or WEBP.'));
    }

    if (file.fieldname === 'manuscript') {
      return allowedManuscripts.has(ext)
        ? cb(null, true)
        : cb(new Error(
            'Unsupported manuscript format. Allowed: TXT, MD, PDF, DOC, DOCX, RTF, ODT, EPUB, PPT, PPTX, XLS, XLSX, CSV, ODS and ODP.'
          ));
    }

    return cb(new Error('Unexpected upload field.'));
  }
});

const rateLimit = rateLimitPackage.rateLimit || rateLimitPackage;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
});

const paymentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});

// Express configuration.
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(express.json({
  limit: '100kb'
}));

app.use(express.urlencoded({
  extended: false,
  limit: '100kb'
}));

// PostgreSQL session store.
app.use(session({
  name: 'msr.sid',
  secret: process.env.SESSION_SECRET,
  store: new PgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: false
  }),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure:
      process.env.COOKIE_SECURE === 'true' ||
      process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

// Helpers.
const safeUser = user => user ? ({
  id: Number(user.id),
  name: user.name,
  email: user.email,
  role: user.role
}) : null;

function requireUser(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: 'Please log in first.'
    });
  }

  next();
}

async function requireAdmin(req, res, next) {
  try {
    if (!req.session.userId) {
      return res.status(401).json({
        error: 'Please log in as administrator.'
      });
    }

    const result = await pool.query(
      'SELECT id,name,email,role FROM users WHERE id=$1',
      [req.session.userId]
    );

    const admin = result.rows[0];

    if (!admin || admin.role !== 'admin') {
      return res.status(403).json({
        error: 'Administrator access required.'
      });
    }

    req.admin = admin;
    next();
  } catch (error) {
    next(error);
  }
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Storage helpers.
function fileObjectPath(folder, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();

  return `${folder}/${crypto.randomBytes(18).toString('hex')}${ext}`;
}

async function uploadToBucket(file, folder) {
  if (!file) return null;

  const objectPath = fileObjectPath(folder, file.originalname);

  const { error } = await supabase
    .storage
    .from(STORAGE_BUCKET)
    .upload(objectPath, file.buffer, {
      contentType: file.mimetype || 'application/octet-stream',
      cacheControl: '3600',
      upsert: false
    });

  if (error) throw error;

  return objectPath;
}

async function removeStorageObjects(paths) {
  const cleanPaths = (paths || []).filter(Boolean);

  if (!cleanPaths.length) return;

  const { error } = await supabase
    .storage
    .from(STORAGE_BUCKET)
    .remove(cleanPaths);

  if (error) {
    console.error('Supabase Storage deletion error:', error.message);
  }
}

async function downloadFromBucket(objectPath) {
  const { data, error } = await supabase
    .storage
    .from(STORAGE_BUCKET)
    .download(objectPath);

  if (error || !data) {
    throw error || new Error('File not found in storage.');
  }

  return Buffer.from(await data.arrayBuffer());
}

async function signedCoverUrl(objectPath) {
  if (!objectPath) return null;

  const { data, error } = await supabase
    .storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(objectPath, 60 * 60);

  if (error) {
    console.error('Could not create cover URL:', error.message);
    return null;
  }

  return data.signedUrl;
}

// Reading access helpers.
async function subscriptionFor(userId) {
  const result = await pool.query(`
    SELECT expires_at
    FROM subscriptions
    WHERE user_id=$1 AND expires_at>NOW()
    ORDER BY expires_at DESC
    LIMIT 1
  `, [userId]);

  return result.rows[0] || null;
}

async function readingStatus(userId) {
  const [readResult, subscription] = await Promise.all([
    pool.query(
      'SELECT COUNT(*)::int AS n FROM reads WHERE user_id=$1',
      [userId]
    ),
    subscriptionFor(userId)
  ]);

  const count = Number(readResult.rows[0].n || 0);

  return {
    booksRead: count,
    freeBooksRemaining: Math.max(0, 2 - count),
    hasAccess: Boolean(subscription),
    expiresAt: subscription?.expires_at || null,
    priceKes: Number(process.env.ACCESS_PRICE_KES || 100),
    durationDays: Number(process.env.ACCESS_DURATION_DAYS || 365),
    mpesaNumber: process.env.MPESA_NUMBER || ''
  };
}

// Extract text from supported manuscript formats.
async function extractManuscriptContent(buffer, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();

  if (ext === '.pdf') {
    const result = await pdfParse(buffer);

    return String(result.text || '').slice(0, 2_000_000);
  }

  if (['.txt', '.md', '.csv'].includes(ext)) {
    return buffer.toString('utf8').slice(0, 2_000_000);
  }

  return '';
}

// Create or update the administrator account.
async function initializeAdmin() {
  const email = process.env.ADMIN_EMAIL.trim().toLowerCase();

  const passwordHash = await bcrypt.hash(
    process.env.ADMIN_PASSWORD,
    12
  );

  const existing = await pool.query(
    'SELECT id FROM users WHERE email=$1',
    [email]
  );

  if (existing.rows[0]) {
    await pool.query(
      'UPDATE users SET role=$1,password_hash=$2 WHERE id=$3',
      ['admin', passwordHash, existing.rows[0].id]
    );
  } else {
    await pool.query(
      `INSERT INTO users(name,email,password_hash,role)
       VALUES($1,$2,$3,$4)`,
      [
        process.env.ADMIN_NAME || 'MindSpring Administrator',
        email,
        passwordHash,
        'admin'
      ]
    );
  }
}

// Health and public configuration.
app.get('/api/health', async (req, res, next) => {
  try {
    await pool.query('SELECT 1');

    res.json({
      ok: true,
      service: 'MindSpring Reads',
      database: 'connected'
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    priceKes: Number(process.env.ACCESS_PRICE_KES || 100),
    durationDays: Number(process.env.ACCESS_DURATION_DAYS || 365),
    mpesaNumber: process.env.MPESA_NUMBER || ''
  });
});

// Registration.
app.post('/api/auth/register', authLimiter, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (name.length < 2 || name.length > 80) {
      return res.status(400).json({
        error: 'Name must be 2–80 characters.'
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        error: 'Enter a valid email address.'
      });
    }

    if (password.length < 10 || password.length > 200) {
      return res.status(400).json({
        error: 'Password must be 10–200 characters.'
      });
    }

    const hash = await bcrypt.hash(password, 12);

    let result;

    try {
      result = await pool.query(
        `INSERT INTO users(name,email,password_hash)
         VALUES($1,$2,$3)
         RETURNING id,name,email,role`,
        [name, email, hash]
      );
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({
          error: 'That email already has an account.'
        });
      }

      throw error;
    }

    req.session.userId = result.rows[0].id;

    await saveSession(req);

    res.status(201).json({
      user: safeUser(result.rows[0]),
      reading: await readingStatus(result.rows[0].id)
    });
  } catch (error) {
    next(error);
  }
});

// Login.
app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    const result = await pool.query(
      'SELECT * FROM users WHERE email=$1',
      [email]
    );

    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({
        error: 'Email or password is incorrect.'
      });
    }

    await regenerateSession(req);

    req.session.userId = user.id;

    await saveSession(req);

    res.json({
      user: safeUser(user),
      reading: await readingStatus(user.id)
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', async (req, res, next) => {
  try {
    await destroySession(req);

    res.clearCookie('msr.sid');

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', async (req, res, next) => {
  try {
    if (!req.session.userId) {
      return res.json({
        user: null,
        reading: null
      });
    }

    const result = await pool.query(
      'SELECT id,name,email,role FROM users WHERE id=$1',
      [req.session.userId]
    );

    const user = result.rows[0];

    if (!user) {
      return res.json({
        user: null,
        reading: null
      });
    }

    res.json({
      user: safeUser(user),
      reading: await readingStatus(user.id)
    });
  } catch (error) {
    next(error);
  }
});

// Public book catalogue.
app.get('/api/books', async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT id,title,author,category,description,cover_path,created_at
      FROM books
      WHERE published=TRUE
      ORDER BY id DESC
    `);

    const books = await Promise.all(
      result.rows.map(async book => ({
        ...book,
        id: Number(book.id),
        coverUrl: await signedCoverUrl(book.cover_path)
      }))
    );

    res.json({ books });
  } catch (error) {
    next(error);
  }
});

// Read a book.
app.get('/api/books/:id/read', requireUser, async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({
        error: 'Invalid book ID.'
      });
    }

    const result = await pool.query(`
      SELECT id,title,author,category,description,content
      FROM books
      WHERE id=$1 AND published=TRUE
    `, [id]);

    const book = result.rows[0];

    if (!book) {
      return res.status(404).json({
        error: 'Book not found.'
      });
    }

    const alreadyReadResult = await pool.query(
      'SELECT 1 FROM reads WHERE user_id=$1 AND book_id=$2',
      [req.session.userId, id]
    );

    const alreadyRead = Boolean(alreadyReadResult.rows[0]);
    const status = await readingStatus(req.session.userId);

    if (!alreadyRead && !status.hasAccess && status.booksRead >= 2) {
      return res.status(402).json({
        error: 'You have used your two free books. One-year access costs KSh 100.',
        reading: status
      });
    }

    if (!alreadyRead) {
      await pool.query(
        `INSERT INTO reads(user_id,book_id)
         VALUES($1,$2)
         ON CONFLICT(user_id,book_id) DO NOTHING`,
        [req.session.userId, id]
      );
    }

    res.json({
      book: {
        ...book,
        id: Number(book.id)
      },
      reading: await readingStatus(req.session.userId)
    });
  } catch (error) {
    next(error);
  }
});

// Download original manuscript.
app.get('/api/books/:id/download', requireUser, async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({
        error: 'Invalid book ID.'
      });
    }

    const result = await pool.query(
      `SELECT title,manuscript_path
       FROM books
       WHERE id=$1 AND published=TRUE`,
      [id]
    );

    const book = result.rows[0];

    if (!book || !book.manuscript_path) {
      return res.status(404).json({
        error: 'Original manuscript download is not available.'
      });
    }

    const [status, readResult] = await Promise.all([
      readingStatus(req.session.userId),
      pool.query(
        'SELECT 1 FROM reads WHERE user_id=$1 AND book_id=$2',
        [req.session.userId, id]
      )
    ]);

    if (!readResult.rows[0] && !status.hasAccess && status.booksRead >= 2) {
      return res.status(402).json({
        error: 'Reading access is required to download this book.'
      });
    }

    const buffer = await downloadFromBucket(book.manuscript_path);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${path.basename(book.manuscript_path)}"`
    );

    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

// Submit manual M-Pesa payment.
app.post('/api/payments', requireUser, paymentLimiter, async (req, res, next) => {
  try {
    const payerName = String(req.body.payerName || '').trim();

    const code = String(req.body.transactionCode || '')
      .trim()
      .toUpperCase();

    if (
      payerName.length < 2 ||
      payerName.length > 100 ||
      !/^[A-Z0-9]{6,20}$/.test(code)
    ) {
      return res.status(400).json({
        error: 'Enter the payer name and valid M-Pesa transaction code.'
      });
    }

    if (await subscriptionFor(req.session.userId)) {
      return res.status(409).json({
        error: 'Your reading access is already active.'
      });
    }

    try {
      await pool.query(
        `INSERT INTO payments(user_id,amount_kes,transaction_code,payer_name)
         VALUES($1,$2,$3,$4)`,
        [
          req.session.userId,
          Number(process.env.ACCESS_PRICE_KES || 100),
          code,
          payerName
        ]
      );
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({
          error: 'This transaction code was already submitted.'
        });
      }

      throw error;
    }

    res.status(201).json({
      message: 'Payment submitted for administrator verification.'
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/payments/mine', requireUser, async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT amount_kes,transaction_code,status,submitted_at,reviewed_at,admin_note
      FROM payments
      WHERE user_id=$1
      ORDER BY id DESC
    `, [req.session.userId]);

    res.json({
      payments: result.rows
    });
  } catch (error) {
    next(error);
  }
});

// Author manuscript submission.
app.post(
  '/api/authors/submissions',
  requireUser,
  upload.single('manuscript'),
  async (req, res, next) => {
    let storedPath = null;

    try {
      const authorName = String(req.body.authorName || '').trim();
      const email = String(req.body.email || '').trim().toLowerCase();
      const title = String(req.body.title || '').trim();
      const category = String(req.body.category || 'Other');
      const description = String(req.body.description || '').trim();

      if (!req.file) {
        return res.status(400).json({
          error: 'Choose a manuscript file. Maximum size is 20 MB.'
        });
      }

      if (
        authorName.length < 2 ||
        !isValidEmail(email) ||
        title.length < 2 ||
        title.length > 180 ||
        description.length < 10 ||
        description.length > 2000 ||
        !categories.includes(category)
      ) {
        return res.status(400).json({
          error: 'Check the author name, email, title, category and description.'
        });
      }

      storedPath = await uploadToBucket(req.file, 'manuscripts');

      await pool.query(`
        INSERT INTO author_submissions
          (user_id,author_name,email,title,category,description,manuscript_path)
        VALUES($1,$2,$3,$4,$5,$6,$7)
      `, [
        req.session.userId,
        authorName,
        email,
        title,
        category,
        description,
        storedPath
      ]);

      res.status(201).json({
        message: 'Your manuscript was submitted for administrator review.'
      });
    } catch (error) {
      if (storedPath) {
        await removeStorageObjects([storedPath]);
      }

      next(error);
    }
  }
);

// All admin endpoints require administrator access.
app.use('/api/admin', requireAdmin);

// Admin dashboard summary.
app.get('/api/admin/summary', async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM users WHERE role='reader') AS users,
        (SELECT COUNT(*)::int FROM books WHERE published=TRUE) AS books,
        (SELECT COUNT(*)::int FROM payments WHERE status='pending') AS "pendingPayments",
        (SELECT COUNT(*)::int FROM author_submissions WHERE status='pending') AS "pendingAuthors"
    `);

    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

// Admin book listing.
app.get('/api/admin/books', async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT id,title,author,category,description,published,
             cover_path,manuscript_path,created_at
      FROM books
      ORDER BY id DESC
    `);

    const books = await Promise.all(
      result.rows.map(async book => ({
        ...book,
        id: Number(book.id),
        coverUrl: await signedCoverUrl(book.cover_path),
        hasManuscript: Boolean(book.manuscript_path)
      }))
    );

    res.json({ books });
  } catch (error) {
    next(error);
  }
});

// Admin publishes a book.
app.post(
  '/api/admin/books',
  upload.fields([
    { name: 'cover', maxCount: 1 },
    { name: 'manuscript', maxCount: 1 }
  ]),
  async (req, res, next) => {
    let manuscriptPath = null;
    let coverPath = null;

    try {
      const title = String(req.body.title || '').trim();
      const author = String(req.body.author || '').trim();
      const category = String(req.body.category || 'Other');
      const description = String(req.body.description || '').trim();

      const manuscript = req.files?.manuscript?.[0];
      const cover = req.files?.cover?.[0];

      if (
        title.length < 2 ||
        title.length > 180 ||
        author.length < 2 ||
        author.length > 180 ||
        !categories.includes(category) ||
        description.length < 10 ||
        description.length > 2000 ||
        !manuscript
      ) {
        return res.status(400).json({
          error: 'Enter a valid title, author, category, description and manuscript.'
        });
      }

      const content = await extractManuscriptContent(
        manuscript.buffer,
        manuscript.originalname
      );

      if (
        path.extname(manuscript.originalname).toLowerCase() === '.pdf' &&
        !content.trim()
      ) {
        return res.status(400).json({
          error: 'No selectable text was found in this PDF. A scanned PDF may require OCR.'
        });
      }

      manuscriptPath = await uploadToBucket(manuscript, 'manuscripts');

      if (cover) {
        coverPath = await uploadToBucket(cover, 'covers');
      }

      const result = await pool.query(`
        INSERT INTO books
          (title,author,category,description,content,cover_path,manuscript_path,published)
        VALUES($1,$2,$3,$4,$5,$6,$7,TRUE)
        RETURNING id
      `, [
        title,
        author,
        category,
        description,
        content,
        coverPath,
        manuscriptPath
      ]);

      res.status(201).json({
        message: 'Book published successfully.',
        id: Number(result.rows[0].id)
      });
    } catch (error) {
      await removeStorageObjects([manuscriptPath, coverPath]);
      next(error);
    }
  }
);

// Delete a book and its files.
app.delete('/api/admin/books/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({
        error: 'Invalid book ID.'
      });
    }

    const client = await pool.connect();
    let book;

    try {
      await client.query('BEGIN');

      const found = await client.query(
        `SELECT id,cover_path,manuscript_path
         FROM books WHERE id=$1 FOR UPDATE`,
        [id]
      );

      book = found.rows[0];

      if (!book) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          error: 'Book not found.'
        });
      }

      await client.query(
        'DELETE FROM reads WHERE book_id=$1',
        [id]
      );

      await client.query(
        'DELETE FROM books WHERE id=$1',
        [id]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    await removeStorageObjects([
      book.cover_path,
      book.manuscript_path
    ]);

    res.json({
      message: 'Book and its uploaded files were deleted.'
    });
  } catch (error) {
    next(error);
  }
});

// Download author manuscript for admin review.
app.get('/api/admin/authors/:id/download', async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({
        error: 'Invalid submission ID.'
      });
    }

    const result = await pool.query(
      'SELECT manuscript_path FROM author_submissions WHERE id=$1',
      [id]
    );

    const submission = result.rows[0];

    if (!submission?.manuscript_path) {
      return res.status(404).json({
        error: 'Manuscript file not found.'
      });
    }

    const buffer = await downloadFromBucket(submission.manuscript_path);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${path.basename(submission.manuscript_path)}"`
    );

    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

// List author submissions.
app.get('/api/admin/authors', async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT id,author_name,email,title,category,description,status,submitted_at
      FROM author_submissions
      ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,id DESC
    `);

    res.json({
      submissions: result.rows.map(row => ({
        ...row,
        id: Number(row.id)
      }))
    });
  } catch (error) {
    next(error);
  }
});

// Review author submission.
app.post('/api/admin/authors/:id/review', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const decision = String(req.body.decision || '');

    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      !['approve', 'reject'].includes(decision)
    ) {
      return res.status(400).json({
        error: 'Invalid review request.'
      });
    }

    const found = await pool.query(
      'SELECT * FROM author_submissions WHERE id=$1',
      [id]
    );

    const submission = found.rows[0];

    if (!submission) {
      return res.status(404).json({
        error: 'Submission not found.'
      });
    }

    if (submission.status !== 'pending') {
      return res.status(409).json({
        error: 'This submission has already been reviewed.'
      });
    }

    if (decision === 'approve') {
      if (!submission.manuscript_path) {
        return res.status(404).json({
          error: 'The submitted manuscript file is missing.'
        });
      }

      let fileBuffer;

      try {
        fileBuffer = await downloadFromBucket(submission.manuscript_path);
      } catch (error) {
        return res.status(404).json({
          error: 'The submitted manuscript file is missing.'
        });
      }

      let content;

      try {
        content = await extractManuscriptContent(
          fileBuffer,
          submission.manuscript_path
        );
      } catch (error) {
        console.error('Author manuscript extraction failed:', error.message);

        return res.status(400).json({
          error: 'Could not extract manuscript text. Check the uploaded file.'
        });
      }

      if (
        path.extname(submission.manuscript_path).toLowerCase() === '.pdf' &&
        !content.trim()
      ) {
        return res.status(400).json({
          error: 'No selectable text was found in this PDF. OCR may be required.'
        });
      }

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const locked = await client.query(
          'SELECT status FROM author_submissions WHERE id=$1 FOR UPDATE',
          [id]
        );

        if (!locked.rows[0] || locked.rows[0].status !== 'pending') {
          throw new Error('This submission has already been reviewed.');
        }

        await client.query(`
          INSERT INTO books
            (title,author,category,description,content,manuscript_path,published)
          VALUES($1,$2,$3,$4,$5,$6,TRUE)
        `, [
          submission.title,
          submission.author_name,
          submission.category,
          submission.description,
          content,
          submission.manuscript_path
        ]);

        await client.query(`
          UPDATE author_submissions
          SET status='approved',reviewed_at=NOW(),reviewed_by=$1
          WHERE id=$2
        `, [req.admin.id, id]);

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');

        if (error.message.includes('already been reviewed')) {
          return res.status(409).json({
            error: error.message
          });
        }

        throw error;
      } finally {
        client.release();
      }
    } else {
      const updated = await pool.query(`
        UPDATE author_submissions
        SET status='rejected',reviewed_at=NOW(),reviewed_by=$1
        WHERE id=$2 AND status='pending'
      `, [req.admin.id, id]);

      if (updated.rowCount !== 1) {
        return res.status(409).json({
          error: 'This submission has already been reviewed.'
        });
      }
    }

    res.json({
      message: decision === 'approve'
        ? 'Manuscript published successfully.'
        : 'Submission rejected.'
    });
  } catch (error) {
    next(error);
  }
});

// Admin payment listing.
app.get('/api/admin/payments', async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT p.id,p.amount_kes,p.transaction_code,p.payer_name,
             p.status,p.submitted_at,
             u.name AS reader_name,u.email AS reader_email
      FROM payments p
      JOIN users u ON u.id=p.user_id
      ORDER BY CASE p.status WHEN 'pending' THEN 0 ELSE 1 END,p.id DESC
    `);

    res.json({
      payments: result.rows.map(row => ({
        ...row,
        id: Number(row.id)
      }))
    });
  } catch (error) {
    next(error);
  }
});

// Approve or reject manual M-Pesa payment.
app.post('/api/admin/payments/:id/review', async (req, res, next) => {
  const id = Number(req.params.id);
  const decision = String(req.body.decision || '');
  const note = String(req.body.note || '').trim().slice(0, 500);

  if (
    !Number.isSafeInteger(id) ||
    id < 1 ||
    !['approve', 'reject'].includes(decision)
  ) {
    return res.status(400).json({
      error: 'Invalid payment review.'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const found = await client.query(
      'SELECT * FROM payments WHERE id=$1 FOR UPDATE',
      [id]
    );

    const payment = found.rows[0];

    if (!payment) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        error: 'Payment not found.'
      });
    }

    if (payment.status !== 'pending') {
      await client.query('ROLLBACK');

      return res.status(409).json({
        error: 'Payment already reviewed.'
      });
    }

    await client.query(`
      UPDATE payments
      SET status=$1,reviewed_at=NOW(),reviewed_by=$2,admin_note=$3
      WHERE id=$4
    `, [
      decision === 'approve' ? 'approved' : 'rejected',
      req.admin.id,
      note,
      id
    ]);

    if (decision === 'approve') {
      const active = await client.query(`
        SELECT expires_at
        FROM subscriptions
        WHERE user_id=$1 AND expires_at>NOW()
        ORDER BY expires_at DESC
        LIMIT 1
      `, [payment.user_id]);

      const now = new Date();

      const start = active.rows[0]
        ? new Date(active.rows[0].expires_at)
        : now;

      const end = new Date(
        start.getTime() +
        Number(process.env.ACCESS_DURATION_DAYS || 365) * 86400000
      );

      await client.query(
        `INSERT INTO subscriptions(user_id,starts_at,expires_at,payment_id)
         VALUES($1,$2,$3,$4)`,
        [
          payment.user_id,
          start.toISOString(),
          end.toISOString(),
          id
        ]
      );
    }

    await client.query('COMMIT');

    res.json({
      message: decision === 'approve'
        ? 'Payment approved and reading access activated.'
        : 'Payment rejected.'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// Static website files.
app.use(express.static(PUBLIC_DIR));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.get('/author', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'author.html'));
});

app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'API endpoint not found.'
  });
});

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Central error handler.
app.use((error, req, res, next) => {
  console.error('Server error:', error);

  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'File is too large. Maximum size is 20 MB.'
      });
    }

    return res.status(400).json({
      error: error.message
    });
  }

  if (/Cover must|Unsupported manuscript format|Unexpected upload field/.test(
    String(error.message || '')
  )) {
    return res.status(400).json({
      error: error.message
    });
  }

  res.status(500).json({
    error: 'Server error. Check the Render logs for details.'
  });
});

// Start server after verifying the database and Storage bucket.
async function start() {
  try {
    await pool.query('SELECT 1');

    const { error } = await supabase
      .storage
      .from(STORAGE_BUCKET)
      .list('', { limit: 1 });

    if (error) {
      throw new Error(
        `Supabase Storage bucket check failed (${STORAGE_BUCKET}): ${error.message}`
      );
    }

    await initializeAdmin();

    app.listen(PORT, () => {
      console.log(`MindSpring Reads running on port ${PORT}`);
      console.log('PostgreSQL: connected');
      console.log(`Supabase Storage bucket: ${STORAGE_BUCKET} (connected)`);
      console.log(
        'Manuscript formats:',
        [...allowedManuscripts].join(', ')
      );
    });
  } catch (error) {
    console.error('Startup failed:', error.message);
    process.exit(1);
  }
}

start();