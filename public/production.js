
"use strict";

/*
 * MindSpring Reads — payment and author submission handlers
 * Uses the existing Express backend.
 */

(() => {
  const PAYMENT_ENDPOINT = "/api/payments";
  const AUTHOR_ENDPOINT = "/api/authors/submissions";

  async function api(url, options = {}) {
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

    const contentType = response.headers.get("content-type") || "";
    const result = contentType.includes("application/json")
      ? await response.json()
      : {};

    if (!response.ok) {
      throw new Error(
        result.error || result.message || `Request failed (${response.status})`
      );
    }

    return result;
  }

  function showMessage(title, message) {
    const existing = document.getElementById("productionMessage");

    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "productionMessage";
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:99999",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "padding:20px",
      "background:rgba(0,0,0,.55)"
    ].join(";");

    const card = document.createElement("div");
    card.style.cssText = [
      "background:#fff",
      "color:#222",
      "width:min(520px,100%)",
      "padding:28px",
      "border-radius:14px",
      "box-shadow:0 15px 50px rgba(0,0,0,.2)"
    ].join(";");

    const heading = document.createElement("h2");
    heading.textContent = title;

    const paragraph = document.createElement("p");
    paragraph.textContent = message;

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Continue";
    button.style.cssText =
      "width:100%;padding:14px;margin-top:12px;border:0;border-radius:8px;background:#075e54;color:white;font-weight:bold;cursor:pointer";
    button.addEventListener("click", () => overlay.remove());

    card.append(heading, paragraph, button);
    overlay.append(card);
    document.body.append(overlay);
  }

  function setFormMessage(form, message) {
    let output = form.querySelector("[data-production-message]");

    if (!output) {
      output = document.createElement("p");
      output.dataset.productionMessage = "true";
      output.setAttribute("role", "status");
      output.style.cssText = "margin-top:12px;font-size:14px";
      form.append(output);
    }

    output.textContent = message;
  }

  // Payment submission
  document.addEventListener("submit", async (event) => {
    const form = event.target;

    if (!(form instanceof HTMLFormElement) ||
        form.id !== "paymentForm") {
      return;
    }

    event.preventDefault();

    // Save the form reference before awaiting: event.currentTarget
    // can become null after the event callback yields.
    const formElement = form;
    const submitButton = formElement.querySelector(
      'button[type="submit"], input[type="submit"]'
    );

    const payerName = String(
      formElement.querySelector('[name="payerName"]')?.value || ""
    ).trim();

    const transactionCode = String(
      formElement.querySelector('[name="transactionCode"]')?.value || ""
    ).trim().toUpperCase();

    if (payerName.length < 2) {
      setFormMessage(formElement, "Please enter the payer's full name.");
      return;
    }

    if (!/^[A-Z0-9]{6,20}$/.test(transactionCode)) {
      setFormMessage(
        formElement,
        "Enter the M-Pesa transaction code from your confirmation message."
      );
      return;
    }

    if (submitButton) submitButton.disabled = true;

    try {
      const result = await api(PAYMENT_ENDPOINT, {
        method: "POST",
        body: JSON.stringify({ payerName, transactionCode })
      });

      formElement.reset();

      const modal = document.getElementById("paymentModal");
      if (modal) {
        modal.setAttribute("aria-hidden", "true");
        modal.classList.remove("active", "open", "visible");
      }

      showMessage(
        "Payment request submitted",
        result.message ||
          "Your request has been submitted for administrator review. Reading access remains locked until payment is verified."
      );
    } catch (error) {
      setFormMessage(
        formElement,
        error.message || "Unable to submit your payment request. Please try again."
      );
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  });

  // Author manuscript submission
  document.addEventListener("submit", async (event) => {
    const form = event.target;

    if (!(form instanceof HTMLFormElement) ||
        !form.querySelector('[name="manuscript"]')) {
      return;
    }

    if (form.id === "paymentForm") return;

    event.preventDefault();

    const formElement = form;
    const submitButton = formElement.querySelector(
      'button[type="submit"], input[type="submit"]'
    );

    if (submitButton) submitButton.disabled = true;

    try {
      const result = await api(AUTHOR_ENDPOINT, {
        method: "POST",
        body: new FormData(formElement)
      });

      formElement.reset();

      showMessage(
        "Manuscript submitted",
        result.message ||
          "Your manuscript has been submitted for review before publication."
      );
    } catch (error) {
      setFormMessage(
        formElement,
        error.message || "Unable to upload the manuscript. Please try again."
      );
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  });
})();
