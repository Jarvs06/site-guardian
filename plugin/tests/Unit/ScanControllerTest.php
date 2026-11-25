<?php
declare(strict_types=1);

namespace SiteGuardian\Tests\Unit;

use Brain\Monkey;
use Brain\Monkey\Functions;
use PHPUnit\Framework\TestCase;

use SiteGuardian\Core\Client;
use SiteGuardian\Core\Result;
use SiteGuardian\Rest\ChatController;
use SiteGuardian\Rest\ScanController;

final class ScanControllerTest extends TestCase {

	private const SID = '11111111-1111-4111-8111-111111111111';
	private const RID = '22222222-2222-4222-8222-222222222222';

	/** @var array<int,array{0:string,1:string,2:array<string,mixed>}> */
	private array $calls = array();

	protected function setUp(): void {
		parent::setUp();
		Monkey\setUp();
		$this->calls = array();
	}

	protected function tearDown(): void {
		ScanController::set_sender( null );
		Monkey\tearDown();
		parent::tearDown();
	}

	/** @param array<string,Result> $routes "METHOD path" => Result. */
	private function routes( array $routes ): void {
		ScanController::set_sender(
			function ( string $m, string $p, array $b ) use ( $routes ) {
				$this->calls[] = array( $m, $p, $b );
				return $routes[ $m . ' ' . $p ] ?? Result::failure( 500, 'unexpected', 'no route ' . $m . ' ' . $p );
			}
		);
	}

	private function req( array $params = array() ): object {
		return new class( $params ) {
			public function __construct( private array $p ) {}
			public function get_param( string $k ) {
				return $this->p[ $k ] ?? null;
			}
		};
	}

	private function pages( int $n ): void {
		\WP_Query::$ids   = range( 1, $n );
		\WP_Query::$found = $n;
		Functions\when( 'home_url' )->justReturn( 'https://example.com/' );
		Functions\when( 'get_post_types' )->justReturn( array( 'page' ) );
		Functions\when( 'get_post_type' )->justReturn( 'page' );
		Functions\when( 'get_permalink' )->alias( fn( $id ) => 'https://example.com/p' . $id . '/' );
		Functions\when( 'get_option' )->justReturn( 'posts' );
	}

	private function paths(): array {
		return array_map( fn( $c ) => $c[0] . ' ' . $c[1], $this->calls );
	}

	public function test_1001_pages_go_in_three_batches_and_only_last_has_pages_found(): void {
		$this->pages( 1000 ); // Plus home = 1001.
		$this->routes(
			array(
				'POST /scans'                           => Result::success( 201, array( 'scan_id' => self::SID, 'status' => 'starting', 'already_running' => false ) ),
				'POST /scans/' . self::SID . '/pages'   => Result::success( 200, array( 'accepted' => 1 ) ),
				'POST /scans/' . self::SID . '/begin'   => Result::success( 200, array( 'scan_id' => self::SID, 'status' => 'queued' ) ),
			)
		);
		$res   = ScanController::handle_start();
		$sizes = array();
		$found = array();
		foreach ( $this->calls as $c ) {
			if ( str_ends_with( $c[1], '/pages' ) ) {
				$sizes[] = count( $c[2]['pages'] );
				$found[] = $c[2]['pages_found'] ?? null;
			}
		}
		$this->assertSame( array( 500, 500, 1 ), $sizes );
		$this->assertSame( array( null, null, 1001 ), $found );
		$this->assertSame( array( 'type' => 'link' ), $this->calls[0][2] );
		$paths = $this->paths();
		$this->assertSame( 'POST /scans/' . self::SID . '/begin', $paths[ count( $paths ) - 1 ] );
		$this->assertSame( 200, $res->get_status() );
		$this->assertSame( 'queued', $res->get_data()['status'] );
	}

	public function test_already_running_skips_pages_and_begin(): void {
		$status = array( 'scan_id' => self::SID, 'status' => 'running', 'already_running' => true );
		$this->routes( array( 'POST /scans' => Result::success( 200, $status ) ) );
		$res = ScanController::handle_start();
		$this->assertSame( array( 'POST /scans' ), $this->paths() );
		$this->assertSame( 200, $res->get_status() );
		$this->assertSame( $status, $res->get_data() );
	}

	public function test_network_error_is_502_network_error(): void {
		$this->routes( array( 'POST /scans' => Result::failure( 0, 'network_error', 'x' ) ) );
		$res = ScanController::handle_start();
		$this->assertSame( 502, $res->get_status() );
		$this->assertSame( 'network_error', $res->get_data()['error']['code'] );
		$this->assertSame( Client::NETWORK_MESSAGE, $res->get_data()['error']['message'] );
	}

	public function test_not_connected_is_503(): void {
		$this->routes( array( 'POST /scans' => Result::failure( 0, 'not_connected', 'x' ) ) );
		$res = ScanController::handle_start();
		$this->assertSame( 503, $res->get_status() );
		$this->assertSame( 'not_connected', $res->get_data()['error']['code'] );
	}

	public function test_core_error_passes_through_with_request_id(): void {
		$this->routes( array( 'POST /scans' => Result::failure( 429, 'rate_limited', 'Slow down', self::RID ) ) );
		$res = ScanController::handle_start();
		$this->assertSame( 429, $res->get_status() );
		$this->assertSame(
			array( 'error' => array( 'code' => 'rate_limited', 'message' => 'Slow down' ), 'request_id' => self::RID ),
			$res->get_data()
		);
	}

	public function test_current_maps_404_to_none(): void {
		$this->routes( array( 'GET /scans/latest?type=link' => Result::failure( 404, 'not_found', 'none', self::RID ) ) );
		$res = ScanController::handle_current();
		$this->assertSame( 200, $res->get_status() );
		$this->assertSame( array( 'status' => 'none' ), $res->get_data() );
	}

	public function test_current_returns_status(): void {
		$s = array( 'scan_id' => self::SID, 'status' => 'running' );
		$this->routes( array( 'GET /scans/latest?type=link' => Result::success( 200, $s ) ) );
		$this->assertSame( $s, ScanController::handle_current()->get_data() );
	}

	public function test_results_use_results_scan_id_and_ignore_browser_id(): void {
		$this->routes(
			array(
				'GET /scans/latest?type=link' => Result::success( 200, array( 'scan_id' => 'other', 'results_scan_id' => self::SID ) ),
				'GET /scans/' . self::SID . '/results?cursor=42' => Result::success( 200, array( 'items' => array( 1 ), 'next_cursor' => null ) ),
			)
		);
		$res = ScanController::handle_results( $this->req( array( 'scan_id' => 'evil', 'cursor' => '42' ) ) );
		$this->assertSame( 200, $res->get_status() );
		$this->assertSame( array( 1 ), $res->get_data()['items'] );
		foreach ( $this->paths() as $p ) {
			$this->assertStringNotContainsString( 'evil', $p );
		}
	}

	public function test_results_without_results_scan_id_is_empty(): void {
		$this->routes( array( 'GET /scans/latest?type=link' => Result::success( 200, array( 'scan_id' => self::SID, 'results_scan_id' => null ) ) ) );
		$res = ScanController::handle_results( $this->req() );
		$this->assertSame( array( 'items' => array(), 'next_cursor' => null ), $res->get_data() );
		$this->assertCount( 1, $this->calls );
	}

	public function test_bad_cursor_is_400_and_calls_nothing(): void {
		$this->routes( array() );
		$res = ScanController::handle_results( $this->req( array( 'cursor' => '1;drop' ) ) );
		$this->assertSame( 400, $res->get_status() );
		$this->assertSame( array(), $this->calls );
	}

	public function test_cancel_active_scan_cancels_the_latest_scan(): void {
		$this->routes(
			array(
				'GET /scans/latest?type=link'              => Result::success( 200, array( 'scan_id' => self::SID, 'status' => 'running' ) ),
				'POST /scans/' . self::SID . '/cancel'     => Result::success( 200, array( 'scan_id' => self::SID, 'status' => 'cancelled' ) ),
			)
		);
		$res = ScanController::handle_cancel();
		$this->assertSame( 'cancelled', $res->get_data()['status'] );
		$this->assertSame( 'POST /scans/' . self::SID . '/cancel', $this->paths()[1] );
	}

	public function test_cancel_completed_scan_makes_no_cancel_call(): void {
		$s = array( 'scan_id' => self::SID, 'status' => 'completed' );
		$this->routes( array( 'GET /scans/latest?type=link' => Result::success( 200, $s ) ) );
		$res = ScanController::handle_cancel();
		$this->assertSame( $s, $res->get_data() );
		$this->assertSame( array( 'GET /scans/latest?type=link' ), $this->paths() );
	}

	public function test_every_route_uses_can_chat(): void {
		$registered = array();
		Functions\when( 'register_rest_route' )->alias(
			function ( $ns, $route, $args ) use ( &$registered ) {
				$registered[ $route ] = $args;
			}
		);
		ScanController::register_routes();
		$this->assertSame( array( '/scans/link', '/scans/link/current', '/scans/link/results', '/scans/link/cancel' ), array_keys( $registered ) );
		foreach ( $registered as $args ) {
			$this->assertSame( array( ChatController::class, 'can_chat' ), $args['permission_callback'] );
		}
	}
}
