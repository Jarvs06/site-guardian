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

if ( ! class_exists( 'WP_Query' ) ) {
	// Minimal stand-in for unit tests: tests set $ids / $found and read $last_args.
	class WP_Query { // phpcs:ignore
		/** @var array<string,mixed> */
		public static array $last_args = array();
		/** @var array<int,int> */
		public static array $ids = array();
		public static int $found = 0;
		public array $posts = array();
		public int $found_posts = 0;
		public function __construct( array $args = array() ) {
			self::$last_args   = $args;
			$this->posts       = self::$ids;
			$this->found_posts = self::$found;
		}
	}
}
