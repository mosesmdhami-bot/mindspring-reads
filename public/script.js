
"use strict";

const $ = (selector) => document.querySelector(selector);

let currentUser = null;
let allBooks = [];

const API = {
    async request(url, options = {}) {
        const response = await fetch(url, {
            credentials: "same-origin",
            ...options,
            headers: {
                ...(options.body instanceof FormData
                    ? {}
                    : { "Content-Type": "application/json" }),
                ...(options.headers || {})
            }
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || data.message || "Something went wrong.");
        }

        return data;
    }
};

function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;

    modal.classList.add("active", "open", "show");
    modal.setAttribute("aria-hidden", "false");
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;

    modal.classList.remove("active", "open", "show");
    modal.setAttribute("aria-hidden", "true");
}

function closeAllModals() {
    document.querySelectorAll(".modal").forEach((modal) => {
        modal.classList.remove("active", "open", "show");
        modal.setAttribute("aria-hidden", "true");
    });
}

function showMessage(title, message) {
    $("#messageTitle").textContent = title;
    $("#messageText").textContent = message;
    openModal("messageModal");
}

function showFormMessage(id, message, isError = false) {
    const element = document.getElementById(id);
    if (!element) return;

    element.textContent = message;
    element.style.color = isError ? "crimson" : "green";
}

function escapeHTML(value = "") {
    return String(value).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    })[character]);
}

function updateNavigation() {
    const loginBtn = $("#loginBtn");
    const registerBtn = $("#registerBtn");
    const logoutBtn = $("#logoutBtn");

    if (currentUser) {
        loginBtn.hidden = true;
        registerBtn.hidden = true;
        logoutBtn.hidden = false;
        logoutBtn.textContent = `Logout (${currentUser.name || currentUser.email})`;
    } else {
        loginBtn.hidden = false;
        registerBtn.hidden = false;
        logoutBtn.hidden = true;
    }
}

async function checkSession() {
    try {
        const result = await API.request("/api/auth/me");
        currentUser = result.user || result;
        if (!currentUser || !currentUser.email) currentUser = null;
    } catch {
        currentUser = null;
    }

    updateNavigation();
}

async function loadBooks(category = "") {
    const container = $("#booksContainer");
    container.innerHTML = "<p>Loading books...</p>";

    try {
        const query = category
            ? `?category=${encodeURIComponent(category)}`
            : "";

        const result = await API.request(`/api/books${query}`);
        allBooks = Array.isArray(result)
            ? result
            : (result.books || result.data || []);

        renderBooks(allBooks);
    } catch (error) {
        container.innerHTML = `
            <p>Could not load books from the server.</p>
            <p>${escapeHTML(error.message)}</p>
        `;
    }
}

function renderBooks(books) {
    const container = $("#booksContainer");

    if (!books.length) {
        container.innerHTML = "<p>No books are available in this category yet.</p>";
        return;
    }

    container.innerHTML = books.map((book) => {
        const id = book.id;
        const title = escapeHTML(book.title || "Untitled book");
        const author = escapeHTML(book.author || book.authorName || "Unknown author");
        const category = escapeHTML(book.category || "General");
        const description = escapeHTML(book.description || "Discover this book on MindSpring Reads.");

        return `
            <article class="book-card">
                <div class="book-cover">
                    <span>MindSpring Reads</span>
                </div>
                <div class="book-info">
                    <h3>${title}</h3>
                    <p>By ${author}</p>
                    <p>${category}</p>
                    <p>${description}</p>
                    <button class="btn read-book-btn"
                        type="button"
                        data-book-id="${escapeHTML(id)}">
                        Read Book
                    </button>
                </div>
            </article>
        `;
    }).join("");
}

async function login(email, password) {
    const result = await API.request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
    });

    currentUser = result.user || result;
    updateNavigation();
    closeAllModals();

    if (currentUser.role === "admin") {
        window.location.href = "/admin";
        return;
    }

    showMessage("Login successful", `Welcome back, ${currentUser.name || currentUser.email}!`);
    await loadBooks();
}

async function register(name, email, password) {
    const result = await API.request("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ name, email, password })
    });

    currentUser = result.user || result;
    updateNavigation();
    closeAllModals();

    showMessage("Account created", "Your account has been created successfully.");
    await loadBooks();
}

async function logout() {
    try {
        await API.request("/api/auth/logout", {
            method: "POST",
            body: JSON.stringify({})
        });

        currentUser = null;
        updateNavigation();
        showMessage("Logged out", "You have logged out successfully.");
    } catch (error) {
        showMessage("Logout failed", error.message);
    }
}

async function readBook(bookId) {
    if (!currentUser) {
        showMessage("Login required", "Please log in or register before reading a book.");
        openModal("loginModal");
        return;
    }

    $("#readerTitle").textContent = "Opening book...";
    $("#readerContent").innerHTML = "";
    $("#readerMessage").textContent = "";
    openModal("readerModal");

    try {
        const result = await API.request(`/api/books/${encodeURIComponent(bookId)}/read`);
        const book = result.book || result;

        $("#readerTitle").textContent = book.title || "Your Book";
        $("#readerMessage").textContent = "";

        const content = book.content || book.text || book.body || "";

        if (content) {
            const paragraph = document.createElement("p");
            paragraph.textContent = content;
            paragraph.style.whiteSpace = "pre-wrap";
            $("#readerContent").replaceChildren(paragraph);
        } else if (book.readUrl || book.url) {
            const link = document.createElement("a");
            link.href = book.readUrl || book.url;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = "Open book";
            $("#readerContent").replaceChildren(link);
        } else {
            $("#readerContent").textContent =
                "The book is available, but its reading content has not been added yet.";
        }
    } catch (error) {
        closeModal("readerModal");
        showMessage("Unable to open book", error.message);
    }
}

async function submitPayment(event) {
    event.preventDefault();

    const button = event.submitter;
    if (button) button.disabled = true;

    showFormMessage("paymentMessage", "Submitting payment details...");

    try {
        if (!currentUser) {
            throw new Error("Please log in before submitting payment details.");
        }

        const payerName = $("#payerName").value.trim();
        const transactionCode = $("#transactionCode").value.trim();

        await API.request("/api/payments", {
            method: "POST",
            body: JSON.stringify({ payerName, transactionCode })
        });

        $("#paymentForm").reset();
        closeModal("paymentModal");
        showMessage(
            "Payment submitted",
            "Your M-Pesa details have been submitted for admin verification. Access is not active until approved."
        );
    } catch (error) {
        showFormMessage("paymentMessage", error.message, true);
    } finally {
        if (button) button.disabled = false;
    }
}

async function submitAuthorForm(event) {
    event.preventDefault();

    const button = event.submitter;
    if (button) button.disabled = true;

    showFormMessage("authorMessage", "Uploading your submission...");

    try {
        if (!currentUser) {
            throw new Error("Please log in before submitting a manuscript.");
        }

        const formData = new FormData($("#authorForm"));

        await API.request("/api/authors/submissions", {
            method: "POST",
            body: formData
        });

        $("#authorForm").reset();
        closeModal("authorModal");

        showMessage(
            "Submission received",
            "Your manuscript has been submitted for review."
        );
    } catch (error) {
        showFormMessage("authorMessage", error.message, true);
    } finally {
        if (button) button.disabled = false;
    }
}

document.addEventListener("DOMContentLoaded", async () => {
    $("#currentYear").textContent = new Date().getFullYear();

    // Make modal visibility work with common CSS class names.
    const modalStyle = document.createElement("style");
    modalStyle.textContent = `
        .modal { display: none; }
        .modal.active, .modal.open, .modal.show {
            display: flex;
            position: fixed;
            inset: 0;
            z-index: 9999;
            align-items: center;
            justify-content: center;
            padding: 20px;
            background: rgba(0,0,0,.65);
            overflow-y: auto;
        }
        .modal-content {
            position: relative;
            background: #fff;
            color: #222;
            width: min(100%, 520px);
            max-height: 90vh;
            overflow-y: auto;
            padding: 28px;
            border-radius: 12px;
            box-shadow: 0 10px 35px rgba(0,0,0,.25);
        }
        .modal-content input,
        .modal-content select,
        .modal-content textarea {
            display: block;
            box-sizing: border-box;
            width: 100%;
            margin: 7px 0 15px;
            padding: 11px;
        }
        .modal-content label { display: block; }
        .close-modal {
            position: absolute;
            right: 12px;
            top: 8px;
            font-size: 28px;
            border: 0;
            background: transparent;
            cursor: pointer;
        }
        .nav-actions { display: flex; gap: 8px; align-items: center; }
        [hidden] { display: none !important; }
        .book-card { padding: 18px; border-radius: 12px; }
        .book-cover {
            min-height: 110px;
            display: flex;
            justify-content: center;
            align-items: center;
            background: #e8eaf6;
            border-radius: 8px;
            margin-bottom: 12px;
            font-weight: bold;
        }
        .category-grid { display: flex; flex-wrap: wrap; gap: 10px; }
        .reader-content { width: min(100%, 760px); }
    `;
    document.head.appendChild(modalStyle);

    $("#loginBtn").addEventListener("click", () => openModal("loginModal"));
    $("#registerBtn").addEventListener("click", () => openModal("registerModal"));
    $("#logoutBtn").addEventListener("click", logout);

    $("#paymentBtn").addEventListener("click", () => {
        if (!currentUser) {
            showMessage("Login required", "Please log in before requesting reader access.");
            openModal("loginModal");
            return;
        }
        openModal("paymentModal");
    });

    $("#authorBtn").addEventListener("click", () => {
        if (!currentUser) {
            showMessage("Login required", "Please log in before submitting a book.");
            openModal("loginModal");
            return;
        }
        openModal("authorModal");
    });

    $("#switchToRegister").addEventListener("click", () => {
        closeModal("loginModal");
        openModal("registerModal");
    });

    $("#switchToLogin").addEventListener("click", () => {
        closeModal("registerModal");
        openModal("loginModal");
    });

    document.querySelectorAll("[data-close]").forEach((button) => {
        button.addEventListener("click", () => closeModal(button.dataset.close));
    });

    document.querySelectorAll(".modal").forEach((modal) => {
        modal.addEventListener("click", (event) => {
            if (event.target === modal) closeModal(modal.id);
        });
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeAllModals();
    });

    $("#loginForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        showFormMessage("loginMessage", "Logging in...");

        try {
            await login($("#loginEmail").value.trim(), $("#loginPassword").value);
            $("#loginForm").reset();
        } catch (error) {
            showFormMessage("loginMessage", error.message, true);
        }
    });

    $("#registerForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        showFormMessage("registerMessage", "Creating account...");

        try {
            await register(
                $("#registerName").value.trim(),
                $("#registerEmail").value.trim(),
                $("#registerPassword").value
            );
            $("#registerForm").reset();
        } catch (error) {
            showFormMessage("registerMessage", error.message, true);
        }
    });

    $("#paymentForm").addEventListener("submit", submitPayment);
    $("#authorForm").addEventListener("submit", submitAuthorForm);

    $("#booksContainer").addEventListener("click", (event) => {
        const button = event.target.closest(".read-book-btn");
        if (button) readBook(button.dataset.bookId);
    });

    document.querySelectorAll("[data-category]").forEach((button) => {
        button.addEventListener("click", () => loadBooks(button.dataset.category));
    });

    await checkSession();
    await loadBooks();
});
