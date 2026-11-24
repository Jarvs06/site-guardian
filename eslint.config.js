import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Browser globals used by the plugin's plain-JS front-end (no bundler, no `globals` package).
const browserGlobals = Object.fromEntries(
  [
    "window",
    "document",
    "navigator",
    "location",
    "fetch",
    "Response",
    "Request",
    "Headers",
    "URL",
    "FormData",
    "Event",
    "KeyboardEvent",
    "HTMLElement",
    "HTMLButtonElement",
    "HTMLTextAreaElement",
    "Element",
    "DOMParser",
    "CSS",
    "requestAnimationFrame",
    "setTimeout",
    "clearTimeout",
    "wp",
    "jQuery",
  ].map((name) => [name, "readonly"]),
);

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "plugin/vendor/**",
      "plugin/assets/vendor/**",
      ".superpowers/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { console: "readonly", process: "readonly" } } },
  {
    files: ["plugin/assets/**/*.js"],
    languageOptions: { sourceType: "module", globals: browserGlobals },
  },
);
