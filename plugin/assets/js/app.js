/**
 * Site Guardian page entry (ES module). Boot data comes from the data-* attributes of #sg-app.
 */
import { createApi } from "./api.js";
import { mountChat } from "./screens/chat.js";
import { mountComingSoon } from "./screens/coming-soon.js";
import { mountLinkScanner } from "./screens/link-scanner.js";

/**
 * Tabs: buttons [role=tab][aria-controls] switch the [role=tabpanel] sections.
 * @param {Element} app
 */
export function mountTabs(app) {
  const tabs = /** @type {HTMLElement[]} */ ([...app.querySelectorAll('[role="tab"][aria-controls]')]);

  /** @param {HTMLElement} active */
  function select(active) {
    for (const tab of tabs) {
      const on = tab === active;
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.tabIndex = on ? 0 : -1;
      tab.classList.toggle("is-active", on);
      const panel = app.ownerDocument.getElementById(tab.getAttribute("aria-controls") ?? "");
      if (panel instanceof HTMLElement) panel.hidden = !on;
    }
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = tabs[(i + step + tabs.length) % tabs.length];
      select(next);
      next.focus();
    });
  });
}

/**
 * @param {Document} doc
 */
export function boot(doc) {
  const app = doc.getElementById("sg-app");
  if (!app) return;

  const api = createApi({
    restUrl: app.dataset.restUrl ?? "",
    nonce: app.dataset.nonce ?? "",
  });

  mountTabs(app);
  for (const panel of app.querySelectorAll("[data-coming-soon]")) mountComingSoon(panel);

  const chatRoot = app.querySelector("#sga-app");
  if (chatRoot) mountChat(chatRoot, { api });

  const linksRoot = app.querySelector("#sg-panel-links");
  if (linksRoot) mountLinkScanner(linksRoot, { api });
}

boot(document);
