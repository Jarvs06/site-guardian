<?php
declare(strict_types=1);

namespace SiteGuardian\Tests\Unit;

use Brain\Monkey;
use Brain\Monkey\Functions;
use PHPUnit\Framework\TestCase;

use SiteGuardian\Admin\Notices;
use SiteGuardian\Admin\SettingsPage;
use SiteGuardian\Core\CredentialStore;
use SiteGuardian\Rest\AdminController;
use SiteGuardian\Support\Options;

final class AdminControllerTest extends TestCase {

	/** @var array<string,mixed> */
	private array $opts = array();

	private FakeWpdb $wpdb;

	protected function setUp(): void {
		parent::setUp();
		Monkey\setUp();
		$this->opts = array();
		$GLOBALS['wpdb'] = $this->wpdb = new FakeWpdb();
		Functions\when( 'wp_cache_delete' )->justReturn( true );
		Functions\when( 'get_option' )->alias( fn( $k, $d = false ) => $this->opts[ $k ] ?? $d );
		Functions\when( 'add_option' )->alias(
			function ( $k, $v ) {
				if ( array_key_exists( $k, $this->opts ) ) {
					return false;
				}
				$this->opts[ $k ] = $v;
				return true;
			}
		);
		Functions\when( 'delete_option' )->alias(
			function ( $k ) {
				unset( $this->opts[ $k ] );
				return true;
			}
		);
		Functions\when( 'update_option' )->alias(
			function ( $k, $v ) {
				$this->opts[ $k ] = $v;
				return true;
			}
		);
	}

	protected function tearDown(): void {
		CredentialStore::set_key_material_provider( null );
		Monkey\tearDown();
		parent::tearDown();
	}

	public function test_permission_denies_non_admin(): void {
		Functions\when( 'current_user_can' )->justReturn( false );
		$this->assertFalse( AdminController::can_manage() );
	}

	public function test_permission_allows_admin_and_checks_manage_options(): void {
		Functions\expect( 'current_user_can' )->once()->with( 'manage_options' )->andReturn( true );
		$this->assertTrue( AdminController::can_manage() );
	}

	private function lock_rows(): array {
		return $this->wpdb->rows;
	}

	public function test_all_routes_wire_can_manage(): void {
		$captured = array();
		Functions\when( 'register_rest_route' )->alias(
			function ( $ns, $route, $args ) use ( &$captured ) {
				$captured[ $ns . $route ] = $args;
			}
		);
		AdminController::register_routes();
		$this->assertEqualsCanonicalizing(
			array( 'site-guardian/v1/admin/connect', 'site-guardian/v1/admin/rotate', 'site-guardian/v1/admin/status' ),
			array_keys( $captured )
		);
		Functions\when( 'current_user_can' )->justReturn( false );
		foreach ( $captured as $args ) {
			$this->assertSame( array( AdminController::class, 'can_manage' ), $args['permission_callback'] );
			$this->assertFalse( ( $args['permission_callback'] )() );
		}
		$this->assertSame( 'GET', $captured['site-guardian/v1/admin/status']['methods'] );
		$this->assertSame( 'POST', $captured['site-guardian/v1/admin/connect']['methods'] );
		$this->assertSame( 'POST', $captured['site-guardian/v1/admin/rotate']['methods'] );
	}

	public function test_lock_contention_returns_409_without_calling_registration(): void {
		$this->wpdb->rows[ Options::CONNECT_LOCK ] = time() . ':abc';
		$called                                     = false;
		$out = AdminController::connect_response(
			function () use ( &$called ) {
				$called = true;
				return null;
			}
		);
		$this->assertSame( 409, $out['status'] );
		$this->assertFalse( $out['body']['connected'] );
		$this->assertSame( 'A connection attempt is already in progress. Please wait a moment.', $out['body']['message'] );
		$this->assertFalse( $called );
		$this->assertSame( array(), $this->wpdb->deleted, 'foreign live lock is left alone' );
	}

	public function test_stale_lock_is_compare_deleted_then_reinserted(): void {
		$stale                                      = ( time() - 120 ) . ':old';
		$this->wpdb->rows[ Options::CONNECT_LOCK ] = $stale;
		$ran                                        = false;
		$out = AdminController::connect_response(
			function () use ( &$ran ) {
				$ran = true;
				return \SiteGuardian\Core\Result::success( 200, array() );
			}
		);
		$this->assertTrue( $ran );
		$this->assertSame( 200, $out['status'] );
		$this->assertSame( $stale, $this->wpdb->deleted[0], 'delete used the observed value' );
		$this->assertCount( 2, $this->wpdb->deleted, 'stale delete then own-token release' );
		$this->assertNotSame( $stale, $this->wpdb->deleted[1] );
		$this->assertSame( array(), $this->lock_rows(), 'lock released' );
	}

	public function test_release_deletes_only_own_token(): void {
		$seen = null;
		AdminController::connect_response(
			function () use ( &$seen ) {
				$seen = $this->wpdb->rows[ Options::CONNECT_LOCK ];
				// Simulate another process replacing the lock mid-flight.
				$this->wpdb->rows[ Options::CONNECT_LOCK ] = time() . ':other';
				return \SiteGuardian\Core\Result::success( 200, array() );
			}
		);
		$this->assertMatchesRegularExpression( '/^\d+:[0-9a-f]{32}$/', $seen );
		$this->assertSame( array( $seen ), $this->wpdb->deleted );
		$this->assertStringEndsWith( ':other', $this->lock_rows()[ Options::CONNECT_LOCK ] );
	}

	public function test_connect_maps_success_and_releases_lock(): void {
		$out = AdminController::connect_response( fn() => \SiteGuardian\Core\Result::success( 200, array( 'credential' => 'sgat_x' ) ) );
		$this->assertSame( 200, $out['status'] );
		$this->assertTrue( $out['body']['connected'] );
		$this->assertSame( array(), $this->lock_rows() );
		$this->assertStringNotContainsString( 'sgat_', json_encode( $out ) );
	}

	public function test_connect_maps_failure(): void {
		$out = AdminController::connect_response( fn() => \SiteGuardian\Core\Result::failure( 400, 'verification_failed', 'Could not verify.' ) );
		$this->assertFalse( $out['body']['connected'] );
		$this->assertSame( 'Could not verify.', $out['body']['message'] );
		$this->assertSame( array(), $this->lock_rows() );
	}

	public function test_lock_released_after_exception(): void {
		try {
			AdminController::connect_response( function () {
				throw new \RuntimeException( 'boom' );
			} );
			$this->fail( 'expected exception' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( array(), $this->lock_rows() );
		}
	}

	public function test_rotate_under_contention_is_409(): void {
		$this->wpdb->rows[ Options::CONNECT_LOCK ] = time() . ':abc';
		$called                                     = false;
		$out = AdminController::rotate_response(
			function () use ( &$called ) {
				$called = true;
				return null;
			},
			fn() => true
		);
		$this->assertSame( 409, $out['status'] );
		$this->assertFalse( $called );
	}

	public function test_status_never_includes_credential(): void {
		$this->opts[ Options::WEBSITE_ID ]  = 'web-1';
		$this->opts[ Options::LAST_ERROR ]  = 'oops';
		$this->opts[ Options::CREDENTIAL ]  = 'secret-blob';
		$body = AdminController::status_body( true );
		$this->assertSame( array( 'connected', 'website_id', 'core_url', 'last_error' ), array_keys( $body ) );
		$this->assertTrue( $body['connected'] );
		$this->assertSame( 'web-1', $body['website_id'] );
		$this->assertSame( 'oops', $body['last_error'] );
		$this->assertStringNotContainsString( 'secret-blob', json_encode( $body ) );
	}

	public function test_rotate_maps_result(): void {
		$out = AdminController::rotate_response( fn() => \SiteGuardian\Core\Result::failure( 401, 'unauthorized', 'Nope.' ), fn() => false );
		$this->assertSame( 401, $out['status'] );
		$this->assertFalse( $out['body']['ok'] );
		$this->assertSame( 'Nope.', $out['body']['message'] );
		$net = AdminController::rotate_response( fn() => \SiteGuardian\Core\Result::failure( 0, 'network_error', 'down' ), fn() => true );
		$this->assertSame( 502, $net['status'] );
		$ok = AdminController::rotate_response( fn() => \SiteGuardian\Core\Result::success( 200, array() ), fn() => true );
		$this->assertSame( 200, $ok['status'] );
		$this->assertTrue( $ok['body']['ok'] );
		$this->assertTrue( $ok['body']['connected'] );
		$this->assertSame( array(), $this->lock_rows() );
	}

	public function test_capability_sanitizer_whitelist(): void {
		foreach ( array( 'manage_options', 'edit_pages', 'edit_posts' ) as $cap ) {
			$this->assertSame( $cap, SettingsPage::sanitize_capability( $cap ) );
		}
		$this->assertSame( 'manage_options', SettingsPage::sanitize_capability( 'do_anything' ) );
		$this->assertSame( 'manage_options', SettingsPage::sanitize_capability( array( 'edit_posts' ) ) );
		$this->assertSame( 'manage_options', SettingsPage::sanitize_capability( null ) );
	}

	public function test_notice_visibility(): void {
		$this->assertTrue( Notices::should_show( true, false, 'dashboard' ) );
		$this->assertFalse( Notices::should_show( true, true, 'dashboard' ), 'connected' );
		$this->assertFalse( Notices::should_show( true, false, 'settings_page_site-guardian' ), 'plugin page' );
		$this->assertFalse( Notices::should_show( false, false, 'dashboard' ), 'non-admin' );
	}
}

/**
 * Minimal $wpdb emulating the options table for the lock queries.
 */
final class FakeWpdb {
	public string $options = 'wp_options';
	/** @var array<string,string> */
	public array $rows = array();
	/** @var string[] Values passed to compare-and-delete, in order. */
	public array $deleted = array();

	public function prepare( string $sql, ...$args ): string {
		return json_encode( array( $sql, $args ) );
	}

	public function query( string $prepared ) {
		list( $sql, $args ) = json_decode( $prepared, true );
		if ( str_starts_with( $sql, 'INSERT IGNORE' ) ) {
			if ( isset( $this->rows[ $args[0] ] ) ) {
				return 0;
			}
			$this->rows[ $args[0] ] = $args[1];
			return 1;
		}
		if ( str_starts_with( $sql, 'DELETE' ) ) {
			$this->deleted[] = $args[1];
			if ( ( $this->rows[ $args[0] ] ?? null ) === $args[1] ) {
				unset( $this->rows[ $args[0] ] );
				return 1;
			}
			return 0;
		}
		return false;
	}

	public function get_var( string $prepared ) {
		list( , $args ) = json_decode( $prepared, true );
		return $this->rows[ $args[0] ] ?? null;
	}
}
