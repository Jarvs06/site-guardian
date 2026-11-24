<?php
/**
 * Admin-only REST routes behind the settings page.
 *
 * @package SiteGuardian
 */

namespace SiteGuardian\Rest;

use SiteGuardian\Core\Client;
use SiteGuardian\Core\Registration;
use SiteGuardian\Core\Result;
use SiteGuardian\Support\Options;

defined( 'ABSPATH' ) || exit;

/**
 * Connect, rotate and status endpoints. Never expose the credential.
 */
final class AdminController {

	private const LOCK_TTL = 60;

	/**
	 * Register hooks.
	 */
	public static function register(): void {
		add_action( 'rest_api_init', array( self::class, 'register_routes' ) );
	}

	/**
	 * Register routes.
	 */
	public static function register_routes(): void {
		$routes = array(
			'admin/connect' => array( 'POST', 'handle_connect' ),
			'admin/rotate'  => array( 'POST', 'handle_rotate' ),
			'admin/status'  => array( 'GET', 'handle_status' ),
		);
		foreach ( $routes as $path => $def ) {
			register_rest_route(
				'site-guardian/v1',
				'/' . $path,
				array(
					'methods'             => $def[0],
					'callback'            => array( self::class, $def[1] ),
					'permission_callback' => array( self::class, 'can_manage' ),
				)
			);
		}
	}

	/**
	 * Permission callback (WP core verifies the wp_rest nonce for cookie auth).
	 */
	public static function can_manage(): bool {
		return (bool) current_user_can( 'manage_options' );
	}

	/**
	 * POST admin/connect.
	 */
	public static function handle_connect(): \WP_REST_Response {
		$out = self::connect_response( array( Registration::class, 'connect' ) );
		return new \WP_REST_Response( $out['body'], $out['status'] );
	}

	/**
	 * POST admin/rotate.
	 */
	public static function handle_rotate(): \WP_REST_Response {
		$out = self::rotate_response( array( Registration::class, 'rotate' ), array( Registration::class, 'is_connected' ) );
		return new \WP_REST_Response( $out['body'], $out['status'] );
	}

	/**
	 * GET admin/status.
	 */
	public static function handle_status(): \WP_REST_Response {
		return new \WP_REST_Response( self::status_body( Registration::is_connected() ), 200 );
	}

	/**
	 * Run a locked connect attempt.
	 *
	 * @param callable $connector Returns a Result.
	 * @return array{status:int,body:array{connected:bool,message:string}}
	 */
	public static function connect_response( callable $connector ): array {
		if ( ! self::acquire_lock() ) {
			return array(
				'status' => 409,
				'body'   => array(
					'connected' => false,
					'message'   => 'A connection attempt is already in progress. Please wait a moment.',
				),
			);
		}
		try {
			/** @var Result $result */
			$result = $connector();
		} finally {
			delete_option( Options::CONNECT_LOCK );
		}
		return array(
			'status' => 200,
			'body'   => array(
				'connected' => $result->ok,
				'message'   => $result->ok ? 'Connected to Site Guardian.' : (string) $result->message,
			),
		);
	}

	/**
	 * Run a rotate.
	 *
	 * @param callable $rotator      Returns a Result.
	 * @param callable $is_connected Returns bool.
	 * @return array{status:int,body:array{connected:bool,message:string}}
	 */
	public static function rotate_response( callable $rotator, callable $is_connected ): array {
		/** @var Result $result */
		$result = $rotator();
		return array(
			'status' => 200,
			'body'   => array(
				'connected' => (bool) $is_connected(),
				'message'   => $result->ok ? 'Credential rotated.' : (string) $result->message,
			),
		);
	}

	/**
	 * Status payload (no credential).
	 *
	 * @param bool $connected Whether connected.
	 * @return array{connected:bool,website_id:string,core_url:string,last_error:string}
	 */
	public static function status_body( bool $connected ): array {
		$website = get_option( Options::WEBSITE_ID, '' );
		$error   = get_option( Options::LAST_ERROR, '' );
		return array(
			'connected'  => $connected,
			'website_id' => $connected && is_string( $website ) ? $website : '',
			'core_url'   => Client::base_url(),
			'last_error' => is_string( $error ) ? $error : '',
		);
	}

	/**
	 * Atomically take the connect lock, reclaiming a stale one once.
	 */
	private static function acquire_lock(): bool {
		if ( add_option( Options::CONNECT_LOCK, time(), '', false ) ) {
			return true;
		}
		$taken = (int) get_option( Options::CONNECT_LOCK, 0 );
		if ( time() - $taken > self::LOCK_TTL ) {
			delete_option( Options::CONNECT_LOCK );
			return (bool) add_option( Options::CONNECT_LOCK, time(), '', false );
		}
		return false;
	}
}
