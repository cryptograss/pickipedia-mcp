#!/usr/bin/env node
/**
 * Manual check: does the server recover when its MediaWiki session expires?
 *
 * NOT part of `npm test`, on purpose. It needs a real wiki and real credentials
 * — it logs in, deliberately destroys the session, and confirms the next write
 * re-authenticates instead of quietly proceeding as an anonymous user. There is
 * nothing to stub here that would still be testing the thing that broke.
 *
 *   npm run build
 *   CONFIG=/path/to/config.json node scripts/check-reauth.mjs
 *
 * The failure this guards against is not loud. An expired session does not
 * raise an authentication error; MediaWiki simply stops recognising the client
 * and answers "permissiondenied: limited to users in the group: Users", which
 * reads as a problem with the bot's rights. It cost two separate investigations
 * before anyone looked at the session instead of the account.
 *
 * The interesting trick is in killSessionKeepingCookies(): emptying the cookie
 * jar would be a much weaker test, because an empty jar is an obvious problem.
 * Production leaves cookies that look perfectly good sitting over a session the
 * server has already thrown away, so that is what this reproduces.
 */
import { getMwn, getAuthenticatedSession, clearMwnCache } from '../dist/common/mwn.js';
import { makeRestPutRequest } from '../dist/common/utils.js';
import { wikiService } from '../dist/common/wikiService.js';

const ANONYMOUS_CSRF_TOKEN = '+\\';

const { server, scriptpath } = wikiService.getCurrent().config;
const restUrl = `${ server }${ scriptpath }/rest.php`;

let failures = 0;

function check( label, passed, detail = '' ) {
	console.log( `  ${ passed ? 'ok  ' : 'FAIL' }  ${ label }${ detail ? ` — ${ detail }` : '' }` );
	if ( !passed ) {
		failures++;
	}
}

async function currentUser( mwn ) {
	const response = await mwn.request( { action: 'query', meta: 'userinfo' } );
	return response.query.userinfo.name;
}

/**
 * Expire the session the way production does: server-side gone, cookies intact.
 *
 * @param {object} mwn A logged-in client.
 * @return {Promise<string>} The cookie string, now worthless, left in the jar.
 */
async function killSessionKeepingCookies( mwn ) {
	const cookies = mwn.cookieJar.getCookieStringSync( restUrl );
	await mwn.logout();
	const { hostname } = new URL( server );
	for ( const pair of cookies.split( '; ' ) ) {
		mwn.cookieJar.setCookieSync( `${ pair }; Domain=${ hostname }; Path=/`, `${ server }/` );
	}
	return cookies;
}

/**
 * Find an existing page the bot is allowed to edit, to aim the write probe at.
 *
 * Discovered rather than hardcoded so this runs against any wiki. A missing
 * page answers 404 and a protected one answers "denied" no matter who is
 * asking, and either would make the probe say "anonymous" about a session that
 * is perfectly fine. Set REAUTH_CHECK_PAGE to choose one yourself.
 *
 * @param {object} mwn A logged-in client.
 * @return {Promise<string|null>} A page title, or null if none was editable.
 */
async function findEditablePage( mwn ) {
	if ( process.env.REAUTH_CHECK_PAGE ) {
		return process.env.REAUTH_CHECK_PAGE;
	}

	const response = await mwn.request( {
		action: 'query',
		generator: 'allpages',
		gapnamespace: 0,
		gaplimit: 10,
		prop: 'info',
		intestactions: 'edit'
	} );

	const pages = Object.values( response.query?.pages ?? {} );
	const editable = pages.find( ( page ) => page.actions?.edit !== undefined );
	return editable ? editable.title : null;
}

/**
 * Try a write that is guaranteed to be refused, and report why it was refused.
 *
 * The stale latest.id means nothing is ever saved. What distinguishes pass from
 * fail is which objection comes back: being turned down over the revision id
 * means authentication succeeded and only the revision was wrong, while being
 * turned down over permissions means the server saw an anonymous request.
 *
 * @param {string} title The page to aim at.
 * @return {Promise<string>} One of 'authenticated', 'anonymous', 'wrote', or a
 *   description of an unrecognised error.
 */
async function probeWrite( title ) {
	try {
		await makeRestPutRequest( `/v1/page/${ encodeURIComponent( title ) }`, {
			source: 'this must never be saved',
			comment: 'session check (expected to be rejected)',
			latest: { id: 1 }
		}, true );
		return 'wrote';
	} catch ( error ) {
		if ( /permissiondenied|denied|not allowed|group/i.test( error.message ) ) {
			return 'anonymous';
		}
		if ( /conflict|latest|revision/i.test( error.message ) ) {
			return 'authenticated';
		}
		return `unrecognised: ${ error.message.slice( 0, 120 ) }`;
	}
}

console.log( `\nSession recovery, against ${ server }\n` );

console.log( 'Baseline:' );
const mwn = await getMwn();
const firstToken = await mwn.getCsrfToken();
check( 'logs in', firstToken !== ANONYMOUS_CSRF_TOKEN, `as ${ await currentUser( mwn ) }` );

// Establish that the probe can tell the two cases apart before trusting it to
// judge anything. A probe that says "anonymous" about a healthy session would
// otherwise report a working fix as broken.
const probePage = await findEditablePage( mwn );
if ( probePage === null ) {
	console.log( '\nNo editable page found to probe writes against. Set REAUTH_CHECK_PAGE.\n' );
	process.exit( 1 );
}
const baseline = await probeWrite( probePage );
if ( baseline !== 'authenticated' ) {
	console.log( `\nThe write probe is unusable: a healthy session on "${ probePage }" ` +
		`reported "${ baseline }". Pick another page with REAUTH_CHECK_PAGE.\n` );
	process.exit( 1 );
}
check( 'writes are authenticated', true, `probing "${ probePage }"` );

console.log( '\nAfter the session expires:' );
await killSessionKeepingCookies( mwn );
check( 'server no longer recognises the cookies', await mwn.getCsrfToken() === ANONYMOUS_CSRF_TOKEN,
	`sees ${ await currentUser( mwn ) }` );

const recovered = await getAuthenticatedSession();
check( 'getAuthenticatedSession logs back in', recovered.csrfToken !== ANONYMOUS_CSRF_TOKEN );
check( 'it builds a fresh client rather than reusing the dead one', recovered.mwn !== mwn );
check( 'writes are authenticated again', await probeWrite( probePage ) === 'authenticated' );

console.log( '\nHealthy sessions are left alone:' );
const reused = await getAuthenticatedSession();
check( 'no needless second login', reused.mwn === recovered.mwn );

console.log( '\nConcurrent callers share one recovery:' );
clearMwnCache();
await killSessionKeepingCookies( await getMwn() );
const racers = await Promise.all( [ 1, 2, 3 ].map( () => getAuthenticatedSession() ) );
check( 'all three recover', racers.every( ( r ) => r.csrfToken !== ANONYMOUS_CSRF_TOKEN ) );
check( 'and share a single client', new Set( racers.map( ( r ) => r.mwn ) ).size === 1 );

console.log( failures ? `\n${ failures } check(s) failed.\n` : '\nAll checks passed.\n' );
process.exit( failures ? 1 : 0 );
