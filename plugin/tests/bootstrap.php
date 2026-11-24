<?php
/**
 * PHPUnit bootstrap.
 *
 * @package SiteGuardian
 */

define( 'ABSPATH', __DIR__ . '/' );

require_once dirname( __DIR__ ) . '/vendor/autoload.php';

if ( ! class_exists( 'WP_REST_Response' ) ) {
	// Minimal stand-in for unit tests.
	class WP_REST_Response { // phpcs:ignore
		public function __construct( private $data = null, private int $status = 200 ) {}
		public function get_data() {
			return $this->data;
		}
		public function get_status(): int {
			return $this->status;
		}
	}
}
