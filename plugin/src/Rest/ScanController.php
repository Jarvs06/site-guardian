<?php
/**
 * Link scan proxy between the browser and Core.
 *
 * @package SiteGuardian
 */

namespace SiteGuardian\Rest;

use SiteGuardian\Core\Client;
use SiteGuardian\Core\Result;
use SiteGuardian\Scan\PageList;

defined( 'ABSPATH' ) || exit;

/**
 * Routes under /scans/link. The browser never supplies a scan id or URLs.
 */
final class ScanController {

	private const BATCH  = 500;
	private const UUID   = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';
	private const ACTIVE = array( 'starting', 'queued', 'running' );

	/**
	 * Test seam for the Core call.
	 *
	 * @var callable|null
	 */
	private static $sender = null;

	/**
	 * Replace the Core call (tests).
	 *
	 * @param callable|null $sender fn(string $method, string $path, array $body): Result.
	 */
	public static function set_sender( ?callable $sender ): void {
		self::$sender = $sender;
	}

	/**
	 * Register hooks.
	 */
	public static function register(): void {
		add_action( 'rest_api_init', array( self::class, 'register_routes' ) );
	}

	/**
	 * Register the routes.
	 */
	public static function register_routes(): void {
		$routes = array(
			'/scans/link'         => array( 'POST', 'handle_start' ),
			'/scans/link/current' => array( 'GET', 'handle_current' ),
			'/scans/link/results' => array( 'GET', 'handle_results' ),
			'/scans/link/cancel'  => array( 'POST', 'handle_cancel' ),
		);
		foreach ( $routes as $path => $def ) {
			register_rest_route(
				'site-guardian/v1',
				$path,
				array(
					'methods'             => $def[0],
					'callback'            => array( self::class, $def[1] ),
					'permission_callback' => array( ChatController::class, 'can_chat' ),
				)
			);
		}
	}

	/**
	 * POST scans/link.
	 */
	public static function handle_start(): \WP_REST_Response {
		$created = self::call( 'POST', '/scans', array( 'type' => 'link' ) );
		if ( ! $created->ok ) {
			return self::error( $created );
		}
		if ( ! empty( $created->data['already_running'] ) ) {
			return new \WP_REST_Response( $created->data, 200 );
		}
		$scan_id = $created->data['scan_id'] ?? null;
		if ( ! is_string( $scan_id ) || 1 !== preg_match( self::UUID, $scan_id ) ) {
			return self::error( Result::failure( 502, 'bad_response', 'Site Guardian returned an unexpected response.' ) );
		}

		$list    = PageList::collect();
		$batches = array_chunk( $list['pages'], self::BATCH );
		$last    = count( $batches ) - 1;
		foreach ( $batches as $i => $batch ) {
			$body = array( 'pages' => $batch );
			if ( $i === $last ) {
				$body['pages_found'] = $list['found'];
			}
			$sent = self::call( 'POST', '/scans/' . $scan_id . '/pages', $body );
			if ( ! $sent->ok ) {
				return self::error( $sent );
			}
		}

		$begun = self::call( 'POST', '/scans/' . $scan_id . '/begin', array() );
		return $begun->ok ? new \WP_REST_Response( $begun->data, 200 ) : self::error( $begun );
	}

	/**
	 * GET scans/link/current.
	 */
	public static function handle_current(): \WP_REST_Response {
		$latest = self::latest();
		if ( 404 === $latest->status && 'not_found' === $latest->error_code ) {
			return new \WP_REST_Response( array( 'status' => 'none' ), 200 );
		}
		return $latest->ok ? new \WP_REST_Response( $latest->data, 200 ) : self::error( $latest );
	}

	/**
	 * GET scans/link/results.
	 *
	 * @param \WP_REST_Request $request Request.
	 */
	public static function handle_results( $request ): \WP_REST_Response {
		$cursor = $request->get_param( 'cursor' );
		$query  = '';
		if ( null !== $cursor && '' !== $cursor ) {
			if ( ! is_string( $cursor ) || 1 !== preg_match( '/^\d{1,19}$/', $cursor ) ) {
				return new \WP_REST_Response(
					array(
						'error' => array(
							'code'    => 'invalid_cursor',
							'message' => 'Invalid cursor.',
						),
					),
					400
				);
			}
			$query = '?cursor=' . $cursor;
		}

		$latest = self::latest();
		if ( 404 === $latest->status && 'not_found' === $latest->error_code ) {
			return self::empty_results();
		}
		if ( ! $latest->ok ) {
			return self::error( $latest );
		}
		$id = $latest->data['results_scan_id'] ?? null;
		if ( ! is_string( $id ) || 1 !== preg_match( self::UUID, $id ) ) {
			return self::empty_results();
		}

		$res = self::call( 'GET', '/scans/' . $id . '/results' . $query, array() );
		return $res->ok ? new \WP_REST_Response( $res->data, 200 ) : self::error( $res );
	}

	/**
	 * POST scans/link/cancel.
	 */
	public static function handle_cancel(): \WP_REST_Response {
		$latest = self::latest();
		if ( 404 === $latest->status && 'not_found' === $latest->error_code ) {
			return new \WP_REST_Response( array( 'status' => 'none' ), 200 );
		}
		if ( ! $latest->ok ) {
			return self::error( $latest );
		}
		$id = $latest->data['scan_id'] ?? null;
		if ( ! in_array( $latest->data['status'] ?? null, self::ACTIVE, true ) || ! is_string( $id ) || 1 !== preg_match( self::UUID, $id ) ) {
			return new \WP_REST_Response( $latest->data, 200 );
		}

		$res = self::call( 'POST', '/scans/' . $id . '/cancel', array() );
		return $res->ok ? new \WP_REST_Response( $res->data, 200 ) : self::error( $res );
	}

	/**
	 * Core's latest link scan.
	 */
	private static function latest(): Result {
		return self::call( 'GET', '/scans/latest?type=link', array() );
	}

	/**
	 * Empty results page.
	 */
	private static function empty_results(): \WP_REST_Response {
		return new \WP_REST_Response(
			array(
				'items'       => array(),
				'next_cursor' => null,
			),
			200
		);
	}

	/**
	 * Call Core (or the test sender).
	 *
	 * @param string              $method HTTP method.
	 * @param string              $path   Path, query included.
	 * @param array<string,mixed> $body   JSON body.
	 */
	private static function call( string $method, string $path, array $body ): Result {
		$result = null !== self::$sender
			? ( self::$sender )( $method, $path, $body )
			: Client::request( $method, $path, $body );
		return $result instanceof Result ? $result : Result::failure( 0, 'network_error', Client::NETWORK_MESSAGE );
	}

	/**
	 * Map a failed result to a response.
	 *
	 * @param Result $result Failed result.
	 */
	private static function error( Result $result ): \WP_REST_Response {
		$code    = (string) $result->error_code;
		$status  = $result->status;
		$message = (string) $result->message;

		if ( 'not_connected' === $code ) {
			$status  = 503;
			$message = "Site Guardian isn't connected yet. Ask an administrator to connect it in Settings → Site Guardian.";
		} elseif ( 'network_error' === $code || $status < 400 ) {
			$code    = 'network_error';
			$status  = 502;
			$message = Client::NETWORK_MESSAGE;
		}

		$body = array(
			'error' => array(
				'code'    => $code,
				'message' => $message,
			),
		);
		if ( null !== $result->request_id ) {
			$body['request_id'] = $result->request_id;
		}
		return new \WP_REST_Response( $body, $status );
	}
}
