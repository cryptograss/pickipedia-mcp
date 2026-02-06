import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { Middleware, EditContext } from './types.js';
import { makeRestGetRequest } from '../common/utils.js';
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
	'PickiPedia'  // Bot config and meta pages
];

/**
 * Fetch the source content of a revision.
 */
async function fetchRevisionSource( revisionId: number ): Promise<string | null> {
	try {
		const data = await makeRestGetRequest<MwRestApiRevisionObject>(
			`/v1/revision/${ revisionId }/bare`
		);
		return data.source ?? null;
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
 * Build a set of normalized lines from content for quick lookup.
 */
function buildLineSet( source: string ): Set<string> {
	const lines = source.split( '\n' );
	const set = new Set<string>();
	for ( const line of lines ) {
		const normalized = normalizeLine( line );
		if ( normalized ) {
			set.add( normalized );
		}
	}
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
		trimmed.startsWith( '|}' ) || // Table end
		trimmed.startsWith( '{|' ) || // Table start
		trimmed.startsWith( '|' ) || // Table row
		trimmed.startsWith( '!' ) // Table header
	);
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
function wrapProseWithBotProposes( source: string, existingLines?: Set<string> ): string {
	const lines = source.split( '\n' );
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

	for ( const line of lines ) {
		if ( isNonWrappableLine( line ) ) {
			// Headings, categories, templates, tables - don't wrap
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
