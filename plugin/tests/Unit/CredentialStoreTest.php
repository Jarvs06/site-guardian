<?php
declare(strict_types=1);

namespace SiteGuardian\Tests\Unit;

use Brain\Monkey;
use Brain\Monkey\Functions;
use PHPUnit\Framework\TestCase;
use SiteGuardian\Core\CredentialStore;
use SiteGuardian\Support\Options;

final class CredentialStoreTest extends TestCase {

	/** @var array<string,mixed> */
	private array $db = array();

	protected function setUp(): void {
		parent::setUp();
		Monkey\setUp();
		$this->db = array();

		Functions\when( 'get_option' )->alias( fn( $k, $d = false ) => $this->db[ $k ] ?? $d );
		Functions\when( 'update_option' )->alias(
			function ( $k, $v, $autoload = null ) {
				$this->db[ $k ] = $v;
				$this->autoload[ $k ] = $autoload;
				return true;
			}
		);
		Functions\when( 'delete_option' )->alias(
			function ( $k ) {
				unset( $this->db[ $k ] );
				return true;
			}
		);
		CredentialStore::set_key_material_provider( fn() => 'key-one' . 'salt-one' );
	}

	/** @var array<string,mixed> */
	private array $autoload = array();

	protected function tearDown(): void {
		CredentialStore::set_key_material_provider( null );
		Monkey\tearDown();
		parent::tearDown();
	}

	public function test_put_then_get_round_trips(): void {
		CredentialStore::put( 'sgat_abc' );
		$this->assertSame( 'sgat_abc', CredentialStore::get() );
	}

	public function test_stored_value_does_not_contain_token_and_autoload_is_off(): void {
		CredentialStore::put( 'sgat_abc' );
		$this->assertStringNotContainsString( 'sgat_abc', (string) $this->db[ Options::CREDENTIAL ] );
		$this->assertFalse( $this->autoload[ Options::CREDENTIAL ] );
	}

	public function test_different_auth_key_returns_null_and_deletes_option(): void {
		CredentialStore::put( 'sgat_abc' );
		CredentialStore::set_key_material_provider( fn() => 'other-key' . 'salt-one' );
		$this->assertNull( CredentialStore::get() );
		$this->assertArrayNotHasKey( Options::CREDENTIAL, $this->db );
	}

	public function test_garbage_value_returns_null_and_deletes_option(): void {
		$this->db[ Options::CREDENTIAL ] = '!!not-base64!!';
		$this->assertNull( CredentialStore::get() );
		$this->assertArrayNotHasKey( Options::CREDENTIAL, $this->db );
	}

	public function test_get_without_stored_value_returns_null(): void {
		$this->assertNull( CredentialStore::get() );
	}

	public function test_clear_deletes_option(): void {
		CredentialStore::put( 'sgat_abc' );
		CredentialStore::clear();
		$this->assertNull( CredentialStore::get() );
	}

	/**
	 * @runInSeparateProcess
	 * @preserveGlobalState disabled
	 */
	public function test_constant_overrides_stored_value(): void {
		define( 'SITE_GUARDIAN_CREDENTIAL', 'sgat_from_constant' );
		CredentialStore::put( 'sgat_stored' );
		$this->assertSame( 'sgat_from_constant', CredentialStore::get() );
	}
}
