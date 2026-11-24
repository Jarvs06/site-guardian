/**
 * "Coming soon" screens (link scanner, layout check, remote scan) keep the old
 * markup but are inert in Stage 1: every control inside them stays disabled.
 */

/**
 * @param {Element} panel
 */
export function mountComingSoon(panel) {
  for (const el of panel.querySelectorAll("button, input, textarea, select")) {
    /** @type {HTMLButtonElement} */ (el).disabled = true;
    el.setAttribute("aria-disabled", "true");
  }
  for (const form of panel.querySelectorAll("form")) {
    form.addEventListener("submit", (e) => e.preventDefault());
  }
}
