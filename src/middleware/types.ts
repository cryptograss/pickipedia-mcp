import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Context for page edit operations (create/update).
 * Passed through the middleware pipeline.
 */
export interface EditContext {
	tool: 'create-page' | 'update-page';
	title: string;
	source: string;
	comment?: string;
	contentModel?: string;
	latestId?: number;  // For updates
}

/**
 * Middleware interface for the onion architecture.
 *
 * Each middleware can transform input before it reaches the wiki API,
 * and transform output before it's returned to the client.
 */
export interface Middleware {
	name: string;

	/**
	 * Transform the edit context before sending to wiki.
	 * Return modified context, or same context if no changes.
	 */
	onInput?: ( context: EditContext ) => Promise<EditContext>;

	/**
	 * Transform/augment the result after wiki responds.
	 * Can add annotations, warnings, etc.
	 */
	onOutput?: ( context: EditContext, result: CallToolResult ) => Promise<CallToolResult>;
}
