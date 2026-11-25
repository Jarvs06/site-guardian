import { afterEach, beforeEach, describe, expect, it } from "vitest";
import createDOMPurify from "dompurify";
import { renderAssistant, renderText, sanitizeHtml, setPurifier } from "../render.js";
import { markdownToHtml } from "../markdown.js";

let el;

/** Parse HTML without assigning innerHTML (keeps the no-innerHTML grep test simple). */
function parse(html) {
  return new DOMParser().parseFromString(html, "text/html").body;
}

beforeEach(() => {
  setPurifier(createDOMPurify(window));
  el = document.createElement("div");
});

afterEach(() => {
  setPurifier(null);
});

describe("renderAssistant", () => {
  it("never inserts event handlers or scripts", () => {
    renderAssistant(el, "hi <img src=x onerror=alert(1)>");
    // The text may mention "onerror" (escaped), but no tag may carry it.
    expect(el.innerHTML).not.toMatch(/<[^>]*onerror/i);
    expect(el.querySelector("[onerror]")).toBeNull();
    expect(el.innerHTML).not.toMatch(/<script/i);
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("does not let a script tag through", () => {
    renderAssistant(el, "<script>alert(1)</script>");
    expect(el.querySelector("script")).toBeNull();
  });

  it("renders bold", () => {
    renderAssistant(el, "**bold**");
    expect(el.innerHTML).toContain("<strong>bold</strong>");
  });

  it("renders lists, headings and code", () => {
    renderAssistant(el, "### Title\n\n- one\n- two\n\nUse `wp-cli`.");
    expect(el.querySelector("h3")?.textContent).toBe("Title");
    expect(el.querySelectorAll("ul > li")).toHaveLength(2);
    expect(el.querySelector("code")?.textContent).toBe("wp-cli");
  });

  it("falls back to plain text when DOMPurify is not loaded", () => {
    setPurifier(null);
    const saved = globalThis.DOMPurify;
    delete globalThis.DOMPurify;
    try {
      renderAssistant(el, "**bold** <img src=x onerror=alert(1)>");
      expect(el.children.length).toBe(0);
      expect(el.textContent).toBe("**bold** <img src=x onerror=alert(1)>");
    } finally {
      if (saved !== undefined) globalThis.DOMPurify = saved;
    }
  });

  it("uses globalThis.DOMPurify when no override is set", () => {
    setPurifier(null);
    globalThis.DOMPurify = createDOMPurify(window);
    try {
      renderAssistant(el, "*it*");
      expect(el.innerHTML).toContain("<em>it</em>");
    } finally {
      delete globalThis.DOMPurify;
    }
  });
});

describe("sanitizeHtml", () => {
  it("strips style attributes and on* handlers", () => {
    const out = sanitizeHtml('<p style="color:red" onclick="x()">a</p>');
    expect(out).toBe("<p>a</p>");
  });

  it("forces safe link attributes", () => {
    const holder = parse(sanitizeHtml('<a href="https://example.com" target="_self">x</a>'));
    const a = holder.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("allows only http(s) and mailto links", () => {
    const holder = parse(
      sanitizeHtml(
        '<a href="javascript:alert(1)">a</a><a href="data:text/html,x">b</a><a href="mailto:a@b.co">c</a>',
      ),
    );
    const links = holder.querySelectorAll("a");
    expect(links[0].hasAttribute("href")).toBe(false);
    expect(links[1].hasAttribute("href")).toBe(false);
    expect(links[2].getAttribute("href")).toBe("mailto:a@b.co");
  });

  it("drops tags outside the allowlist", () => {
    expect(sanitizeHtml("<p>a</p><iframe src=x></iframe><img src=x>")).toBe("<p>a</p>");
  });
});

describe("renderText", () => {
  it("inserts text, never markup", () => {
    renderText(el, "<b>x</b>");
    expect(el.textContent).toBe("<b>x</b>");
    expect(el.children.length).toBe(0);
  });
});

describe("markdownToHtml", () => {
  it("escapes HTML before applying markdown", () => {
    expect(markdownToHtml('**<b>"x"</b>**')).toBe(
      "<p><strong>&lt;b&gt;&quot;x&quot;&lt;/b&gt;</strong></p>",
    );
  });

  it("keeps the old converter's output for paragraphs, line breaks and rules", () => {
    expect(markdownToHtml("a\nb\n\nc\n\n---\n\n#### H")).toBe("<p>a<br>b</p>\n<p>c</p>\n<hr>\n<h4>H</h4>");
  });
});
