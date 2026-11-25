/**
 * The only place on the page that turns dynamic data into HTML.
 *
 * - renderAssistant(): AI reply markdown → markdownToHtml (escapes first) → DOMPurify → insert.
 * - renderText(): everything else (user text, errors, URLs, …) via textContent.
 *
 * DOMPurify is the vendored assets/vendor/purify.min.js, loaded as a classic
 * script before the app module, so it is read from globalThis.DOMPurify.
 * Tests inject their own instance with setPurifier().
 */
import { markdownToHtml } from "./markdown.js";

/** Tags the markdown converter can emit (plus a, ol and pre for future use). */
const ALLOWED_TAGS = ["p", "strong", "em", "code", "pre", "ul", "ol", "li", "a", "br", "h3", "h4", "hr"];
const ALLOWED_ATTR = ["href", "target", "rel"];
/** http(s) and mailto only — no javascript:, data:, relative or protocol-relative URLs. */
const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:)/i;

const CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOWED_URI_REGEXP,
  FORBID_ATTR: ["style"],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

/** @type {any} */
let override = null;
/** DOMPurify instances that already carry our link hook. */
const hooked = new WeakSet();

/**
 * Inject a DOMPurify instance (tests). Pass null to go back to globalThis.DOMPurify.
 * @param {any} purifier
 */
export function setPurifier(purifier) {
  override = purifier;
}

function purifier() {
  const p = override ?? globalThis.DOMPurify;
  if (!p || typeof p.sanitize !== "function" || typeof p.addHook !== "function") return null;
  if (!hooked.has(p)) {
    p.addHook("afterSanitizeAttributes", (node) => {
      if (node.nodeName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
    hooked.add(p);
  }
  return p;
}

/**
 * Sanitize an HTML string with the page's DOMPurify policy.
 * Throws if DOMPurify is not available.
 * @param {string} html
 * @returns {string}
 */
export function sanitizeHtml(html) {
  const p = purifier();
  if (!p) throw new Error("DOMPurify is not loaded");
  return String(p.sanitize(html, CONFIG));
}

/**
 * Render an AI reply (markdown) into el. Without DOMPurify it fails closed and shows plain text.
 * @param {Element} el
 * @param {string} markdown
 */
export function renderAssistant(el, markdown) {
  if (!purifier()) {
    renderText(el, markdown);
    return;
  }
  el.innerHTML = sanitizeHtml(markdownToHtml(markdown));
}

/**
 * Render untrusted text into el as text.
 * @param {Element} el
 * @param {string} text
 */
export function renderText(el, text) {
  el.textContent = String(text ?? "");
}
