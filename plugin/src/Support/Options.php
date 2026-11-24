<?php
/**
 * Option names.
 *
 * @package SiteGuardian
 */

namespace SiteGuardian\Support;

defined( 'ABSPATH' ) || exit;

/**
 * Names of every option the plugin stores. All are written with autoload off.
 */
final class Options {

	public const INSTALLATION_ID   = 'site_guardian_installation_id';
	public const WEBSITE_ID        = 'site_guardian_website_id';
	public const CREDENTIAL        = 'site_guardian_credential';
	public const USER_REF_SECRET   = 'site_guardian_user_ref_secret';
	public const PENDING_CHALLENGE = 'site_guardian_pending_challenge';
	public const CAPABILITY        = 'site_guardian_capability';
	public const LAST_ERROR        = 'site_guardian_last_error';
	public const PAGE_ID           = 'site_guardian_page_id';
	public const CONNECT_LOCK      = 'site_guardian_connect_lock';

	/**
	 * Every option name.
	 *
	 * @return string[]
	 */
	public static function all(): array {
		return array(
			self::INSTALLATION_ID,
			self::WEBSITE_ID,
			self::CREDENTIAL,
			self::USER_REF_SECRET,
			self::PENDING_CHALLENGE,
			self::CAPABILITY,
			self::LAST_ERROR,
			self::PAGE_ID,
			self::CONNECT_LOCK,
		);
	}
}
