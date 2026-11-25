( function () {
	'use strict';

	var cfg = window.siteGuardianAdmin;
	var connect = document.getElementById( 'sg-connect' );
	var rotate = document.getElementById( 'sg-rotate' );
	var progress = document.getElementById( 'sg-progress' );
	if ( ! cfg || ! connect || ! progress ) {
		return;
	}

	function buttons() {
		return [ connect, rotate ].filter( Boolean );
	}

	function run( path, working ) {
		buttons().forEach( function ( b ) {
			b.disabled = true;
		} );
		progress.textContent = working;

		return fetch( cfg.restUrl + path, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'X-WP-Nonce': cfg.nonce, 'Content-Type': 'application/json' },
			body: '{}'
		} )
			.then( function ( res ) {
				return res.json().then( function ( body ) {
					return { ok: res.ok, body: body };
				} );
			} )
			.then( function ( r ) {
				var msg = r.body && typeof r.body.message === 'string' ? r.body.message : 'Request failed.';
				progress.textContent = msg;
				if ( r.ok && r.body && r.body.connected && r.body.ok !== false ) {
					window.setTimeout( function () {
						window.location.reload();
					}, 800 );
					return;
				}
				connect.textContent = 'Retry';
				buttons().forEach( function ( b ) {
					b.disabled = false;
				} );
			} )
			.catch( function () {
				progress.textContent = 'Could not reach your site. Please try again.';
				connect.textContent = 'Retry';
				buttons().forEach( function ( b ) {
					b.disabled = false;
				} );
			} );
	}

	connect.addEventListener( 'click', function () {
		run( 'connect', 'Connecting to Site Guardian…' );
	} );
	if ( rotate ) {
		rotate.addEventListener( 'click', function () {
			run( 'rotate', 'Rotating credential…' );
		} );
	}
}() );
