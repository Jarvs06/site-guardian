<?php
/**
 * Public endpoints Core calls to verify domain ownership.
 *
 * @package SiteGuardian
 */

namespace SiteGuardian\Rest;

use SiteGuardian\Support\Options;

defined( 'ABSPATH' ) || exit;

/**
 * Serves the pending challenge value to Core.
 */
final class VerifyController {

	public const QUERY_VAR = 'site_guardian_verify';

	/**
	 * Register hooks.
	 */
	public static function register(): void {
		add_action( 'rest_api_init', array( self::class, 'register_routes' ) );
		add_filter( 'query_vars', array( self::class, 'add_query_var' ) );
		add_action( 'template_redirect', array( self::class, 'handle_query_var' ), 0 );
	}

	/**
	 * Register the REST route.
	 */
	public static function register_routes(): void {
		register_rest_route(
			'site-guardian/v1',
			'/verify/(?P<id>[0-9a-f-]{36})',
			array(
				'methods'             => 'GET',
				'callback'            => array( self::class, 'rest_callback' ),
				'permission_callback' => '__return_true',
			)
		);
	}

	/**
	 * Add the fallback query var.
	 *
	 * @param array<int,string> $vars Query vars.
	 * @return array<int,string>
	 */
	public static function add_query_var( array $vars ): array {
		$vars[] = self::QUERY_VAR;
		return $vars;
	}

	/**
	 * REST callback.
	 *
	 * @param \WP_REST_Request $request Request.
	 */
	public static function rest_callback( $request ): \WP_REST_Response {
		$out = self::respond( (string) $request['id'] );
		nocache_headers();
		return new \WP_REST_Response( $out['body'], $out['status'] );
	}

	/**
	 * Query-var fallback; prints JSON and exits when the var is present.
	 */
	public static function handle_query_var(): void {
		$id = get_query_var( self::QUERY_VAR, '' );
		if ( ! is_string( $id ) || '' === $id ) {
			return;
		}
		$out = self::respond( $id );
		status_header( $out['status'] );
		nocache_headers();
		header( 'Content-Type: application/json; charset=utf-8' );
		echo wp_json_encode( $out['body'] ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- JSON payload.
		exit;
	}

	/**
	 * Decide the response for a challenge id.
	 *
	 * @param string $id Challenge id from the request.
	 * @return array{status:int,body:array<string,string>}
	 */
	public static function respond( string $id ): array {
		$pending = get_option( Options::PENDING_CHALLENGE, null );

		if (
			is_array( $pending )
			&& isset( $pending['id'], $pending['value'], $pending['expires'] )
			&& is_string( $pending['id'] )
			&& is_string( $pending['value'] )
			&& (int) $pending['expires'] > time()
			&& hash_equals( $pending['id'], $id )
		) {
			return array(
				'status' => 200,
				'body'   => array( 'challenge' => $pending['value'] ),
			);
		}
		return array(
			'status' => 404,
			'body'   => array( 'error' => 'not_found' ),
		);
	}
}
