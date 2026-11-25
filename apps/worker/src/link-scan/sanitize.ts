import type { ResultRow } from "./engine.js";

const URL_MAX = 2048;
const LABEL_MAX = 200;
const DETAIL_MAX = 500;

/** The first `max` code points of `s`; a surrogate pair is never split. */
export function cutCodePoints(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = 0;
  for (let n = 0; n < max && end < s.length; n++) end += (s.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
  return s.slice(0, end);
}

/** Text Postgres accepts: no NUL, no lone surrogate, at most `max` characters. */
function cleanText(s: string, max: number): string {
  const wellFormed = (s.replaceAll("\u0000", "") as string & { toWellFormed(): string }).toWellFormed();
  return cutCodePoints(wellFormed, max);
}

/** The row with every scan-derived text column made storable. */
export function sanitizeRow(row: ResultRow): ResultRow {
  return {
    ...row,
    url: cleanText(row.url, URL_MAX),
    label: row.label === null ? null : cleanText(row.label, LABEL_MAX),
    found_in: row.found_in === null ? null : cleanText(row.found_in, URL_MAX),
    detail: row.detail === null ? null : cleanText(row.detail, DETAIL_MAX),
  };
}
