#!/usr/bin/env bash
# Installs the local WordPress (docker compose) and activates Site Guardian. Idempotent.
#
#   docker compose up -d && scripts/dev-setup.sh
#
# Creates admin/admin-pass-local (administrator) and sub/sub-pass-local (subscriber),
# sets /%postname%/ permalinks so /site-health-check/ and /wp-json/ resolve.
set -euo pipefail

cd "$(dirname "$0")/.."

SITE_URL="http://127.0.0.1:8080"

wp() {
  docker compose run --rm -T wpcli wp "$@"
}

# PHP mysqli, as WordPress uses: the CLI image's MariaDB client can't do MySQL 8 auth/TLS.
db_ready() {
  docker compose run --rm -T wpcli php -r \
    'exit(@mysqli_connect("db", "wordpress", "wordpress", "wordpress") ? 0 : 1);' >/dev/null 2>&1
}

if [ ! -f plugin/vendor/autoload.php ]; then
  echo "plugin/vendor is missing: run 'composer install' in plugin/ first." >&2
  exit 1
fi

echo "Waiting for WordPress files and database..."
for _ in $(seq 1 60); do
  if docker compose exec -T wordpress test -f /var/www/html/wp-config.php 2>/dev/null && db_ready; then
    break
  fi
  sleep 2
done
db_ready || { echo "Database not reachable." >&2; exit 1; }

if wp core is-installed >/dev/null 2>&1; then
  echo "WordPress already installed."
else
  wp core install --url="$SITE_URL" --title="Site Guardian Local" \
    --admin_user=admin --admin_password=admin-pass-local --admin_email=admin@example.test --skip-email
fi

# Re-assert the admin password and make sure the subscriber exists.
wp user update admin --user_pass=admin-pass-local --skip-email >/dev/null
if wp user get sub --field=ID >/dev/null 2>&1; then
  wp user update sub --user_pass=sub-pass-local --role=subscriber --skip-email >/dev/null
else
  wp user create sub sub@example.test --role=subscriber --user_pass=sub-pass-local >/dev/null
fi

wp rewrite structure '/%postname%/' >/dev/null
wp rewrite flush >/dev/null

if wp plugin is-active site-guardian >/dev/null 2>&1; then
  echo "Site Guardian already active."
else
  wp plugin activate site-guardian
fi

echo "WordPress ready at $SITE_URL (admin/admin-pass-local, sub/sub-pass-local)."
