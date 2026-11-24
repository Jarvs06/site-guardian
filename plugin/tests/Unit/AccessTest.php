<?php
declare(strict_types=1);

namespace SiteGuardian\Tests\Unit;

use Brain\Monkey;
use Brain\Monkey\Functions;
use PHPUnit\Framework\TestCase;

use SiteGuardian\Frontend\Access;

final class AccessTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		Monkey\setUp();
		Functions\when( 'get_option' )->alias( fn( $k, $d = false ) => 'site_guardian_page_id' === $k ? 12 : 'manage_options' );
	}

	protected function tearDown(): void {
		Monkey\tearDown();
		parent::tearDown();
	}

	public function test_decide_covers_all_outcomes(): void {
		$this->assertSame( 'skip', Access::decide( false, true, true ) );
		$this->assertSame( 'redirect', Access::decide( true, false, false ) );
		$this->assertSame( 'not_found', Access::decide( true, true, false ) );
		$this->assertSame( 'allow', Access::decide( true, true, true ) );
	}

	public function test_headers_include_exact_csp(): void {
		$h = Access::headers();
		$this->assertSame(
			"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
			$h['Content-Security-Policy']
		);
		$this->assertSame( 'noindex, nofollow', $h['X-Robots-Tag'] );
		$this->assertSame( 'nosniff', $h['X-Content-Type-Options'] );
		$this->assertSame( 'same-origin', $h['Referrer-Policy'] );
	}

	public function test_gate_guest_redirects_to_login(): void {
		Functions\when( 'is_page' )->justReturn( true );
		Functions\when( 'is_user_logged_in' )->justReturn( false );
		Functions\expect( 'auth_redirect' )->once();
		Access::gate();
		$this->addToAssertionCount( 1 );
	}

	public function test_gate_subscriber_gets_404(): void {
		Functions\when( 'is_page' )->justReturn( true );
		Functions\when( 'is_user_logged_in' )->justReturn( true );
		Functions\when( 'current_user_can' )->justReturn( false );
		Functions\expect( 'status_header' )->once()->with( 404 );
		Functions\expect( 'nocache_headers' )->once();
		$GLOBALS['wp_query'] = new class() {
			public bool $notfound = false;
			public function set_404(): void {
				$this->notfound = true;
			}
		};
		Access::gate();
		$this->assertTrue( $GLOBALS['wp_query']->notfound );
	}

	public function test_gate_ignores_other_pages(): void {
		Functions\when( 'is_page' )->justReturn( false );
		Functions\when( 'is_user_logged_in' )->justReturn( false );
		Functions\expect( 'auth_redirect' )->never();
		Access::gate();
		$this->addToAssertionCount( 1 );
	}

	public function test_gate_admin_passes(): void {
		Functions\when( 'is_page' )->justReturn( true );
		Functions\when( 'is_user_logged_in' )->justReturn( true );
		Functions\when( 'current_user_can' )->justReturn( true );
		Functions\expect( 'nocache_headers' )->once();
		Functions\expect( 'auth_redirect' )->never();
		Functions\expect( 'status_header' )->never();
		Access::gate();
		$this->addToAssertionCount( 1 );
	}
}
