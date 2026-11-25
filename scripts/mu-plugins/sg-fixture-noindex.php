<?php
/**
 * Local e2e fixture (mounted by docker-compose.yml): the page with slug `sg-fixture-noindex`
 * is served with a robots noindex meta tag, so the link scan has a Noindex page row.
 *
 * @package SiteGuardianFixtures
 */

add_filter(
	'wp_robots',
	static function ( array $robots ): array {
		if ( is_page( 'sg-fixture-noindex' ) ) {
			$robots['noindex'] = true;
		}
		return $robots;
	}
);
