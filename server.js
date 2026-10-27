require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const SQLiteStoreFactory = require('connect-sqlite3');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DB_FILE = path.resolve(ROOT, process.env.DATABASE_FILE || './data/mindspring.sqlite');
const UPLOAD_DIR = path.resolve(ROOT, process.env.UPLOAD_DIR || './uploads');
const COVER_DIR = path.join(UPLOAD_DIR, 'covers');
const MANUSCRIPT_DIR = path.join(UPLOAD_DIR, 'manuscripts');
for (const dir of [path.dirname(DB_FILE), UPLOAD_DIR, COVER_DIR, MANUSCRIPT_DIR]) fs.mkdirSync(dir, { recursive: true });
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error('SETUP ERROR: SESSION_SECRET must be at least 32 characters. Copy .env.example to .env and set it.');
  process.exit(1);
}
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.startsWith('CHANGE-')) {
  console.error('SETUP ERROR: Set ADMIN_EMAIL and a unique ADMIN_PASSWORD in .env before starting.');
  process.exit(1);
}

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'reader' CHECK(role IN ('reader','admin')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS books (
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, author TEXT NOT NULL,
 category TEXT NOT NULL, description TEXT NOT NULL, content TEXT NOT NULL,
 cover_path TEXT, published INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reads (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
 first_read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id, book_id)
);
CREATE TABLE IF NOT EXISTS payments (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 amount_kes INTEGER NOT NULL, transaction_code TEXT NOT NULL UNIQUE, payer_name TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT, reviewed_by INTEGER REFERENCES users(id), admin_note TEXT
);
CREATE TABLE IF NOT EXISTS subscriptions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 starts_at TEXT NOT NULL, expires_at TEXT NOT NULL, payment_id INTEGER NOT NULL REFERENCES payments(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS author_submissions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 author_name TEXT NOT NULL, email TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL,
 description TEXT NOT NULL, manuscript_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','approved','rejected')), submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reviewed_at TEXT, reviewed_by INTEGER REFERENCES users(id), admin_note TEXT
);
`);

const count = db.prepare('SELECT COUNT(*) AS n FROM books').get().n;
if (!count) {
  const samples = [
    ['The Power of Small Steps','MindSpring Editorial','Self-help','Build better habits through small, consistent actions.',`THE POWER OF SMALL STEPS\n\nINTRODUCTION\nBig changes often begin with small decisions repeated over time. A page read today or a skill practised for fifteen minutes can become part of a meaningful routine.\n\nCHAPTER ONE: BEGIN WHERE YOU ARE\nChoose one area where a small improvement would matter. Make the goal realistic and decide when you will practise it.\n\nCHAPTER TWO: CONSISTENCY OVER PERFECTION\nMotivation changes. A simple routine helps you continue when enthusiasm is low. Learn from setbacks instead of treating them as proof that you cannot improve.\n\nREFLECTION\nWhat small action can you take today that your future self will appreciate?\n\nThis is introductory demonstration content for MindSpring Reads.`,'#365b45'],
    ['Understanding Your Money','MindSpring Editorial','Finance','Learn the basics of budgeting, saving and financial goals.',`UNDERSTANDING YOUR MONEY\n\nINTRODUCTION\nFinancial confidence begins with understanding where money comes from, where it goes, and what you want it to accomplish.\n\nCHAPTER ONE: KNOW YOUR NUMBERS\nWrite down your income and regular expenses. Separate essential costs from optional spending.\n\nCHAPTER TWO: BUILD A SAVING HABIT\nSet a realistic savings target that fits your circumstances. Track your progress and build a plan for unexpected costs.\n\nCHAPTER THREE: PLAN BEFORE YOU SPEND\nGive your money a purpose. Review your plan when your circumstances change. Be cautious of promises of quick wealth.\n\nThis is introductory demonstration content, not personal financial advice.`,'#8c7040'],
    ['The Practice of Inner Peace','MindSpring Editorial','Spirituality','Explore reflection, gratitude and a calmer daily routine.',`THE PRACTICE OF INNER PEACE\n\nINTRODUCTION\nA meaningful life does not require every day to be easy. It can begin with learning to pause and respond thoughtfully.\n\nCHAPTER ONE: MAKE ROOM FOR QUIET\nSet aside a few minutes for prayer, meditation, journalling or quiet reflection, according to your own beliefs and values.\n\nCHAPTER TWO: PRACTISE GRATITUDE\nNotice the people and ordinary moments you appreciate. Gratitude does not mean denying difficulties.\n\nREFLECTION\nWhat deserves more of your attention today?\n\nThis is introductory demonstration content for MindSpring Reads.`,'#796a8c'],
    ['Learning How to Learn','MindSpring Editorial','Academic','Practical approaches to studying, memory and revision.',`LEARNING HOW TO LEARN\n\nINTRODUCTION\nEffective studying is not only about spending more hours with a book. It is also about using those hours well.\n\nCHAPTER ONE: ACTIVE RECALL\nClose your notes and explain the main ideas from memory. Revisit what you missed.\n\nCHAPTER TWO: SPACED PRACTICE\nReview important material over several sessions instead of leaving everything until the last night.\n\nCHAPTER THREE: ASK BETTER QUESTIONS\nExplain concepts in your own words and connect them with examples. Seek feedback when something remains unclear.\n\nThis is introductory demonstration content for MindSpring Reads.`,'#416a85'],
    ['Your First Steps in Technology','MindSpring Editorial','Technology','Understand digital skills and begin learning confidently.',`YOUR FIRST STEPS IN TECHNOLOGY\n\nINTRODUCTION\nTechnology becomes easier to understand when you divide large ideas into small practical tasks.\n\nCHAPTER ONE: LEARN THE FOUNDATIONS\nUnderstand files, folders, browsers, operating systems and networks.\n\nCHAPTER TWO: PRACTISE BY BUILDING\nChoose a small project, such as a personal webpage. Learn a concept and use it in your project.\n\nCHAPTER THREE: STAY SAFE ONLINE\nUse unique passwords, enable multifactor authentication, keep software updated and practise security testing only on systems you are authorised to test.\n\nThis is introductory demonstration content for MindSpring Reads.`,'#35776c']
  ];
  const insert = db.prepare('INSERT INTO books(title,author,category,description,content,published) VALUES(?,?,?,?,?,1)');
  const tx = db.transaction(() => samples.forEach(b => insert.run(...b.slice(0,5)))); tx();
}

(async () => {
  const adminEmail = process.env.ADMIN_EMAIL.trim().toLowerCase();
  const admin = db.prepare('SELECT id, role FROM users WHERE email=?').get(adminEmail);
  const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
  if (!admin) db.prepare('INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,\'admin\')').run(process.env.ADMIN_NAME || 'MindSpring Administrator', adminEmail, passwordHash);
  else if (admin.role !== 'admin') db.prepare('UPDATE users SET role=\'admin\', password_hash=? WHERE id=?').run(passwordHash, admin.id);
})();

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
const SQLiteStore = SQLiteStoreFactory(session);
app.use(session({
  name: 'msr.sid', secret: process.env.SESSION_SECRET,
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: path.dirname(DB_FILE) }),
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 1000 * 60 * 60 * 24 * 7 }
}));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts. Please wait and try again.' } });
const paymentLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many payment submissions. Please try again later.' } });
const categories = ['Self-help','Finance','Spirituality','Academic','Technology','Other'];
const safeUser = user => user ? ({ id: user.id, name: user.name, email: user.email, role: user.role }) : null;
function requireUser(req,res,next) { if (!req.session.userId) return res.status(401).json({ error: 'Please log in first.' }); next(); }
function requireAdmin(req,res,next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Please log in as administrator.' });
  const user = db.prepare('SELECT id,name,email,role FROM users WHERE id=?').get(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
  req.admin = user; next();
}
function subscriptionFor(userId) {
  const rows = db.prepare('SELECT expires_at FROM subscriptions WHERE user_id=? ORDER BY expires_at DESC').all(userId);
  const now = Date.now();
  return rows.find(row => new Date(row.expires_at).getTime() > now) || null;
}
function readingStatus(userId) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM reads WHERE user_id=?').get(userId).n;
  const subscription = subscriptionFor(userId);
  return { booksRead: count, freeBooksRemaining: Math.max(0, 2 - count), hasAccess: Boolean(subscription), expiresAt: subscription?.expires_at || null, priceKes: Number(process.env.ACCESS_PRICE_KES || 100), durationDays: Number(process.env.ACCESS_DURATION_DAYS || 365), mpesaNumber: process.env.MPESA_NUMBER || '0792470754' };
}
const storage = multer.diskStorage({
  destination: (req,file,cb) => cb(null, file.fieldname === 'cover' ? COVER_DIR : MANUSCRIPT_DIR),
  filename: (req,file,cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase())
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024, files: 2 }, fileFilter: (req,file,cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowed = file.fieldname === 'cover' ? ['.jpg','.jpeg','.png','.webp'] : ['.txt','.md'];
  if (!allowed.includes(ext)) return cb(new Error(file.fieldname === 'cover' ? 'Cover must be JPG, PNG or WEBP.' : 'Manuscript must be a TXT or MD text file.'));
  cb(null,true);
}});

app.get('/api/health', (req,res) => res.json({ ok: true, service: 'MindSpring Reads' }));
app.get('/api/config', (req,res) => res.json({ priceKes: Number(process.env.ACCESS_PRICE_KES || 100), durationDays: Number(process.env.ACCESS_DURATION_DAYS || 365), mpesaNumber: process.env.MPESA_NUMBER || '0792470754' }));
app.post('/api/auth/register', authLimiter, async (req,res,next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter a name between 2 and 80 characters.' });
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 180) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 10 || password.length > 200) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
    const hash = await bcrypt.hash(password,12);
    let result;
    try { result = db.prepare('INSERT INTO users(name,email,password_hash) VALUES(?,?,?)').run(name,email,hash); }
    catch (e) { if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'An account with that email already exists.' }); throw e; }
    req.session.userId = Number(result.lastInsertRowid);
    res.status(201).json({ user: safeUser(db.prepare('SELECT id,name,email,role FROM users WHERE id=?').get(req.session.userId)), reading: readingStatus(req.session.userId) });
  } catch(e) { next(e); }
});
app.post('/api/auth/login', authLimiter, async (req,res,next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!user || !(await bcrypt.compare(password,user.password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.userId = user.id;
      req.session.save(err2 => { if (err2) return next(err2); res.json({ user: safeUser(user), reading: readingStatus(user.id) }); });
    });
  } catch(e) { next(e); }
});
app.post('/api/auth/logout', (req,res) => req.session.destroy(() => { res.clearCookie('msr.sid'); res.json({ ok: true }); }));
app.get('/api/auth/me', (req,res) => {
  if (!req.session.userId) return res.json({ user: null, reading: null });
  const user = db.prepare('SELECT id,name,email,role FROM users WHERE id=?').get(req.session.userId);
  if (!user) return res.json({ user: null, reading: null });
  res.json({ user: safeUser(user), reading: readingStatus(user.id) });
});
app.get('/api/books', (req,res) => {
  const rows = db.prepare('SELECT id,title,author,category,description,cover_path FROM books WHERE published=1 ORDER BY id DESC').all();
  res.json({ books: rows.map(b => ({ ...b, coverUrl: b.cover_path ? `/covers/${path.basename(b.cover_path)}` : null })) });
});
app.get('/api/books/:id/read', requireUser, (req,res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid book.' });
  const book = db.prepare('SELECT id,title,author,category,description,content FROM books WHERE id=? AND published=1').get(id);
  if (!book) return res.status(404).json({ error: 'Book not found.' });
  const existing = db.prepare('SELECT 1 FROM reads WHERE user_id=? AND book_id=?').get(req.session.userId,id);
  const status = readingStatus(req.session.userId);
  if (!existing && !status.hasAccess && status.booksRead >= 2) return res.status(402).json({ error: 'You have used your two free books. Request one-year access for KSh 100.', reading: status });
  if (!existing) db.prepare('INSERT INTO reads(user_id,book_id) VALUES(?,?)').run(req.session.userId,id);
  res.json({ book, reading: readingStatus(req.session.userId) });
});
app.post('/api/payments', requireUser, paymentLimiter, (req,res) => {
  const payerName = String(req.body.payerName || '').trim();
  const code = String(req.body.transactionCode || '').trim().toUpperCase();
  if (payerName.length < 2 || payerName.length > 100) return res.status(400).json({ error: 'Enter the payer name.' });
  if (!/^[A-Z0-9]{6,20}$/.test(code)) return res.status(400).json({ error: 'Enter a valid-looking M-Pesa transaction code.' });
  if (subscriptionFor(req.session.userId)) return res.status(409).json({ error: 'Your reading access is already active.' });
  try {
    db.prepare('INSERT INTO payments(user_id,amount_kes,transaction_code,payer_name) VALUES(?,?,?,?)').run(req.session.userId,Number(process.env.ACCESS_PRICE_KES || 100),code,payerName);
    res.status(201).json({ message: 'Payment request submitted for manual review. Access remains locked until the administrator confirms the payment.' });
  } catch(e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'That transaction code has already been submitted.' });
    throw e;
  }
});
app.get('/api/payments/mine', requireUser, (req,res) => res.json({ payments: db.prepare('SELECT amount_kes,transaction_code,status,submitted_at,reviewed_at,admin_note FROM payments WHERE user_id=? ORDER BY id DESC').all(req.session.userId) }));
app.post('/api/authors/submissions', requireUser, upload.single('manuscript'), (req,res) => {
  const authorName = String(req.body.authorName || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const title = String(req.body.title || '').trim();
  const category = String(req.body.category || 'Other');
  const description = String(req.body.description || '').trim();
  if (!req.file) return res.status(400).json({ error: 'Upload a TXT or MD manuscript (maximum 5 MB).' });
  if (authorName.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || title.length < 2 || title.length > 180 || description.length < 10 || description.length > 2000 || !categories.includes(category)) {
    fs.unlink(req.file.path,()=>{}); return res.status(400).json({ error: 'Check the author name, email, title, category and description.' });
  }
  db.prepare('INSERT INTO author_submissions(user_id,author_name,email,title,category,description,manuscript_path) VALUES(?,?,?,?,?,?,?)').run(req.session.userId,authorName,email,title,category,description,req.file.path);
  res.status(201).json({ message: 'Your manuscript was submitted for administrator review.' });
});
app.use('/api/admin', requireAdmin);
app.get('/api/admin/summary', (req,res) => res.json({ users: db.prepare('SELECT COUNT(*) n FROM users WHERE role=\'reader\'').get().n, books: db.prepare('SELECT COUNT(*) n FROM books WHERE published=1').get().n, pendingPayments: db.prepare('SELECT COUNT(*) n FROM payments WHERE status=\'pending\'').get().n, pendingAuthors: db.prepare('SELECT COUNT(*) n FROM author_submissions WHERE status=\'pending\'').get().n }));
app.get('/api/admin/payments', (req,res) => res.json({ payments: db.prepare(`SELECT p.id,p.amount_kes,p.transaction_code,p.payer_name,p.status,p.submitted_at,u.name AS reader_name,u.email AS reader_email FROM payments p JOIN users u ON u.id=p.user_id ORDER BY CASE p.status WHEN 'pending' THEN 0 ELSE 1 END,p.id DESC LIMIT 500`).all() }));
app.post('/api/admin/payments/:id/review', (req,res) => {
  const id = Number(req.params.id); const decision = String(req.body.decision || '');
  if (!Number.isSafeInteger(id) || !['approve','reject'].includes(decision)) return res.status(400).json({ error: 'Invalid review request.' });
  const payment = db.prepare('SELECT * FROM payments WHERE id=?').get(id);
  if (!payment) return res.status(404).json({ error: 'Payment request not found.' });
  if (payment.status !== 'pending') return res.status(409).json({ error: 'This payment has already been reviewed.' });
  const note = String(req.body.note || '').trim().slice(0,500);
  const tx = db.transaction(() => {
    db.prepare('UPDATE payments SET status=?,reviewed_at=CURRENT_TIMESTAMP,reviewed_by=?,admin_note=? WHERE id=?').run(decision === 'approve' ? 'approved' : 'rejected',req.admin.id,note,id);
    if (decision === 'approve') {
      const now = new Date();
      const active = db.prepare('SELECT expires_at FROM subscriptions WHERE user_id=? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1').get(payment.user_id,now.toISOString());
      const start = active ? new Date(active.expires_at) : now;
      const expires = new Date(start.getTime() + Number(process.env.ACCESS_DURATION_DAYS || 365) * 86400000);
      db.prepare('INSERT INTO subscriptions(user_id,starts_at,expires_at,payment_id) VALUES(?,?,?,?)').run(payment.user_id,start.toISOString(),expires.toISOString(),id);
    }
  });
  tx(); res.json({ message: decision === 'approve' ? 'Payment approved and one-year access activated.' : 'Payment rejected.' });
});
app.get('/api/admin/authors', (req,res) => res.json({ submissions: db.prepare(`SELECT a.id,a.author_name,a.email,a.title,a.category,a.description,a.status,a.submitted_at,u.name AS account_name FROM author_submissions a LEFT JOIN users u ON u.id=a.user_id ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END,a.id DESC LIMIT 500`).all() }));
app.post('/api/admin/authors/:id/review', (req,res) => {
  const id = Number(req.params.id); const decision = String(req.body.decision || '');
  if (!Number.isSafeInteger(id) || !['approve','reject'].includes(decision)) return res.status(400).json({ error: 'Invalid review request.' });
  const sub = db.prepare('SELECT * FROM author_submissions WHERE id=?').get(id);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (sub.status !== 'pending') return res.status(409).json({ error: 'This submission has already been reviewed.' });
  const tx = db.transaction(() => {
    if (decision === 'approve') {
      const content = fs.readFileSync(sub.manuscript_path,'utf8');
      if (!content.trim()) throw new Error('The manuscript is empty.');
      db.prepare('INSERT INTO books(title,author,category,description,content,published) VALUES(?,?,?,?,?,1)').run(sub.title,sub.author_name,sub.category,sub.description,content);
    }
    db.prepare('UPDATE author_submissions SET status=?,reviewed_at=CURRENT_TIMESTAMP,reviewed_by=? WHERE id=?').run(decision === 'approve' ? 'approved' : 'rejected',req.admin.id,id);
  });
  tx(); res.json({ message: decision === 'approve' ? 'Author material approved and published.' : 'Author submission rejected.' });
});
app.post('/api/admin/books', upload.fields([{name:'cover',maxCount:1},{name:'manuscript',maxCount:1}]), (req,res) => {
  const title = String(req.body.title || '').trim(); const author = String(req.body.author || '').trim();
  const category = String(req.body.category || 'Other'); const description = String(req.body.description || '').trim();
  const manuscript = req.files?.manuscript?.[0]; const cover = req.files?.cover?.[0];
  if (title.length < 2 || author.length < 2 || !categories.includes(category) || description.length < 10 || !manuscript) {
    if (manuscript) fs.unlink(manuscript.path,()=>{}); if (cover) fs.unlink(cover.path,()=>{});
    return res.status(400).json({ error: 'Provide title, author, category, description and a TXT/MD manuscript.' });
  }
  const content = fs.readFileSync(manuscript.path,'utf8');
  if (!content.trim()) return res.status(400).json({ error: 'Manuscript is empty.' });
  const result = db.prepare('INSERT INTO books(title,author,category,description,content,cover_path,published) VALUES(?,?,?,?,?,?,1)').run(title,author,category,description,content,cover ? cover.path : null);
  fs.unlink(manuscript.path,()=>{});
  res.status(201).json({ message: 'Book published.', id: Number(result.lastInsertRowid) });
});
app.use('/covers', express.static(COVER_DIR, { fallthrough: false, dotfiles: 'deny', index: false }));
app.use(express.static(path.join(ROOT,'public')));
app.get('/admin', (req,res) => res.sendFile(path.join(ROOT,'public','admin.html')));
app.get('/author', (req,res) => res.sendFile(path.join(ROOT,'public','author.html')));
app.get('*', (req,res) => res.sendFile(path.join(ROOT,'public','index.html')));
app.use((err,req,res,next) => {
  console.error(err.message);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Upload failed or file is too large (maximum 5 MB).' });
  if (err.message && /Cover must|Manuscript must/.test(err.message)) return res.status(400).json({ error: err.message });
  res.status(500).json({ error: 'Something went wrong. Please try again later.' });
});
app.listen(PORT, () => console.log(`MindSpring Reads running at http://localhost:${PORT}`));
