// Static checks over the plugin's front-end sources (CSP and XSS rules).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// fileURLToPath on the string: under jsdom, `URL` is jsdom's class, which node:url rejects.
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const jsRoot = join(pluginRoot, "assets/js");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "vendor" ? [] : walk(path);
    return name.endsWith(".js") ? [path] : [];
  });
}

describe("no dynamic innerHTML", () => {
  it("only render.js assigns innerHTML from a non-literal", () => {
    const files = walk(jsRoot);
    expect(files.length).toBeGreaterThan(3);
    const offenders = files
      .filter((f) => relative(jsRoot, f) !== "render.js")
      .filter((f) => /innerHTML\s*=\s*[^'"`]/.test(readFileSync(f, "utf8")))
      .map((f) => relative(jsRoot, f));
    expect(offenders).toEqual([]);
  });

  it("no outerHTML / insertAdjacentHTML / document.write anywhere", () => {
    const offenders = walk(jsRoot)
      .filter((f) => !f.includes("__tests__"))
      .filter((f) => /outerHTML\s*=|insertAdjacentHTML|document\.write/.test(readFileSync(f, "utf8")))
      .map((f) => relative(jsRoot, f));
    expect(offenders).toEqual([]);
  });
});

describe("templates/app.php is CSP-clean", () => {
  const php = readFileSync(join(pluginRoot, "templates/app.php"), "utf8");

  it("has no style attributes or <style> blocks", () => {
    expect(php).not.toMatch(/\sstyle\s*=/i);
    expect(php).not.toMatch(/<style[\s>]/i);
  });

  it("has no inline event handlers", () => {
    expect(php).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it("has no inline scripts (every <script> has a src)", () => {
    // The tag is printed from the asset list, so check each line that opens a <script.
    const lines = php.split("\n").filter((l) => /<script\b/i.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/\ssrc=/);
  });

  it("loads DOMPurify as a classic script before the app module", () => {
    const purify = php.indexOf("assets/vendor/purify.min.js");
    const app = php.indexOf("assets/js/app.js");
    expect(purify).toBeGreaterThan(-1);
    expect(app).toBeGreaterThan(purify);
  });
});
