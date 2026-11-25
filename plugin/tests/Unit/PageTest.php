<?php
declare(strict_types=1);

namespace SiteGuardian\Tests\Unit;

use Brain\Monkey;
use Brain\Monkey\Functions;
use PHPUnit\Framework\TestCase;

use SiteGuardian\Frontend\Page;

final class PageTest extends TestCase {

	/** @var array<string,mixed> */
	private array $opts = array();

	protected function setUp(): void {
		parent::setUp();
		Monkey\setUp();
		$this->opts = array();
		Functions\when( 'get_option' )->alias( fn( $k, $d = false ) => $this->opts[ $k ] ?? $d );
		Functions\when( 'update_option' )->alias(
			function ( $k, $v ) {
				$this->opts[ $k ] = $v;
				return true;
			}
		);
	}

	protected function tearDown(): void {
		Monkey\tearDown();
		parent::tearDown();
	}

	private function post( int $id, string $slug, string $status = 'publish' ): object {
		return (object) array( 'ID' => $id, 'post_name' => $slug, 'post_status' => $status );
	}

	public function test_creates_when_none(): void {
		Functions\when( 'get_post' )->justReturn( null );
		Functions\when( 'get_posts' )->justReturn( array() );
		Functions\expect( 'wp_insert_post' )->once()->with(
			\Mockery::on( fn( $a ) => 'site-health-check' === $a['post_name'] && 'Site Health Check' === $a['post_title'] && 'publish' === $a['post_status'] && 'page' === $a['post_type'] && '' === $a['post_content'] )
		)->andReturn( 42 );
		Functions\expect( 'update_post_meta' )->once()->with( 42, '_site_guardian_page', '1' );
		$this->assertSame( 42, Page::ensure() );
		$this->assertSame( 42, $this->opts['site_guardian_page_id'] );
	}

	public function test_trashes_newer_duplicates(): void {
		Functions\when( 'get_post' )->justReturn( null );
		Functions\when( 'get_posts' )->justReturn(
			array( $this->post( 9, 'site-health-check-2' ), $this->post( 5, 'site-health-check' ), $this->post( 7, 'unrelated' ) )
		);
		Functions\expect( 'wp_trash_post' )->once()->with( 9 );
		Functions\expect( 'wp_insert_post' )->never();
		$this->assertSame( 5, Page::ensure() );
		$this->assertSame( 5, $this->opts['site_guardian_page_id'] );
	}

	public function test_fast_path_when_published(): void {
		$this->opts['site_guardian_page_id'] = 5;
		Functions\when( 'get_post' )->justReturn( $this->post( 5, 'site-health-check' ) );
		Functions\expect( 'get_posts' )->never();
		$this->assertSame( 5, Page::ensure() );
	}

	public function test_recreates_when_stored_page_trashed(): void {
		$this->opts['site_guardian_page_id'] = 5;
		Functions\when( 'get_post' )->justReturn( $this->post( 5, 'site-health-check', 'trash' ) );
		Functions\when( 'get_posts' )->justReturn( array() );
		Functions\when( 'wp_insert_post' )->justReturn( 6 );
		Functions\when( 'update_post_meta' )->justReturn( true );
		$this->assertSame( 6, Page::ensure() );
	}
}
