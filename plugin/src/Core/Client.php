<?php
/**
 * HTTP client for Site Guardian Core.
 *
 * @package SiteGuardian
 */

namespace SiteGuardian\Core;

defined( 'ABSPATH' ) || exit;

/**
 * Talks JSON to Core. Never logs or echoes the credential.
 */
final class Client {

	public const DEFAULT_BASE_URL = 'https://core.siteguardian.ai/api/v1';

	/**
	 * Seconds to wait for Core. Longer than Core's own worst case for each slow route
	 * (chat: 75 s AI deadline; complete: two 10 s verify fetches), so WordPress never gives up
	 * on work Core then completes.
	 */
	public const DEFAULT_TIMEOUT = 15;
	public const ROUTE_TIMEOUTS  = array(
		'ai/chat'                 => 90,
		'sites/register/complete' => 30,
	);

	public const NETWORK_MESSAGE = "Couldn't reach Site Guardian. Please check your connection and try again.";

	/**
	 * Core base URL (constant or default).
	 */
	public static function base_url(): string {
		$url = ( defined( 'SITE_GUARDIAN_CORE_URL' ) && is_string( SITE_GUARDIAN_CORE_URL ) && '' !== SITE_GUARDIAN_CORE_URL )
			? SITE_GUARDIAN_CORE_URL
			: self::DEFAULT_BASE_URL;
		return rtrim( $url, '/' );
	}

	/**
	 * Perform a request against Core.
	 *
	 * @param string              $method HTTP method.
	 * @param string              $path   Path relative to the base URL.
	 * @param array<string,mixed> $body   JSON body (sent when non-empty).
	 * @param bool                $auth   Send the Bearer credential and user ref.
	 */
	public static function request( string $method, string $path, array $body = array(), bool $auth = true ): Result {
		$version = defined( 'SITE_GUARDIAN_VERSION' ) ? SITE_GUARDIAN_VERSION : '0';
		$headers = array(
			'Accept'       => 'application/json',
			'Content-Type' => 'application/json',
			'User-Agent'   => 'SiteGuardian/' . $version,
		);

		if ( $auth ) {
			$credential = CredentialStore::get();
			if ( null === $credential ) {
				return Result::failure( 0, 'not_connected', 'This site is not connected to Site Guardian.' );
			}
			$headers['Authorization'] = 'Bearer ' . $credential;
			$user_id                  = (int) get_current_user_id();
			if ( $user_id > 0 ) {
				$headers['x-sg-user-ref'] = UserRef::for_user( $user_id );
			}
		}

		$args = array(
			'method'      => strtoupper( $method ),
			'timeout'     => self::ROUTE_TIMEOUTS[ ltrim( $path, '/' ) ] ?? self::DEFAULT_TIMEOUT,
			'sslverify'   => true,
			'redirection' => 0,
			'headers'     => $headers,
		);
		if ( array() !== $body ) {
			$args['body'] = wp_json_encode( $body );
		}

		$response = wp_remote_request( self::base_url() . '/' . ltrim( $path, '/' ), $args );
		if ( is_wp_error( $response ) ) {
			return Result::failure( 0, 'network_error', self::NETWORK_MESSAGE );
		}

		$status  = (int) wp_remote_retrieve_response_code( $response );
		$decoded = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		if ( ! is_array( $decoded ) ) {
			return Result::failure( $status, 'bad_response', 'Site Guardian returned an unexpected response.' );
		}

		if ( $status >= 200 && $status < 300 ) {
			return Result::success( $status, $decoded );
		}

		$error = $decoded['error'] ?? null;
		if ( is_array( $error ) && isset( $error['code'] ) && is_string( $error['code'] ) ) {
			$message = isset( $error['message'] ) && is_string( $error['message'] ) ? $error['message'] : 'Site Guardian reported an error.';
			$rid     = isset( $decoded['request_id'] ) && is_string( $decoded['request_id'] ) ? $decoded['request_id'] : null;
			return Result::failure( $status, $error['code'], $message, $rid );
		}
		return Result::failure( $status, 'bad_response', 'Site Guardian returned an unexpected response.' );
	}
}
