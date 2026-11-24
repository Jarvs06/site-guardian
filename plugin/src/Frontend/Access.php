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

	/**
	 * Capability required to use the front-end page.
	 */
	public static function capability(): string {
		$cap = apply_filters( 'site_guardian_capability', get_option( Options::CAPABILITY, 'manage_options' ) );
		return is_string( $cap ) && '' !== $cap ? $cap : 'manage_options';
	}
}
