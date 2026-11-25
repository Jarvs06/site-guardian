<?php
/**
 * Plugin bootstrap.
 *
 * @package SiteGuardian
 */

namespace SiteGuardian;

defined( 'ABSPATH' ) || exit;

/**
 * Wires the hooks of every module.
 */
final class Plugin {

	/**
	 * Boot the plugin.
	 *
	 * @param string $file Absolute path to the main plugin file.
	 */
	public static function boot( string $file ): void {
		if ( ! extension_loaded( 'sodium' ) ) {
			add_action( 'admin_notices', array( self::class, 'sodium_notice' ) );
			return;
		}

		\SiteGuardian\Rest\VerifyController::register();
		\SiteGuardian\Rest\AdminController::register();
		\SiteGuardian\Admin\SettingsPage::register();
		\SiteGuardian\Admin\Notices::register();
		\SiteGuardian\Rest\ChatController::register();
		\SiteGuardian\Rest\ScanController::register();
		\SiteGuardian\Frontend\Access::register();
		\SiteGuardian\Frontend\Template::register();
		\SiteGuardian\Frontend\Page::register();

		register_activation_hook( $file, array( self::class, 'activate' ) );
		register_deactivation_hook( $file, array( self::class, 'deactivate' ) );
	}

	/**
	 * Activation: create the capability option with autoload off.
	 *
	 * The Settings API (register_setting) never controls autoload, so the
	 * option is created here; later saves via update_option keep its autoload flag.
	 */
	public static function activate(): void {
		add_option( \SiteGuardian\Support\Options::CAPABILITY, 'manage_options', '', false );
		\SiteGuardian\Frontend\Page::ensure();
	}

	/**
	 * Deactivation placeholder; later tasks fill this in.
	 */
	public static function deactivate(): void {
	}

	/**
	 * Admin notice shown when the sodium extension is unavailable.
	 */
	public static function sodium_notice(): void {
		echo '<div class="notice notice-error"><p>'
			. esc_html__( 'Site Guardian requires the PHP sodium extension, which is not available on this server.', 'site-guardian' )
			. '</p></div>';
	}
}
