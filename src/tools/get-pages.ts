import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';

/**
 * Several pages' source at once, each with who last edited it and when.
 *
 * An agent loading its notes (Agent:Magent/...) wants five or ten pages at a
 * time; one get-page each is a round trip each. And for a page an agent reads
 * as its own memory, who wrote the current version is part of what it read.
 *
 * @param {McpServer} server
 * @return {RegisteredTool}
 */
export function getPagesTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-pages',
		'Returns the current source of up to 50 wiki pages in one call, each with who last edited it and when. ' +
			'For reading several pages at once, such as an agent\'s notes.',
		{
			titles: z.array( z.string() ).min( 1 ).max( 50 ).describe( 'Wiki page titles' )
		},
		{
			title: 'Get pages',
			readOnlyHint: true,
			destructiveHint: false
		} as ToolAnnotations,
		async ( { titles } ) => handleGetPagesTool( titles )
	);
}

async function handleGetPagesTool( titles: string[] ): Promise< CallToolResult > {
	try {
		const mwn = await getMwn();
		const read = await mwn.read( titles, { rvprop: [ 'content', 'timestamp', 'user' ] } );
		// In the order asked for: the API answers missing pages first.
		const asked = titles.map( ( t ) => mwn.Title.newFromText( t )?.toText() ?? t );
		const at = ( title: string ): number => {
			const i = asked.indexOf( title );
			return i === -1 ? asked.length : i;
		};
		const pages = [ ...read ].sort( ( a, b ) => at( a.title ) - at( b.title ) );
		return {
			content: pages.map( ( page ) => {
				const rev = page.revisions?.[ 0 ];
				const text = page.missing || page.invalid || !rev ?
					`Title: ${ page.title }\nMissing: this page does not exist` :
					[
						`Title: ${ page.title }`,
						`Last edited: ${ rev.timestamp } by ${ rev.user }`,
						'Source:',
						rev.content ?? rev.slots?.main?.content ?? ''
					].join( '\n' );
				return { type: 'text', text } as TextContent;
			} )
		};
	} catch ( error ) {
		return {
			content: [ { type: 'text', text: `Failed to read pages: ${ ( error as Error ).message }` } as TextContent ],
			isError: true
		};
	}
}
