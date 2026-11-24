import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import createDOMPurify from "dompurify";
import { setPurifier } from "../render.js";
import { ApiFailure, SessionExpiredError } from "../api.js";
import { mountChat } from "../screens/chat.js";

// Same ids and classes as the chat section of templates/app.php.
const FIXTURE = `
<div class="sga-wrap" id="sga-app">
  <nav class="sga-quick-actions">
    <button class="sga-quick-btn" type="button" data-prompt="Check my links">Link Check</button>
  </nav>
  <section class="sga-messages" id="sga-messages">
    <div class="sga-msg sga-msg--ai"><div class="sga-avatar">🛡️</div><div class="sga-bubble"><p>Welcome</p></div></div>
  </section>
  <div class="sga-typing" id="sga-typing" hidden></div>
  <textarea id="sga-input" maxlength="2000"></textarea>
  <span class="sga-char-count" id="sga-char-count"></span>
  <button id="sga-send" type="button">Send</button>
</div>`;

function mountFixture() {
  const doc = new DOMParser().parseFromString(FIXTURE, "text/html");
  document.body.replaceChildren(...doc.body.childNodes);
  return document.getElementById("sga-app");
}

function fakeApi(overrides = {}) {
  return {
    getConversation: vi.fn(async () => null),
    postChat: vi.fn(async () => ({ reply: "**Hi** there", conversation_id: "c-1" })),
    ...overrides,
  };
}

function bubbles(kind) {
  return [...document.querySelectorAll(`#sga-messages .sga-msg--${kind} .sga-bubble`)];
}

function lastAiBubble() {
  const all = bubbles("ai");
  return all[all.length - 1];
}

beforeEach(() => {
  setPurifier(createDOMPurify(window));
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
});

afterEach(() => {
  setPurifier(null);
  document.body.replaceChildren();
});

describe("chat screen", () => {
  it("shows the user's message as text and the reply as rendered markdown", async () => {
    const api = fakeApi();
    const chat = mountChat(mountFixture(), { api });
    await chat.ready;

    await chat.send("<b>hello</b>");

    const user = bubbles("user");
    expect(user).toHaveLength(1);
    expect(user[0].textContent).toBe("<b>hello</b>");
    expect(user[0].querySelector("b")).toBeNull();
    expect(lastAiBubble().innerHTML).toContain("<strong>Hi</strong>");
    expect(document.getElementById("sga-typing").hidden).toBe(true);
  });

  it("shows the typing indicator and disables input while waiting", async () => {
    let resolve;
    const api = fakeApi({ postChat: vi.fn(() => new Promise((r) => (resolve = r))) });
    const chat = mountChat(mountFixture(), { api });
    await chat.ready;

    const pending = chat.send("hi");
    expect(document.getElementById("sga-typing").hidden).toBe(false);
    expect(document.getElementById("sga-send").disabled).toBe(true);
    expect(document.getElementById("sga-input").disabled).toBe(true);
    expect(document.querySelector(".sga-quick-btn").disabled).toBe(true);

    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    resolve({ reply: "ok", conversation_id: "c-1" });
    await pending;
    expect(document.getElementById("sga-typing").hidden).toBe(true);
    expect(document.getElementById("sga-send").disabled).toBe(false);
  });

  it("reuses the stored conversation and follows the id from each reply", async () => {
    const api = fakeApi({
      getConversation: vi.fn(async () => "c-stored"),
      postChat: vi
        .fn()
        .mockResolvedValueOnce({ reply: "one", conversation_id: "c-stored" })
        .mockResolvedValueOnce({ reply: "two", conversation_id: "c-new" })
        .mockResolvedValueOnce({ reply: "three", conversation_id: "c-new" }),
    });
    const chat = mountChat(mountFixture(), { api });
    await chat.send("a");
    await chat.send("b");
    await chat.send("c");

    expect(api.postChat.mock.calls.map((c) => c[1])).toEqual(["c-stored", "c-stored", "c-new"]);
  });

  it("starts a new conversation when loading the stored one fails", async () => {
    const api = fakeApi({ getConversation: vi.fn(async () => Promise.reject(new Error("x"))) });
    const chat = mountChat(mountFixture(), { api });
    await chat.send("a");
    expect(api.postChat).toHaveBeenCalledWith("a", null);
  });

  it("tells the owner to refresh on SessionExpiredError", async () => {
    const api = fakeApi({ postChat: vi.fn(async () => Promise.reject(new SessionExpiredError())) });
    const chat = mountChat(mountFixture(), { api });
    await chat.send("hi");
    expect(lastAiBubble().textContent).toContain("Your session expired — please refresh the page.");
  });

  it("shows Core's friendly message for ai_unavailable, as text", async () => {
    const api = fakeApi({
      postChat: vi.fn(async () =>
        Promise.reject(new ApiFailure("ai_unavailable", "The assistant is <i>unavailable</i> right now.", 502)),
      ),
    });
    const chat = mountChat(mountFixture(), { api });
    await chat.send("hi");
    const bubble = lastAiBubble();
    expect(bubble.textContent).toContain("The assistant is <i>unavailable</i> right now.");
    expect(bubble.querySelector("i")).toBeNull();
  });

  it("sends on Enter and the send button, not on Shift+Enter, and ignores blank input", async () => {
    const api = fakeApi();
    const chat = mountChat(mountFixture(), { api });
    await chat.ready;
    const input = document.getElementById("sga-input");

    input.value = "line";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    expect(api.postChat).not.toHaveBeenCalled();

    input.value = "   ";
    document.getElementById("sga-send").click();
    expect(api.postChat).not.toHaveBeenCalled();

    input.value = "hello";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(api.postChat).toHaveBeenCalledWith("hello", null));
    expect(input.value).toBe("");

    await vi.waitFor(() => expect(document.getElementById("sga-send").disabled).toBe(false));
    input.value = "again";
    document.getElementById("sga-send").click();
    await vi.waitFor(() => expect(api.postChat).toHaveBeenCalledWith("again", "c-1"));
  });

  it("sends a quick action's prompt", async () => {
    const api = fakeApi();
    const chat = mountChat(mountFixture(), { api });
    await chat.ready;
    document.querySelector(".sga-quick-btn").click();
    await vi.waitFor(() => expect(api.postChat).toHaveBeenCalledWith("Check my links", null));
  });

  it("shows the character counter", async () => {
    const chat = mountChat(mountFixture(), { api: fakeApi() });
    await chat.ready;
    const input = document.getElementById("sga-input");
    const counter = document.getElementById("sga-char-count");
    input.value = "x".repeat(1900);
    input.dispatchEvent(new Event("input"));
    expect(counter.textContent).toBe("1900 / 2000");
    expect(counter.classList.contains("sga-char-count--warn")).toBe(true);
    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(counter.textContent).toBe("");
  });
});
