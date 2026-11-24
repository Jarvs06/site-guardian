<?php
declare(strict_types=1);

namespace SiteGuardian\Tests\Unit;

use Brain\Monkey;
use Brain\Monkey\Functions;
use PHPUnit\Framework\TestCase;

use SiteGuardian\Rest\VerifyController;

final class VerifyControllerTest extends TestCase {

	private const ID = '11111111-1111-4111-8111-111111111111';

	/** @var mixed */
	private $pending;

	protected function setUp(): void {
		parent::setUp();
		Monkey\setUp();
		$this->pending = array( 'id' => self::ID, 'value' => 'secret-value', 'expires' => time() + 600 );
		Functions\when( 'get_option' )->alias( fn( $k, $d = false ) => $this->pending ?? $d );
	}

	protected function tearDown(): void {
		Monkey\tearDown();
		parent::tearDown();
	}

	public function test_matching_id_returns_challenge(): void {
		$this->assertSame( array( 'status' => 200, 'body' => array( 'challenge' => 'secret-value' ) ), VerifyController::respond( self::ID ) );
	}

	public function test_wrong_id_is_404(): void {
		$this->assertSame( 404, VerifyController::respond( '22222222-2222-4222-8222-222222222222' )['status'] );
	}

	public function test_expired_is_404(): void {
		$this->pending['expires'] = time() - 1;
		$this->assertSame( 404, VerifyController::respond( self::ID )['status'] );
	}

	public function test_no_pending_is_404(): void {
		$this->pending = null;
		$this->assertSame( 404, VerifyController::respond( self::ID )['status'] );
	}

	public function test_query_var_registered(): void {
		$this->assertContains( 'site_guardian_verify', VerifyController::add_query_var( array() ) );
	}
}
