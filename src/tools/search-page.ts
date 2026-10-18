// TODO: Make tools into an interface
import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { wikiService } from '../common/wikiService.js';
import { makeRestGetRequest } from '../common/utils.js';
import { getMwn } from '../common/mwn.js';
import type { MwRestApiSearchPageResponse, MwRestApiSearchResultObject } from '../types/mwRestApi.js';

export function searchPageTool( server: McpServer ): RegisteredTool {
	// TODO: Not having named parameters is a pain,
	// but using low-level Server type or using a wrapper function are addedd complexity
	return server.tool(
		'search-page',
		'Search wiki page titles and contents for the provided search terms, and returns matching pages. ' +
			'Give a namespace or a title prefix (e.g. "Agent:Magent/" for magent\'s notes) to search only there; ' +
			'each result then carries a snippet of the match and when the page was last edited.',
		{
			query: z.string().describe( 'Search terms' ),
			limit: z.number().int().min( 1 ).max( 100 ).optional().describe( 'Maximum number of search results to return' ),
			namespace: z.number().int().nonnegative().optional().describe( 'Search only this namespace (by number: 3010 is Agent)' ),
			prefix: z.string().optional().describe( 'Search only pages whose full title starts with this, e.g. "Agent:Magent/"' )
		},
		{
			title: 'Search page',
			readOnlyHint: true,
			destructiveHint: false
		} as ToolAnnotations,
		async ( { query, limit, namespace, prefix } ) => ( namespace !== undefined || prefix ?
			handleScopedSearch( query, limit ?? 10, namespace, prefix ) :
			handleSearchPageTool( query, limit ) )
	);
}

/**
 * A search kept to one namespace, or to the pages under one title: an
 * agent's notes (Agent:Magent/...) among a wiki of articles. The REST search
 * the plain tool uses takes no namespace and returns no snippet, so this goes
 * through the action API, asking for a full-text search explicitly: without
 * srwhat=text PickiPedia's search backend matched nothing at all (2026-10-18).
 *
 * @param {string} query Search terms.
 * @param {number} limit Results to return at most.
 * @param {number|undefined} namespace Namespace number, or taken from the prefix.
 * @param {string|undefined} prefix Full-title prefix, e.g. "Agent:Magent/".
 * @return {Promise<CallToolResult>}
 */
async function handleScopedSearch(
	query: string, limit: number, namespace?: number, prefix?: string
): Promise< CallToolResult > {
	let lines: string[];
	try {
		const mwn = await getMwn();
		let wanted = '';
		if ( prefix ) {
			const slash = prefix.endsWith( '/' );
			const title = mwn.Title.newFromText( slash ? prefix.slice( 0, -1 ) : prefix );
			if ( !title ) {
				throw new Error( `"${ prefix }" is not a title prefix` );
			}
			namespace = namespace ?? title.getNamespaceId();
			wanted = title.toText() + ( slash ? '/' : '' );
		}
		// Filtering by prefix happens here, so ask for as many as the wiki gives.
		const results = await mwn.search( query, prefix ? 'max' : limit, [ 'snippet', 'timestamp' ],
			{ srwhat: 'text', srnamespace: namespace } );
		lines = results.filter( ( r ) => !wanted || r.title.startsWith( wanted ) ).slice( 0, limit )
			.map( ( r ) => [
				`Title: ${ r.title }`,
				`Last edited: ${ r.timestamp }`,
				`Snippet: ${ plainSnippet( r.snippet ) }`
			].join( '\n' ) );
	} catch ( error ) {
		return {
			content: [ { type: 'text', text: `Failed to search: ${ ( error as Error ).message }` } as TextContent ],
			isError: true
		};
	}
	if ( lines.length === 0 ) {
		return {
			content: [ { type: 'text', text: `No pages found for ${ query }` +
				( prefix ? ` under ${ prefix }` : ` in namespace ${ namespace }` ) } as TextContent ]
		};
	}
	return { content: lines.map( ( text ) => ( { type: 'text', text } as TextContent ) ) };
}

/**
 * A search snippet as text: the wiki marks matches with spans and escapes
 * the rest as HTML.
 *
 * @param {string} html The snippet as the API returns it.
 * @return {string}
 */
export function plainSnippet( html: string ): string {
	return html
		.replace( /<span class="searchmatch">(.*?)<\/span>/g, '**$1**' )
		.replace( /<[^>]*>/g, '' )
		.replace( /&quot;/g, '"' ).replace( /&#0?39;/g, "'" ).replace( /&lt;/g, '<' ).replace( /&gt;/g, '>' )
		.replace( /&amp;/g, '&' )
		.replace( /\s+/g, ' ' ).trim();
}

async function handleSearchPageTool( query: string, limit?: number ): Promise< CallToolResult > {
	let data: MwRestApiSearchPageResponse;
	try {
		data = await makeRestGetRequest<MwRestApiSearchPageResponse>(
			'/v1/search/page',
			{ q: query, ...( limit ? { limit: limit.toString() } : {} ) }
		);
	} catch ( error ) {
		return {
			content: [
				{ type: 'text', text: `Failed to retrieve search data: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	}

	const pages = data.pages || [];
	if ( pages.length === 0 ) {
		return {
			content: [
				{ type: 'text', text: `No pages found for ${ query }` } as TextContent
			]
		};
	}

	return {
		content: pages.map( getSearchResultToolResult )
	};
}

// TODO: Decide how to handle the tool's result
function getSearchResultToolResult( result: MwRestApiSearchResultObject ): TextContent {
	const { server, articlepath } = wikiService.getCurrent().config;
	return {
		type: 'text',
		text: [
			`Title: ${ result.title }`,
			`Description: ${ result.description ?? 'Not available' }`,
			`Page ID: ${ result.id }`,
			`Page URL: ${ `${ server }${ articlepath }/${ result.key }` }`,
			`Thumbnail URL: ${ result.thumbnail?.url ?? 'Not available' }`
		].join( '\n' )
	};
}
