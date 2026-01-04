import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { makeRestPostRequest, getPageUrl, formatEditComment } from '../common/utils.js';
import type { MwRestApiPageObject } from '../types/mwRestApi.js';
import { pipeline } from '../middleware/index.js';
import type { EditContext } from '../middleware/types.js';

export function createPageTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'create-page',
		'Creates a wiki page with the provided content.',
		{
			source: z.string().describe( 'Page content in the format specified by the contentModel parameter' ),
			title: z.string().describe( 'Wiki page title' ),
			comment: z.string().optional().describe( 'Reason for creating the page' ),
			contentModel: z.string().optional().default( 'wikitext' ).describe( 'Type of content on the page' )
		},
		{
			title: 'Create page',
			readOnlyHint: false,
			destructiveHint: true
		} as ToolAnnotations,
		async (
			{ source, title, comment, contentModel }
		) => {
			const context: EditContext = {
				tool: 'create-page',
				title,
				source,
				comment,
				contentModel
			};
			return pipeline.wrapHandler( context, handleCreatePageToolWithContext );
		}
	);
}

async function handleCreatePageToolWithContext( context: EditContext ): Promise<CallToolResult> {
	let data: MwRestApiPageObject;

	try {
		data = await makeRestPostRequest<MwRestApiPageObject>( '/v1/page', {
			source: context.source,
			title: context.title,
			comment: formatEditComment( 'create-page', context.comment ),
			// eslint-disable-next-line camelcase
			content_model: context.contentModel
		}, true );
	} catch ( error ) {
		return {
			content: [
				{ type: 'text', text: `Failed to create page: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	}

	return {
		content: createPageToolResult( data )
	};
}

function createPageToolResult( result: MwRestApiPageObject ): TextContent[] {
	return [
		{
			type: 'text',
			text: `Page created successfully: ${ getPageUrl( result.title ) }`
		},
		{
			type: 'text',
			text: [
				'Page object:',
				`Page ID: ${ result.id }`,
				`Title: ${ result.title }`,
				`Latest revision ID: ${ result.latest.id }`,
				`Latest revision timestamp: ${ result.latest.timestamp }`,
				`Content model: ${ result.content_model }`,
				`License: ${ result.license.url } ${ result.license.title }`,
				`HTML URL: ${ result.html_url }`
			].join( '\n' )
		}
	];
}
