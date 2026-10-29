
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const SQLiteStoreFactory = require('connect-sqlite3');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const multer = require('multer');
const rateLimitPackage = require('express-rate-limit');
const pdfParse = require('pdf-parse');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

const DB_FILE = path.resolve(
  ROOT,
  process.env.DATABASE_FILE || './data/mindspring.sqlite'
);

const UPLOAD_DIR = path.resolve(
  ROOT,
  process.env.UPLOAD_DIR || './uploads'
);

const COVER_DIR = path.join(UPLOAD_DIR, 'covers');
const MANUSCRIPT_DIR = path.join(UPLOAD_DIR, 'manuscripts');

for (const dir of [
  path.dirname(DB_FILE),
  UPLOAD_DIR,
  COVER_DIR,
  MANUSCRIPT_DIR
]) {
  fs.mkdirSync(dir, { recursive: true });
}

if (!process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET.length < 32) {
  console.error('SETUP ERROR: SESSION_SECRET must be at least 32 characters.');
  process.exit(1);
}

if (!process.env.ADMIN_EMAIL ||
    !process.env.ADMIN_PASSWORD ||
    process.env.ADMIN_PASSWORD.startsWith('CHANGE-')) {
  console.error('SETUP ERROR: Configure ADMIN_EMAIL and ADMIN_PASSWORD in .env.');
  process.exit(1);
}

const db = new Database(DB_FILE);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'reader',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  cover_path TEXT,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reads (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  first_read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, book_id)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_kes INTEGER NOT NULL,
  transaction_code TEXT NOT NULL UNIQUE,
  payer_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  admin_note TEXT
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS author_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  email TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  manuscript_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  admin_note TEXT
);
`);

// Safe migration for existing databases.
const bookColumns = db.prepare('PRAGMA table_info(books)').all();

if (!bookColumns.some(column => column.name === 'manuscript_path')) {
  db.exec('ALTER TABLE books ADD COLUMN manuscript_path TEXT');
}

const categories = [
  'Self-help',
  'Finance',
  'Spirituality',
  'Academic',
  'Technology',
  'Other'
];

const allowedManuscripts = new Set([
  '.txt', '.md', '.pdf', '.doc', '.docx',
  '.rtf', '.odt', '.epub', '.ppt', '.pptx',
  '.xls', '.xlsx', '.csv', '.ods', '.odp'
]);

const allowedCovers = new Set([
  '.jpg', '.jpeg', '.png', '.webp'
]);

const storage = multer.diskStorage({
  destination(req, file, cb) {
    if (file.fieldname === 'cover') {
      return cb(null, COVER_DIR);
    }

    if (file.fieldname === 'manuscript') {
      return cb(null, MANUSCRIPT_DIR);
    }

    cb(new Error('Unexpected upload field.'));
  },

  filename(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();

    cb(
      null,
      crypto.randomBytes(16).toString('hex') + ext
    );
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 2
  },

  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();

    if (file.fieldname === 'cover') {
      if (allowedCovers.has(ext)) return cb(null, true);

      return cb(new Error(
        'Cover must be JPG, JPEG, PNG or WEBP.'
      ));
    }

    if (file.fieldname === 'manuscript') {
      if (allowedManuscripts.has(ext)) return cb(null, true);

      return cb(new Error(
        'Unsupported manuscript format. Allowed: TXT, MD, PDF, DOC, DOCX, RTF, ODT, EPUB, PPT, PPTX, XLS, XLSX, CSV, ODS and ODP.'
      ));
    }

    cb(new Error('Unexpected upload field.'));
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

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({
  extended: false,
  limit: '100kb'
}));

const SQLiteStore = SQLiteStoreFactory(session);

app.use(session({
  name: 'msr.sid',
  secret: process.env.SESSION_SECRET,

  store: new SQLiteStore({
    db: 'sessions.sqlite',
    dir: path.dirname(DB_FILE)
  }),

  resave: false,
  saveUninitialized: false,

  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

const safeUser = user => user ? ({
  id: user.id,
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

function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: 'Please log in as administrator.'
    });
  }

  const admin = db.prepare(
    'SELECT id,name,email,role FROM users WHERE id=?'
  ).get(req.session.userId);

  if (!admin || admin.role !== 'admin') {
    return res.status(403).json({
      error: 'Administrator access required.'
    });
  }

  req.admin = admin;
  next();
}

function removeFile(filePath) {
  if (!filePath) return;

  const resolved = path.resolve(filePath);
  const uploadRoot = path.resolve(UPLOAD_DIR) + path.sep;

  if (resolved.startsWith(uploadRoot)) {
    fs.unlink(resolved, error => {
      if (error && error.code !== 'ENOENT') {
        console.error('File deletion error:', error.message);
      }
    });
  }
}

function subscriptionFor(userId) {
  return db.prepare(`
    SELECT expires_at
    FROM subscriptions
    WHERE user_id=? AND expires_at>?
    ORDER BY expires_at DESC
    LIMIT 1
  `).get(userId, new Date().toISOString()) || null;
}

function readingStatus(userId) {
  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM reads WHERE user_id=?'
  ).get(userId).n;

  const subscription = subscriptionFor(userId);

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

// Text extraction for TXT, Markdown and CSV.
function readTextContent(filePath, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();

  if (!['.txt', '.md', '.csv'].includes(ext)) {
    return '';
  }

  try {
    return fs.readFileSync(filePath, 'utf8').slice(0, 2_000_000);
  } catch (error) {
    console.error('Text extraction error:', error.message);
    return '';
  }
}

// Extract selectable text from PDFs using pdf-parse 1.1.4.
async function extractManuscriptContent(filePath, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();

  if (ext === '.pdf') {
    const buffer = fs.readFileSync(filePath);
    const result = await pdfParse(buffer);

    return String(result.text || '').slice(0, 2_000_000);
  }

  return readTextContent(filePath, originalName);
}

async function initializeAdmin() {
  const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(
    process.env.ADMIN_PASSWORD,
    12
  );

  const existing = db.prepare(
    'SELECT id FROM users WHERE email=?'
  ).get(email);

  if (existing) {
    db.prepare(
      'UPDATE users SET role=?,password_hash=? WHERE id=?'
    ).run('admin', passwordHash, existing.id);
  } else {
    db.prepare(`
      INSERT INTO users(name,email,password_hash,role)
      VALUES(?,?,?,?)
    `).run(
      process.env.ADMIN_NAME || 'MindSpring Administrator',
      email,
      passwordHash,
      'admin'
    );
  }
}

// Health and public configuration.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'MindSpring Reads' });
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

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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
      result = db.prepare(`
        INSERT INTO users(name,email,password_hash)
        VALUES(?,?,?)
      `).run(name, email, hash);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        return res.status(409).json({
          error: 'That email already has an account.'
        });
      }

      throw error;
    }

    req.session.userId = Number(result.lastInsertRowid);

    req.session.save(error => {
      if (error) return next(error);

      const user = db.prepare(
        'SELECT id,name,email,role FROM users WHERE id=?'
      ).get(req.session.userId);

      res.status(201).json({
        user: safeUser(user),
        reading: readingStatus(user.id)
      });
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

    const user = db.prepare(
      'SELECT * FROM users WHERE email=?'
    ).get(email);

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({
        error: 'Email or password is incorrect.'
      });
    }

    req.session.regenerate(error => {
      if (error) return next(error);

      req.session.userId = user.id;

      req.session.save(saveError => {
        if (saveError) return next(saveError);

        res.json({
          user: safeUser(user),
          reading: readingStatus(user.id)
        });
      });
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);

    res.clearCookie('msr.sid');
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null, reading: null });
  }

  const user = db.prepare(
    'SELECT id,name,email,role FROM users WHERE id=?'
  ).get(req.session.userId);

  if (!user) {
    return res.json({ user: null, reading: null });
  }

  res.json({
    user: safeUser(user),
    reading: readingStatus(user.id)
  });
});

// Public catalogue.
app.get('/api/books', (req, res) => {
  const books = db.prepare(`
    SELECT id,title,author,category,description,cover_path,created_at
    FROM books
    WHERE published=1
    ORDER BY id DESC
  `).all();

  res.json({
    books: books.map(book => ({
      ...book,
      coverUrl: book.cover_path
        ? '/covers/' + path.basename(book.cover_path)
        : null
    }))
  });
});

// Read a book.
app.get('/api/books/:id/read', requireUser, (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid book ID.' });
  }

  const book = db.prepare(`
    SELECT id,title,author,category,description,content
    FROM books
    WHERE id=? AND published=1
  `).get(id);

  if (!book) {
    return res.status(404).json({ error: 'Book not found.' });
  }

  const alreadyRead = db.prepare(
    'SELECT 1 FROM reads WHERE user_id=? AND book_id=?'
  ).get(req.session.userId, id);

  const status = readingStatus(req.session.userId);

  if (!alreadyRead && !status.hasAccess && status.booksRead >= 2) {
    return res.status(402).json({
      error: 'You have used your two free books. One-year access costs KSh 100.',
      reading: status
    });
  }

  if (!alreadyRead) {
    db.prepare(
      'INSERT INTO reads(user_id,book_id) VALUES(?,?)'
    ).run(req.session.userId, id);
  }

  res.json({
    book,
    reading: readingStatus(req.session.userId)
  });
});

// Download an original manuscript.
app.get('/api/books/:id/download', requireUser, (req, res) => {
  const id = Number(req.params.id);

  const book = db.prepare(`
    SELECT title,manuscript_path
    FROM books
    WHERE id=? AND published=1
  `).get(id);

  if (!book || !book.manuscript_path ||
      !fs.existsSync(book.manuscript_path)) {
    return res.status(404).json({
      error: 'Original manuscript download is not available.'
    });
  }

  const status = readingStatus(req.session.userId);

  const alreadyRead = db.prepare(
    'SELECT 1 FROM reads WHERE user_id=? AND book_id=?'
  ).get(req.session.userId, id);

  if (!alreadyRead && !status.hasAccess && status.booksRead >= 2) {
    return res.status(402).json({
      error: 'Reading access is required to download this book.'
    });
  }

  res.download(
    book.manuscript_path,
    path.basename(book.manuscript_path)
  );
});

// Submit manual M-Pesa payment.
app.post('/api/payments', requireUser, paymentLimiter, (req, res, next) => {
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

  if (subscriptionFor(req.session.userId)) {
    return res.status(409).json({
      error: 'Your reading access is already active.'
    });
  }

  try {
    db.prepare(`
      INSERT INTO payments(user_id,amount_kes,transaction_code,payer_name)
      VALUES(?,?,?,?)
    `).run(
      req.session.userId,
      Number(process.env.ACCESS_PRICE_KES || 100),
      code,
      payerName
    );

    res.status(201).json({
      message: 'Payment submitted for administrator verification.'
    });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      return res.status(409).json({
        error: 'This transaction code was already submitted.'
      });
    }

    next(error);
  }
});

app.get('/api/payments/mine', requireUser, (req, res) => {
  res.json({
    payments: db.prepare(`
      SELECT amount_kes,transaction_code,status,submitted_at,reviewed_at,admin_note
      FROM payments
      WHERE user_id=?
      ORDER BY id DESC
    `).all(req.session.userId)
  });
});

// Author manuscript submission.
app.post(
  '/api/authors/submissions',
  requireUser,
  upload.single('manuscript'),
  (req, res, next) => {
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
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      title.length < 2 ||
      title.length > 180 ||
      description.length < 10 ||
      description.length > 2000 ||
      !categories.includes(category)
    ) {
      removeFile(req.file.path);

      return res.status(400).json({
        error: 'Check the author name, email, title, category and description.'
      });
    }

    try {
      db.prepare(`
        INSERT INTO author_submissions
        (user_id,author_name,email,title,category,description,manuscript_path)
        VALUES(?,?,?,?,?,?,?)
      `).run(
        req.session.userId,
        authorName,
        email,
        title,
        category,
        description,
        req.file.path
      );

      res.status(201).json({
        message: 'Your manuscript was submitted for administrator review.'
      });
    } catch (error) {
      removeFile(req.file.path);
      next(error);
    }
  }
);

// All admin endpoints require administrator access.
app.use('/api/admin', requireAdmin);

app.get('/api/admin/summary', (req, res) => {
  res.json({
    users: db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role='reader'"
    ).get().n,

    books: db.prepare(
      'SELECT COUNT(*) AS n FROM books WHERE published=1'
    ).get().n,

    pendingPayments: db.prepare(
      "SELECT COUNT(*) AS n FROM payments WHERE status='pending'"
    ).get().n,

    pendingAuthors: db.prepare(
      "SELECT COUNT(*) AS n FROM author_submissions WHERE status='pending'"
    ).get().n
  });
});

// Admin book listing.
app.get('/api/admin/books', (req, res) => {
  const books = db.prepare(`
    SELECT id,title,author,category,description,published,
           cover_path,manuscript_path,created_at
    FROM books
    ORDER BY id DESC
  `).all();

  res.json({
    books: books.map(book => ({
      ...book,
      coverUrl: book.cover_path
        ? '/covers/' + path.basename(book.cover_path)
        : null,

      hasManuscript: Boolean(
        book.manuscript_path &&
        fs.existsSync(book.manuscript_path)
      )
    }))
  });
});

// Admin publishing with PDF extraction.
app.post(
  '/api/admin/books',
  upload.fields([
    { name: 'cover', maxCount: 1 },
    { name: 'manuscript', maxCount: 1 }
  ]),
  async (req, res, next) => {
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
      removeFile(manuscript?.path);
      removeFile(cover?.path);

      return res.status(400).json({
        error: 'Enter a valid title, author, category, description and manuscript.'
      });
    }

    let content;

    try {
      content = await extractManuscriptContent(
        manuscript.path,
        manuscript.originalname
      );

      if (
        path.extname(manuscript.originalname).toLowerCase() === '.pdf' &&
        !content.trim()
      ) {
        removeFile(manuscript.path);
        removeFile(cover?.path);

        return res.status(400).json({
          error: 'No selectable text was found in this PDF. A scanned PDF may require OCR.'
        });
      }
    } catch (error) {
      console.error('Manuscript extraction failed:', error);

      removeFile(manuscript.path);
      removeFile(cover?.path);

      return res.status(400).json({
        error: 'Could not read this manuscript. Check the file and try again.'
      });
    }

    try {
      const result = db.prepare(`
        INSERT INTO books
        (title,author,category,description,content,cover_path,manuscript_path,published)
        VALUES(?,?,?,?,?,?,?,1)
      `).run(
        title,
        author,
        category,
        description,
        content,
        cover?.path || null,
        manuscript.path
      );

      res.status(201).json({
        message: 'Book published successfully.',
        id: Number(result.lastInsertRowid)
      });
    } catch (error) {
      removeFile(manuscript.path);
      removeFile(cover?.path);
      next(error);
    }
  }
);

// Delete book and associated files.
app.delete('/api/admin/books/:id', (req, res, next) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid book ID.' });
  }

  const book = db.prepare(
    'SELECT id,cover_path,manuscript_path FROM books WHERE id=?'
  ).get(id);

  if (!book) {
    return res.status(404).json({ error: 'Book not found.' });
  }

  try {
    db.transaction(() => {
      db.prepare('DELETE FROM reads WHERE book_id=?').run(id);
      db.prepare('DELETE FROM books WHERE id=?').run(id);
    })();

    removeFile(book.cover_path);
    removeFile(book.manuscript_path);

    res.json({
      message: 'Book and its uploaded files were deleted.'
    });
  } catch (error) {
    next(error);
  }
});

// Download author manuscript for admin review.
app.get('/api/admin/authors/:id/download', (req, res) => {
  const submission = db.prepare(`
    SELECT manuscript_path
    FROM author_submissions
    WHERE id=?
  `).get(Number(req.params.id));

  if (!submission ||
      !submission.manuscript_path ||
      !fs.existsSync(submission.manuscript_path)) {
    return res.status(404).json({
      error: 'Manuscript file not found.'
    });
  }

  res.download(
    submission.manuscript_path,
    path.basename(submission.manuscript_path)
  );
});

// List author submissions.
app.get('/api/admin/authors', (req, res) => {
  res.json({
    submissions: db.prepare(`
      SELECT id,author_name,email,title,category,description,status,submitted_at
      FROM author_submissions
      ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,id DESC
    `).all()
  });
});

// Review author submission. PDF extraction happens BEFORE the transaction.
app.post('/api/admin/authors/:id/review', async (req, res, next) => {
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

  const submission = db.prepare(
    'SELECT * FROM author_submissions WHERE id=?'
  ).get(id);

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

  let content = '';

  if (decision === 'approve') {
    if (
      !submission.manuscript_path ||
      !fs.existsSync(submission.manuscript_path)
    ) {
      return res.status(404).json({
        error: 'The submitted manuscript file is missing.'
      });
    }

    try {
      content = await extractManuscriptContent(
        submission.manuscript_path,
        submission.manuscript_path
      );

      if (
        path.extname(submission.manuscript_path).toLowerCase() === '.pdf' &&
        !content.trim()
      ) {
        return res.status(400).json({
          error: 'No selectable text was found in this PDF. OCR may be required.'
        });
      }
    } catch (error) {
      console.error('Author PDF extraction failed:', error);

      return res.status(400).json({
        error: 'Could not extract manuscript text. Check the uploaded file.'
      });
    }
  }

  try {
    db.transaction(() => {
      if (decision === 'approve') {
        db.prepare(`
          INSERT INTO books
          (title,author,category,description,content,manuscript_path,published)
          VALUES(?,?,?,?,?,?,1)
        `).run(
          submission.title,
          submission.author_name,
          submission.category,
          submission.description,
          content,
          submission.manuscript_path
        );
      }

      db.prepare(`
        UPDATE author_submissions
        SET status=?,reviewed_at=CURRENT_TIMESTAMP,reviewed_by=?
        WHERE id=? AND status='pending'
      `).run(
        decision === 'approve' ? 'approved' : 'rejected',
        req.admin.id,
        id
      );
    })();

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
app.get('/api/admin/payments', (req, res) => {
  res.json({
    payments: db.prepare(`
      SELECT p.id,p.amount_kes,p.transaction_code,p.payer_name,
             p.status,p.submitted_at,u.name AS reader_name,
             u.email AS reader_email
      FROM payments p
      JOIN users u ON u.id=p.user_id
      ORDER BY CASE p.status WHEN 'pending' THEN 0 ELSE 1 END,p.id DESC
    `).all()
  });
});

// Approve or reject a manual payment.
app.post('/api/admin/payments/:id/review', (req, res, next) => {
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

  const payment = db.prepare(
    'SELECT * FROM payments WHERE id=?'
  ).get(id);

  if (!payment) {
    return res.status(404).json({
      error: 'Payment not found.'
    });
  }

  if (payment.status !== 'pending') {
    return res.status(409).json({
      error: 'Payment already reviewed.'
    });
  }

  try {
    db.transaction(() => {
      const updated = db.prepare(`
        UPDATE payments
        SET status=?,reviewed_at=CURRENT_TIMESTAMP,reviewed_by=?,admin_note=?
        WHERE id=? AND status='pending'
      `).run(
        decision === 'approve' ? 'approved' : 'rejected',
        req.admin.id,
        note,
        id
      );

      if (updated.changes !== 1) {
        throw new Error('Payment was already reviewed.');
      }

      if (decision === 'approve') {
        const now = new Date();

        const active = db.prepare(`
          SELECT expires_at FROM subscriptions
          WHERE user_id=? AND expires_at>?
          ORDER BY expires_at DESC
          LIMIT 1
        `).get(payment.user_id, now.toISOString());

        const start = active
          ? new Date(active.expires_at)
          : now;

        const end = new Date(
          start.getTime() +
          Number(process.env.ACCESS_DURATION_DAYS || 365) * 86400000
        );

        db.prepare(`
          INSERT INTO subscriptions(user_id,starts_at,expires_at,payment_id)
          VALUES(?,?,?,?)
        `).run(
          payment.user_id,
          start.toISOString(),
          end.toISOString(),
          id
        );
      }
    })();

    res.json({
      message: decision === 'approve'
        ? 'Payment approved and reading access activated.'
        : 'Payment rejected.'
    });
  } catch (error) {
    next(error);
  }
});

// Static files.
app.use('/covers', express.static(COVER_DIR, {
  dotfiles: 'deny',
  index: false
}));

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

  if (res.headersSent) return next(error);

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
    error: 'Server error. Check the terminal for details.'
  });
});

initializeAdmin()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`MindSpring Reads running at http://localhost:${PORT}`);
      console.log(`Database: ${DB_FILE}`);
      console.log('Manuscript formats:', [...allowedManuscripts].join(', '));
    });
  })
  .catch(error => {
    console.error('Could not initialize administrator:', error);
    process.exit(1);
  });
