-- Local dev seed: plans only (idempotent; the migration already inserts them).
insert into plans (code, name, price_cents, currency, limits) values
  ('free',       'Free',       0,    'usd', '{"performance_checks_per_day": 3,  "concurrent_scans": 1}'::jsonb),
  ('starter',    'Starter',    1900, 'usd', '{"performance_checks_per_day": 5,  "concurrent_scans": 2}'::jsonb),
  ('pro',        'Pro',        4900, 'usd', '{"performance_checks_per_day": 10, "concurrent_scans": 3}'::jsonb),
  ('enterprise', 'Enterprise', 0,    'usd', '{"performance_checks_per_day": 25, "concurrent_scans": 5}'::jsonb)
on conflict (code) do nothing;
