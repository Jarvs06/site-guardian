import { afterEach, describe, expect, it } from "vitest";
import { mountTabs } from "../app.js";
import { mountComingSoon } from "../screens/coming-soon.js";

const FIXTURE = `
<div id="sg-app">
  <nav role="tablist">
    <button type="button" role="tab" id="t-chat" aria-controls="p-chat" aria-selected="true">Chat</button>
    <button type="button" role="tab" id="t-links" aria-controls="p-links" aria-selected="false">Links</button>
  </nav>
  <section id="p-chat" role="tabpanel"></section>
  <section id="p-links" role="tabpanel" hidden data-coming-soon>
    <button type="button" id="scan">Scan</button>
    <input id="url">
  </section>
</div>`;

function mountFixture() {
  const doc = new DOMParser().parseFromString(FIXTURE, "text/html");
  document.body.replaceChildren(...doc.body.childNodes);
  return document.getElementById("sg-app");
}

afterEach(() => document.body.replaceChildren());

describe("tabs", () => {
  it("switches panels on click", () => {
    const app = mountFixture();
    mountTabs(app);
    document.getElementById("t-links").click();
    expect(document.getElementById("p-chat").hidden).toBe(true);
    expect(document.getElementById("p-links").hidden).toBe(false);
    expect(document.getElementById("t-links").getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("t-chat").getAttribute("aria-selected")).toBe("false");
  });

  it("moves with arrow keys", () => {
    const app = mountFixture();
    mountTabs(app);
    document
      .getElementById("t-chat")
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.getElementById("p-links").hidden).toBe(false);
  });
});

describe("coming soon", () => {
  it("disables every control in the panel", () => {
    mountFixture();
    mountComingSoon(document.getElementById("p-links"));
    expect(document.getElementById("scan").disabled).toBe(true);
    expect(document.getElementById("url").disabled).toBe(true);
  });
});
