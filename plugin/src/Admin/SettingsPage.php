<?php
/**
 * Settings → Site Guardian.
 *
 * @package SiteGuardian
 */

namespace SiteGuardian\Admin;

use SiteGuardian\Core\Client;
use SiteGuardian\Core\CredentialStore;
use SiteGuardian\Core\Registration;
use SiteGuardian\Support\Options;

defined( 'ABSPATH' ) || exit;

/**
 * Settings page: connection status, connect/rotate, capability.
 */
final class SettingsPage {

	public const SLUG      = 'site-guardian';
	public const SCREEN_ID = 'settings_page_site-guardian';
	public const GROUP     = 'site_guardian';

	private const CAPS = array( 'manage_options', 'edit_pages', 'edit_posts' );

	/**
	 * Register hooks.
	 */
	public static function register(): void {
		add_action( 'admin_menu', array( self::class, 'add_menu' ) );
		add_action( 'admin_init', array( self::class, 'register_settings' ) );
		add_action( 'admin_enqueue_scripts', array( self::class, 'enqueue' ) );
	}

	/**
	 * Add the menu entry.
	 */
	public static function add_menu(): void {
		add_options_page( 'Site Guardian', 'Site Guardian', 'manage_options', self::SLUG, array( self::class, 'render' ) );
	}

	/**
	 * Register the capability setting.
	 */
	public static function register_settings(): void {
		register_setting(
			self::GROUP,
			Options::CAPABILITY,
			array(
				'type'              => 'string',
				'sanitize_callback' => array( self::class, 'sanitize_capability' ),
				'default'           => 'manage_options',
			)
		);
	}

	/**
	 * Whitelist the capability.
	 *
	 * @param mixed $value Submitted value.
	 */
	public static function sanitize_capability( $value ): string {
		return is_string( $value ) && in_array( $value, self::CAPS, true ) ? $value : 'manage_options';
	}

	/**
	 * Enqueue assets on this screen only.
	 *
	 * @param string $hook Hook suffix.
	 */
	public static function enqueue( $hook ): void {
		if ( self::SCREEN_ID !== $hook ) {
			return;
		}
		$url = plugins_url( 'assets/admin/', SITE_GUARDIAN_FILE );
		wp_enqueue_style( 'site-guardian-settings', $url . 'settings.css', array(), SITE_GUARDIAN_VERSION );
		wp_enqueue_script( 'site-guardian-settings', $url . 'settings.js', array(), SITE_GUARDIAN_VERSION, true );
		wp_localize_script(
			'site-guardian-settings',
			'siteGuardianAdmin',
			array(
				'restUrl' => esc_url_raw( rest_url( 'site-guardian/v1/admin/' ) ),
				'nonce'   => wp_create_nonce( 'wp_rest' ),
			)
		);
	}

	/**
	 * Render the page.
	 */
	public static function render(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$connected  = Registration::is_connected();
		$website_id = (string) get_option( Options::WEBSITE_ID, '' );
		$last_error = (string) get_option( Options::LAST_ERROR, '' );
		$cap        = (string) get_option( Options::CAPABILITY, 'manage_options' );
		$labels     = array(
			'manage_options' => __( 'Administrators', 'site-guardian' ),
			'edit_pages'     => __( 'Editors and above', 'site-guardian' ),
			'edit_posts'     => __( 'Authors and above', 'site-guardian' ),
		);
		?>
		<div class="wrap sg-settings">
			<h1><?php echo esc_html__( 'Site Guardian', 'site-guardian' ); ?></h1>

			<h2><?php echo esc_html__( 'Connection', 'site-guardian' ); ?></h2>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><?php echo esc_html__( 'Status', 'site-guardian' ); ?></th>
					<td><strong id="sg-status"><?php echo esc_html( $connected ? __( 'Connected', 'site-guardian' ) : __( 'Not connected', 'site-guardian' ) ); ?></strong></td>
				</tr>
				<?php if ( $connected && '' !== $website_id ) : ?>
				<tr>
					<th scope="row"><?php echo esc_html__( 'Website ID', 'site-guardian' ); ?></th>
					<td><code><?php echo esc_html( $website_id ); ?></code></td>
				</tr>
				<?php endif; ?>
				<tr>
					<th scope="row"><label for="sg-core-url"><?php echo esc_html__( 'Core URL', 'site-guardian' ); ?></label></th>
					<td><input type="text" id="sg-core-url" class="regular-text" readonly value="<?php echo esc_attr( Client::base_url() ); ?>" /></td>
				</tr>
				<?php if ( '' !== $last_error ) : ?>
				<tr>
					<th scope="row"><?php echo esc_html__( 'Last error', 'site-guardian' ); ?></th>
					<td><span class="sg-error"><?php echo esc_html( $last_error ); ?></span></td>
				</tr>
				<?php endif; ?>
			</table>

			<?php if ( CredentialStore::from_constant() ) : ?>
			<p class="description"><?php echo esc_html( Registration::CONFIG_CREDENTIAL_MESSAGE ); ?></p>
			<?php else : ?>
			<p>
				<button type="button" class="button button-primary" id="sg-connect"><?php echo esc_html( '' !== $last_error && ! $connected ? __( 'Retry', 'site-guardian' ) : __( 'Connect', 'site-guardian' ) ); ?></button>
				<?php if ( $connected ) : ?>
				<button type="button" class="button" id="sg-rotate"><?php echo esc_html__( 'Rotate credential', 'site-guardian' ); ?></button>
				<?php endif; ?>
				<span id="sg-progress" role="status" aria-live="polite"></span>
			</p>
			<?php endif; ?>

			<h2><?php echo esc_html__( 'Access', 'site-guardian' ); ?></h2>
			<form method="post" action="<?php echo esc_url( admin_url( 'options.php' ) ); ?>">
				<?php settings_fields( self::GROUP ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="sg-capability"><?php echo esc_html__( 'Who can use Site Guardian', 'site-guardian' ); ?></label></th>
						<td>
							<select id="sg-capability" name="<?php echo esc_attr( Options::CAPABILITY ); ?>">
								<?php foreach ( $labels as $value => $label ) : ?>
								<option value="<?php echo esc_attr( $value ); ?>" <?php selected( $cap, $value ); ?>><?php echo esc_html( $label ); ?></option>
								<?php endforeach; ?>
							</select>
						</td>
					</tr>
				</table>
				<?php submit_button(); ?>
			</form>
		</div>
		<?php
	}
}
