<?php
/**
 * Front-end access rules.
 *
 * @package SiteGuardian
 */

namespace SiteGuardian\Frontend;

use SiteGuardian\Support\Options;

defined( 'ABSPATH' ) || exit;

/**
 * Who may use the Site Guardian page.
 */
final class Access {

	public const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";

	/**
	 * Capability required to use the front-end page.
	 */
	public static function capability(): string {
		$cap = apply_filters( 'site_guardian_capability', get_option( Options::CAPABILITY, 'manage_options' ) );
		return is_string( $cap ) && '' !== $cap ? $cap : 'manage_options';
	}

	/**
	 * Header sender seam (tests).
	 *
	 * @var callable|null
	 */
	private static $header_sender = null;

	/**
	 * Replace the header sender (tests).
	 *
	 * @param callable|null $sender fn(string $line): void.
	 */
	public static function set_header_sender( ?callable $sender ): void {
		self::$header_sender = $sender;
	}

	/**
	 * Hook the gate.
	 */
	public static function register(): void {
		add_action( 'template_redirect', array( self::class, 'gate' ), 1 );
	}

	/**
	 * Whether the current request is the Site Guardian page.
	 */
	public static function is_app_page(): bool {
		$page_id = (int) get_option( Options::PAGE_ID, 0 );
		return $page_id > 0 && is_page( $page_id );
	}

	/**
	 * Whether the current visitor may use the page.
	 */
	public static function current_user_allowed(): bool {
		return is_user_logged_in() && current_user_can( self::capability() );
	}

	/**
	 * Pure decision.
	 *
	 * @param bool $is_app_page Request is the Site Guardian page.
	 * @param bool $logged_in   Visitor is logged in.
	 * @param bool $has_cap     Visitor has the capability.
	 * @return string 'skip'|'redirect'|'not_found'|'allow'
	 */
	public static function decide( bool $is_app_page, bool $logged_in, bool $has_cap ): string {
		if ( ! $is_app_page ) {
			return 'skip';
		}
		if ( ! $logged_in ) {
			return 'redirect';
		}
		return $has_cap ? 'allow' : 'not_found';
	}

	/**
	 * Response headers for the allowed page.
	 *
	 * @return array<string,string>
	 */
	public static function headers(): array {
		return array(
			'Content-Security-Policy' => self::CSP,
			'X-Robots-Tag'            => 'noindex, nofollow',
			'X-Content-Type-Options'  => 'nosniff',
			'Referrer-Policy'         => 'same-origin',
		);
	}

	/**
	 * Gate the page (template_redirect, priority 1).
	 */
	public static function gate(): void {
		$logged_in = is_user_logged_in();
		$decision  = self::decide( self::is_app_page(), $logged_in, $logged_in && current_user_can( self::capability() ) );

		if ( 'redirect' === $decision ) {
			auth_redirect();
			return;
		}
		if ( 'not_found' === $decision ) {
			global $wp_query;
			$wp_query->set_404();
			status_header( 404 );
			nocache_headers();
			return;
		}
		if ( 'allow' === $decision ) {
			foreach ( self::headers() as $name => $value ) {
				if ( null !== self::$header_sender ) {
					( self::$header_sender )( $name . ': ' . $value );
				} else {
					header( $name . ': ' . $value );
				}
			}
			nocache_headers();
		}
	}
}
