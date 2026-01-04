import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { makeRestPutRequest, getPageUrl, formatEditComment } from '../common/utils.js';
import type { MwRestApiPageObject } from '../types/mwRestApi.js';
import { pipeline } from '../middleware/index.js';
import type { EditContext } from '../middleware/types.js';

export function updatePageTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'update-page',
		'Updates a wiki page. Replaces the existing content of a page with the provided content',
		{
			title: z.string().describe( 'Wiki page title' ),
			source: z.string().describe( 'Page content in the same content model of the existing page' ),
			latestId: z.number().int().positive().describe( 'Revision ID used as the base for the new source' ),
			comment: z.string().optional().describe( 'Summary of the edit' )
		},
		{
			title: 'Update page',
			readOnlyHint: false,
			destructiveHint: true
		} as ToolAnnotations,
		async (
			{ title, source, latestId, comment }
		) => {
			const context: EditContext = {
				tool: 'update-page',
				title,
				source,
				comment,
				latestId
			};
			return pipeline.wrapHandler( context, handleUpdatePageToolWithContext );
		}
	);
}

async function handleUpdatePageToolWithContext( context: EditContext ): Promise<CallToolResult> {
	let data: MwRestApiPageObject;
	try {
		data = await makeRestPutRequest<MwRestApiPageObject>( `/v1/page/${ encodeURIComponent( context.title ) }`, {
			source: context.source,
			comment: formatEditComment( 'update-page', context.comment ),
			latest: { id: context.latestId }
		}, true );
	} catch ( error ) {
		return {
			content: [
				{ type: 'text', text: `Failed to update page: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	}

	return {
		content: updatePageToolResult( data )
	};
}

function updatePageToolResult( result: MwRestApiPageObject ): TextContent[] {
	return [
		{
			type: 'text',
			text: `Page updated successfully: ${ getPageUrl( result.title ) }`
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
