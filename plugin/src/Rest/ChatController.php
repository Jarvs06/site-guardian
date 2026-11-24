<?php
/**
 * Chat proxy between the browser and Core.
 *
 * @package SiteGuardian
 */

namespace SiteGuardian\Rest;

use SiteGuardian\Core\Client;
use SiteGuardian\Core\Result;
use SiteGuardian\Frontend\Access;

defined( 'ABSPATH' ) || exit;

/**
 * POST /chat and GET /conversation.
 */
final class ChatController {

	public const USER_META = 'site_guardian_conversation_id';
	private const UUID     = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';

	/**
	 * Test seam for the Core call.
	 *
	 * @var callable|null
	 */
	private static $sender = null;

	/**
	 * Replace the Core call (tests).
	 *
	 * @param callable|null $sender fn(array $body): Result.
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
		register_rest_route(
			'site-guardian/v1',
			'/chat',
			array(
				'methods'             => 'POST',
				'callback'            => array( self::class, 'handle_chat' ),
				'permission_callback' => array( self::class, 'can_chat' ),
				'args'                => array(
					'message'         => array(
						'required'          => true,
						'type'              => 'string',
						'validate_callback' => array( self::class, 'validate_message' ),
						'sanitize_callback' => 'wp_unslash',
					),
					'conversation_id' => array(
						'required'          => false,
						'type'              => 'string',
						'validate_callback' => array( self::class, 'validate_conversation_id' ),
					),
				),
			)
		);
		register_rest_route(
			'site-guardian/v1',
			'/conversation',
			array(
				'methods'             => 'GET',
				'callback'            => array( self::class, 'handle_conversation' ),
				'permission_callback' => array( self::class, 'can_chat' ),
			)
		);
	}

	/**
	 * Permission: logged in and holds the capability.
	 */
	public static function can_chat(): bool {
		return is_user_logged_in() && current_user_can( Access::capability() );
	}

	/**
	 * Validate message (1..4000 chars).
	 *
	 * @param mixed $value Value.
	 */
	public static function validate_message( $value ): bool {
		if ( ! is_string( $value ) ) {
			return false;
		}
		$len = mb_strlen( $value );
		return $len >= 1 && $len <= 4000;
	}

	/**
	 * Validate optional conversation id.
	 *
	 * @param mixed $value Value.
	 */
	public static function validate_conversation_id( $value ): bool {
		return null === $value || '' === $value || ( is_string( $value ) && 1 === preg_match( self::UUID, $value ) );
	}

	/**
	 * POST /chat.
	 *
	 * @param \WP_REST_Request $request Request.
	 */
	public static function handle_chat( $request ): \WP_REST_Response {
		$message = (string) $request->get_param( 'message' );
		$cid     = $request->get_param( 'conversation_id' );
		$out     = self::respond( $message, is_string( $cid ) && '' !== $cid ? $cid : null, get_current_user_id() );
		return new \WP_REST_Response( $out['body'], $out['status'] );
	}

	/**
	 * GET /conversation.
	 */
	public static function handle_conversation(): \WP_REST_Response {
		$stored = get_user_meta( get_current_user_id(), self::USER_META, true );
		return new \WP_REST_Response(
			array( 'conversation_id' => is_string( $stored ) && '' !== $stored ? $stored : null ),
			200
		);
	}

	/**
	 * Forward to Core and map the outcome.
	 *
	 * @param string      $message Message.
	 * @param string|null $cid     Conversation id.
	 * @param int         $user_id Current user.
	 * @return array{status:int,body:array<string,mixed>}
	 */
	public static function respond( string $message, ?string $cid, int $user_id ): array {
		$body = array( 'message' => $message );
		if ( null !== $cid ) {
			$body['conversation_id'] = $cid;
		}

		$result = null !== self::$sender
			? ( self::$sender )( $body )
			: Client::request( 'POST', '/ai/chat', $body );

		if ( $result instanceof Result && $result->ok ) {
			$new = $result->data['conversation_id'] ?? null;
			if ( is_string( $new ) && '' !== $new ) {
				update_user_meta( $user_id, self::USER_META, $new );
			}
			return array(
				'status' => $result->status,
				'body'   => $result->data,
			);
		}

		return self::error_for( $result );
	}

	/**
	 * Map a failed result to a response.
	 *
	 * @param mixed $result Result.
	 * @return array{status:int,body:array<string,mixed>}
	 */
	private static function error_for( $result ): array {
		$code    = $result instanceof Result ? (string) $result->error_code : 'ai_unavailable';
		$status  = $result instanceof Result ? $result->status : 502;
		$message = $result instanceof Result ? (string) $result->message : '';

		if ( 'not_connected' === $code ) {
			$status  = 503;
			$message = "Site Guardian isn't connected yet. Ask an administrator to connect it in Settings → Site Guardian.";
		} elseif ( 'network_error' === $code || $status < 400 ) {
			$code    = 'ai_unavailable';
			$status  = 502;
			$message = "Couldn't reach Site Guardian. Please try again.";
		}

		return array(
			'status' => $status,
			'body'   => array(
				'error' => array(
					'code'    => $code,
					'message' => $message,
				),
			),
		);
	}
}
