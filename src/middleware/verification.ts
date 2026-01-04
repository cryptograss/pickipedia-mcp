import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { Middleware, EditContext } from './types.js';

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
 * Inject status=proposed into content.
 */
function injectProposedStatus( source: string ): string {
	const template = getTemplateWithStatus( source );

	if ( template ) {
		// Insert status=proposed after the template opening
		const regex = new RegExp( `(^\\s*\\{\\{${ template }\\s*\\n)`, 'i' );
		return source.replace( regex, `$1|status=proposed\n` );
	}

	// No recognized template - wrap with Bot_proposes
	return `{{Bot_proposes}}\n${ source }`;
}

/**
 * Verification middleware.
 *
 * Automatically injects status=proposed or {{Bot_proposes}} for all edits,
 * ensuring bot content goes through the verification workflow.
 */
export const verificationMiddleware: Middleware = {
	name: 'verification',

	async onInput( context: EditContext ): Promise<EditContext> {
		// Skip if already has verification markers
		if ( hasVerificationMarkers( context.source ) ) {
			console.error( `[verification] ${ context.title }: already has verification markers` );
			return context;
		}

		// Inject proposed status
		const modifiedSource = injectProposedStatus( context.source );
		console.error( `[verification] ${ context.title }: injected status=proposed` );

		return {
			...context,
			source: modifiedSource
		};
	},

	async onOutput( context: EditContext, result: CallToolResult ): Promise<CallToolResult> {
		// Add a note to the output indicating verification was applied
		if ( !result.isError && result.content ) {
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
