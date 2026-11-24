<?php
/**
 * Theme-free template for the Site Guardian page.
 *
 * @package SiteGuardian
 */

namespace SiteGuardian\Frontend;

defined( 'ABSPATH' ) || exit;

/**
 * Swaps the theme template for templates/app.php on the allowed page.
 */
final class Template {

	/**
	 * Hook the swap.
	 */
	public static function register(): void {
		add_filter( 'template_include', array( self::class, 'include_template' ), 99 );
	}

	/**
	 * Filter callback.
	 *
	 * @param string $template Theme template path.
	 */
	public static function include_template( $template ) {
		if ( Access::is_app_page() && Access::current_user_allowed() ) {
			return dirname( __DIR__, 2 ) . '/templates/app.php';
		}
		return $template;
	}

	/**
	 * Data handed to the template.
	 *
	 * @return array{rest_url:string,nonce:string,site_name:string}
	 */
	public static function boot_data(): array {
		return array(
			'rest_url'  => rest_url( 'site-guardian/v1/' ),
			'nonce'     => wp_create_nonce( 'wp_rest' ),
			'site_name' => (string) get_bloginfo( 'name' ),
		);
	}
}
