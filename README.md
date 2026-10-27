# MindSpring Reads — production backend starter

This adds a Node.js/Express backend to the existing MindSpring Reads HTML/CSS/JavaScript design. It is configured for KSh 100 for 365 days, manual M-Pesa review, the M-Pesa number 0792470754, two distinct free books per account, secure reader sessions, author submissions and an admin dashboard.

## Before you begin

- Install Node.js 20 LTS or newer from https://nodejs.org/.
- Keep a private backup of your current three website files.
- This backend uses SQLite. For production hosting, use a host with a persistent disk; otherwise the database and uploaded manuscripts may be lost on redeploy. Never put `.env`, the database, sessions, or uploaded manuscripts in a public GitHub repository.
- The author upload accepts `.txt` and `.md` text manuscripts up to 5 MB and optional JPG/PNG/WEBP cover images. PDF uploads are not enabled in this starter.

## 1. Put the existing design in `public/`

Copy your current `index.html`, `style.css`, and `script.js` into this project's `public` folder. Do not overwrite your original backup. The included `production.js` connects the existing visual interface to the server. Add this line immediately AFTER the existing `/script.js` or `script.js` line near the bottom of `public/index.html`, before `</body>`:

```html
<script src="/production.js"></script>
```

Keep the existing HTML IDs from the original MindSpring Reads design: `bookGrid`, `searchInput`, `freeCount`, `resultsLabel`, `readerModal`, `readerCategory`, `readerTitle`, `readerAuthor`, `readerContent`, `finishReading`, `paymentModal`, `paymentForm`, `payerName`, `transactionCode`, `copyNumber`, `authorForm`, `authorName`, `authorEmail`, `bookTitle`, `bookCategory`, `bookDescription`, `membershipBtn`, `bannerPayBtn`, and `noticeModal` / `noticeTitle` / `noticeMessage`. These are present in the supplied starter design.

The new `/admin` page and `/admin.js` are included separately and do not replace your public design.

## 2. Configure your private environment

From the project folder in VS Code, make a copy of `.env.example` named `.env`. Open `.env` and:

- Set `ADMIN_EMAIL` to the email you will use as the administrator.
- Set `ADMIN_PASSWORD` to a unique password of at least 14 characters. Do not use the example text.
- Set `SESSION_SECRET` to a long random secret (at least 32 characters).
- Keep `MPESA_NUMBER=0792470754`, `ACCESS_PRICE_KES=100`, and `ACCESS_DURATION_DAYS=365`.
- Keep `COOKIE_SECURE=false` for localhost. On an HTTPS production host, set `COOKIE_SECURE=true`.

Never commit `.env` to GitHub. It is already in `.gitignore`.

## 3. Install and run locally

Open VS Code's Terminal in this folder and run:

```bash
npm install
npm start
```

Open http://localhost:3000. Test account registration, login, opening two different books, trying a third book, submitting a payment code, and author manuscript submission. The five starter books contain short demonstration texts; replace them with content you own or have permission to publish.

To administer the site, log in through the public website with the `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `.env`, then visit http://localhost:3000/admin. Confirm an M-Pesa payment in your own transaction records before approving it. The admin approval action activates 365 days of reading access. Rejection does not grant access.

## 4. Publish the code safely

GitHub Pages alone cannot run this Node.js backend, sessions, database, uploads, or private reading routes. Deploy the entire Node.js project to a Node-compatible host that supports persistent storage (for example, a web service with a persistent disk). Configure the environment variables in that host's private dashboard, set `NODE_ENV=production`, `COOKIE_SECURE=true`, and set `SITE_URL` to the real HTTPS URL. Keep the SQLite database and uploads on the persistent disk. Test backups and restore before real customers use it.

You may keep the source in a private GitHub repository and connect the hosting provider to it. Do not publish user data, `.env`, session files, the SQLite database, or uploaded manuscripts to GitHub. If you use GitHub Pages for the front end instead, you must change the frontend API URLs to the deployed backend's HTTPS origin and configure strict CORS/credentials; the easiest first deployment is to serve `public/` from this same Node.js application.

## Important limits / launch checklist

- Manual M-Pesa verification is intentionally not automated. A transaction code is a claim, not proof. Check amount, recipient and transaction in M-Pesa before approving.
- The backend prevents the same transaction code being used twice and only administrators can approve/reject.
- Sessions are stored in SQLite, and password hashes use bcrypt. Keep the server updated and the secret private.
- Uploads are limited to text manuscripts and image covers. Add malware scanning, backups, account email verification, password reset and a privacy/terms page before a larger public launch.
- This starter does not send emails or M-Pesa STK pushes. It does not promise absolute DRM: any content displayed to a reader can potentially be copied. The API does enforce access before returning book text.
- Use HTTPS in production and do not host the SQLite database or uploads in a publicly served folder.
