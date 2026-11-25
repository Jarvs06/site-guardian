<?php
declare(strict_types=1);

namespace SiteGuardian\Tests\Unit;

use Brain\Monkey;
use Brain\Monkey\Functions;
use PHPUnit\Framework\TestCase;

use SiteGuardian\Scan\PageList;

final class PageListTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		Monkey\setUp();
		\WP_Query::$last_args = array();
		\WP_Query::$ids       = array( 1, 2, 3 );
		\WP_Query::$found     = 3;
		Functions\when( 'home_url' )->justReturn( 'https://example.com/' );
		Functions\when( 'get_post_types' )->justReturn( array( 'post', 'page', 'attachment', 'wp_block', 'product' ) );
		Functions\when( 'get_post_type' )->alias( fn( $id ) => 3 === $id ? 'post' : 'page' );
		Functions\when( 'get_permalink' )->alias( fn( $id ) => 'https://example.com/p' . $id . '/' );
		Functions\when( 'get_option' )->alias( fn( $name ) => 'show_on_front' === $name ? 'posts' : 0 );
		Functions\when( 'get_post_status' )->justReturn( 'publish' );
	}

	/**
	 * Make post $id the static front page, whose permalink is the home URL.
	 */
	private function static_front_page( int $id ): void {
		Functions\when( 'get_option' )->alias(
			fn( $name ) => 'show_on_front' === $name ? 'page' : ( 'page_on_front' === $name ? $id : 0 )
		);
		Functions\when( 'get_permalink' )->alias( fn( $pid ) => $id === $pid ? 'https://example.com/' : 'https://example.com/p' . $pid . '/' );
	}

	protected function tearDown(): void {
		Monkey\tearDown();
		parent::tearDown();
	}

	public function test_excluded_types_are_not_queried(): void {
		PageList::collect();
		$args = \WP_Query::$last_args;
		$this->assertSame( array( 'post', 'page', 'product' ), $args['post_type'] );
		$this->assertSame( 'publish', $args['post_status'] );
		$this->assertSame( 'modified', $args['orderby'] );
		$this->assertSame( 'DESC', $args['order'] );
		$this->assertSame( 'ids', $args['fields'] );
		$this->assertSame( 1000, $args['posts_per_page'] );
		$this->assertFalse( $args['no_found_rows'] );
	}

	public function test_filter_can_add_a_type(): void {
		Functions\expect( 'apply_filters' )
			->once()
			->with( 'site_guardian_scan_excluded_post_types', PageList::EXCLUDED )
			->andReturn( array_merge( PageList::EXCLUDED, array( 'product' ) ) );
		PageList::collect();
		$this->assertSame( array( 'post', 'page' ), \WP_Query::$last_args['post_type'] );
	}

	public function test_home_first_then_pages_with_sources(): void {
		$out = PageList::collect();
		$this->assertSame( array( 'url' => 'https://example.com/', 'source' => 'home' ), $out['pages'][0] );
		$this->assertSame( array( 'url' => 'https://example.com/p3/', 'source' => 'post' ), $out['pages'][3] );
		$this->assertCount( 4, $out['pages'] );
	}

	public function test_permalink_equal_to_home_is_not_repeated(): void {
		Functions\when( 'get_permalink' )->alias( fn( $id ) => 1 === $id ? 'https://example.com/' : 'https://example.com/p' . $id . '/' );
		$urls = array_column( PageList::collect()['pages'], 'url' );
		$this->assertSame( array( 'https://example.com/', 'https://example.com/p2/', 'https://example.com/p3/' ), $urls );
	}

	public function test_found_counts_home(): void {
		\WP_Query::$found = 40;
		$this->assertSame( 41, PageList::collect()['found'] );
	}

	public function test_found_does_not_count_a_skipped_duplicate(): void {
		Functions\when( 'get_permalink' )->alias( fn( $id ) => 3 === $id ? 'https://example.com/p2/' : 'https://example.com/p' . $id . '/' );
		$out = PageList::collect();
		$this->assertCount( 3, $out['pages'] );
		$this->assertSame( 3, $out['found'] );
	}

	public function test_static_front_page_is_counted_once(): void {
		$this->static_front_page( 1 );
		$out = PageList::collect();
		$this->assertCount( 3, $out['pages'] );
		$this->assertSame( 3, $out['found'] );
	}

	public function test_static_front_page_beyond_the_cap_is_counted_once(): void {
		\WP_Query::$found = 1500;
		$this->static_front_page( 9999 );
		$this->assertSame( 1500, PageList::collect()['found'] );
	}

	public function test_unpublished_static_front_page_is_not_subtracted(): void {
		\WP_Query::$found = 1500;
		$this->static_front_page( 9999 );
		Functions\when( 'get_post_status' )->justReturn( 'draft' );
		$this->assertSame( 1501, PageList::collect()['found'] );
	}
}
