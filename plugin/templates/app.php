<?php
/**
 * Clean, theme-free shell for the Site Guardian page.
 *
 * No wp_head()/wp_footer(), no inline script or style.
 *
 * @package SiteGuardian
 */

defined( 'ABSPATH' ) || exit;

$site_guardian_data = \SiteGuardian\Frontend\Template::boot_data();

// Plugin assets only. Each entry has a type (style, script or module) and a src relative to the plugin root.
$site_guardian_assets = array();

$site_guardian_base = defined( 'SITE_GUARDIAN_FILE' ) ? plugin_dir_url( SITE_GUARDIAN_FILE ) : '';
$site_guardian_ver  = defined( 'SITE_GUARDIAN_VERSION' ) ? SITE_GUARDIAN_VERSION : '0';
?>
<!doctype html>
<html lang="<?php echo esc_attr( get_bloginfo( 'language' ) ); ?>">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title><?php echo esc_html( $site_guardian_data['site_name'] . ' — ' . __( 'Site Guardian', 'site-guardian' ) ); ?></title>
<?php foreach ( $site_guardian_assets as $site_guardian_asset ) : ?>
	<?php if ( 'style' === $site_guardian_asset['type'] ) : ?>
<link rel="stylesheet" href="<?php echo esc_url( $site_guardian_base . $site_guardian_asset['src'] . '?ver=' . $site_guardian_ver ); ?>"><?php // phpcs:ignore WordPress.WP.EnqueuedResources.NonEnqueuedStylesheet -- clean page, no wp_head(). ?>
	<?php endif; ?>
<?php endforeach; ?>
</head>
<body>
<div id="sg-app" data-rest-url="<?php echo esc_attr( $site_guardian_data['rest_url'] ); ?>" data-nonce="<?php echo esc_attr( $site_guardian_data['nonce'] ); ?>" data-site-name="<?php echo esc_attr( $site_guardian_data['site_name'] ); ?>"></div>
<?php foreach ( $site_guardian_assets as $site_guardian_asset ) : ?>
	<?php if ( 'script' === $site_guardian_asset['type'] || 'module' === $site_guardian_asset['type'] ) : ?>
<script<?php echo 'module' === $site_guardian_asset['type'] ? ' type="module"' : ''; ?> src="<?php echo esc_url( $site_guardian_base . $site_guardian_asset['src'] . '?ver=' . $site_guardian_ver ); ?>"></script>
	<?php endif; ?>
<?php endforeach; ?>
</body>
</html>
