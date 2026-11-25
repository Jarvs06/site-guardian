/**
 * CSV export of link scan results (same columns as the old plugin's export).
 */

const HEADERS = ["URL", "Source", "Found In", "Index", "Follow", "Status", "HTTP Code", "Detail"];

/**
 * Quote one cell. Cells starting with = + - @ get a leading ' so spreadsheets don't run them.
 * @param {unknown} value
 */
function cell(value) {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * @param {Array<{url: string, source: string, found_in: string|null, robots_index: string|null,
 *   robots_follow: string|null, status: string, http_code: number|null, detail: string|null}>} rows
 * @returns {string} UTF-8 BOM + CRLF-separated, fully quoted CSV
 */
export function toCsv(rows) {
  const lines = [HEADERS.map(cell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.url,
        r.source,
        r.found_in,
        r.robots_index ?? "N/A",
        r.robots_follow ?? "N/A",
        r.status,
        r.http_code,
        r.detail,
      ]
        .map(cell)
        .join(","),
    );
  }
  return "﻿" + lines.join("\r\n");
}
