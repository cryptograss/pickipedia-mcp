#!/usr/bin/env node
/**
 * Checks for the bot-edit verification middleware.
 *
 * Run against the compiled output: `npm test`.
 *
 * The cases here are all things that broke real pages on pickipedia.xyz, so
 * they're worth keeping honest.
 */

import { readFile } from 'node:fs/promises';
import { wrapProseWithBotProposes, computeProtectedLines, buildLineSet, buildBlockSet } from
	'../dist/middleware/verification.js';
import { ContentFormat, getSubEndpoint } from
	'../dist/common/mwRestApiContentFormat.js';

let failures = 0;

function check( name, condition, detail = '' ) {
	if ( condition ) {
		console.log( `  ok   ${ name }` );
	} else {
		failures++;
		console.log( `  FAIL ${ name }${ detail ? '\n       ' + detail : '' }` );
	}
}

// The exact shape that shattered Cryptograss:Delivery-kid's infobox: a template
// whose parameter value is a multi-line <pre> block.
const infoboxWithArt = `{{Infobox resource
| image = <pre style="font-size:5px;">
  .-----.
 (  o o  )
  '-----'
</pre>
| role = the distributor
| type = Server
| namesake = [[wikipedia:The_Pizza_Tapes|The kid who leaked the pizza tapes]]
}}

delivery-kid is the official seedbox configuration of cryptograss.

===Releases===
* [[Special:Releases]]
* Some claim about releases that should get wrapped.`;

console.log( '\nInfobox with multi-line <pre> art:' );
const out = wrapProseWithBotProposes( infoboxWithArt );

check( 'ASCII art survives untouched', out.includes( '  .-----.\n (  o o  )\n  \'-----\'' ) );
check( 'no wrapper injected inside the template',
	!out.split( '\n}}' )[ 0 ].includes( '{{Bot_proposes' ),
	out.split( '\n' ).slice( 0, 10 ).join( '\n' ) );
check( 'infobox params untouched', out.includes( '| role = the distributor' ) );
check( 'namesake pipe not escaped to {{!}}', out.includes( '[[wikipedia:The_Pizza_Tapes|The kid' ) );
check( 'closing }} left alone', /\n\}\}\n/.test( out ) );
check( 'prose after the template still gets wrapped',
	out.includes( '{{Bot_proposes|delivery-kid is the official seedbox' ) );
check( 'heading untouched', out.includes( '===Releases===' ) );
check( 'bare wikilink list item not wrapped', out.includes( '* [[Special:Releases]]' ) );
check( 'descriptive list item still wrapped',
	out.includes( '* {{Bot_proposes|Some claim about releases' ) );

console.log( '\nStandalone <pre> block:' );
const banner = `Intro prose here.

<pre>
 ___  ___
|   ||   |
</pre>

Closing prose here.`;
const bannerOut = wrapProseWithBotProposes( banner );
check( 'art inside pre survives', bannerOut.includes( '|   ||   |' ) );
check( 'pipes in art not escaped', !bannerOut.includes( '{{!}}   {{!}}{{!}}' ) );
check( 'prose before pre wrapped', bannerOut.includes( '{{Bot_proposes|Intro prose here.' ) );
check( 'prose after pre wrapped', bannerOut.includes( '{{Bot_proposes|Closing prose here.' ) );

console.log( '\nOrdinary prose (unchanged behaviour):' );
const plain = 'A claim about a banjo.\n\nAnother claim entirely.';
const plainOut = wrapProseWithBotProposes( plain );
check( 'both paragraphs wrapped',
	( plainOut.match( /\{\{Bot_proposes\|/g ) || [] ).length === 2, plainOut );

console.log( '\nUnbalanced braces:' );
const strayOut = wrapProseWithBotProposes( 'Prose one.\n}}\nProse two.' );
check( 'stray }} does not swallow following prose',
	strayOut.includes( '{{Bot_proposes|Prose two.' ), strayOut );

const unclosedOut = wrapProseWithBotProposes(
	'{{Broken\n| a = 1\nProse that follows an unclosed template.'
);
check( 'unclosed template protects rather than mangles',
	!unclosedOut.includes( '{{Bot_proposes' ), unclosedOut );

// buildLineSet() and wrapProseWithBotProposes() are two halves of one
// comparison. If they segment paragraphs differently, the lookup misses and
// unchanged prose is re-marked unverified — pickipedia#43.
console.log( '\nDiff round-trip across a <pre> block:' );
const previousRevision = `Verified prose above the block.

<pre>
 ___  ___
|   ||   |
</pre>

Verified prose below the block.`;

const editedRevision = previousRevision + '\n\nA brand new claim just added.';
const roundTrip = wrapProseWithBotProposes(
	editedRevision, buildLineSet( previousRevision ), buildBlockSet( previousRevision ) );

check( 'unchanged prose above <pre> not re-wrapped',
	roundTrip.includes( 'Verified prose above the block.' ) &&
	!roundTrip.includes( '{{Bot_proposes|Verified prose above' ), roundTrip );
check( 'unchanged prose below <pre> not re-wrapped',
	!roundTrip.includes( '{{Bot_proposes|Verified prose below' ), roundTrip );
check( 'newly added prose IS wrapped',
	roundTrip.includes( '{{Bot_proposes|A brand new claim just added.' ), roundTrip );
check( 'art still intact after a diff-aware pass', roundTrip.includes( '|   ||   |' ) );

console.log( '\nDiff round-trip across a multi-line template:' );
const prevInfobox = `{{Infobox resource
| role = the distributor
}}

Verified prose after the infobox.`;
const editedInfobox = prevInfobox + '\n\nAnother new claim.';
const infoboxTrip = wrapProseWithBotProposes(
	editedInfobox, buildLineSet( prevInfobox ), buildBlockSet( prevInfobox ) );

check( 'unchanged prose after infobox not re-wrapped',
	!infoboxTrip.includes( '{{Bot_proposes|Verified prose after' ), infoboxTrip );
check( 'new claim after infobox IS wrapped',
	infoboxTrip.includes( '{{Bot_proposes|Another new claim.' ), infoboxTrip );

// pickipedia#43's root cause was not the wrapping logic at all — it was asking
// the wrong REST endpoint for the previous revision. `/v1/revision/{id}/bare`
// returns metadata with no `source` field, so the fetch always resolved to
// null, the diff was always skipped, and every edit re-wrapped the whole page.
// It failed silently for months. Assert the endpoint directly.
console.log( '\nPrevious-revision endpoint:' );
// tsc keeps JSDoc, and the comment on fetchRevisionSource names the bad
// endpoint on purpose. Strip comments so this reads code, not prose.
const compiled = ( await readFile(
	new URL( '../dist/middleware/verification.js', import.meta.url ), 'utf8'
) ).replace( /\/\*[\s\S]*?\*\//g, '' ).replace( /^\s*\/\/.*$/gm, '' );
check( 'does not request the bare (metadata-only) revision endpoint',
	!/\/bare/.test( compiled ),
	'`/bare` omits `source`; the diff silently degrades to wrapping everything' );
check( 'still requests a revision endpoint',
	/v1\/revision\//.test( compiled ) );
check( 'source endpoint resolves to the empty suffix',
	getSubEndpoint( ContentFormat.source ) === '' &&
	getSubEndpoint( ContentFormat.none ) === '/bare',
	`source=${ JSON.stringify( getSubEndpoint( ContentFormat.source ) ) }` );

// The edit from the bug report itself, replayed. Fixtures are revision 1982 of
// "Water tower" (the state before) and the source Magent submitted as revision
// 1983 — reconstructed by unwrapping what the middleware actually saved. That
// edit added one {{Ensemble}} template and nothing else, yet it came back with
// all five pre-existing paragraphs marked unverified.
console.log( '\npickipedia#43, replayed:' );
const fixture = ( name ) => readFile(
	new URL( `./fixtures/pickipedia-43-${ name }.wikitext`, import.meta.url ), 'utf8'
);
const [ prevRev, submitted ] = await Promise.all( [ fixture( 'previous' ), fixture( 'edit' ) ] );
const replayed = wrapProseWithBotProposes(
	submitted, buildLineSet( prevRev ), buildBlockSet( prevRev ) );

check( 'adding one template wraps nothing else',
	!replayed.includes( '{{Bot_proposes' ),
	replayed );
check( 'no pipes mangled to {{!}}',
	!replayed.includes( '{{!}}' ),
	replayed );
// Before pickipedia-mcp#15 this asserted byte-identical output, because the
// added {{Ensemble}} was left unmarked — which is why the wiki then refused
// the edit for carrying no verification marker at all. Marking it is the fix,
// so what must hold now is narrower: the prose is untouched, and exactly the
// one template this edit introduced is marked.
check( 'the {{Ensemble}} this edit adds IS marked',
	replayed.includes( '<proposed by="Magent">' ) &&
	replayed.includes( '|Kenny Feinstein' ), replayed );
check( 'only that one template is marked',
	( replayed.match( /<proposed/g ) || [] ).length === 1, replayed );
check( 'the {{BandInfo}} that was already there is not marked',
	/<proposed by="Magent">\n\{\{Ensemble/.test( replayed ), replayed );
check( 'every pre-existing paragraph survives verbatim',
	[ 'Water Tower plays bluegrass but crappy.',
		'They started as a Foghorn Stringband tribute band in 2003.',
		'This band loves Foghorn so much' ].every( ( t ) => replayed.includes( t ) ),
	replayed );
// Keeps the fixture honest: run the same input with no previous revision and
// the original bug must come back. Asserted by naming the damage rather than
// counting wrappers, so reflowing the fixture can't quietly satisfy it.
const undiffed = wrapProseWithBotProposes( submitted );
check( 'and without the diff it reproduces the reported damage',
	undiffed.includes( '{{Bot_proposes|Water Tower plays bluegrass but crappy.' ) &&
	undiffed.includes( '{{Bot_proposes|They started as a Foghorn Stringband' ),
	undiffed );

console.log( '\nDirect region marking:' );
const marks = computeProtectedLines( [ 'plain', '{{T', '| x = 1', '}}', 'plain again' ] );
check( 'template body and closer marked, plain lines not',
	JSON.stringify( marks ) === JSON.stringify( [ false, true, true, true, false ] ),
	JSON.stringify( marks ) );


// pickipedia-mcp#15: a bot edit that adds only a template used to produce no
// marker at all, so the claim escaped review and the wiki refused the edit
// (cryptograss/pickipedia#85). The podcast firehose (pickipedia#38) is entirely
// this shape: an infobox and semantic annotations, no prose.
console.log( '\nMarking new template calls:' );
const episode = `{{PodcastEpisode
|podcast=Bluegrass Jam Along
|guest=Molly Tuttle
|date=2025-01-15
}}`;
const prevPage = 'Some verified prose about the podcast.';
const added = wrapProseWithBotProposes(
	prevPage + '\n\n' + episode, buildLineSet( prevPage ), buildBlockSet( prevPage ) );

check( 'a newly added template call is marked',
	added.includes( '<proposed by="Magent">' ), added );
check( 'the template itself is untouched inside the tag',
	added.includes( '|guest=Molly Tuttle' ) && !added.includes( '{{!}}' ), added );
check( 'the tag wraps the whole call, not each line',
	( added.match( /<proposed/g ) || [] ).length === 1, added );
check( 'unchanged prose beside it is not re-wrapped',
	!added.includes( '{{Bot_proposes|Some verified prose' ), added );

const unchanged = wrapProseWithBotProposes(
	prevPage + '\n\n' + episode + '\n\nA new sentence.',
	buildLineSet( prevPage + '\n\n' + episode ),
	buildBlockSet( prevPage + '\n\n' + episode ) );
check( 'a template already on the page is NOT re-marked',
	!unchanged.includes( '<proposed' ), unchanged );
check( 'but new prose alongside it still is',
	unchanged.includes( '{{Bot_proposes|A new sentence.' ), unchanged );

console.log( '\nWhat must NOT be marked:' );
const q = 'Intro.\n\n{{#ask: [[Has venue::The Station Inn]]\n|?Has artist\n}}';
check( 'a parser function is furniture, not a claim',
	!wrapProseWithBotProposes( q, buildLineSet( 'Intro.' ), buildBlockSet( 'Intro.' ) )
		.includes( '<proposed' ) );
check( 'a heading is not marked',
	!wrapProseWithBotProposes( '== Shows ==', undefined, new Set() ).includes( '<proposed' ) );
check( 'a bare category is not marked',
	!wrapProseWithBotProposes( '[[Category:Shows]]', undefined, new Set() ).includes( '<proposed' ) );
check( 'an already-marked call is not double-marked',
	!wrapProseWithBotProposes(
		'<proposed by="Magent">\n{{Ensemble|Kenny}}\n</proposed>', undefined, new Set()
	).includes( '<proposed by="Magent">\n<proposed' ) );
check( 'a template that supports status gets status=proposed, not the tag',
	( () => {
		const out = wrapProseWithBotProposes( '{{Show\n|artists=Billy Strings\n}}', undefined, new Set() );
		return out.includes( 'status=proposed' ) && !out.includes( '<proposed' );
	} )() );

console.log( '\nBlock segmentation:' );
check( 'a template does not swallow the paragraph after it',
	wrapProseWithBotProposes(
		'{{Infobox\n| a = 1\n}}\nProse right after.', undefined, new Set()
	).includes( '{{Bot_proposes|Prose right after.' ),
	wrapProseWithBotProposes( '{{Infobox\n| a = 1\n}}\nProse right after.', undefined, new Set() ) );
check( 'buildBlockSet and the wrapper agree on block boundaries',
	buildBlockSet( episode ).size === 1, JSON.stringify( [ ...buildBlockSet( episode ) ] ) );

console.log( failures === 0 ? '\nAll checks passed.\n' : `\n${ failures } FAILED\n` );
process.exit( failures === 0 ? 0 : 1 );
