<?php
/**
 * Published page list for link scans.
 *
 * @package SiteGuardian
 */

namespace SiteGuardian\Scan;

defined( 'ABSPATH' ) || exit;

/**
 * Builds the list of public URLs a link scan starts from.
 */
final class PageList {

	public const EXCLUDED = array(
		'attachment',
		'elementor_library',
		'elementor-hf',
		'popup_theme',
		'popups',
		'pum-popup',
		'oembed_cache',
		'wp_block',
		'wp_template',
		'wp_template_part',
		'wp_global_styles',
		'wp_navigation',
	);

	private const LIMIT = 1000;

	/**
	 * Collect the home page and published pages, newest edited first.
	 *
	 * @return array{pages: list<array{url:string,source:string}>, found:int}
	 */
	public static function collect(): array {
		$home  = (string) home_url( '/' );
		$pages = array(
			array(
				'url'    => $home,
				'source' => 'home',
			),
		);

		$excluded = apply_filters( 'site_guardian_scan_excluded_post_types', self::EXCLUDED );
		$excluded = is_array( $excluded ) ? $excluded : self::EXCLUDED;
		$types    = array_values( array_diff( array_values( (array) get_post_types( array( 'public' => true ) ) ), $excluded ) );

		$found = 1;
		if ( array() !== $types ) {
			$query  = new \WP_Query(
				array(
					'post_status'    => 'publish',
					'post_type'      => $types,
					'orderby'        => 'modified',
					'order'          => 'DESC',
					'fields'         => 'ids',
					'posts_per_page' => self::LIMIT,
					'no_found_rows'  => false,
				)
			);
			$found += (int) $query->found_posts;

			$seen = array( $home => true );
			foreach ( (array) $query->posts as $id ) {
				$url = get_permalink( $id );
				if ( ! is_string( $url ) || '' === $url || isset( $seen[ $url ] ) ) {
					continue;
				}
				$seen[ $url ] = true;
				$pages[]      = array(
					'url'    => $url,
					'source' => (string) get_post_type( $id ),
				);
			}
		}

		return array(
			'pages' => $pages,
			'found' => $found,
		);
	}
}
