<?php
declare(strict_types=1);

namespace SiteGuardian\Tests\Unit;

use Brain\Monkey;
use Brain\Monkey\Functions;
use PHPUnit\Framework\TestCase;

use SiteGuardian\Core\UserRef;

final class UserRefTest extends TestCase {

	/** @var array<string,mixed> */
	private array $db = array();

	protected function setUp(): void {
		parent::setUp();
		Monkey\setUp();
		$this->db = array();
		Functions\when( 'get_option' )->alias( fn( $k, $d = false ) => $this->db[ $k ] ?? $d );
		Functions\when( 'update_option' )->alias( function ( $k, $v ) { $this->db[ $k ] = $v; return true; } );
	}

	protected function tearDown(): void {
		Monkey\tearDown();
		parent::tearDown();
	}

	public function test_stable_and_distinct(): void {
		$a = UserRef::for_user( 1 );
		$this->assertSame( $a, UserRef::for_user( 1 ) );
		$this->assertNotSame( $a, UserRef::for_user( 2 ) );
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{64}$/', $a );
	}

	public function test_secret_created_once(): void {
		UserRef::for_user( 1 );
		$secret = $this->db['site_guardian_user_ref_secret'];
		$this->assertSame( 64, strlen( $secret ) );
		UserRef::for_user( 2 );
		$this->assertSame( $secret, $this->db['site_guardian_user_ref_secret'] );
	}
}
