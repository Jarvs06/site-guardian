<?php
/**
 * Pseudonymous per-user reference.
 *
 * @package SiteGuardian
 */

namespace SiteGuardian\Core;

use SiteGuardian\Support\Options;

defined( 'ABSPATH' ) || exit;

/**
 * HMAC of the WordPress user id, so Core never sees raw ids.
 */
final class UserRef {

	/**
	 * Reference for a user.
	 *
	 * @param int $user_id WordPress user id.
	 */
	public static function for_user( int $user_id ): string {
		return hash_hmac( 'sha256', (string) $user_id, self::secret() );
	}

	/**
	 * Get (lazily creating) the secret.
	 */
	private static function secret(): string {
		$secret = get_option( Options::USER_REF_SECRET, '' );
		if ( ! is_string( $secret ) || '' === $secret ) {
			$secret = bin2hex( random_bytes( 32 ) );
			update_option( Options::USER_REF_SECRET, $secret, false );
		}
		return $secret;
	}
}
