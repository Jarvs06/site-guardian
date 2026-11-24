/**
 * Minimal markdown → HTML converter, ported from markdownToHtml() in the old chat.js.
 *
 * The raw text is HTML-escaped FIRST, then the markdown transforms add a small
 * fixed set of tags (p, br, strong, em, code, ul, li, h3, h4, hr). The output
 * still goes through DOMPurify in render.js before it reaches the page.
 */

/**
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * @param {string} md
 * @returns {string}
 */
export function markdownToHtml(md) {
  let s = escapeHtml(md ?? "");
  s = s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

  const lines = s.split("\n");
  const out = [];
  let inList = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const headMatch = line.match(/^(#{3,4}) (.+)$/);
    const hrMatch = line.match(/^---+$/);
    const liMatch = line.match(/^\s*(?:[-*•]|\d+\.) (.+)$/);

    if (headMatch) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      const tag = headMatch[1].length === 3 ? "h3" : "h4";
      out.push(`<${tag}>${headMatch[2]}</${tag}>`);
    } else if (hrMatch) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push("<hr>");
    } else if (liMatch) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${liMatch[1]}</li>`);
    } else {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push(line);
    }
  }
  if (inList) out.push("</ul>");

  return out
    .join("\n")
    .split(/\n\n+/)
    .map((block) => {
      block = block.trim();
      if (!block) return "";
      if (/^<(?:h[34]|ul|hr)/.test(block)) return block;
      return "<p>" + block.replace(/\n/g, "<br>") + "</p>";
    })
    .join("\n");
}
