<?php
/**
 * Encrypted credential storage.
 *
 * @package SiteGuardian
 */

namespace SiteGuardian\Core;

use SiteGuardian\Support\Options;

defined( 'ABSPATH' ) || exit;

/**
 * Stores the Core credential encrypted with a key derived from AUTH_KEY/AUTH_SALT.
 */
final class CredentialStore {

	/**
	 * Test seam: when set, supplies the key material instead of the constants.
	 *
	 * @var (callable(): string)|null
	 */
	private static $key_material_provider = null;

	/**
	 * Override the key material source (tests only). Pass null to reset.
	 *
	 * @param (callable(): string)|null $provider Provider returning raw key material.
	 */
	public static function set_key_material_provider( ?callable $provider ): void {
		self::$key_material_provider = $provider;
	}

	/**
	 * Whether the credential comes from the SITE_GUARDIAN_CREDENTIAL constant (it then wins over the option).
	 */
	public static function from_constant(): bool {
		return defined( 'SITE_GUARDIAN_CREDENTIAL' ) && is_string( SITE_GUARDIAN_CREDENTIAL ) && '' !== SITE_GUARDIAN_CREDENTIAL;
	}

	/**
	 * Get the plaintext credential, or null if absent or undecryptable.
	 */
	public static function get(): ?string {
		if ( self::from_constant() ) {
			return SITE_GUARDIAN_CREDENTIAL;
		}

		$stored = get_option( Options::CREDENTIAL, '' );
		if ( ! is_string( $stored ) || '' === $stored ) {
			return null;
		}

		$plain = self::decrypt( $stored );
		if ( null === $plain ) {
			delete_option( Options::CREDENTIAL );
		}
		return $plain;
	}

	/**
	 * Encrypt and store the credential.
	 *
	 * @param string $token Plaintext credential.
	 */
	public static function put( string $token ): void {
		$key    = self::key();
		$nonce  = random_bytes( SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		$cipher = sodium_crypto_secretbox( $token, $nonce, $key );
		sodium_memzero( $key );

		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- Binary-safe storage encoding, not obfuscation.
		update_option( Options::CREDENTIAL, base64_encode( $nonce . $cipher ), false );
	}

	/**
	 * Remove the stored credential.
	 */
	public static function clear(): void {
		delete_option( Options::CREDENTIAL );
	}

	/**
	 * Decrypt a stored value; null on any failure.
	 *
	 * @param string $stored Stored base64 value.
	 */
	private static function decrypt( string $stored ): ?string {
		try {
			// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode -- Decoding our own storage format.
			$raw = base64_decode( $stored, true );
			if ( false === $raw || strlen( $raw ) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES + SODIUM_CRYPTO_SECRETBOX_MACBYTES ) {
				return null;
			}
			$nonce  = substr( $raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
			$cipher = substr( $raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
			$key    = self::key();
			$plain  = sodium_crypto_secretbox_open( $cipher, $nonce, $key );
			sodium_memzero( $key );
			return false === $plain ? null : $plain;
		} catch ( \Throwable $e ) {
			return null;
		}
	}

	/**
	 * Derive the 32-byte encryption key.
	 */
	private static function key(): string {
		$material = null !== self::$key_material_provider
			? ( self::$key_material_provider )()
			: ( defined( 'AUTH_KEY' ) ? AUTH_KEY : '' ) . ( defined( 'AUTH_SALT' ) ? AUTH_SALT : '' );

		return sodium_crypto_generichash( $material . 'site-guardian', '', 32 );
	}
}
