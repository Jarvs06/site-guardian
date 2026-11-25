import { z } from "zod";

export const SCAN_LIMITS = {
  maxPages: 1000,
  maxLinks: 5000,
  batchMax: 500,
  timeBudgetMs: 1_200_000,
  startingTimeoutMs: 600_000,
} as const;

export const LINK_SCAN_QUEUE = "link-scan";
// heartbeatSeconds: pg-boss fails an active job whose worker stopped refreshing it (a crash) after this
// long plus its supervise interval, so it is retried in about two minutes instead of after expireInSeconds.
export const LINK_SCAN_QUEUE_OPTIONS = {
  retryLimit: 2,
  retryDelay: 30,
  expireInSeconds: 1500,
  heartbeatSeconds: 30,
} as const;

export const ScanType = z.enum(["link"]);
export type ScanType = z.infer<typeof ScanType>;
export const ScanState = z.enum(["starting", "queued", "running", "completed", "failed", "cancelled"]);
export type ScanState = z.infer<typeof ScanState>;
export const TruncatedReason = z.enum(["page_cap", "link_cap", "time_limit"]);
export type TruncatedReason = z.infer<typeof TruncatedReason>;
export const LinkStatus = z.enum(["ok", "broken", "redirect", "restricted", "warning", "skipped"]);
export type LinkStatus = z.infer<typeof LinkStatus>;

export const CreateScanRequest = z.object({ type: ScanType }).strict();
export type CreateScanRequest = z.infer<typeof CreateScanRequest>;

export const ScanPagesRequest = z
  .object({
    pages: z
      .array(z.object({ url: z.string().max(2048), source: z.string().max(64) }).strict())
      .min(1)
      .max(SCAN_LIMITS.batchMax),
    pages_found: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();
export type ScanPagesRequest = z.infer<typeof ScanPagesRequest>;

const count = z.number().int().min(0);

export const ScanStatus = z
  .object({
    scan_id: z.string().uuid(),
    type: ScanType,
    status: ScanState,
    pages_total: count,
    pages_checked: count,
    links_total: count,
    links_checked: count,
    pages_submitted: count,
    pages_found: count.nullable(),
    truncated_reason: TruncatedReason.nullable(),
    results_scan_id: z.string().uuid().nullable(),
    counts: z
      .object({
        ok: count,
        broken: count,
        redirect: count,
        restricted: count,
        warning: count,
        skipped: count,
        indexed: count,
        noindex: count,
        nofollow: count,
      })
      .strict(),
    created_at: z.string(),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type ScanStatus = z.infer<typeof ScanStatus>;

export const CreateScanResponse = ScanStatus.extend({ already_running: z.boolean() });
export type CreateScanResponse = z.infer<typeof CreateScanResponse>;

export const ScanPagesResponse = z
  .object({ accepted: count, rejected: count, pages_submitted: count })
  .strict();
export type ScanPagesResponse = z.infer<typeof ScanPagesResponse>;

export const LinkResult = z
  .object({
    id: z.string(),
    kind: z.enum(["page", "link"]),
    url: z.string(),
    label: z.string().nullable(),
    source: z.string(),
    found_in: z.string().nullable(),
    found_count: count,
    status: LinkStatus,
    http_code: z.number().int().nullable(),
    detail: z.string().nullable(),
    robots_index: z.enum(["index", "noindex"]).nullable(),
    robots_follow: z.enum(["follow", "nofollow"]).nullable(),
  })
  .strict();
export type LinkResult = z.infer<typeof LinkResult>;

export const ScanResultsResponse = z
  .object({ items: z.array(LinkResult), next_cursor: z.string().nullable() })
  .strict();
export type ScanResultsResponse = z.infer<typeof ScanResultsResponse>;

export const LinkScanJob = z.object({ scan_id: z.string().uuid() }).strict();
export type LinkScanJob = z.infer<typeof LinkScanJob>;
