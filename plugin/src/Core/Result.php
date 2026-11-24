<?php
/**
 * Result of a Core API call.
 *
 * @package SiteGuardian
 */

namespace SiteGuardian\Core;

defined( 'ABSPATH' ) || exit;

/**
 * Immutable outcome of a request to Core.
 */
final class Result {

	/**
	 * Constructor.
	 *
	 * @param bool                 $ok         Whether the call succeeded.
	 * @param int                  $status     HTTP status (0 when unreachable).
	 * @param array<string,mixed>  $data       Decoded JSON body on success.
	 * @param string|null          $error_code Error code on failure.
	 * @param string|null          $message    Human-readable error message.
	 * @param string|null          $request_id Core request id, when known.
	 */
	public function __construct(
		public readonly bool $ok,
		public readonly int $status,
		public readonly array $data,
		public readonly ?string $error_code,
		public readonly ?string $message,
		public readonly ?string $request_id = null
	) {}

	/**
	 * Success result.
	 *
	 * @param int                 $status HTTP status.
	 * @param array<string,mixed> $data   Decoded body.
	 */
	public static function success( int $status, array $data ): self {
		return new self( true, $status, $data, null, null );
	}

	/**
	 * Failure result.
	 *
	 * @param int    $status     HTTP status.
	 * @param string $error_code Error code.
	 * @param string $message    Message.
	 * @param string|null $request_id Core request id.
	 */
	public static function failure( int $status, string $error_code, string $message, ?string $request_id = null ): self {
		return new self( false, $status, array(), $error_code, $message, $request_id );
	}
}
