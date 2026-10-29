
"use strict";

/* =========================================================
   MINDSRING READS
   Frontend controller for the existing Node.js backend.
   Preserves the existing database and uploaded files.
   ========================================================= */

const API_BASE = "/api";

let currentUser = null;
let allBooks = [];
let currentBook = null;
let currentReaderText = "";
let readerFontSize = 17;
let readerDarkMode = false;
let readerSearchTerm = "";
let savedReaderPosition = 0;
let publicConfig = {
  priceKes: 100,
  durationDays: 365,
  mpesaNumber: ""
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const byId = (id) => document.getElementById(id);

function normalise(value) {
  return String(value ?? "").trim().toLowerCase();
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function setMessage(target, message, type = "info") {
  const element = typeof target === "string" ? byId(target) : target;
  if (!element) return;

  element.textContent = message;
  element.dataset.state = type;
  element.setAttribute("role", type === "error" ? "alert" : "status");
}

/* -------------------- API -------------------- */

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const isFormData = options.body instanceof FormData;

  if (options.body && !isFormData && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  headers.set("Accept", "application/json");

  let response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      credentials: "same-origin"
    });
  } catch {
    throw new Error(
      "Cannot reach the server. Make sure Node.js is running."
    );
  }

  const text = await response.text();
  let data = {};

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!response.ok) {
    throw new Error(
      data.message ||
      data.error ||
      `Request failed (${response.status}).`
    );
  }

  return data;
}

/* -------------------- Notifications -------------------- */

function showNotice(message, title = "MindSpring Reads") {
  const modal = byId("messageModal");
  const text = byId("messageText");
  const heading = byId("messageTitle");

  if (modal && text) {
    text.textContent = message;
    if (heading) heading.textContent = title;
    openModal(modal);
  } else {
    window.alert(message);
  }
}

/* -------------------- Modals -------------------- */

function openModal(modalOrId) {
  const modal = typeof modalOrId === "string"
    ? byId(modalOrId)
    : modalOrId;

  if (!modal) {
    console.warn("Modal not found:", modalOrId);
    return;
  }

  // Close other dialogs to avoid stacked backdrops.
  $$(".modal.open:not([hidden])").forEach((other) => {
    if (other !== modal) closeModal(other);
  });

  modal.hidden = false;
  modal.classList.add("active", "open", "show");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");

  const focusable = $(
    "input:not([type='hidden']), textarea, select, button",
    modal
  );

  if (focusable) {
    window.setTimeout(() => focusable.focus(), 50);
  }
}

function closeModal(modalOrId) {
  const modal = typeof modalOrId === "string"
    ? byId(modalOrId)
    : modalOrId;

  if (!modal) return;

  modal.classList.remove("active", "open", "show");
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");

  if (!$(".modal.open:not([hidden])")) {
    document.body.classList.remove("modal-open");
  }
}

function closeAllModals() {
  $$(".modal").forEach(closeModal);
}

function setupModalEvents() {
  $$(".modal").forEach((modal) => {
    // Supports both data-close and data-close-modal.
    $$(
      ".close-modal, [data-close], [data-close-modal]",
      modal
    ).forEach((button) => {
      button.addEventListener("click", () => closeModal(modal));
    });

    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeModal(modal);
    });

    modal.hidden = true;
    modal.classList.remove("active", "open", "show");
    modal.setAttribute("aria-hidden", "true");
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const modal = $(".modal.open:not([hidden])");
      if (modal) closeModal(modal);
    }
  });
}

/* -------------------- Configuration -------------------- */

async function loadPublicConfig() {
  try {
    const result = await api("/config");
    const config = result.config || result;

    publicConfig = {
      ...publicConfig,
      ...config
    };

    updatePaymentInstructions();
  } catch (error) {
    console.warn("Configuration could not be loaded:", error.message);
  }
}

function updatePaymentInstructions() {
  const numberElement = byId("mpesaNumber");

  if (numberElement) {
    numberElement.textContent = publicConfig.mpesaNumber || "Contact the administrator";
  }

  $$("[data-access-price]").forEach((element) => {
    element.textContent = `KSh ${publicConfig.priceKes}`;
  });

  $$("[data-access-duration]").forEach((element) => {
    element.textContent = `${publicConfig.durationDays} days`;
  });
}

/* -------------------- Account and session -------------------- */

function updateAccountUI() {
  const display = byId("currentUserDisplay");
  const loginButton = byId("loginBtn");
  const registerButton = byId("registerBtn");
  const logoutButton = byId("logoutBtn");

  if (display) {
    display.textContent = currentUser
      ? `Signed in as ${
          currentUser.name ||
          currentUser.fullName ||
          currentUser.email ||
          "Reader"
        }`
      : "You are browsing as a guest.";
  }

  if (loginButton) loginButton.hidden = Boolean(currentUser);
  if (registerButton) registerButton.hidden = Boolean(currentUser);
  if (logoutButton) logoutButton.hidden = !currentUser;

  // Do not assume an administrator role from a displayed name.
  const adminOnly = $$("[data-admin-only]");
  const isAdmin = Boolean(
    currentUser &&
    (
      currentUser.isAdmin === true ||
      currentUser.role === "admin"
    )
  );

  adminOnly.forEach((element) => {
    element.hidden = !isAdmin;
  });

  updateAccessStatus();
}

function updateAccessStatus(reading = null) {
  const elements = [
    byId("freeCount"),
    byId("readerAccessStatus")
  ].filter(Boolean);

  let message = "Sign in to track your free books.";

  if (currentUser && reading?.hasAccess) {
    message = "Your reader access is active.";
  } else if (
    currentUser &&
    reading?.freeBooksRemaining !== undefined
  ) {
    message =
      `${reading.freeBooksRemaining} free book(s) remaining.`;
  } else if (currentUser) {
    message = "Your reading account is ready.";
  }

  elements.forEach((element) => {
    element.textContent = message;
  });
}

async function checkSession() {
  try {
    const result = await api("/auth/me");
    currentUser = result.user || null;
    updateAccountUI();
    updateAccessStatus(result.reading || null);
  } catch (error) {
    console.warn("Session check failed:", error.message);
    currentUser = null;
    updateAccountUI();
  }
}

function openLogin() {
  closeModal("registerModal");
  openModal("loginModal");
}

function openRegister() {
  closeModal("loginModal");
  openModal("registerModal");
}

async function handleLogin(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const button = $("button[type='submit']", form);
  const message = byId("loginMessage");

  const email = String(form.elements.email?.value || "").trim();
  const password = String(form.elements.password?.value || "");

  if (!email || !password) {
    setMessage(message, "Enter your email and password.", "error");
    return;
  }

  if (button) button.disabled = true;

  try {
    const result = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    currentUser = result.user || null;
    updateAccountUI();
    updateAccessStatus(result.reading || null);

    form.reset();
    closeModal("loginModal");

    await loadBooks();
    showNotice("You have signed in successfully.");
  } catch (error) {
    setMessage(message, error.message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function handleRegister(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const button = $("button[type='submit']", form);
  const message = byId("registerMessage");

  const formData = new FormData(form);
  const name = String(
    formData.get("name") ||
    formData.get("fullName") ||
    formData.get("full_name") ||
    ""
  ).trim();

  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");
  const confirmation =
    formData.get("confirmPassword") ??
    formData.get("confirm_password");

  if (!name || !email || !password) {
    setMessage(message, "Complete all required fields.", "error");
    return;
  }

  if (password.length < 10) {
    setMessage(
      message,
      "Your password must contain at least 10 characters.",
      "error"
    );
    return;
  }

  if (confirmation !== null && String(confirmation) !== password) {
    setMessage(message, "Your passwords do not match.", "error");
    return;
  }

  if (button) button.disabled = true;

  try {
    const result = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, email, password })
    });

    currentUser = result.user || null;
    updateAccountUI();
    updateAccessStatus(result.reading || null);

    form.reset();
    closeModal("registerModal");

    await loadBooks();
    showNotice("Your account has been created successfully.");
  } catch (error) {
    setMessage(message, error.message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function handleLogout() {
  try {
    await api("/auth/logout", { method: "POST" });
  } catch (error) {
    console.warn("Logout request failed:", error.message);
  }

  currentUser = null;
  updateAccountUI();
  await loadBooks();
  showNotice("You have signed out.");
}

/* -------------------- Navigation and buttons -------------------- */

function setupNavigation() {
  const mobileButton = byId("mobileMenuBtn");
  const navigation = byId("primaryNavigation");

  mobileButton?.addEventListener("click", () => {
    if (!navigation) return;

    const expanded =
      mobileButton.getAttribute("aria-expanded") === "true";

    mobileButton.setAttribute("aria-expanded", String(!expanded));
    navigation.classList.toggle("mobile-open", !expanded);
  });

  navigation?.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      navigation.classList.remove("mobile-open");
      mobileButton?.setAttribute("aria-expanded", "false");
    });
  });

  byId("loginBtn")?.addEventListener("click", openLogin);
  byId("registerBtn")?.addEventListener("click", openRegister);
  byId("logoutBtn")?.addEventListener("click", handleLogout);

  byId("switchToRegister")?.addEventListener("click", openRegister);
  byId("switchToLogin")?.addEventListener("click", openLogin);

  // The IDs below match the supplied index.html.
  byId("authorBtn")?.addEventListener("click", () => {
    if (!currentUser) {
      showNotice("Please sign in before submitting your manuscript.");
      openLogin();
      return;
    }

    openModal("authorModal");
  });

  byId("paymentBtn")?.addEventListener("click", () => {
    if (!currentUser) {
      showNotice("Please sign in before requesting reader access.");
      openLogin();
      return;
    }

    openModal("paymentModal");
  });

  // Support older versions of the page too.
  byId("openPaymentBtn")?.addEventListener("click", () => {
    if (!currentUser) {
      showNotice("Please sign in before requesting reader access.");
      openLogin();
      return;
    }

    openModal("paymentModal");
  });
}

/* -------------------- Book listing and search -------------------- */

function getBookId(book) {
  return book.id ?? book.book_id ?? "";
}

function getBookTitle(book) {
  return book.title || "Untitled book";
}

function getBookAuthor(book) {
  return book.author || book.authorName || "Unknown author";
}

function getBookCategory(book) {
  return book.category || "Other";
}

function getBookCover(book) {
  return book.coverUrl || book.cover_url || book.cover_path || "";
}

function getSelectedCategory() {
  const select = byId("bookCategoryFilter");

  if (select && select.value) {
    const value = normalise(select.value);

    if (
      value === "all" ||
      value === "all categories" ||
      value === "all categories "
    ) {
      return "";
    }

    return select.value;
  }

  const activeButton = $(".category-card.active[data-category]");
  return activeButton?.dataset.category || "";
}

function filterBooks() {
  const query = normalise(byId("bookSearch")?.value);
  const category = normalise(getSelectedCategory());

  const results = allBooks.filter((book) => {
    const matchesQuery = !query || [
      getBookTitle(book),
      getBookAuthor(book),
      getBookCategory(book),
      book.description
    ].some((value) => normalise(value).includes(query));

    const matchesCategory =
      !category ||
      category === "all" ||
      category === "all categories" ||
      normalise(getBookCategory(book)) === category;

    return matchesQuery && matchesCategory;
  });

  renderBooks(results);

  const message = byId("bookSearchMessage");
  if (message) {
    message.textContent = results.length
      ? `${results.length} book${results.length === 1 ? "" : "s"} found.`
      : "No books match your search. Try another title or category.";
  }
}

function renderBooks(books) {
  // Match the actual ID and class in the supplied index.html.
  const container =
    byId("booksContainer") ||
    byId("bookGrid") ||
    $(".books-grid") ||
    $(".book-grid");

  if (!container) {
    console.error("Library container was not found in index.html.");
    return;
  }

  container.replaceChildren();

  if (!books.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent =
      "No books found. Try another search or check back later.";
    container.appendChild(empty);
    return;
  }

  books.forEach((book, index) => {
    const card = document.createElement("article");
    card.className = "book-card";

    const cover = document.createElement("div");
    cover.className = "cover";

    const backgrounds = [
      "#183d32", "#58664b", "#785c43",
      "#495b69", "#735b75", "#536c65"
    ];

    cover.style.background = backgrounds[index % backgrounds.length];
    cover.style.position = "relative";
    cover.style.overflow = "hidden";

    const coverUrl = getBookCover(book);

    if (coverUrl) {
      const image = document.createElement("img");
      image.src = coverUrl;
      image.alt = `Cover of ${getBookTitle(book)}`;
      image.loading = "lazy";
      image.style.cssText =
        "width:100%;height:100%;object-fit:cover;position:absolute;inset:0;";

      image.addEventListener("error", () => image.remove());
      cover.appendChild(image);
    }

    const coverInner = document.createElement("div");
    coverInner.className = "cover-inner";

    const brand = document.createElement("small");
    brand.textContent = "MINDSPRING READS";

    const coverTitle = document.createElement("strong");
    coverTitle.textContent = getBookTitle(book);

    const coverAuthor = document.createElement("em");
    coverAuthor.textContent = getBookAuthor(book);

    coverInner.append(brand, coverTitle, coverAuthor);
    cover.appendChild(coverInner);

    const info = document.createElement("div");
    info.className = "book-info";

    const tag = document.createElement("span");
    tag.className = "book-tag";
    tag.textContent = getBookCategory(book);

    const title = document.createElement("h3");
    title.textContent = getBookTitle(book);

    const description = document.createElement("p");
    description.textContent =
      book.description ||
      "Explore this reading material on MindSpring Reads.";

    const meta = document.createElement("div");
    meta.className = "book-meta";

    const author = document.createElement("span");
    author.textContent = getBookAuthor(book);

    const access = document.createElement("span");
    access.textContent = "Read online";

    meta.append(author, access);

    const readButton = document.createElement("button");
    readButton.type = "button";
    readButton.className = "read-btn";
    readButton.textContent = "Read book";
    readButton.addEventListener("click", () => {
      readBook(getBookId(book));
    });

    info.append(tag, title, description, meta, readButton);
    card.append(cover, info);
    container.appendChild(card);
  });
}

async function loadBooks() {
  const container =
    byId("booksContainer") ||
    byId("bookGrid") ||
    $(".books-grid") ||
    $(".book-grid");

  if (container) {
    container.setAttribute("aria-busy", "true");
  }

  try {
    const result = await api("/books");

    allBooks = Array.isArray(result)
      ? result
      : Array.isArray(result.books)
        ? result.books
        : [];

    filterBooks();
  } catch (error) {
    console.error("Book loading failed:", error);

    if (container) {
      container.replaceChildren();

      const message = document.createElement("div");
      message.className = "empty-state";
      message.textContent =
        `We could not load the library: ${error.message}`;

      container.appendChild(message);
    }
  } finally {
    if (container) {
      container.removeAttribute("aria-busy");
    }
  }
}

function setupBookSearch() {
  const search = byId("bookSearch");
  const searchButton = byId("bookSearchBtn");
  const clearButton = byId("clearBookSearchBtn");
  const categorySelect = byId("bookCategoryFilter");

  search?.addEventListener("input", filterBooks);
  searchButton?.addEventListener("click", filterBooks);

  search?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      filterBooks();
    }
  });

  clearButton?.addEventListener("click", () => {
    if (search) search.value = "";
    if (categorySelect) categorySelect.value = "";

    $$(".category-card.active").forEach((button) => {
      button.classList.remove("active");
    });

    filterBooks();
  });

  categorySelect?.addEventListener("change", () => {
    $$(".category-card.active").forEach((button) => {
      button.classList.remove("active");
    });

    filterBooks();
  });

  $$("[data-category]").forEach((button) => {
    button.addEventListener("click", () => {
      const category = button.dataset.category || "";

      $$(".category-card.active").forEach((item) => {
        item.classList.remove("active");
      });

      button.classList.add("active");

      if (categorySelect) categorySelect.value = category;

      filterBooks();

      const library = byId("books") || byId("library");
      library?.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    });
  });
}

/* -------------------- Reader -------------------- */

function getReaderElements() {
  return {
    modal: byId("readerModal"),
    title: byId("readerTitle"),
    message: byId("readerMessage"),
    content: byId("readerContent"),
    progressBar: byId("readerProgressBar"),
    progressText: byId("readerProgressText"),
    searchInput: byId("readerSearchInput"),
    searchMessage: byId("readerSearchMessage")
  };
}

function getReaderStorageKey(bookId) {
  const account = currentUser?.id || currentUser?.email || "guest";
  return `mindspring-reader-${account}-${bookId}`;
}

function resetReader() {
  const elements = getReaderElements();

  currentReaderText = "";
  readerSearchTerm = "";
  savedReaderPosition = 0;

  if (elements.content) {
    elements.content.replaceChildren();
    elements.content.scrollTop = 0;
  }

  if (elements.searchInput) elements.searchInput.value = "";
  if (elements.searchMessage) elements.searchMessage.textContent = "";
  if (elements.message) elements.message.textContent = "";

  updateReaderProgress();
}

function getReaderParagraphs() {
  if (!currentReaderText.trim()) return [];

  return currentReaderText
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/);
}

function renderReaderText() {
  const { content } = getReaderElements();
  if (!content) return;

  content.replaceChildren();
  content.classList.toggle("dark-mode", readerDarkMode);
  content.style.fontSize = `${readerFontSize}px`;

  const paragraphs = getReaderParagraphs();

  if (!paragraphs.length) {
    const p = document.createElement("p");
    p.textContent = "There is no readable text available for this book yet.";
    content.appendChild(p);
  } else {
    paragraphs.forEach((text) => {
      const p = document.createElement("p");
      p.textContent = text;
      content.appendChild(p);
    });
  }

  if (readerSearchTerm) {
    highlightReaderSearch();
  }

  content.scrollTop = savedReaderPosition;
  updateReaderProgress();
}

function highlightReaderSearch() {
  const { content, searchMessage } = getReaderElements();
  if (!content) return;

  const previousScroll = content.scrollTop;
  const paragraphs = getReaderParagraphs();
  const query = readerSearchTerm.toLocaleLowerCase();
  let matches = 0;

  content.replaceChildren();

  paragraphs.forEach((text) => {
    const p = document.createElement("p");

    if (!query) {
      p.textContent = text;
      content.appendChild(p);
      return;
    }

    const lowerText = text.toLocaleLowerCase();
    let start = 0;
    let index = lowerText.indexOf(query);

    while (index !== -1) {
      p.appendChild(document.createTextNode(text.slice(start, index)));

      const mark = document.createElement("mark");
      mark.textContent = text.slice(index, index + readerSearchTerm.length);
      p.appendChild(mark);

      start = index + readerSearchTerm.length;
      matches++;
      index = lowerText.indexOf(query, start);
    }

    p.appendChild(document.createTextNode(text.slice(start)));
    content.appendChild(p);
  });

  content.scrollTop = previousScroll;

  if (searchMessage) {
    searchMessage.textContent = readerSearchTerm
      ? `${matches} match${matches === 1 ? "" : "es"} found.`
      : "";
  }
}

function searchReader() {
  readerSearchTerm =
    getReaderElements().searchInput?.value.trim() || "";

  highlightReaderSearch();
}

function clearReaderSearch() {
  const input = getReaderElements().searchInput;
  if (input) input.value = "";

  readerSearchTerm = "";
  highlightReaderSearch();
}

function updateReaderProgress() {
  const { content, progressBar, progressText } = getReaderElements();
  if (!content) return;

  const scrollable = content.scrollHeight - content.clientHeight;
  const percent = scrollable > 0
    ? Math.round((content.scrollTop / scrollable) * 100)
    : 100;

  if (progressBar) {
    progressBar.style.width = `${percent}%`;
    progressBar.setAttribute("aria-valuenow", String(percent));
  }

  if (progressText) {
    progressText.textContent = `${percent}% read`;
  }
}

function saveReaderPosition() {
  const { content } = getReaderElements();
  if (!content || !currentBook) return;

  savedReaderPosition = content.scrollTop;

  try {
    localStorage.setItem(
      getReaderStorageKey(getBookId(currentBook)),
      String(savedReaderPosition)
    );
  } catch {
    // Reader still works if local storage is unavailable.
  }

  updateReaderProgress();
}

function restoreReaderPosition(bookId) {
  const { content } = getReaderElements();
  if (!content) return;

  try {
    const saved = localStorage.getItem(getReaderStorageKey(bookId));
    savedReaderPosition = Math.max(0, Number(saved) || 0);
  } catch {
    savedReaderPosition = 0;
  }

  content.scrollTop = savedReaderPosition;
}

async function readBook(bookId) {
  if (!bookId) {
    showNotice("This book does not have a valid ID.");
    return;
  }

  currentBook = allBooks.find(
    (book) => String(getBookId(book)) === String(bookId)
  ) || { id: bookId, title: "Book" };

  resetReader();

  const elements = getReaderElements();

  if (elements.title) {
    elements.title.textContent = getBookTitle(currentBook);
  }

  if (elements.message) {
    elements.message.textContent = "Loading your book...";
  }

  openModal("readerModal");

  try {
    const result = await api(
      `/books/${encodeURIComponent(bookId)}/read`
    );

    const book = result.book || result;
    currentBook = book;

    if (elements.title) {
      elements.title.textContent = getBookTitle(book);
    }

    const readerAuthor = byId("readerAuthor");
    if (readerAuthor) {
      readerAuthor.textContent = getBookAuthor(book);
    }

    currentReaderText = String(
      book.content ||
      book.text ||
      book.extractedText ||
      ""
    );

    const reading = result.reading || {};
    updateAccessStatus(reading);

    if (reading.mpesaNumber) {
      publicConfig.mpesaNumber = reading.mpesaNumber;
    }

    if (reading.priceKes) {
      publicConfig.priceKes = reading.priceKes;
    }

    updatePaymentInstructions();

    if (elements.message) {
      elements.message.textContent = currentReaderText.trim()
        ? ""
        : "No readable text is available for this book yet. Please contact the administrator.";
    }

    restoreReaderPosition(getBookId(book));
    renderReaderText();
  } catch (error) {
    if (elements.message) {
      elements.message.textContent = error.message;
    } else {
      showNotice(error.message);
    }

    const message = normalise(error.message);

    if (
      message.includes("access") ||
      message.includes("subscription") ||
      message.includes("payment")
    ) {
      showNotice(
        "You may need reader access to open this book. You can request access from the Reader Access section."
      );
    }
  }
}

/* -------------------- Reader toolbar -------------------- */

function setupReaderControls() {
  byId("readerDecreaseFont")?.addEventListener("click", () => {
    readerFontSize = Math.max(12, readerFontSize - 1);

    const content = byId("readerContent");
    if (content) content.style.fontSize = `${readerFontSize}px`;
  });

  byId("readerIncreaseFont")?.addEventListener("click", () => {
    readerFontSize = Math.min(30, readerFontSize + 1);

    const content = byId("readerContent");
    if (content) content.style.fontSize = `${readerFontSize}px`;
  });

  byId("readerThemeBtn")?.addEventListener("click", () => {
    readerDarkMode = !readerDarkMode;

    byId("readerContent")?.classList.toggle(
      "dark-mode",
      readerDarkMode
    );

    const button = byId("readerThemeBtn");

    if (button) {
      button.textContent = readerDarkMode ? "Light mode" : "Dark mode";
      button.setAttribute("aria-pressed", String(readerDarkMode));
    }
  });

  byId("readerSearchBtn")?.addEventListener("click", searchReader);
  byId("readerClearSearch")?.addEventListener("click", clearReaderSearch);

  byId("readerSearchInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchReader();
    }
  });

  byId("readerTopBtn")?.addEventListener("click", () => {
    byId("readerContent")?.scrollTo({
      top: 0,
      behavior: "smooth"
    });
  });

  const content = byId("readerContent");

  if (content) {
    content.addEventListener("scroll", saveReaderPosition, {
      passive: true
    });
  }
}

/* -------------------- Reader access payment -------------------- */

async function handlePayment(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const button = $("button[type='submit']", form);
  const message = byId("paymentMessage");

  if (!currentUser) {
    setMessage(
      message,
      "Please sign in before requesting reader access.",
      "error"
    );
    openLogin();
    return;
  }

  const payerName = String(
    byId("payerName")?.value || ""
  ).trim();

  const payerEmail = String(
    byId("payerEmail")?.value || ""
  ).trim();

  const transactionCode = String(
    byId("transactionCode")?.value || ""
  ).trim().toUpperCase();

  if (!payerName || !payerEmail || !transactionCode) {
    setMessage(
      message,
      "Enter your name, email, and M-Pesa transaction code.",
      "error"
    );
    return;
  }

  if (button) button.disabled = true;

  try {
    // The existing backend contract accepts payerName and transactionCode.
    const result = await api("/payments", {
      method: "POST",
      body: JSON.stringify({
        payerName,
        transactionCode
      })
    });

    setMessage(
      message,
      result.message ||
        "Your payment details have been submitted for verification.",
      "success"
    );

    form.reset();
  } catch (error) {
    setMessage(message, error.message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

/* -------------------- Author manuscript submission -------------------- */

async function handleAuthorSubmission(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const button = $("button[type='submit']", form);
  const message = byId("authorMessage");

  if (!currentUser) {
    setMessage(
      message,
      "Please sign in before submitting your manuscript.",
      "error"
    );
    openLogin();
    return;
  }

  const file = byId("manuscript")?.files?.[0];

  if (!file) {
    setMessage(message, "Please select your manuscript file.", "error");
    return;
  }

  const maximumBytes = 20 * 1024 * 1024;

  if (file.size > maximumBytes) {
    setMessage(
      message,
      "The manuscript exceeds 20 MB. Please select a smaller file.",
      "error"
    );
    return;
  }

  if (button) button.disabled = true;

  try {
    const formData = new FormData(form);

    const result = await api("/authors/submissions", {
      method: "POST",
      body: formData
    });

    setMessage(
      message,
      result.message ||
        "Your manuscript has been submitted for review.",
      "success"
    );

    form.reset();
  } catch (error) {
    setMessage(message, error.message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

/* -------------------- Forms -------------------- */

function setupForms() {
  byId("loginForm")?.addEventListener("submit", handleLogin);
  byId("registerForm")?.addEventListener("submit", handleRegister);
  byId("paymentForm")?.addEventListener("submit", handlePayment);
  byId("authorForm")?.addEventListener("submit", handleAuthorSubmission);
}

/* -------------------- Footer -------------------- */

function setupFooter() {
  const year = byId("currentYear");
  if (year) year.textContent = String(new Date().getFullYear());
}

/* -------------------- Start the application -------------------- */

document.addEventListener("DOMContentLoaded", async () => {
  setupModalEvents();
  setupNavigation();
  setupForms();
  setupBookSearch();
  setupReaderControls();
  setupFooter();

  await loadPublicConfig();
  await checkSession();
  await loadBooks();
});
