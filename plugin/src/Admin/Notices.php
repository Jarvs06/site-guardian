<?php
/**
 * Admin notice prompting the site owner to connect.
 *
 * @package SiteGuardian
 */

namespace SiteGuardian\Admin;

use SiteGuardian\Core\Registration;

defined( 'ABSPATH' ) || exit;

/**
 * "Not connected" notice.
 */
final class Notices {

	/**
	 * Register hooks.
	 */
	public static function register(): void {
		add_action( 'admin_notices', array( self::class, 'render' ) );
	}

	/**
	 * Whether the notice should show.
	 *
	 * @param bool   $can_manage Current user has manage_options.
	 * @param bool   $connected  Site is connected.
	 * @param string $screen_id  Current screen id.
	 */
	public static function should_show( bool $can_manage, bool $connected, string $screen_id ): bool {
		return $can_manage && ! $connected && SettingsPage::SCREEN_ID !== $screen_id;
	}

	/**
	 * Print the notice.
	 */
	public static function render(): void {
		$screen    = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		$screen_id = $screen ? (string) $screen->id : '';
		if ( ! self::should_show( current_user_can( 'manage_options' ), Registration::is_connected(), $screen_id ) ) {
			return;
		}
		printf(
			'<div class="notice notice-warning is-dismissible"><p>%s <a href="%s">%s</a></p></div>',
			esc_html__( 'Site Guardian is not connected yet.', 'site-guardian' ),
			esc_url( admin_url( 'options-general.php?page=' . SettingsPage::SLUG ) ),
			esc_html__( 'Connect your site', 'site-guardian' )
		);
	}
}
