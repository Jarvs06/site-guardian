<?php
/**
 * Plugin Name:       Site Guardian
 * Description:       Connects your site to Site Guardian for health checks and AI-assisted maintenance.
 * Version:           0.1.0
 * Requires at least: 6.4
 * Requires PHP:      8.1
 * Author:            Site Guardian
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       site-guardian
 *
 * @package SiteGuardian
 */

defined( 'ABSPATH' ) || exit;

define( 'SITE_GUARDIAN_VERSION', '0.1.0' );
define( 'SITE_GUARDIAN_FILE', __FILE__ );

$site_guardian_autoload = __DIR__ . '/vendor/autoload.php';

if ( ! is_readable( $site_guardian_autoload ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			echo '<div class="notice notice-error"><p>'
				. esc_html__( 'Site Guardian is missing its dependencies (vendor/autoload.php). Please reinstall the plugin from the release package.', 'site-guardian' )
				. '</p></div>';
		}
	);
	return;
}

require_once $site_guardian_autoload;

\SiteGuardian\Plugin::boot( __FILE__ );
