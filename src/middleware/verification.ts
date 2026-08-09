import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { Middleware, EditContext } from './types.js';
// Imported lazily inside fetchRevisionSource(). Statically, this module sits in
// a cycle — verification -> common/utils -> server -> middleware/index ->
// verification — which only initialises correctly when the app's own entry
// point happens to load first. Deferring it breaks the cycle and lets this
// module be imported on its own, which the wrapper tests rely on.
import type { makeRestGetRequest as MakeRestGetRequest } from '../common/utils.js';
// Leaf module, no imports of its own, so this one is safe to take statically.
import { ContentFormat, getSubEndpoint } from '../common/mwRestApiContentFormat.js';
import type { MwRestApiRevisionObject } from '../types/mwRestApi.js';

/**
 * Namespaces exempt from verification.
 * These contain meta/organizational/discussion content, not factual claims.
 */
const EXEMPT_NAMESPACES = [
	'Template',
	'Talk',
	'User',
	'MediaWiki',
	'Special',
	'Module',
	'Form',
	'PickiPedia'  // Bot config and meta pages
];

/**
 * Fetch the source content of a revision.
 *
 * The endpoint comes from getSubEndpoint() rather than a literal, because the
 * literal is what went wrong: this asked for `/v1/revision/{id}/bare`, which
 * getSubEndpoint maps to ContentFormat.none — metadata, no `source` at all. So
 * every call yielded null, the caller read that as "no previous revision
 * available", and fell back to wrapping the whole page. That is precisely the
 * bug reported in pickipedia#43: an edit adding one template marked every
 * pre-existing paragraph unverified.
 */
async function fetchRevisionSource( revisionId: number ): Promise<string | null> {
	try {
		const { makeRestGetRequest } = await import( '../common/utils.js' ) as
			{ makeRestGetRequest: typeof MakeRestGetRequest };
		const data = await makeRestGetRequest<MwRestApiRevisionObject>(
			`/v1/revision/${ revisionId }${ getSubEndpoint( ContentFormat.source ) }`
		);
		if ( typeof data.source !== 'string' ) {
			// Don't let this fail quietly again. A diff we can't compute is a
			// page we're about to re-wrap wholesale.
			console.error(
				`[verification] Revision ${ revisionId } came back without source; ` +
				`keys: ${ Object.keys( data ).join( ', ' ) }`
			);
			return null;
		}
		return data.source;
	} catch ( error ) {
		console.error( `[verification] Failed to fetch revision ${ revisionId }: ${ error }` );
		return null;
	}
}

/**
 * Strip Bot_proposes wrapper from a line to get the original content.
 * Used for comparing old vs new content.
 */
function stripBotProposes( text: string ): string {
	// Match {{Bot_proposes|content|by=...}} and extract the content
	// Handle escaped pipes ({{!}})
	const match = text.match( /\{\{Bot_proposes\|(.+?)\|by=[^}]+\}\}/i );
	if ( match ) {
		// Unescape pipes
		return match[ 1 ].replace( /\{\{!\}\}/g, '|' );
	}
	return text;
}

/**
 * Normalize a line for comparison purposes.
 * Strips Bot_proposes wrappers and normalizes whitespace.
 */
function normalizeLine( line: string ): string {
	return stripBotProposes( line.trim() ).trim();
}

/**
 * Build a set of normalized paragraphs from content for quick lookup.
 * Handles multi-line paragraphs by joining consecutive non-markup lines.
 *
 * Segmentation here MUST match wrapProseWithBotProposes() exactly, protected
 * regions included. The two functions are the halves of one comparison: this
 * builds what the previous revision said, that decides what is new. Split a
 * paragraph differently on either side and the lookup misses, so unchanged
 * prose gets re-wrapped and previously-verified content silently reverts to
 * unverified — the complaint in pickipedia#43.
 *
 * @param {string} source Wikitext to index.
 * @return {Set<string>} Normalized paragraph and list-item text.
 */
export function buildLineSet( source: string ): Set<string> {
	const lines = source.split( '\n' );
	const protectedLines = computeProtectedLines( lines );
	const set = new Set<string>();
	let currentParagraph: string[] = [];

	const flushParagraph = () => {
		if ( currentParagraph.length > 0 ) {
			const text = currentParagraph.join( ' ' ).trim();
			const normalized = normalizeLine( text );
			if ( normalized ) {
				set.add( normalized );
			}
			currentParagraph = [];
		}
	};

	for ( let i = 0; i < lines.length; i++ ) {
		const line = lines[ i ];
		if ( protectedLines[ i ] || isNonWrappableLine( line ) ) {
			flushParagraph();
			// Don't add markup lines to the set
		} else if ( isListItem( line ) ) {
			flushParagraph();
			// Add list item content
			const match = line.trim().match( /^[*#:;]+\s*(.*)$/ );
			if ( match && match[ 1 ] ) {
				const normalized = normalizeLine( match[ 1 ] );
				if ( normalized ) {
					set.add( normalized );
				}
			}
		} else {
			currentParagraph.push( line );
		}
	}

	flushParagraph();
	return set;
}

/**
 * Check if a page title is in an exempt namespace.
 */
function isExemptNamespace( title: string ): boolean {
	// Check for talk pages (any namespace ending in _talk)
	if ( /_talk:/i.test( title ) ) {
		return true;
	}

	// Check for explicit exempt namespaces
	const colonIndex = title.indexOf( ':' );
	if ( colonIndex === -1 ) {
		// Main namespace - not exempt
		return false;
	}

	const namespace = title.substring( 0, colonIndex );
	return EXEMPT_NAMESPACES.some( ns =>
		namespace.toLowerCase() === ns.toLowerCase()
	);
}

/**
 * Templates that support the status parameter.
 * When content starts with one of these, we inject status=proposed.
 */
const TEMPLATES_WITH_STATUS = [
	'Show',
	'Venue',
	'Scene',
	'Artist',
	'Song',
	'Album'
];

/**
 * Check if content already has verification markers.
 */
function hasVerificationMarkers( source: string ): boolean {
	// Check for Bot_proposes template
	if ( /\{\{Bot_proposes/i.test( source ) ) {
		return true;
	}

	// Check for status=proposed or status=unverified
	if ( /\|\s*status\s*=\s*(proposed|unverified)/i.test( source ) ) {
		return true;
	}

	return false;
}

/**
 * Check if a line/text has already been verified (not just proposed).
 * Verified content should not be re-wrapped.
 */
function isAlreadyVerified( text: string ): boolean {
	// Check for {{verified|...}} or {{source|...}} templates
	return /\{\{(verified|source)\s*\|/i.test( text );
}

/**
 * Check if content uses a template that supports status parameter.
 * Returns the template name if found, null otherwise.
 */
function getTemplateWithStatus( source: string ): string | null {
	for ( const template of TEMPLATES_WITH_STATUS ) {
		// Match {{Template at start of content (with optional whitespace)
		const regex = new RegExp( `^\\s*\\{\\{${ template }\\s*[\\n|]`, 'i' );
		if ( regex.test( source ) ) {
			return template;
		}
	}
	return null;
}

/**
 * Check if a specific template already has status=proposed.
 */
function templateHasProposedStatus( source: string, template: string ): boolean {
	// Look for the template followed eventually by |status=proposed before the closing }}
	const regex = new RegExp(
		`\\{\\{${ template }[^}]*\\|\\s*status\\s*=\\s*proposed`,
		'i'
	);
	return regex.test( source );
}

/**
 * Inject status=proposed into a template at the start of content.
 */
function injectTemplateStatus( source: string, template: string ): string {
	// Check if this specific template already has status=proposed
	if ( templateHasProposedStatus( source, template ) ) {
		return source; // Already has it, don't double-inject
	}
	// Insert status=proposed after the template opening
	const regex = new RegExp( `(^\\s*\\{\\{${ template }\\s*\\n)`, 'i' );
	return source.replace( regex, `$1|status=proposed\n` );
}

/**
 * Find the end of a template block (matching closing }}).
 */
function findTemplateEnd( source: string, startIndex: number ): number {
	let depth = 0;
	let i = startIndex;

	while ( i < source.length - 1 ) {
		if ( source[ i ] === '{' && source[ i + 1 ] === '{' ) {
			depth++;
			i += 2;
		} else if ( source[ i ] === '}' && source[ i + 1 ] === '}' ) {
			depth--;
			if ( depth === 0 ) {
				return i + 2; // Return position after the closing }}
			}
			i += 2;
		} else {
			i++;
		}
	}
	return source.length; // Template not closed, return end of string
}

/**
 * Check if a line is wikitext markup that shouldn't be wrapped at all.
 * Note: List items (*, #) are handled separately - their content gets wrapped.
 */
function isNonWrappableLine( line: string ): boolean {
	const trimmed = line.trim();
	return (
		trimmed === '' ||
		trimmed.startsWith( '==' ) || // Headings
		trimmed.startsWith( '[[Category:' ) ||
		trimmed.startsWith( '{{' ) || // Templates
		trimmed === '}}' || // Template close on its own line
		trimmed.startsWith( '|}' ) || // Table end
		trimmed.startsWith( '{|' ) || // Table start
		trimmed.startsWith( '|' ) || // Table row
		trimmed.startsWith( '!' ) // Table header
	);
}

/**
 * Tags whose contents are verbatim wikitext and must never be rewritten.
 * ASCII art in <pre> is the case that keeps biting us.
 */
const PROTECTED_TAGS = [ 'pre', 'nowiki', 'syntaxhighlight', 'source', 'poem', 'math' ];

/**
 * Open/close matchers per protected tag, compiled once from the constant list
 * above rather than rebuilt per line.
 */
const PROTECTED_TAG_PATTERNS: { tag: string; open: RegExp; close: RegExp }[] =
	PROTECTED_TAGS.map( ( tag ) => ( {
		tag,
		// eslint-disable-next-line security/detect-non-literal-regexp -- built from the constant list above
		open: new RegExp( `<${ tag }(\\s[^>]*)?>`, 'i' ),
		// eslint-disable-next-line security/detect-non-literal-regexp -- built from the constant list above
		close: new RegExp( `</${ tag }\\s*>`, 'i' )
	} ) );

/**
 * Count non-overlapping occurrences of a substring.
 *
 * @param {string} haystack String to search.
 * @param {string} needle Substring to count.
 * @return {number} Number of occurrences.
 */
function countOccurrences( haystack: string, needle: string ): number {
	return haystack.split( needle ).length - 1;
}

/**
 * If this line opens a protected tag it doesn't also close, return the tag name.
 *
 * @param {string} line Single line of wikitext.
 * @return {string|null} Tag name left open by this line, or null.
 */
function openedProtectedTag( line: string ): string | null {
	for ( const { tag, open, close } of PROTECTED_TAG_PATTERNS ) {
		if ( open.test( line ) && !close.test( line ) ) {
			return tag;
		}
	}
	return null;
}

/**
 * Closing matcher for a tag known to be in PROTECTED_TAGS.
 *
 * @param {string} tag Tag name.
 * @return {RegExp} Matcher for that tag's closing form.
 */
function closingPatternFor( tag: string ): RegExp {
	const entry = PROTECTED_TAG_PATTERNS.find( ( p ) => p.tag === tag );
	// Every caller passes a tag that came out of openedProtectedTag().
	return entry!.close;
}

/**
 * Mark lines that belong to a multi-line region and must be passed through
 * untouched.
 *
 * isNonWrappableLine() judges each line on its own, which is fine for a
 * heading or a table row but wrong for anything spanning lines. Two cases
 * broke real pages:
 *
 * - Content inside <pre> looks like prose line by line, so ASCII art was
 *   wrapped and destroyed.
 * - A template parameter whose value runs over several lines (say
 *   `| image = <pre>` with art beneath it) got a {{Bot_proposes}} injected
 *   into the middle of the template call, which shattered the whole
 *   infobox — see Cryptograss:Delivery-kid.
 *
 * A bare `}}` closing line is prose by the line-at-a-time test too, and
 * wrapping that swallows it into the parameter, where it closes the
 * Bot_proposes call early and spills the rest as literal text.
 *
 * @param {string[]} lines Source split on newlines.
 * @return {boolean[]} Array parallel to `lines`; true means "leave this line alone".
 */
export function computeProtectedLines( lines: string[] ): boolean[] {
	const protectedLines: boolean[] = new Array( lines.length ).fill( false );
	let openTag: string | null = null;
	let braceDepth = 0;

	for ( let i = 0; i < lines.length; i++ ) {
		const line = lines[ i ];

		// Inside <pre> and friends, through and including the closing tag.
		if ( openTag ) {
			protectedLines[ i ] = true;
			if ( closingPatternFor( openTag ).test( line ) ) {
				openTag = null;
			}
			continue;
		}

		// Inside an unclosed template, through and including the line that
		// finally balances the braces.
		if ( braceDepth > 0 ) {
			protectedLines[ i ] = true;
		}

		const opened = openedProtectedTag( line );
		if ( opened ) {
			protectedLines[ i ] = true;
			openTag = opened;
		}

		braceDepth += countOccurrences( line, '{{' ) - countOccurrences( line, '}}' );
		if ( braceDepth < 0 ) {
			// Unbalanced source; don't let a stray }} protect the rest of the page.
			braceDepth = 0;
		}
		if ( braceDepth > 0 ) {
			protectedLines[ i ] = true;
		}
	}

	return protectedLines;
}

/**
 * Check if a line is a list item (bullet or numbered).
 */
function isListItem( line: string ): boolean {
	const trimmed = line.trim();
	return (
		trimmed.startsWith( '*' ) ||
		trimmed.startsWith( '#' ) ||
		trimmed.startsWith( ':' ) ||
		trimmed.startsWith( ';' )
	);
}

/**
 * Wrap the content of a list item with Bot_proposes.
 * Preserves the list prefix (* or # etc) and wraps the rest.
 * Only wraps if the content is not in the existingLines set.
 */
function wrapListItemContent( line: string, existingLines?: Set<string> ): string {
	const trimmed = line.trim();

	// Find the list prefix (may be multiple chars like ** or **)
	const match = trimmed.match( /^([*#:;]+)\s*(.*)$/ );
	if ( !match ) {
		return line;
	}

	const prefix = match[ 1 ];
	const content = match[ 2 ];

	// Don't wrap if empty, already wrapped, or already verified
	if ( !content || content.startsWith( '{{Bot_proposes' ) || isAlreadyVerified( content ) ) {
		return line;
	}

	// Don't wrap if it's just a wikilink with no descriptive text
	// e.g., "* [[Justin Holmes]]" - just a name link, not a claim
	if ( /^\[\[[^\]]+\]\]$/.test( content ) ) {
		return line;
	}

	// Don't wrap if this content existed in the previous revision
	if ( existingLines && existingLines.has( normalizeLine( content ) ) ) {
		return line;
	}

	// Escape pipes and wrap the content
	const escaped = content.replace( /\|/g, '{{!}}' );
	return `${ prefix } {{Bot_proposes|${ escaped }|by=Magent}}`;
}

/**
 * Wrap prose paragraphs and list items with Bot_proposes.
 * Only wraps content that is NOT in the existingLines set (i.e., new or changed content).
 */
export function wrapProseWithBotProposes( source: string, existingLines?: Set<string> ): string {
	const lines = source.split( '\n' );
	const protectedLines = computeProtectedLines( lines );
	const result: string[] = [];
	let currentParagraph: string[] = [];

	const flushParagraph = () => {
		if ( currentParagraph.length > 0 ) {
			const text = currentParagraph.join( ' ' ).trim();
			if ( text && !text.startsWith( '{{Bot_proposes' ) && !isAlreadyVerified( text ) ) {
				// Check if this paragraph existed in the previous revision
				const normalizedText = normalizeLine( text );
				if ( existingLines && existingLines.has( normalizedText ) ) {
					// Content existed before - don't wrap it
					result.push( text );
				} else {
					// New content - wrap it
					const escaped = text.replace( /\|/g, '{{!}}' );
					result.push( `{{Bot_proposes|${ escaped }|by=Magent}}` );
				}
			} else if ( text ) {
				result.push( text );
			}
			currentParagraph = [];
		}
	};

	for ( let i = 0; i < lines.length; i++ ) {
		const line = lines[ i ];
		if ( protectedLines[ i ] || isNonWrappableLine( line ) ) {
			// Multi-line regions, headings, categories, templates, tables - don't wrap
			flushParagraph();
			result.push( line );
		} else if ( isListItem( line ) ) {
			// List items - wrap the content after the prefix
			flushParagraph();
			result.push( wrapListItemContent( line, existingLines ) );
		} else {
			// It's prose - accumulate into current paragraph
			currentParagraph.push( line );
		}
	}

	flushParagraph();
	return result.join( '\n' );
}

/**
 * Apply verification to content.
 * If existingLines is provided, only new/changed content gets wrapped.
 */
function applyVerification( source: string, existingLines?: Set<string> ): string {
	const template = getTemplateWithStatus( source );

	if ( template ) {
		// Inject status=proposed into the template
		let modified = injectTemplateStatus( source, template );

		// Find where the template ends
		const templateStart = modified.search( /\{\{/i );
		if ( templateStart !== -1 ) {
			const templateEnd = findTemplateEnd( modified, templateStart );
			const beforeTemplate = modified.substring( 0, templateStart );
			const templateContent = modified.substring( templateStart, templateEnd );
			const afterTemplate = modified.substring( templateEnd );

			// Wrap any prose after the template
			if ( afterTemplate.trim() ) {
				const wrappedAfter = wrapProseWithBotProposes( afterTemplate, existingLines );
				modified = beforeTemplate + templateContent + wrappedAfter;
			}
		}

		return modified;
	}

	// No recognized template - wrap all prose with Bot_proposes
	return wrapProseWithBotProposes( source, existingLines );
}

/**
 * Verification middleware.
 *
 * Automatically injects status=proposed or {{Bot_proposes}} for all edits,
 * ensuring bot content goes through the verification workflow.
 *
 * Exempt namespaces (Template, Talk, User, MediaWiki, Special, *_talk)
 * are not modified.
 */
export const verificationMiddleware: Middleware = {
	name: 'verification',

	async onInput( context: EditContext ): Promise<EditContext> {
		// Check if this namespace is exempt from verification
		if ( isExemptNamespace( context.title ) ) {
			console.error( `[verification] ${ context.title }: exempt namespace, skipping` );
			return context;
		}

		// For updates, fetch the previous revision to do diff-based verification
		let existingLines: Set<string> | undefined;
		if ( context.tool === 'update-page' && context.latestId ) {
			const previousSource = await fetchRevisionSource( context.latestId );
			if ( previousSource ) {
				existingLines = buildLineSet( previousSource );
				console.error( `[verification] ${ context.title }: fetched ${ existingLines.size } lines from revision ${ context.latestId } for diff comparison` );
			} else {
				console.error( `[verification] ${ context.title }: could not fetch previous revision, will wrap all content` );
			}
		}

		// Apply verification to non-exempt content
		const modifiedSource = applyVerification( context.source, existingLines );

		// Log what we did
		if ( modifiedSource !== context.source ) {
			const template = getTemplateWithStatus( context.source );
			if ( template ) {
				console.error( `[verification] ${ context.title }: injected status=proposed into ${ template } template and wrapped new prose` );
			} else {
				console.error( `[verification] ${ context.title }: wrapped new prose with Bot_proposes` );
			}
		} else {
			console.error( `[verification] ${ context.title }: no modification needed` );
		}

		return {
			...context,
			source: modifiedSource
		};
	},

	async onOutput( context: EditContext, result: CallToolResult ): Promise<CallToolResult> {
		// Only add verification note if this namespace is NOT exempt
		// (exempt namespaces don't go through verification workflow)
		if ( !result.isError && result.content && !isExemptNamespace( context.title ) ) {
			const note: TextContent = {
				type: 'text',
				text: '⚠️ This edit was automatically marked as "proposed" and requires human verification.'
			};
			return {
				...result,
				content: [ ...result.content, note ]
			};
		}
		return result;
	}
};
