#!/usr/bin/env node
/**
 * Checks for the bot-edit verification middleware.
 *
 * Run against the compiled output: `npm test`.
 *
 * The cases here are all things that broke real pages on pickipedia.xyz, so
 * they're worth keeping honest.
 */

import { wrapProseWithBotProposes, computeProtectedLines } from
	'../dist/middleware/verification.js';

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

console.log( '\nDirect region marking:' );
const marks = computeProtectedLines( [ 'plain', '{{T', '| x = 1', '}}', 'plain again' ] );
check( 'template body and closer marked, plain lines not',
	JSON.stringify( marks ) === JSON.stringify( [ false, true, true, true, false ] ),
	JSON.stringify( marks ) );

console.log( failures === 0 ? '\nAll checks passed.\n' : `\n${ failures } FAILED\n` );
process.exit( failures === 0 ? 0 : 1 );
