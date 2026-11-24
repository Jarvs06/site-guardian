<?php
declare(strict_types=1);

namespace SiteGuardian\Tests\Unit;

use Brain\Monkey;
use Brain\Monkey\Functions;
use PHPUnit\Framework\TestCase;

use SiteGuardian\Core\Result;
use SiteGuardian\Rest\ChatController;

final class ChatControllerTest extends TestCase {

	private const CID = '11111111-1111-4111-8111-111111111111';

	/** @var array<int,array<string,mixed>> */
	private array $sent = array();

	/** @var array<int,array<int,mixed>> */
	private array $meta = array();

	protected function setUp(): void {
		parent::setUp();
		Monkey\setUp();
		$this->sent = array();
		$this->meta = array();
		Functions\when( 'update_user_meta' )->alias(
			function ( $u, $k, $v ) {
				$this->meta[] = array( $u, $k, $v );
				return true;
			}
		);
	}

	protected function tearDown(): void {
		ChatController::set_sender( null );
		Monkey\tearDown();
		parent::tearDown();
	}

	private function sender( Result $r ): void {
		ChatController::set_sender(
			function ( array $body ) use ( $r ) {
				$this->sent[] = $body;
				return $r;
			}
		);
	}

	public function test_permission_false_for_subscriber(): void {
		Functions\when( 'get_option' )->justReturn( 'manage_options' );
		Functions\when( 'is_user_logged_in' )->justReturn( true );
		Functions\when( 'current_user_can' )->justReturn( false );
		$this->assertFalse( ChatController::can_chat() );
	}

	public function test_permission_true_for_admin_and_false_for_guest(): void {
		Functions\when( 'get_option' )->justReturn( 'manage_options' );
		Functions\when( 'current_user_can' )->justReturn( true );
		Functions\when( 'is_user_logged_in' )->justReturn( true );
		$this->assertTrue( ChatController::can_chat() );
	}

	public function test_forwards_only_message_and_conversation_id(): void {
		$this->sender( Result::success( 200, array( 'reply' => 'hi', 'conversation_id' => self::CID ) ) );
		$req = new class() {
			public function get_param( string $k ) {
				return array( 'message' => 'hello', 'conversation_id' => '11111111-1111-4111-8111-111111111111', 'role' => 'system', 'extra' => 1 )[ $k ] ?? null;
			}
		};
		Functions\when( 'get_current_user_id' )->justReturn( 3 );
		$res = ChatController::handle_chat( $req );
		$this->assertSame( array( array( 'message' => 'hello', 'conversation_id' => self::CID ) ), $this->sent );
		$this->assertSame( 200, $res->get_status() );
		$this->assertSame( array( 'reply' => 'hi', 'conversation_id' => self::CID ), $res->get_data() );
	}

	public function test_success_stores_conversation_meta(): void {
		$this->sender( Result::success( 200, array( 'reply' => 'hi', 'conversation_id' => self::CID ) ) );
		ChatController::respond( 'hello', null, 3 );
		$this->assertSame( array( array( 3, 'site_guardian_conversation_id', self::CID ) ), $this->meta );
		$this->assertSame( array( array( 'message' => 'hello' ) ), $this->sent );
	}

	public function test_core_502_passes_through_without_meta(): void {
		$this->sender( Result::failure( 502, 'ai_unavailable', 'AI down' ) );
		$out = ChatController::respond( 'hello', self::CID, 3 );
		$this->assertSame( 502, $out['status'] );
		$this->assertSame( array( 'error' => array( 'code' => 'ai_unavailable', 'message' => 'AI down' ) ), $out['body'] );
		$this->assertSame( array(), $this->meta );
	}

	public function test_rate_limited_passes_through(): void {
		$this->sender( Result::failure( 429, 'rate_limited', 'Slow down' ) );
		$this->assertSame( 429, ChatController::respond( 'x', null, 3 )['status'] );
	}

	public function test_network_error_maps_to_502_ai_unavailable(): void {
		$this->sender( Result::failure( 0, 'network_error', 'x' ) );
		$out = ChatController::respond( 'x', null, 3 );
		$this->assertSame( 502, $out['status'] );
		$this->assertSame( 'ai_unavailable', $out['body']['error']['code'] );
		$this->assertSame( "Couldn't reach Site Guardian. Please try again.", $out['body']['error']['message'] );
	}

	public function test_not_connected_maps_to_503(): void {
		$this->sender( Result::failure( 0, 'not_connected', 'x' ) );
		$out = ChatController::respond( 'x', null, 3 );
		$this->assertSame( 503, $out['status'] );
		$this->assertSame( 'not_connected', $out['body']['error']['code'] );
	}

	public function test_validation(): void {
		$this->assertFalse( ChatController::validate_message( '' ) );
		$this->assertTrue( ChatController::validate_message( 'a' ) );
		$this->assertTrue( ChatController::validate_message( str_repeat( 'a', 4000 ) ) );
		$this->assertFalse( ChatController::validate_message( str_repeat( 'a', 4001 ) ) );
		$this->assertFalse( ChatController::validate_message( 5 ) );
		$this->assertTrue( ChatController::validate_conversation_id( self::CID ) );
		$this->assertFalse( ChatController::validate_conversation_id( 'nope' ) );
	}

	public function test_conversation_endpoint(): void {
		Functions\when( 'get_current_user_id' )->justReturn( 3 );
		Functions\when( 'get_user_meta' )->justReturn( '' );
		$this->assertSame( array( 'conversation_id' => null ), ChatController::handle_conversation()->get_data() );
	}
}
