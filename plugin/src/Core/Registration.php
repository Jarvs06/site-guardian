<?php
/**
 * Domain-verified registration with Core.
 *
 * @package SiteGuardian
 */

namespace SiteGuardian\Core;

use SiteGuardian\Support\Options;

defined( 'ABSPATH' ) || exit;

/**
 * Connect, rotate and inspect the Core connection.
 */
final class Registration {

	public const CONFIG_CREDENTIAL_MESSAGE = 'The Site Guardian credential is set in wp-config.php (SITE_GUARDIAN_CREDENTIAL). Change it there.';

	/**
	 * Whether a credential is available.
	 */
	public static function is_connected(): bool {
		return null !== CredentialStore::get();
	}

	/**
	 * Run the start, verify, complete handshake.
	 */
	public static function connect(): Result {
		if ( CredentialStore::from_constant() ) {
			return self::config_credential_failure();
		}
		try {
			$result = self::handshake();
		} finally {
			delete_option( Options::PENDING_CHALLENGE );
		}

		if ( ! $result->ok ) {
			update_option( Options::LAST_ERROR, (string) $result->message, false );
		}
		return $result;
	}

	/**
	 * Rotate the credential.
	 */
	public static function rotate(): Result {
		if ( CredentialStore::from_constant() ) {
			return self::config_credential_failure();
		}
		$result = Client::request( 'POST', 'sites/credential/rotate' );

		if ( $result->ok && isset( $result->data['credential'] ) && is_string( $result->data['credential'] ) ) {
			CredentialStore::put( $result->data['credential'] );
			delete_option( Options::LAST_ERROR );
			return $result;
		}
		if ( 401 === $result->status ) {
			CredentialStore::clear();
			update_option( Options::LAST_ERROR, 'Site Guardian no longer accepts this site\'s credential. Please reconnect the site.', false );
		} elseif ( ! $result->ok ) {
			update_option( Options::LAST_ERROR, (string) $result->message, false );
		}
		return $result->ok ? Result::failure( $result->status, 'bad_response', 'Site Guardian returned an unexpected response.' ) : $result;
	}

	/**
	 * A new credential would be stored in the option, which the constant overrides, while Core
	 * would already reject the old one: refuse before calling Core.
	 */
	private static function config_credential_failure(): Result {
		return Result::failure( 409, 'credential_in_config', self::CONFIG_CREDENTIAL_MESSAGE );
	}

	/**
	 * The start/complete exchange (pending challenge is cleaned up by the caller).
	 */
	private static function handshake(): Result {
		$start = Client::request(
			'POST',
			'sites/register/start',
			array(
				'installation_id' => self::installation_id(),
				'site_url'        => home_url(),
				'site_name'       => get_bloginfo( 'name' ),
				'wp_version'      => get_bloginfo( 'version' ),
				'plugin_version'  => defined( 'SITE_GUARDIAN_VERSION' ) ? SITE_GUARDIAN_VERSION : '',
				'php_version'     => PHP_VERSION,
			),
			false
		);
		if ( ! $start->ok ) {
			return $start;
		}

		$id      = $start->data['challenge_id'] ?? null;
		$value   = $start->data['challenge'] ?? null;
		$expires = isset( $start->data['expires_at'] ) && is_string( $start->data['expires_at'] ) ? strtotime( $start->data['expires_at'] ) : false;
		if ( ! is_string( $id ) || ! is_string( $value ) || false === $expires ) {
			return Result::failure( $start->status, 'bad_response', 'Site Guardian returned an unexpected response.' );
		}

		update_option(
			Options::PENDING_CHALLENGE,
			array(
				'id'      => $id,
				'value'   => $value,
				'expires' => $expires,
			),
			false
		);

		$complete = Client::request( 'POST', 'sites/register/complete', array( 'challenge_id' => $id ), false );
		if ( ! $complete->ok ) {
			return $complete;
		}

		$credential = $complete->data['credential'] ?? null;
		$website_id = $complete->data['website_id'] ?? null;
		if ( ! is_string( $credential ) || '' === $credential || ! is_string( $website_id ) ) {
			return Result::failure( $complete->status, 'bad_response', 'Site Guardian returned an unexpected response.' );
		}

		CredentialStore::put( $credential );
		update_option( Options::WEBSITE_ID, $website_id, false );
		delete_option( Options::LAST_ERROR );
		return $complete;
	}

	/**
	 * Get (creating once) the installation id.
	 */
	private static function installation_id(): string {
		$id = get_option( Options::INSTALLATION_ID, '' );
		if ( ! is_string( $id ) || '' === $id ) {
			$id = wp_generate_uuid4();
			update_option( Options::INSTALLATION_ID, $id, false );
		}
		return $id;
	}
}
