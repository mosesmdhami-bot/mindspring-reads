
'use strict';

const $ = selector => document.querySelector(selector);

async function api(url, options = {}) {
  const isForm = options.body instanceof FormData;

  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {})
    }
  });

  let data = {};
  try {
    data = await response.json();
  } catch {}

  if (!response.ok) {
    throw new Error(data.error || 'Request failed. Please try again.');
  }

  return data;
}

function message(text) {
  const element = $('#message');
  if (element) element.textContent = text;
}

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text ?? '';
  return td;
}

function makeTable(headers, rows) {
  const table = document.createElement('table');
  table.className = 'admin-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  headers.forEach(header => {
    const th = document.createElement('th');
    th.textContent = header;
    headerRow.appendChild(th);
  });

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach(row => tbody.appendChild(row));
  table.appendChild(tbody);

  return table;
}

function showLogin() {
  document.body.innerHTML = `
    <header class="navbar">
      <a href="/" class="brand">
        <span class="brand-icon">M</span>
        MindSpring <span class="brand-light">Reads</span>
      </a>
      <a href="/" class="button button-outline">Back to website</a>
    </header>

    <main style="max-width:480px;margin:65px auto;padding:25px;">
      <div class="eyebrow">PRIVATE CONTROL PANEL</div>
      <h1 style="font-size:40px;">Administrator <em>login.</em></h1>
      <p>Sign in with your MindSpring Reads administrator account to manage books, author submissions and payments.</p>

      <form id="adminLoginForm"
        style="background:white;border:1px solid var(--line);border-radius:10px;padding:25px;">

        <label for="adminEmail">Administrator email</label>
        <input id="adminEmail" name="email" type="email"
          autocomplete="username" required
          placeholder="Enter administrator email">

        <label for="adminPassword" style="display:block;margin-top:16px;">
          Password
        </label>
        <input id="adminPassword" name="password" type="password"
          autocomplete="current-password" required
          placeholder="Enter your password">

        <p id="loginMessage" role="status"
          style="color:#a33;white-space:pre-wrap;"></p>

        <button id="loginButton" class="button button-dark full-width"
          type="submit">Sign in</button>
      </form>

      <p style="font-size:13px;margin-top:18px;">
        Use the administrator credentials configured for your website.
        Regular reader accounts cannot access the admin dashboard.
      </p>
    </main>
  `;

  $('#adminLoginForm').addEventListener('submit', async event => {
    event.preventDefault();

    const button = $('#loginButton');
    const status = $('#loginMessage');
    const email = $('#adminEmail').value.trim();
    const password = $('#adminPassword').value;

    button.disabled = true;
    button.textContent = 'Signing in...';
    status.textContent = '';

    try {
      const result = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });

      if (!result.user || result.user.role !== 'admin') {
        await api('/api/auth/logout', {
          method: 'POST',
          body: JSON.stringify({})
        });

        throw new Error(
          'This account is not an administrator. Use your admin account.'
        );
      }

      window.location.reload();
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });
}

async function load() {
  try {
    const me = await api('/api/auth/me');

    if (!me.user || me.user.role !== 'admin') {
      showLogin();
      return;
    }

    const [summary, payments, authors] = await Promise.all([
      api('/api/admin/summary'),
      api('/api/admin/payments'),
      api('/api/admin/authors')
    ]);

    $('#summary').replaceChildren(
      ...[
        ['Readers', summary.users],
        ['Published books', summary.books],
        ['Pending payments', summary.pendingPayments],
        ['Pending manuscripts', summary.pendingAuthors]
      ].map(([label, number]) => {
        const div = document.createElement('div');
        div.className = 'admin-stat';

        const strong = document.createElement('strong');
        strong.textContent = number;

        const span = document.createElement('span');
        span.textContent = label;

        div.append(strong, span);
        return div;
      })
    );

    renderPayments(payments.payments || []);
    renderAuthors(authors.submissions || []);

  } catch (error) {
    message(error.message);
  }
}

function renderPayments(items) {
  const container = $('#payments');

  if (!items.length) {
    container.textContent = 'No payment requests yet.';
    return;
  }

  const rows = items.map(payment => {
    const row = document.createElement('tr');

    row.append(
      cell(`${payment.reader_name}\n${payment.reader_email}`),
      cell(`KSh ${payment.amount_kes}\n${payment.payer_name}`),
      cell(payment.transaction_code),
      cell(`${payment.status}\n${payment.submitted_at}`)
    );

    const actions = cell('');

    if (payment.status === 'pending') {
      for (const [label, decision] of [
        ['Approve', 'approve'],
        ['Reject', 'reject']
      ]) {
        const button = document.createElement('button');
        button.className =
          `button ${decision === 'approve' ? 'button-dark' : 'button-outline'}`;
        button.textContent = label;

        button.addEventListener('click', async () => {
          if (
            decision === 'approve' &&
            !confirm(
              `Have you independently verified transaction ` +
              `${payment.transaction_code} for KSh ${payment.amount_kes} ` +
              `in your M-Pesa records?`
            )
          ) return;

          try {
            const note = prompt('Optional administrator note:', '') || '';

            await api(`/api/admin/payments/${payment.id}/review`, {
              method: 'POST',
              body: JSON.stringify({ decision, note })
            });

            message(`Payment ${decision} request processed.`);
            await load();
          } catch (error) {
            message(error.message);
          }
        });

        actions.appendChild(button);
      }
    } else {
      actions.textContent = payment.status === 'approved'
        ? 'Access activated'
        : 'No further action';
    }

    row.appendChild(actions);
    return row;
  });

  container.replaceChildren(
    makeTable(
      ['Reader', 'Amount / payer', 'Transaction code', 'Status / submitted', 'Actions'],
      rows
    )
  );
}

function renderAuthors(items) {
  const container = $('#authors');

  if (!items.length) {
    container.textContent = 'No author submissions yet.';
    return;
  }

  const rows = items.map(author => {
    const row = document.createElement('tr');

    row.append(
      cell(`${author.title}\nBy ${author.author_name}\n${author.email}`),
      cell(`${author.category}\n${author.description}`),
      cell(`${author.status}\n${author.submitted_at}`)
    );

    const actions = cell('');

    if (author.status === 'pending') {
      for (const [label, decision] of [
        ['Approve & publish', 'approve'],
        ['Reject', 'reject']
      ]) {
        const button = document.createElement('button');
        button.className =
          `button ${decision === 'approve' ? 'button-dark' : 'button-outline'}`;
        button.textContent = label;

        button.addEventListener('click', async () => {
          if (
            decision === 'approve' &&
            !confirm(
              `Publish "${author.title}"? Confirm that the author has permission to publish it.`
            )
          ) return;

          try {
            await api(`/api/admin/authors/${author.id}/review`, {
              method: 'POST',
              body: JSON.stringify({ decision })
            });

            message(`Author submission ${decision} request processed.`);
            await load();
          } catch (error) {
            message(error.message);
          }
        });

        actions.appendChild(button);
      }
    }

    row.appendChild(actions);
    return row;
  });

  container.replaceChildren(
    makeTable(['Submission', 'Description', 'Status', 'Actions'], rows)
  );
}

const bookForm = $('#bookForm');

if (bookForm) {
  bookForm.addEventListener('submit', async event => {
    event.preventDefault();

    const form = event.currentTarget;
    const data = new FormData(form);

    try {
      const result = await api('/api/admin/books', {
        method: 'POST',
        body: data
      });

      message(result.message || 'Book published successfully.');
      form.reset();
      await load();
    } catch (error) {
      message(error.message);
    }
  });
}

const logoutButton = $('#logout');

if (logoutButton) {
  logoutButton.addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', {
        method: 'POST',
        body: JSON.stringify({})
      });

      window.location.href = '/admin';
    } catch (error) {
      message(error.message);
    }
  });
}

load();
