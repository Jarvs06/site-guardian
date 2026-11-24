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

	protected function setUp(): void {
		parent::setUp();
		Monkey\setUp();
		$this->opts = array();
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

	public function test_lock_contention_returns_409_without_calling_registration(): void {
		$this->opts[ Options::CONNECT_LOCK ] = time();
		$called                              = false;
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
		$this->assertArrayHasKey( Options::CONNECT_LOCK, $this->opts, 'foreign lock is left alone' );
	}

	public function test_stale_lock_is_replaced(): void {
		$this->opts[ Options::CONNECT_LOCK ] = time() - 120;
		$out = AdminController::connect_response( fn() => \SiteGuardian\Core\Result::success( 200, array() ) );
		$this->assertSame( 200, $out['status'] );
	}

	public function test_connect_maps_success_and_releases_lock(): void {
		CredentialStore::set_key_material_provider( fn() => 'k' );
		$out = AdminController::connect_response( fn() => \SiteGuardian\Core\Result::success( 200, array( 'credential' => 'sgat_x' ) ) );
		$this->assertSame( 200, $out['status'] );
		$this->assertTrue( $out['body']['connected'] );
		$this->assertArrayNotHasKey( Options::CONNECT_LOCK, $this->opts );
		$this->assertStringNotContainsString( 'sgat_', (string) wp_json_encode_stub( $out ) );
	}

	public function test_connect_maps_failure(): void {
		$out = AdminController::connect_response( fn() => \SiteGuardian\Core\Result::failure( 400, 'verification_failed', 'Could not verify.' ) );
		$this->assertFalse( $out['body']['connected'] );
		$this->assertSame( 'Could not verify.', $out['body']['message'] );
		$this->assertArrayNotHasKey( Options::CONNECT_LOCK, $this->opts );
	}

	public function test_lock_released_after_exception(): void {
		try {
			AdminController::connect_response( function () {
				throw new \RuntimeException( 'boom' );
			} );
			$this->fail( 'expected exception' );
		} catch ( \RuntimeException $e ) {
			$this->assertArrayNotHasKey( Options::CONNECT_LOCK, $this->opts );
		}
	}

	public function test_status_never_includes_credential(): void {
		$this->opts[ Options::WEBSITE_ID ]  = 'web-1';
		$this->opts[ Options::LAST_ERROR ]  = 'oops';
		$this->opts[ Options::CREDENTIAL ]  = 'secret-blob';
		Functions\when( 'defined' )->alias( fn( $n ) => \defined( $n ) );
		$body = AdminController::status_body( true );
		$this->assertSame( array( 'connected', 'website_id', 'core_url', 'last_error' ), array_keys( $body ) );
		$this->assertTrue( $body['connected'] );
		$this->assertSame( 'web-1', $body['website_id'] );
		$this->assertSame( 'oops', $body['last_error'] );
		$this->assertStringNotContainsString( 'secret-blob', wp_json_encode_stub( $body ) );
	}

	public function test_rotate_maps_result(): void {
		$out = AdminController::rotate_response( fn() => \SiteGuardian\Core\Result::failure( 401, 'unauthorized', 'Nope.' ), fn() => false );
		$this->assertSame( array( 'connected' => false, 'message' => 'Nope.' ), $out['body'] );
		$ok = AdminController::rotate_response( fn() => \SiteGuardian\Core\Result::success( 200, array() ), fn() => true );
		$this->assertTrue( $ok['body']['connected'] );
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

function wp_json_encode_stub( $v ): string {
	return json_encode( $v );
}
