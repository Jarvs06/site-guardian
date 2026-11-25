<?php
/**
 * The Site Guardian front-end page.
 *
 * @package SiteGuardian
 */

namespace SiteGuardian\Frontend;

use SiteGuardian\Support\Options;

defined( 'ABSPATH' ) || exit;

/**
 * Creates, dedupes and recreates the page.
 */
final class Page {

	public const SLUG = 'site-health-check';
	public const META = '_site_guardian_page';

	/**
	 * Hook admin_init.
	 */
	public static function register(): void {
		add_action( 'admin_init', array( self::class, 'ensure' ) );
	}

	/**
	 * Make sure exactly one published page exists.
	 *
	 * @return int Page id.
	 */
	public static function ensure(): int {
		$stored = (int) get_option( Options::PAGE_ID, 0 );
		if ( $stored > 0 ) {
			$post = get_post( $stored );
			if ( is_object( $post ) && 'publish' === $post->post_status ) {
				return $stored;
			}
		}

		$found = get_posts(
			array(
				'post_type'      => 'page',
				'post_status'    => array( 'publish', 'draft', 'pending', 'private', 'future' ),
				'meta_key'       => self::META, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
				'meta_value'     => '1', // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_value
				'posts_per_page' => -1,
				'orderby'        => 'ID',
				'order'          => 'ASC',
			)
		);

		$pages = array();
		foreach ( (array) $found as $post ) {
			if ( 1 === preg_match( '/^' . preg_quote( self::SLUG, '/' ) . '(-\d+)?$/', (string) $post->post_name ) ) {
				$pages[] = $post;
			}
		}
		usort( $pages, static fn( $a, $b ) => (int) $a->ID <=> (int) $b->ID );

		if ( array() === $pages ) {
			$id = wp_insert_post(
				array(
					'post_title'   => 'Site Health Check',
					'post_name'    => self::SLUG,
					'post_status'  => 'publish',
					'post_type'    => 'page',
					'post_content' => '',
				)
			);
			$id = is_int( $id ) ? $id : 0;
			if ( $id > 0 ) {
				update_post_meta( $id, self::META, '1' );
				update_option( Options::PAGE_ID, $id, false );
			}
			return $id;
		}

		$keep = array_shift( $pages );
		foreach ( $pages as $extra ) {
			wp_trash_post( (int) $extra->ID );
		}
		if ( 'publish' !== $keep->post_status ) {
			wp_update_post(
				array(
					'ID'          => (int) $keep->ID,
					'post_status' => 'publish',
				)
			);
		}
		update_option( Options::PAGE_ID, (int) $keep->ID, false );
		return (int) $keep->ID;
	}
}
