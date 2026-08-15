import { USER_AGENT } from '../server.js';
import { wikiService } from './wikiService.js';
import { Mwn, MwnOptions } from 'mwn';

/**
 * The CSRF token MediaWiki issues to a request it does not recognise.
 *
 * Two characters: a plus sign and a backslash. Every authenticated token is a
 * long hex string ending in the same suffix, so the whole token being just the
 * suffix is unambiguous — it is MediaWiki saying "I have no idea who you are".
 * Verified against pickipedia.xyz with an unauthenticated meta=tokens query.
 *
 * This is what makes the session check free. Signing a write already costs a
 * round trip for the token; the answer to that request also carries the answer
 * to "am I still logged in?", so there is nothing extra to ask.
 */
const ANONYMOUS_CSRF_TOKEN = '+\\';

/**
 * The promise, not the resolved client.
 *
 * Caching the client left a window where two concurrent tools could both find
 * the cache empty and both run a full login. That was survivable when it only
 * happened at startup; it stops being survivable once a stale session can
 * trigger a login mid-run, because MediaWiki aborts a BotPassword login that
 * arrives while another BotPassword session is being established.
 */
let mwnPromise: Promise<Mwn> | null = null;

/**
 * The cached login, starting one if there isn't one.
 *
 * Synchronous up to the point it hands back a promise, deliberately: callers
 * compare the returned promise against `mwnPromise` to find out whether the
 * client they are holding is still the current one, and that comparison is
 * only sound if no other task can interleave between the check and the assign.
 *
 * @return {Promise<Mwn>} The cached login promise, resolving to a logged-in client.
 */
function currentMwnPromise(): Promise<Mwn> {
	if ( mwnPromise ) {
		return mwnPromise;
	}

	const pending = createMwn();
	mwnPromise = pending;

	// A failed login must not be cached, or every later call replays the same
	// rejection without ever retrying. Only clear if nothing has replaced it in
	// the meantime — otherwise a login that failed long ago could evict a good
	// client that succeeded since.
	pending.catch( () => {
		if ( mwnPromise === pending ) {
			mwnPromise = null;
		}
	} );

	return pending;
}

async function createMwn(): Promise<Mwn> {
	const {
		server,
		scriptpath,
		token,
		username,
		password
	} = wikiService.getCurrent().config;

	const options: MwnOptions = {
		apiUrl: `${ server }${ scriptpath }/api.php`,
		userAgent: USER_AGENT
	};

	if ( token ) {
		options.OAuth2AccessToken = token;
		return await Mwn.init( options );
	}

	if ( username && password ) {
		options.username = username;
		options.password = password;
		const mwn = await Mwn.init( options );
		// Says plainly, on stderr, who the server thinks we are. The failure
		// this whole file is about was invisible precisely because nothing ever
		// stated the answer out loud.
		console.error( `[mwn] Logged in to ${ server } as ${ mwn.state?.lgusername ?? username }` );
		return mwn;
	}

	const mwn = new Mwn( options );
	await mwn.getSiteInfo();
	return mwn;
}

export async function getMwn(): Promise<Mwn> {
	return currentMwnPromise();
}

/**
 * Whether this wiki is configured to log in with a username and password.
 *
 * OAuth wikis are excluded on purpose: their token is sent as a bearer header
 * and never touches the cookie session, so there is no session to lose and
 * nothing for the re-login below to fix. Wikis configured with no credentials
 * at all are excluded because for them an anonymous token is the correct
 * answer, not a symptom.
 *
 * @return {boolean} True if a lost session is worth recovering by logging in again.
 */
function usesPasswordLogin(): boolean {
	const { token, username, password } = wikiService.getCurrent().config;
	return !token && Boolean( username ) && Boolean( password );
}

export type AuthenticatedSession = {
	mwn: Mwn;
	csrfToken: string;
};

/**
 * A client whose session is known good right now, plus the token that proved it.
 *
 * `getMwn()` logs in once and then hands back the same client for the lifetime
 * of the process. MediaWiki expires the session behind it after
 * $wgObjectCacheSessionExpiry — an hour by default — and the client, which
 * holds cookies rather than a persistent credential, has no idea. It keeps
 * making requests, the server keeps treating them as anonymous, and the edit
 * comes back "permissiondenied: limited to users in the group: Users", which
 * reads as a rights problem on the account and sends you off investigating the
 * wrong thing. That cost two separate investigations before it was understood.
 *
 * The recovery deliberately builds a *new* client rather than calling
 * login() on the existing one. mwn's own re-login reuses the cookie jar, and
 * a BotPassword login arriving on a connection that already carries a
 * BotPassword session is refused outright:
 *
 *     Cannot log in when using MediaWiki\Session\BotPasswordSessionProvider sessions.
 *
 * A fresh client starts with an empty jar and cannot hit that. Since the bot
 * authenticates as Magent@magent — a BotPassword — this is not hypothetical.
 *
 * @return {Promise<AuthenticatedSession>} A live client, and a CSRF token
 *   minted under a session confirmed to be authenticated.
 * @throws {Error} If logging in again still leaves the session anonymous.
 */
export async function getAuthenticatedSession(): Promise<AuthenticatedSession> {
	const pending = currentMwnPromise();
	const mwn = await pending;
	const csrfToken = await mwn.getCsrfToken();

	if ( csrfToken !== ANONYMOUS_CSRF_TOKEN || !usesPasswordLogin() ) {
		return { mwn, csrfToken };
	}

	console.error( '[mwn] Session is no longer authenticated; logging in again.' );

	// Only whoever noticed first replaces the client. A second caller that
	// raced into the same stale session finds the cache already moved on and
	// simply waits for the login that is underway, instead of starting another.
	if ( mwnPromise === pending ) {
		clearMwnCache();
	}

	const freshMwn = await currentMwnPromise();
	const freshToken = await freshMwn.getCsrfToken();

	if ( freshToken === ANONYMOUS_CSRF_TOKEN ) {
		throw new Error(
			'Logged in successfully but MediaWiki still reports an anonymous session. ' +
			'The account may have been blocked, or its BotPassword revoked.'
		);
	}

	return { mwn: freshMwn, csrfToken: freshToken };
}

export function clearMwnCache(): void {
	mwnPromise = null;
}
