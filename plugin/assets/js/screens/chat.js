/**
 * Chat screen — ported from the chat flow of the old chat.js (bubbles, typing
 * indicator, quick actions, input/send, character counter, scrolling).
 * The keyword-triggered scan cards of the old plugin are not ported.
 */
import { renderAssistant, renderText } from "../render.js";
import { SessionExpiredError } from "../api.js";

const MAX_CHARS = 2000;
const MAX_INPUT_HEIGHT = 140;
const SESSION_EXPIRED_MESSAGE = "Your session expired — please refresh the page.";
const GENERIC_MESSAGE = "Something went wrong. Please try again.";

/**
 * @param {Element} root  The chat section (contains #sga-messages, #sga-input, …).
 * @param {{ api: { postChat: Function, getConversation: Function } }} deps
 */
export function mountChat(root, { api }) {
  const messagesEl = /** @type {HTMLElement} */ (root.querySelector("#sga-messages"));
  const inputEl = /** @type {HTMLTextAreaElement} */ (root.querySelector("#sga-input"));
  const sendBtn = /** @type {HTMLButtonElement} */ (root.querySelector("#sga-send"));
  const typingEl = /** @type {HTMLElement} */ (root.querySelector("#sga-typing"));
  const charCountEl = root.querySelector("#sga-char-count");
  const quickBtns = /** @type {HTMLButtonElement[]} */ ([...root.querySelectorAll(".sga-quick-btn")]);

  /** @type {string|null} */
  let conversationId = null;
  let busy = false;

  // Load the stored conversation once; sends wait for it. Failures start a new conversation.
  const ready = Promise.resolve()
    .then(() => api.getConversation())
    .then(
      (id) => {
        if (typeof id === "string" && id) conversationId = id;
      },
      () => {},
    );

  /* ── Quick action buttons ── */
  for (const btn of quickBtns) {
    btn.addEventListener("click", () => {
      const prompt = btn.dataset.prompt;
      if (prompt) void send(prompt);
    });
  }

  /* ── Send on Enter (Shift+Enter = newline) ── */
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      triggerSend();
    }
  });
  sendBtn.addEventListener("click", triggerSend);

  /* ── Auto-grow textarea + character counter ── */
  inputEl.addEventListener("input", () => {
    autoGrow();
    updateCharCount();
  });

  // CSSOM height changes are allowed by the page CSP (only style attributes in markup are not).
  function autoGrow() {
    inputEl.style.height = "auto";
    if (inputEl.value) inputEl.style.height = Math.min(inputEl.scrollHeight, MAX_INPUT_HEIGHT) + "px";
  }

  function updateCharCount() {
    if (!charCountEl) return;
    const len = inputEl.value.length;
    charCountEl.className = "sga-char-count";
    if (len === 0) {
      charCountEl.textContent = "";
      return;
    }
    charCountEl.textContent = len + " / " + MAX_CHARS;
    charCountEl.classList.toggle("sga-char-count--warn", len > MAX_CHARS * 0.9);
    charCountEl.classList.toggle("sga-char-count--over", len >= MAX_CHARS);
  }

  function triggerSend() {
    const text = inputEl.value.trim();
    if (!text || busy) return;
    inputEl.value = "";
    autoGrow();
    updateCharCount();
    void send(text);
  }

  /**
   * Send one message and render the reply (or an error). Resolves when done.
   * @param {string} text
   */
  async function send(text) {
    if (busy) return;
    appendMessage("user", text);
    setLoading(true);
    try {
      await ready;
      const res = await api.postChat(text, conversationId);
      if (typeof res.conversation_id === "string" && res.conversation_id) conversationId = res.conversation_id;
      appendMessage("ai", res.reply);
    } catch (err) {
      appendError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  /** @param {unknown} err */
  function errorMessage(err) {
    if (err instanceof SessionExpiredError) return SESSION_EXPIRED_MESSAGE;
    if (err instanceof Error && err.name === "ApiFailure" && err.message) return err.message;
    return GENERIC_MESSAGE;
  }

  /**
   * @param {"user"|"ai"} role
   * @param {string} text
   */
  function appendMessage(role, text) {
    const { row, bubble } = createMessageShell(role);
    if (role === "ai") renderAssistant(bubble, text);
    else renderText(bubble, text);
    messagesEl.appendChild(row);
    scrollToBottom();
  }

  /** @param {string} message */
  function appendError(message) {
    const { row, bubble } = createMessageShell("ai");
    row.classList.add("sg-msg--error");
    renderText(bubble, "⚠️ " + message);
    messagesEl.appendChild(row);
    scrollToBottom();
  }

  /** @param {"user"|"ai"} role */
  function createMessageShell(role) {
    const row = document.createElement("div");
    row.className = "sga-msg sga-msg--" + (role === "user" ? "user" : "ai");
    row.setAttribute("role", "listitem");

    const avatar = document.createElement("div");
    avatar.className = "sga-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = role === "user" ? "👤" : "🛡️";

    const bubble = document.createElement("div");
    bubble.className = "sga-bubble";
    if (role === "user") bubble.classList.add("sg-bubble--plain");

    row.appendChild(avatar);
    row.appendChild(bubble);
    return { row, bubble };
  }

  /** @param {boolean} on */
  function setLoading(on) {
    busy = on;
    sendBtn.disabled = on;
    inputEl.disabled = on;
    for (const btn of quickBtns) btn.disabled = on;
    typingEl.hidden = !on;
    if (on) scrollToBottom();
    else inputEl.focus();
  }

  function scrollToBottom() {
    // rAF ensures the DOM has painted before we measure scrollHeight.
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  return { ready, send };
}
