<?php
declare(strict_types=1);

namespace SiteGuardian\Tests\Unit;

use Brain\Monkey;
use Brain\Monkey\Functions;
use PHPUnit\Framework\TestCase;

use SiteGuardian\Core\Client;
use SiteGuardian\Core\CredentialStore;
use SiteGuardian\Support\Options;

final class ClientTest extends TestCase {

	/** @var array<string,mixed> */
	private array $db = array();
	/** @var array<int,array{0:string,1:array}> */
	private array $calls = array();
	private int $user = 0;

	protected function setUp(): void {
		parent::setUp();
		Monkey\setUp();
		$this->db    = array();
		$this->calls = array();
		$this->user  = 0;
		CredentialStore::set_key_material_provider( fn() => 'k' );
		Functions\when( 'get_option' )->alias( fn( $k, $d = false ) => $this->db[ $k ] ?? $d );
		Functions\when( 'update_option' )->alias( function ( $k, $v ) { $this->db[ $k ] = $v; return true; } );
		Functions\when( 'delete_option' )->alias( function ( $k ) { unset( $this->db[ $k ] ); return true; } );
		Functions\when( 'get_current_user_id' )->alias( fn() => $this->user );
		Functions\when( 'wp_json_encode' )->alias( fn( $v ) => json_encode( $v ) );
		Functions\when( 'is_wp_error' )->alias( fn( $v ) => $v instanceof \stdClass && isset( $v->wp_error ) );
		Functions\when( 'wp_remote_retrieve_response_code' )->alias( fn( $r ) => $r['code'] );
		Functions\when( 'wp_remote_retrieve_body' )->alias( fn( $r ) => $r['body'] );
	}

	protected function tearDown(): void {
		CredentialStore::set_key_material_provider( null );
		Monkey\tearDown();
		parent::tearDown();
	}

	private function respond( int $code, string $body ): void {
		Functions\when( 'wp_remote_request' )->alias(
			function ( $url, $args ) use ( $code, $body ) {
				$this->calls[] = array( $url, $args );
				return array( 'code' => $code, 'body' => $body );
			}
		);
	}

	public function test_base_url_default(): void {
		$this->assertSame( 'https://core.siteguardian.ai/api/v1', Client::base_url() );
	}

	public function test_auth_request_sends_bearer_and_user_ref_when_logged_in(): void {
		CredentialStore::put( 'sgat_abc' );
		$this->user = 7;
		$this->respond( 200, '{"ok":true}' );
		$r = Client::request( 'POST', 'x', array( 'a' => 1 ) );
		$this->assertTrue( $r->ok );
		$args = $this->calls[0][1];
		$this->assertSame( 'Bearer sgat_abc', $args['headers']['Authorization'] );
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{64}$/', $args['headers']['x-sg-user-ref'] );
		$this->assertSame( 15, $args['timeout'] );
		$this->assertTrue( $args['sslverify'] );
		$this->assertSame( 0, $args['redirection'] );
		$this->assertSame( '{"a":1}', $args['body'] );
	}

	public function test_no_user_ref_without_logged_in_user(): void {
		CredentialStore::put( 'sgat_abc' );
		$this->respond( 200, '{}' );
		Client::request( 'GET', 'x' );
		$this->assertArrayNotHasKey( 'x-sg-user-ref', $this->calls[0][1]['headers'] );
		$this->assertArrayHasKey( 'Authorization', $this->calls[0][1]['headers'] );
	}

	public function test_unauthenticated_request_sends_no_auth_headers(): void {
		$this->user = 7;
		$this->respond( 200, '{}' );
		Client::request( 'POST', 'x', array(), false );
		$this->assertArrayNotHasKey( 'Authorization', $this->calls[0][1]['headers'] );
		$this->assertArrayNotHasKey( 'x-sg-user-ref', $this->calls[0][1]['headers'] );
	}

	public function test_wp_error_is_network_error(): void {
		Functions\when( 'wp_remote_request' )->justReturn( (object) array( 'wp_error' => true ) );
		$r = Client::request( 'POST', 'x', array(), false );
		$this->assertFalse( $r->ok );
		$this->assertSame( 'network_error', $r->error_code );
	}

	public function test_core_error_shape_is_parsed(): void {
		$this->respond( 400, '{"error":{"code":"verification_failed","message":"Nope"},"request_id":"r"}' );
		$r = Client::request( 'POST', 'x', array(), false );
		$this->assertSame( 400, $r->status );
		$this->assertSame( 'verification_failed', $r->error_code );
		$this->assertSame( 'Nope', $r->message );
	}

	public function test_non_json_is_bad_response(): void {
		$this->respond( 502, '<html>' );
		$this->assertSame( 'bad_response', Client::request( 'POST', 'x', array(), false )->error_code );
	}
}
