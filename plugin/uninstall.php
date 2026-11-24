<?php
/**
 * Uninstall: remove the plugin's options and page.
 *
 * @package SiteGuardian
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

require_once __DIR__ . '/vendor/autoload.php';

use SiteGuardian\Support\Options;

$site_guardian_page_id = (int) get_option( Options::PAGE_ID, 0 );
if ( $site_guardian_page_id > 0 ) {
	wp_delete_post( $site_guardian_page_id, true );
}

foreach ( Options::all() as $site_guardian_option ) {
	delete_option( $site_guardian_option );
}
