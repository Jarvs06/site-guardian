<?php
/**
 * Clean, theme-free shell for the Site Guardian page.
 *
 * No wp_head()/wp_footer(), no inline script or style (the page CSP forbids them).
 * Markup ported from the old plugin's chat-page.php, link-scanner.php and
 * remote-scan.php (same ids and class names, so the copied CSS applies).
 * Elements the old templates hid with an inline display:none use the hidden attribute.
 *
 * @package SiteGuardian
 */

defined( 'ABSPATH' ) || exit;

$site_guardian_data = \SiteGuardian\Frontend\Template::boot_data();

// Plugin assets only. Each entry has a type (style, script or module) and a src relative to the plugin root.
// DOMPurify is a classic script printed before the app module so window.DOMPurify exists when it runs.
$site_guardian_assets = array(
	array(
		'type' => 'style',
		'src'  => 'assets/css/chat.css',
	),
	array(
		'type' => 'style',
		'src'  => 'assets/css/layout-check.css',
	),
	array(
		'type' => 'style',
		'src'  => 'assets/css/link-scanner.css',
	),
	array(
		'type' => 'style',
		'src'  => 'assets/css/remote-scan.css',
	),
	array(
		'type' => 'style',
		'src'  => 'assets/css/app.css',
	),
	array(
		'type' => 'script',
		'src'  => 'assets/vendor/purify.min.js',
	),
	array(
		'type' => 'module',
		'src'  => 'assets/js/app.js',
	),
);

$site_guardian_base      = defined( 'SITE_GUARDIAN_FILE' ) ? plugin_dir_url( SITE_GUARDIAN_FILE ) : '';
$site_guardian_ver       = defined( 'SITE_GUARDIAN_VERSION' ) ? SITE_GUARDIAN_VERSION : '0';
$site_guardian_site_url  = home_url( '/' );
$site_guardian_site_host = (string) preg_replace( '#^https?://#', '', untrailingslashit( $site_guardian_site_url ) );
?>
<!doctype html>
<html lang="<?php echo esc_attr( get_bloginfo( 'language' ) ); ?>">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0ea5e9">
<meta name="robots" content="noindex,nofollow">
<title><?php echo esc_html( $site_guardian_data['site_name'] . ' — ' . __( 'Site Guardian', 'site-guardian' ) ); ?></title>
<?php foreach ( $site_guardian_assets as $site_guardian_asset ) : ?>
	<?php if ( 'style' === $site_guardian_asset['type'] ) : ?>
<link rel="stylesheet" href="<?php echo esc_url( $site_guardian_base . $site_guardian_asset['src'] . '?ver=' . $site_guardian_ver ); ?>"><?php // phpcs:ignore WordPress.WP.EnqueuedResources.NonEnqueuedStylesheet -- clean page, no wp_head(). ?>
	<?php endif; ?>
<?php endforeach; ?>
</head>
<body class="sga-standalone">
<div id="sg-app" class="sg-app" data-rest-url="<?php echo esc_attr( $site_guardian_data['rest_url'] ); ?>" data-nonce="<?php echo esc_attr( $site_guardian_data['nonce'] ); ?>" data-site-name="<?php echo esc_attr( $site_guardian_data['site_name'] ); ?>">

	<nav class="sg-tabs" role="tablist" aria-label="<?php esc_attr_e( 'Site Guardian tools', 'site-guardian' ); ?>">
		<button class="sg-tab is-active" type="button" role="tab" id="sg-tab-chat" aria-controls="sg-panel-chat" aria-selected="true"><?php esc_html_e( '💬 Chat', 'site-guardian' ); ?></button>
		<button class="sg-tab" type="button" role="tab" id="sg-tab-links" aria-controls="sg-panel-links" aria-selected="false" tabindex="-1"><?php esc_html_e( '🔗 Link Scanner', 'site-guardian' ); ?></button>
		<button class="sg-tab" type="button" role="tab" id="sg-tab-layout" aria-controls="sg-panel-layout" aria-selected="false" tabindex="-1"><?php esc_html_e( '🖥️ Layout Check', 'site-guardian' ); ?></button>
		<button class="sg-tab" type="button" role="tab" id="sg-tab-remote" aria-controls="sg-panel-remote" aria-selected="false" tabindex="-1"><?php esc_html_e( '🌐 Remote Scan', 'site-guardian' ); ?></button>
	</nav>

	<!-- ════════ Chat (old chat-page.php) ════════ -->
	<section class="sg-panel sg-panel--chat" id="sg-panel-chat" role="tabpanel" aria-labelledby="sg-tab-chat">
	<div class="sga-wrap" id="sga-app" role="main" aria-label="<?php esc_attr_e( 'Site Guardian AI chat', 'site-guardian' ); ?>">

		<!-- ── Header ── -->
		<header class="sga-header" role="banner">
			<div class="sga-header-text">
				<h2><?php esc_html_e( 'Site Guardian', 'site-guardian' ); ?></h2>
				<span class="sga-status" aria-live="polite">
					<span class="sga-dot" aria-hidden="true"></span>
					<?php esc_html_e( 'Monitoring', 'site-guardian' ); ?> <strong><?php echo esc_html( $site_guardian_data['site_name'] ); ?></strong>
				</span>
			</div>
			<div class="sga-header-site" aria-hidden="true">
				<span class="sga-site-pill" title="<?php echo esc_attr( $site_guardian_site_url ); ?>">
					🌐 <?php echo esc_html( $site_guardian_site_host ); ?>
				</span>
			</div>
		</header>

		<!-- ── Quick Actions ── -->
		<nav class="sga-quick-actions" aria-label="<?php esc_attr_e( 'Quick checks', 'site-guardian' ); ?>">
			<button class="sga-quick-btn" type="button"
				data-prompt="<?php esc_attr_e( 'Check all the links on this website. Are any of them broken or leading to the wrong page?', 'site-guardian' ); ?>">
				<?php esc_html_e( '🔗 Link Check', 'site-guardian' ); ?>
			</button>
			<button class="sga-quick-btn" type="button"
				data-prompt="<?php esc_attr_e( 'Analyse this website speed and performance. How fast does it load and what does the score mean?', 'site-guardian' ); ?>">
				<?php esc_html_e( '⚡ Speed Check', 'site-guardian' ); ?>
			</button>
			<button class="sga-quick-btn" type="button"
				data-prompt="<?php esc_attr_e( 'Check my website layout and browser display. Are there any visual or responsive issues?', 'site-guardian' ); ?>">
				<?php esc_html_e( '🖥️ Browser Check', 'site-guardian' ); ?>
			</button>
		</nav>

		<!-- ── Chat Messages ── -->
		<section class="sga-messages" id="sga-messages" aria-live="polite" aria-label="<?php esc_attr_e( 'Chat messages', 'site-guardian' ); ?>">

			<!-- Welcome message -->
			<div class="sga-msg sga-msg--ai" role="listitem">
				<div class="sga-avatar" aria-hidden="true">🛡️</div>
				<div class="sga-bubble">
					<p>👋 <?php esc_html_e( 'Hi! I\'m', 'site-guardian' ); ?> <strong><?php esc_html_e( 'Site Guardian', 'site-guardian' ); ?></strong>, <?php esc_html_e( 'your website health assistant.', 'site-guardian' ); ?></p>
					<p><?php esc_html_e( 'I\'m already connected to', 'site-guardian' ); ?> <strong><?php echo esc_html( $site_guardian_data['site_name'] ); ?></strong> <?php esc_html_e( 'and ready to check:', 'site-guardian' ); ?></p>
					<ul>
						<li>🔗 <strong><?php esc_html_e( 'Broken links', 'site-guardian' ); ?></strong> — <?php esc_html_e( 'pages that no longer exist or lead nowhere', 'site-guardian' ); ?></li>
						<li>⚡ <strong><?php esc_html_e( 'Website speed', 'site-guardian' ); ?></strong> — <?php esc_html_e( 'how fast your site loads for visitors', 'site-guardian' ); ?></li>
						<li>🖥️ <strong><?php esc_html_e( 'Layout issues', 'site-guardian' ); ?></strong> — <?php esc_html_e( 'how your site looks on different screen sizes', 'site-guardian' ); ?></li>
						<li>💡 <strong><?php esc_html_e( 'Easy tips', 'site-guardian' ); ?></strong> — <?php esc_html_e( 'simple steps to fix any problems found', 'site-guardian' ); ?></li>
					</ul>
					<p><?php esc_html_e( 'Tap a quick action above or type a question below to get started!', 'site-guardian' ); ?></p>
				</div>
			</div>

		</section>

		<!-- ── Typing Indicator ── -->
		<div class="sga-typing" id="sga-typing" hidden role="status" aria-label="<?php esc_attr_e( 'AI is typing', 'site-guardian' ); ?>">
			<div class="sga-avatar" aria-hidden="true">🛡️</div>
			<div class="sga-bubble sga-bubble--typing" aria-hidden="true">
				<span></span><span></span><span></span>
			</div>
		</div>

		<!-- ── Input Area ── -->
		<div class="sga-input-area" role="form" aria-label="<?php esc_attr_e( 'Message input', 'site-guardian' ); ?>">
			<div class="sga-input-wrap">
				<textarea
					id="sga-input"
					placeholder="<?php esc_attr_e( 'Ask anything about your website health…', 'site-guardian' ); ?>"
					rows="1"
					maxlength="2000"
					aria-label="<?php esc_attr_e( 'Your message', 'site-guardian' ); ?>"
					aria-multiline="true"
					autocomplete="off"
					spellcheck="true"
				></textarea>
				<div class="sga-input-footer" aria-hidden="true">
					<span class="sga-char-count" id="sga-char-count"></span>
				</div>
			</div>
			<button id="sga-send" type="button" aria-label="<?php esc_attr_e( 'Send message', 'site-guardian' ); ?>">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
					stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<line x1="22" y1="2" x2="11" y2="13"/>
					<polygon points="22 2 15 22 11 13 2 9 22 2"/>
				</svg>
			</button>
		</div>

		<p class="sga-disclaimer"><?php esc_html_e( 'Site Guardian · Results are for guidance only', 'site-guardian' ); ?></p>

	</div><!-- /#sga-app -->
	</section>

	<!-- ════════ Link Scanner (old link-scanner.php) — coming soon ════════ -->
	<section class="sg-panel sg-panel--page" id="sg-panel-links" role="tabpanel" aria-labelledby="sg-tab-links" hidden data-coming-soon>
	<div class="sga-scanner" id="sga-scanner">

		<div class="sga-scanner-header">
			<div class="sga-scanner-title">
				<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
					<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
				</svg>
				<span><?php esc_html_e( 'Link Scanner', 'site-guardian' ); ?></span>
			</div>
			<div class="sga-scanner-actions">
				<button id="sga-scan-start" class="sga-btn sga-btn--primary" type="button" disabled>
					<?php esc_html_e( '🔍 Scan All Links', 'site-guardian' ); ?>
				</button>
				<button id="sga-scan-refresh" class="sga-btn sga-btn--ghost" type="button" hidden disabled>
					<?php esc_html_e( '🔄 Re-scan', 'site-guardian' ); ?>
				</button>
				<button id="sga-scan-export" class="sga-btn sga-btn--ghost" type="button" hidden disabled>
					<?php esc_html_e( '📥 Export CSV', 'site-guardian' ); ?>
				</button>
			</div>
		</div>

		<p class="sg-coming-soon" role="status"><strong><?php esc_html_e( 'Coming soon', 'site-guardian' ); ?></strong> — <?php esc_html_e( 'the link scanner is being rebuilt and will be back in a later update. You can still ask about your links in the chat.', 'site-guardian' ); ?></p>

		<!-- Progress bar -->
		<div class="sga-progress-wrap" id="sga-progress-wrap" hidden>
			<div class="sga-progress-bar">
				<div class="sga-progress-fill" id="sga-progress-fill"></div>
			</div>
			<p class="sga-progress-label" id="sga-progress-label"><?php esc_html_e( 'Collecting links…', 'site-guardian' ); ?></p>
		</div>

		<!-- Summary pills -->
		<div class="sga-summary" id="sga-summary" hidden>
			<div class="sga-summary-group">
				<span class="sga-pill sga-pill--total" id="sga-count-total"><?php esc_html_e( '0 links', 'site-guardian' ); ?></span>
				<span class="sga-pill sga-pill--ok" id="sga-count-ok"><?php esc_html_e( '0 OK', 'site-guardian' ); ?></span>
				<span class="sga-pill sga-pill--broken" id="sga-count-broken"><?php esc_html_e( '0 Broken', 'site-guardian' ); ?></span>
				<span class="sga-pill sga-pill--restricted" id="sga-count-restricted"><?php esc_html_e( '0 Restricted', 'site-guardian' ); ?></span>
				<span class="sga-pill sga-pill--warning" id="sga-count-warning"><?php esc_html_e( '0 Warning', 'site-guardian' ); ?></span>
				<span class="sga-pill sga-pill--redir" id="sga-count-redir"><?php esc_html_e( '0 Redirect', 'site-guardian' ); ?></span>
				<span class="sga-pill sga-pill--skip" id="sga-count-skip"><?php esc_html_e( '0 Skipped', 'site-guardian' ); ?></span>
			</div>
			<div class="sga-summary-group sga-summary-group--seo">
				<span class="sga-pill sga-pill--indexed" id="sga-count-indexed"><?php esc_html_e( '0 Indexed', 'site-guardian' ); ?></span>
				<span class="sga-pill sga-pill--noindex" id="sga-count-noindex"><?php esc_html_e( '0 Noindex', 'site-guardian' ); ?></span>
				<span class="sga-pill sga-pill--nofollow" id="sga-count-nofollow"><?php esc_html_e( '0 Nofollow', 'site-guardian' ); ?></span>
			</div>
		</div>

		<!-- Filter bar -->
		<div class="sga-filter-bar" id="sga-filter-bar" hidden>
			<div class="sga-filter-group">
				<span class="sga-filter-label"><?php esc_html_e( 'Status', 'site-guardian' ); ?></span>
				<button class="sga-filter-btn active" type="button" data-filter-status="all" disabled><?php esc_html_e( 'All', 'site-guardian' ); ?></button>
				<button class="sga-filter-btn" type="button" data-filter-status="ok" disabled><?php esc_html_e( 'OK', 'site-guardian' ); ?></button>
				<button class="sga-filter-btn" type="button" data-filter-status="broken" disabled><?php esc_html_e( 'Broken', 'site-guardian' ); ?></button>
				<button class="sga-filter-btn" type="button" data-filter-status="restricted" disabled><?php esc_html_e( 'Restricted', 'site-guardian' ); ?></button>
				<button class="sga-filter-btn" type="button" data-filter-status="warning" disabled><?php esc_html_e( 'Warning', 'site-guardian' ); ?></button>
				<button class="sga-filter-btn" type="button" data-filter-status="redirect" disabled><?php esc_html_e( 'Redirect', 'site-guardian' ); ?></button>
			</div>
			<div class="sga-filter-group">
				<span class="sga-filter-label"><?php esc_html_e( 'SEO', 'site-guardian' ); ?></span>
				<button class="sga-filter-btn active" type="button" data-filter-seo="all" disabled><?php esc_html_e( 'All', 'site-guardian' ); ?></button>
				<button class="sga-filter-btn" type="button" data-filter-seo="indexed" disabled><?php esc_html_e( 'Indexed', 'site-guardian' ); ?></button>
				<button class="sga-filter-btn" type="button" data-filter-seo="noindex" disabled><?php esc_html_e( 'Noindex', 'site-guardian' ); ?></button>
				<button class="sga-filter-btn" type="button" data-filter-seo="nofollow" disabled><?php esc_html_e( 'Nofollow', 'site-guardian' ); ?></button>
				<button class="sga-filter-btn" type="button" data-filter-seo="unknown" disabled><?php esc_html_e( 'Unknown', 'site-guardian' ); ?></button>
			</div>
			<input type="search" id="sga-search" class="sga-search" placeholder="<?php esc_attr_e( 'Filter URLs…', 'site-guardian' ); ?>" hidden disabled>
		</div>

		<!-- Results table -->
		<div class="sga-table-wrap" id="sga-table-wrap" hidden>
			<table class="sga-table" id="sga-table">
				<thead>
					<tr>
						<th><?php esc_html_e( 'URL', 'site-guardian' ); ?></th>
						<th><?php esc_html_e( 'Source', 'site-guardian' ); ?></th>
						<th class="sga-col-robots"><?php esc_html_e( 'Index / Follow', 'site-guardian' ); ?></th>
						<th class="sga-col-status"><?php esc_html_e( 'Status', 'site-guardian' ); ?></th>
					</tr>
				</thead>
				<tbody id="sga-tbody"></tbody>
			</table>
		</div>

		<p class="sga-scanner-note">
			✅ <strong><?php esc_html_e( 'OK', 'site-guardian' ); ?></strong> — <?php esc_html_e( 'accessible', 'site-guardian' ); ?> &nbsp;|&nbsp;
			🔒 <strong><?php esc_html_e( 'Restricted', 'site-guardian' ); ?></strong> — <?php esc_html_e( 'page exists but blocks automated checkers (403/429/999) — works in browser', 'site-guardian' ); ?> &nbsp;|&nbsp;
			⚠️ <strong><?php esc_html_e( 'Warning', 'site-guardian' ); ?></strong> — <?php esc_html_e( 'server error, may be temporary', 'site-guardian' ); ?> &nbsp;|&nbsp;
			❌ <strong><?php esc_html_e( 'Broken', 'site-guardian' ); ?></strong> — <?php esc_html_e( 'page not found (404/410) or unreachable', 'site-guardian' ); ?>
		</p>
	</div><!-- /#sga-scanner -->
	</section>

	<!-- ════════ Layout Check (old chat-triggered layout card) — coming soon ════════ -->
	<section class="sg-panel sg-panel--page" id="sg-panel-layout" role="tabpanel" aria-labelledby="sg-tab-layout" hidden data-coming-soon>
	<div class="sga-scanner">
		<div class="sga-scanner-header">
			<div class="sga-scanner-title">
				<span aria-hidden="true">🖥️</span>
				<span><?php esc_html_e( 'Layout Check', 'site-guardian' ); ?></span>
			</div>
			<div class="sga-scanner-actions">
				<button class="sga-btn sga-btn--primary" type="button" disabled><?php esc_html_e( '🖥️ Check Layout', 'site-guardian' ); ?></button>
			</div>
		</div>

		<p class="sg-coming-soon" role="status"><strong><?php esc_html_e( 'Coming soon', 'site-guardian' ); ?></strong> — <?php esc_html_e( 'the layout and browser check is being rebuilt and will be back in a later update.', 'site-guardian' ); ?></p>

		<div class="sg-panel-body">
			<div class="sga-layout-summary">
				<div class="sga-ls-header">
					<span class="sga-ls-header-icon" aria-hidden="true">🖥️</span>
					<?php esc_html_e( 'Checks each page at four screen sizes', 'site-guardian' ); ?>
				</div>
				<ul class="sg-plain-list">
					<li><?php esc_html_e( 'Desktop (1980px)', 'site-guardian' ); ?></li>
					<li><?php esc_html_e( 'Laptop (1024px)', 'site-guardian' ); ?></li>
					<li><?php esc_html_e( 'Tablet (767px)', 'site-guardian' ); ?></li>
					<li><?php esc_html_e( 'Mobile (400px)', 'site-guardian' ); ?></li>
				</ul>
			</div>
		</div>
	</div>
	</section>

	<!-- ════════ Remote Scan (old remote-scan.php) — coming soon ════════ -->
	<section class="sg-panel sg-panel--remote" id="sg-panel-remote" role="tabpanel" aria-labelledby="sg-tab-remote" hidden data-coming-soon>
	<div class="sgr-wrap" id="sgr-app" aria-label="<?php esc_attr_e( 'Site Guardian Remote Scanner', 'site-guardian' ); ?>">

		<!-- ── Header ── -->
		<header class="sgr-header">
			<div class="sgr-header-text">
				<h2><?php esc_html_e( 'Site Guardian', 'site-guardian' ); ?></h2>
				<span class="sgr-status">
					<span class="sgr-dot" aria-hidden="true"></span>
					<?php esc_html_e( 'Remote Website Scanner', 'site-guardian' ); ?>
				</span>
			</div>
		</header>

		<!-- ── URL Input ── -->
		<section class="sgr-input-section" id="sgr-input-section">
			<p class="sg-coming-soon" role="status"><strong><?php esc_html_e( 'Coming soon', 'site-guardian' ); ?></strong> — <?php esc_html_e( 'the remote website scanner is being rebuilt and will be back in a later update.', 'site-guardian' ); ?></p>
			<p class="sgr-intro"><?php esc_html_e( 'Enter any website URL below — no installation needed.', 'site-guardian' ); ?></p>
			<div class="sgr-url-bar">
				<div class="sgr-url-icon" aria-hidden="true">🌐</div>
				<input
					type="url"
					id="sgr-url-input"
					placeholder="https://example.com"
					autocomplete="off"
					spellcheck="false"
					aria-label="<?php esc_attr_e( 'Website URL to scan', 'site-guardian' ); ?>"
					disabled
				/>
				<button id="sgr-scan-btn" type="button" aria-label="<?php esc_attr_e( 'Start scan', 'site-guardian' ); ?>" disabled>
					<?php esc_html_e( 'Scan Website', 'site-guardian' ); ?>
				</button>
			</div>
			<p class="sgr-disclaimer sg-error-text" id="sgr-url-error" hidden aria-live="polite"></p>
		</section>

		<p class="sgr-footer-note"><?php esc_html_e( 'Site Guardian · Results are for guidance only · Remote scans cover publicly accessible pages only', 'site-guardian' ); ?></p>

	</div><!-- /#sgr-app -->
	</section>

</div><!-- /#sg-app -->
<?php foreach ( $site_guardian_assets as $site_guardian_asset ) : ?>
	<?php if ( 'script' === $site_guardian_asset['type'] || 'module' === $site_guardian_asset['type'] ) : ?>
<script<?php echo 'module' === $site_guardian_asset['type'] ? ' type="module"' : ''; ?> src="<?php echo esc_url( $site_guardian_base . $site_guardian_asset['src'] . '?ver=' . $site_guardian_ver ); ?>"></script>
	<?php endif; ?>
<?php endforeach; ?>
</body>
</html>
