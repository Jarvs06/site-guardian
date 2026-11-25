-- =============================================================================
-- Site Guardian Core — Stage 2 link scanner schema (migration 0002)
--
-- Extends scan_jobs with progress and truncation columns, allows one active
-- scan per website and type, and adds scan_pages (the submitted page list) and
-- link_results (page and link check results). Same access model as 0001: RLS
-- on, no anon/authenticated privileges, explicit service_role grants.
-- =============================================================================

alter table scan_jobs
  add column pages_total     integer not null default 0,
  add column pages_checked   integer not null default 0,
  add column links_total     integer not null default 0,
  add column links_checked   integer not null default 0,
  add column pages_submitted integer not null default 0,
  add column pages_found     integer,
  add column truncated_reason text
    constraint ck_scan_jobs_truncated_reason check (truncated_reason in ('page_cap', 'link_cap', 'time_limit')),
  add column pgboss_job_id   uuid;

-- At most one active scan per website and type.
create unique index uq_scan_jobs_active
  on scan_jobs(website_id, type)
  where status in ('starting', 'queued', 'running');

-- The page list submitted by the plugin. Never results.
create table scan_pages (
  scan_job_id  uuid not null references scan_jobs(id) on delete cascade,
  url          text not null,
  source       text not null,
  ordinal      integer not null,
  constraint uq_scan_pages_scan_url unique (scan_job_id, url)
);

create table link_results (
  id            bigint generated always as identity primary key,
  scan_job_id   uuid not null references scan_jobs(id) on delete cascade,
  kind          text not null check (kind in ('page', 'link')),
  url           text not null check (char_length(url) <= 2048),  -- normalized; skipped rows keep the trimmed raw href
  label         text check (char_length(label) <= 200),
  source        text not null,                                    -- post type for pages, 'page' for links
  found_in      text,
  found_count   integer not null default 1,
  status        text not null check (status in ('ok', 'broken', 'redirect', 'restricted', 'warning', 'skipped')),
  http_code     integer,
  detail        text check (char_length(detail) <= 500),
  robots_index  text check (robots_index in ('index', 'noindex')),
  robots_follow text check (robots_follow in ('follow', 'nofollow')),
  checked_at    timestamptz not null default now(),
  constraint uq_link_results_scan_kind_url unique (scan_job_id, kind, url)
);

create index idx_link_results_scan_id on link_results(scan_job_id, id);

alter table scan_pages   enable row level security;
alter table link_results enable row level security;

revoke all on scan_pages, link_results from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant all on scan_pages, link_results to service_role;
grant all on all sequences in schema public to service_role;
