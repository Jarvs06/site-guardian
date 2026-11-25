<?php
declare(strict_types=1);

namespace SiteGuardian\Tests\Unit;

use Brain\Monkey;
use Brain\Monkey\Functions;
use PHPUnit\Framework\TestCase;

use SiteGuardian\Core\CredentialStore;
use SiteGuardian\Core\Registration;
use SiteGuardian\Support\Options;

final class RegistrationTest extends TestCase {

	/** @var array<string,mixed> */
	private array $db = array();
	/** @var array<int,array{0:string,1:array}> */
	private array $calls = array();
	/** @var array<string,array|object> */
	private array $responses = array();
	/** @var array<int,mixed> */
	private array $pending_during_complete = array();

	protected function setUp(): void {
		parent::setUp();
		Monkey\setUp();
		$this->db = array();
		$this->calls = array();
		$this->responses = array();
		CredentialStore::set_key_material_provider( fn() => 'k' );
		Functions\when( 'get_option' )->alias( fn( $k, $d = false ) => $this->db[ $k ] ?? $d );
		Functions\when( 'update_option' )->alias( function ( $k, $v ) { $this->db[ $k ] = $v; return true; } );
		Functions\when( 'delete_option' )->alias( function ( $k ) { unset( $this->db[ $k ] ); return true; } );
		Functions\when( 'get_current_user_id' )->justReturn( 0 );
		Functions\when( 'wp_generate_uuid4' )->justReturn( 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' );
		Functions\when( 'home_url' )->justReturn( 'https://example.com' );
		Functions\when( 'get_bloginfo' )->justReturn( 'x' );
		Functions\when( 'wp_json_encode' )->alias( fn( $v ) => json_encode( $v ) );
		Functions\when( 'is_wp_error' )->alias( fn( $v ) => $v instanceof \stdClass );
		Functions\when( 'wp_remote_retrieve_response_code' )->alias( fn( $r ) => $r['code'] );
		Functions\when( 'wp_remote_retrieve_body' )->alias( fn( $r ) => $r['body'] );
		Functions\when( 'wp_remote_request' )->alias(
			function ( $url, $args ) {
				$this->calls[] = array( $url, $args );
				foreach ( $this->responses as $suffix => $resp ) {
					if ( str_ends_with( $url, $suffix ) ) {
						if ( 'sites/register/complete' === $suffix ) {
							$this->pending_during_complete = $this->db[ Options::PENDING_CHALLENGE ] ?? array();
						}
						return $resp;
					}
				}
				return (object) array();
			}
		);
	}

	protected function tearDown(): void {
		CredentialStore::set_key_material_provider( null );
		Monkey\tearDown();
		parent::tearDown();
	}

	private function start_ok(): array {
		return array( 'code' => 201, 'body' => json_encode( array(
			'challenge_id' => '11111111-1111-4111-8111-111111111111',
			'challenge'    => 'abc',
			'expires_at'   => gmdate( 'c', time() + 600 ),
		) ) );
	}

	public function test_happy_path_stores_credential_and_clears_pending(): void {
		$this->responses['sites/register/start']    = $this->start_ok();
		$this->responses['sites/register/complete'] = array( 'code' => 201, 'body' => json_encode( array( 'website_id' => 'w1', 'credential' => 'sgat_xyz', 'plan_code' => 'free' ) ) );
		$this->db[ Options::LAST_ERROR ] = 'old';

		$r = Registration::connect();

		$this->assertTrue( $r->ok );
		$this->assertSame( 'sgat_xyz', CredentialStore::get() );
		$this->assertSame( 'w1', $this->db[ Options::WEBSITE_ID ] );
		$this->assertArrayNotHasKey( Options::PENDING_CHALLENGE, $this->db );
		$this->assertArrayNotHasKey( Options::LAST_ERROR, $this->db );
		$this->assertSame( 'abc', $this->pending_during_complete['value'] );
		$this->assertGreaterThan( time(), $this->pending_during_complete['expires'] );
		$this->assertTrue( Registration::is_connected() );
		$start_body = json_decode( $this->calls[0][1]['body'], true );
		$this->assertSame( 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', $start_body['installation_id'] );
		$this->assertArrayNotHasKey( 'Authorization', $this->calls[0][1]['headers'] );
	}

	public function test_core_unreachable(): void {
		$r = Registration::connect();
		$this->assertFalse( $r->ok );
		$this->assertSame( 'network_error', $r->error_code );
		$this->assertSame( "Couldn't reach Site Guardian. Please check your connection and try again.", $this->db[ Options::LAST_ERROR ] );
		$this->assertNull( CredentialStore::get() );
		$this->assertArrayNotHasKey( Options::PENDING_CHALLENGE, $this->db );
	}

	public function test_complete_400_passes_message_and_stores_no_credential(): void {
		$this->responses['sites/register/start']    = $this->start_ok();
		$this->responses['sites/register/complete'] = array( 'code' => 400, 'body' => '{"error":{"code":"verification_failed","message":"Could not verify your domain."},"request_id":"r"}' );

		$r = Registration::connect();

		$this->assertFalse( $r->ok );
		$this->assertSame( 'Could not verify your domain.', $this->db[ Options::LAST_ERROR ] );
		$this->assertNull( CredentialStore::get() );
		$this->assertArrayNotHasKey( Options::PENDING_CHALLENGE, $this->db );
	}

	public function test_rotate_replaces_credential(): void {
		CredentialStore::put( 'sgat_old' );
		$this->responses['sites/credential/rotate'] = array( 'code' => 200, 'body' => '{"credential":"sgat_new"}' );
		$this->assertTrue( Registration::rotate()->ok );
		$this->assertSame( 'sgat_new', CredentialStore::get() );
	}

	public function test_rotate_401_clears_credential(): void {
		CredentialStore::put( 'sgat_old' );
		$this->responses['sites/credential/rotate'] = array( 'code' => 401, 'body' => '{"error":{"code":"unauthorized","message":"bad"},"request_id":"r"}' );
		$this->assertFalse( Registration::rotate()->ok );
		$this->assertNull( CredentialStore::get() );
		$this->assertStringContainsString( 'reconnect', $this->db[ Options::LAST_ERROR ] );
	}

	/**
	 * With SITE_GUARDIAN_CREDENTIAL set, a new credential written to the option would be ignored
	 * (the constant wins), while Core would already reject the old one.
	 */
	#[\PHPUnit\Framework\Attributes\RunInSeparateProcess]
	#[\PHPUnit\Framework\Attributes\PreserveGlobalState( false )]
	public function test_connect_and_rotate_refuse_when_credential_is_a_constant(): void {
		define( 'SITE_GUARDIAN_CREDENTIAL', 'sgat_from_config' );
		$this->responses['sites/credential/rotate'] = array( 'code' => 200, 'body' => '{"credential":"sgat_new"}' );

		foreach ( array( Registration::connect(), Registration::rotate() ) as $r ) {
			$this->assertFalse( $r->ok );
			$this->assertSame( 409, $r->status );
			$this->assertSame( 'credential_in_config', $r->error_code );
			$this->assertStringContainsString( 'wp-config.php', (string) $r->message );
		}
		$this->assertSame( array(), $this->calls, 'Core must not be called' );
		$this->assertArrayNotHasKey( Options::CREDENTIAL, $this->db );
		$this->assertSame( 'sgat_from_config', CredentialStore::get() );
		$this->assertTrue( CredentialStore::from_constant() );
	}
}
