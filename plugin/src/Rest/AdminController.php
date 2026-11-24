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
	 * @return array{status:int,body:array<string,mixed>}
	 */
	public static function connect_response( callable $connector ): array {
		return self::locked(
			static function () use ( $connector ): array {
				/** @var Result $result */
				$result = $connector();
				return array(
					'status' => 200,
					'body'   => array(
						'connected' => $result->ok,
						'message'   => $result->ok ? 'Connected to Site Guardian.' : (string) $result->message,
					),
				);
			}
		);
	}

	/**
	 * Run a locked rotate.
	 *
	 * @param callable $rotator      Returns a Result.
	 * @param callable $is_connected Returns bool.
	 * @return array{status:int,body:array<string,mixed>}
	 */
	public static function rotate_response( callable $rotator, callable $is_connected ): array {
		return self::locked(
			static function () use ( $rotator, $is_connected ): array {
				/** @var Result $result */
				$result = $rotator();
				if ( $result->ok ) {
					return array(
						'status' => 200,
						'body'   => array(
							'ok'        => true,
							'connected' => (bool) $is_connected(),
							'message'   => 'Credential rotated.',
						),
					);
				}
				return array(
					'status' => $result->status >= 400 ? $result->status : 502,
					'body'   => array(
						'ok'        => false,
						'connected' => (bool) $is_connected(),
						'message'   => (string) $result->message,
					),
				);
			}
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
	 * Run $work under the connect lock, or return a 409.
	 *
	 * @param callable $work Returns a response array.
	 * @return array{status:int,body:array<string,mixed>}
	 */
	private static function locked( callable $work ): array {
		$token = self::acquire_lock();
		if ( null === $token ) {
			return array(
				'status' => 409,
				'body'   => array(
					'ok'        => false,
					'connected' => false,
					'message'   => 'A connection attempt is already in progress. Please wait a moment.',
				),
			);
		}
		try {
			return $work();
		} finally {
			self::delete_lock_if( $token );
		}
	}

	/**
	 * Take the lock with an atomic INSERT IGNORE, reclaiming a stale one once.
	 *
	 * @return string|null Owner token, or null when not acquired.
	 */
	private static function acquire_lock(): ?string {
		global $wpdb;
		$token = time() . ':' . bin2hex( random_bytes( 16 ) );

		if ( self::insert_lock( $token ) ) {
			return $token;
		}

		$observed = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", Options::CONNECT_LOCK ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		if ( is_string( $observed ) && time() - (int) $observed > self::LOCK_TTL ) {
			self::delete_lock_if( $observed );
			if ( self::insert_lock( $token ) ) {
				return $token;
			}
		}
		return null;
	}

	/**
	 * Atomic insert; true only when this call created the row.
	 *
	 * @param string $token Owner token.
	 */
	private static function insert_lock( string $token ): bool {
		global $wpdb;
		$rows = $wpdb->query( $wpdb->prepare( "INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')", Options::CONNECT_LOCK, $token ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		self::flush_lock_cache();
		return 1 === $rows;
	}

	/**
	 * Compare-and-delete: remove the lock only if it still holds $value.
	 *
	 * @param string $value Expected lock value.
	 */
	private static function delete_lock_if( string $value ): void {
		global $wpdb;
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name = %s AND option_value = %s", Options::CONNECT_LOCK, $value ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		self::flush_lock_cache();
	}

	/**
	 * Keep the object cache from serving a stale lock.
	 */
	private static function flush_lock_cache(): void {
		wp_cache_delete( Options::CONNECT_LOCK, 'options' );
		wp_cache_delete( 'alloptions', 'options' );
	}
}
