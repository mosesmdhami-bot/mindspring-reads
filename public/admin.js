
'use strict';

const $ = selector => document.querySelector(selector);

const ALLOWED_MANUSCRIPT_EXTENSIONS = [
  'txt', 'md', 'pdf', 'doc', 'docx', 'rtf', 'odt',
  'epub', 'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'ods', 'odp'
];

const MAX_MANUSCRIPT_SIZE = 20 * 1024 * 1024;
const MAX_COVER_SIZE = 5 * 1024 * 1024;

let isRefreshing = false;

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };

  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers
  });

  let data = {};
  try {
    data = await response.json();
  } catch {}

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        data.error || 'Your administrator session has expired or access was denied. Please sign in again.'
      );
    }

    throw new Error(data.error || `Request failed (${response.status}).`);
  }

  return data;
}

function message(text, isError = false) {
  const element = $('#globalMessage') || $('#message');

  if (element) {
    element.textContent = text || '';
    element.className =
      'message' + (text ? (isError ? ' error' : ' success') : '');
  }
}

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text == null ? '' : String(text);
  return td;
}

function makeButton(label, className, action) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.className = className || '';
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await action();
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

function emptyRow(tbody, columns, text) {
  const tr = document.createElement('tr');
  const td = cell(text);
  td.colSpan = columns;
  td.className = 'empty';
  tr.appendChild(td);
  tbody.replaceChildren(tr);
}

async function loadSummary() {
  const s = await api('/api/admin/summary');

  if ($('#statBooks')) $('#statBooks').textContent = s.books ?? 0;
  if ($('#statUsers')) $('#statUsers').textContent = s.users ?? 0;
  if ($('#statAuthors')) $('#statAuthors').textContent = s.pendingAuthors ?? 0;
  if ($('#statPayments')) $('#statPayments').textContent = s.pendingPayments ?? 0;
}

async function loadBooks() {
  const data = await api('/api/admin/books');
  const tbody = $('#booksTable');

  if (!tbody) return;

  const books = Array.isArray(data.books) ? data.books : [];

  if (!books.length) {
    emptyRow(tbody, 5, 'No books uploaded yet.');
    return;
  }

  tbody.replaceChildren();

  for (const book of books) {
    const tr = document.createElement('tr');

    tr.append(
      cell(`${book.title || 'Untitled'} — ${book.author || 'Unknown author'}`),
      cell(book.category || 'Other'),
      cell(
        `${book.hasManuscript ? 'Manuscript saved' : 'No manuscript'}` +
        `${book.coverUrl ? ' · Cover saved' : ''}`
      ),
      cell(book.published ? 'Published' : 'Unpublished')
    );

    const actions = cell('');
    const wrap = document.createElement('div');
    wrap.className = 'actions';

    if (book.manuscript_path && book.hasManuscript) {
      const note = document.createElement('span');
      note.className = 'pill';
      note.textContent = 'Original file stored';
      wrap.appendChild(note);
    }

    wrap.appendChild(makeButton(
      'Delete book and files',
      'danger',
      async () => {
        const confirmed = confirm(
          `Delete "${book.title}" and its stored manuscript and cover? This cannot be undone.`
        );

        if (!confirmed) return;

        const result = await api(
          `/api/admin/books/${encodeURIComponent(book.id)}`,
          { method: 'DELETE' }
        );

        message(result.message || 'Book deleted.');
        await refreshAll();
      }
    ));

    actions.appendChild(wrap);
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
}

async function loadAuthors() {
  const data = await api('/api/admin/authors');
  const tbody = $('#authorsTable');

  if (!tbody) return;

  const submissions = Array.isArray(data.submissions)
    ? data.submissions
    : [];

  if (!submissions.length) {
    emptyRow(tbody, 5, 'No author submissions yet.');
    return;
  }

  tbody.replaceChildren();

  for (const sub of submissions) {
    const tr = document.createElement('tr');

    tr.append(
      cell(`${sub.title || 'Untitled'}\n${sub.category || 'Other'}`),
      cell(`${sub.author_name || 'Unknown'}\n${sub.email || ''}`),
      cell(sub.submitted_at || ''),
      cell(sub.status || 'unknown')
    );

    const actions = cell('');
    const wrap = document.createElement('div');
    wrap.className = 'actions';

    const download = document.createElement('a');
    download.href = `/api/admin/authors/${encodeURIComponent(sub.id)}/download`;
    download.textContent = 'Download';
    download.className = 'button secondary';
    wrap.appendChild(download);

    if (sub.status === 'pending') {
      wrap.appendChild(makeButton('Approve & publish', 'approve', async () => {
        if (!confirm(
          `Publish "${sub.title}"? Confirm that the author has permission to publish it.`
        )) return;

        const result = await api(
          `/api/admin/authors/${encodeURIComponent(sub.id)}/review`,
          {
            method: 'POST',
            body: JSON.stringify({ decision: 'approve' })
          }
        );

        message(result.message || 'Submission approved and published.');
        await refreshAll();
      }));

      wrap.appendChild(makeButton('Reject', 'reject', async () => {
        if (!confirm(`Reject "${sub.title}"?`)) return;

        const result = await api(
          `/api/admin/authors/${encodeURIComponent(sub.id)}/review`,
          {
            method: 'POST',
            body: JSON.stringify({ decision: 'reject' })
          }
        );

        message(result.message || 'Submission rejected.');
        await refreshAll();
      }));
    }

    actions.appendChild(wrap);
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
}

async function loadPayments() {
  const data = await api('/api/admin/payments');
  const tbody = $('#paymentsTable');

  if (!tbody) return;

  const payments = Array.isArray(data.payments) ? data.payments : [];

  if (!payments.length) {
    emptyRow(tbody, 5, 'No payment requests yet.');
    return;
  }

  tbody.replaceChildren();

  for (const p of payments) {
    const tr = document.createElement('tr');

    tr.append(
      cell(`${p.reader_name || 'Unknown reader'}\n${p.reader_email || ''}`),
      cell(`KSh ${p.amount_kes ?? 100}`),
      cell(p.transaction_code || ''),
      cell(p.status || 'unknown')
    );

    const actions = cell('');
    const wrap = document.createElement('div');
    wrap.className = 'actions';

    if (p.status === 'pending') {
      wrap.appendChild(makeButton('Approve', 'approve', async () => {
        if (!confirm(
          `Have you independently verified transaction ${p.transaction_code} for KSh ${p.amount_kes} in your M-Pesa records?`
        )) return;

        const note = prompt('Optional administrator note:', '') || '';

        const result = await api(
          `/api/admin/payments/${encodeURIComponent(p.id)}/review`,
          {
            method: 'POST',
            body: JSON.stringify({ decision: 'approve', note })
          }
        );

        message(result.message || 'Payment approved.');
        await refreshAll();
      }));

      wrap.appendChild(makeButton('Reject', 'reject', async () => {
        if (!confirm(`Reject payment ${p.transaction_code}?`)) return;

        const note = prompt('Optional reason for rejection:', '') || '';

        const result = await api(
          `/api/admin/payments/${encodeURIComponent(p.id)}/review`,
          {
            method: 'POST',
            body: JSON.stringify({ decision: 'reject', note })
          }
        );

        message(result.message || 'Payment rejected.');
        await refreshAll();
      }));
    } else {
      wrap.textContent = p.status === 'approved'
        ? 'Access activated'
        : 'Reviewed';
    }

    actions.appendChild(wrap);
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
}

async function refreshAll() {
  if (isRefreshing) return;

  isRefreshing = true;

  const refreshButton = $('#refreshButton');
  if (refreshButton) {
    refreshButton.disabled = true;
    refreshButton.textContent = 'Refreshing…';
  }

  message('Refreshing dashboard…');

  try {
    const me = await api('/api/auth/me');

    if (!me.user || me.user.role !== 'admin') {
      showLogin();
      return;
    }

    await Promise.all([
      loadSummary(),
      loadBooks(),
      loadAuthors(),
      loadPayments()
    ]);

    message('Dashboard updated.');
  } catch (error) {
    message(error.message || 'Could not refresh the dashboard.', true);
  } finally {
    isRefreshing = false;

    if (refreshButton) {
      refreshButton.disabled = false;
      refreshButton.textContent = 'Refresh dashboard';
    }
  }
}

function showLogin() {
  // If this dashboard's HTML contains its own login form, use it.
  // Otherwise show a clear instruction rather than a blank page.
  document.body.innerHTML = `
    <main style="max-width:600px;margin:70px auto;padding:24px;font-family:Arial,sans-serif">
      <h1>Administrator sign-in required</h1>
      <p>Your administrator session is missing or has expired.</p>
      <p>Please sign in with your administrator account on the main website, then reopen the dashboard.</p>
      <p><a href="/">Return to MindSpring Reads</a></p>
      <p><a href="/admin">Reload the administrator dashboard</a></p>
    </main>`;
}

const bookForm = $('#bookForm');

if (bookForm) {
  bookForm.addEventListener('submit', async event => {
    event.preventDefault();

    const submitButton = $('#publishButton') ||
      bookForm.querySelector('button[type="submit"]');

    const manuscript = bookForm.querySelector('[name="manuscript"]')?.files?.[0];
    const cover = bookForm.querySelector('[name="cover"]')?.files?.[0];

    if (!manuscript) {
      message('Please choose a manuscript file.', true);
      return;
    }

    const extension = manuscript.name.includes('.')
      ? manuscript.name.split('.').pop().toLowerCase()
      : '';

    if (!ALLOWED_MANUSCRIPT_EXTENSIONS.includes(extension)) {
      message('Unsupported manuscript file type.', true);
      return;
    }

    if (manuscript.size === 0 || manuscript.size > MAX_MANUSCRIPT_SIZE) {
      message('The manuscript must be larger than 0 bytes and no larger than 20 MB.', true);
      return;
    }

    if (cover) {
      const coverExtension = cover.name.includes('.')
        ? cover.name.split('.').pop().toLowerCase()
        : '';

      if (!['jpg', 'jpeg', 'png', 'webp'].includes(coverExtension)) {
        message('The cover must be a JPG, PNG, or WebP image.', true);
        return;
      }

      if (cover.size === 0 || cover.size > MAX_COVER_SIZE) {
        message('The cover must be larger than 0 bytes and no larger than 5 MB.', true);
        return;
      }
    }

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Publishing…';
    }

    message('Uploading manuscript…');

    try {
      const result = await api('/api/admin/books', {
        method: 'POST',
        body: new FormData(bookForm)
      });

      bookForm.reset();
      message(result.message || 'Book published successfully.');
      await refreshAll();
    } catch (error) {
      message(`Publishing failed: ${error.message}`, true);
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = 'Publish book';
      }
    }
  });
}

const refreshButton = $('#refreshButton');
if (refreshButton) {
  refreshButton.addEventListener('click', refreshAll);
}

const logoutButton = $('#logoutButton') || $('#logout');
if (logoutButton) {
  logoutButton.addEventListener('click', async () => {
    logoutButton.disabled = true;

    try {
      await api('/api/auth/logout', {
        method: 'POST',
        body: JSON.stringify({})
      });

      window.location.href = '/';
    } catch (error) {
      message(error.message, true);
      logoutButton.disabled = false;
    }
  });
}

refreshAll();
