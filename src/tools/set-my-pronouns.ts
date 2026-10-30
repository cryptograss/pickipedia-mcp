import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';

// PickiPedia's Pronouns preference (pickipedia#162). Only this one key: action=options with the editmyoptions
// grant could change any of the account's own preferences (its email, its signature), and a tool that names one
// key keeps that grant from being used for anything else (re, magenta-interface, 29 Oct).
export const PRONOUNS_OPTION = 'pickipedia-pronouns';
// As the wiki checks them (PickiPedia's Pronouns::clean): words, with slashes, commas, apostrophes and hyphens.
const PRONOUNS = /^(?:|[\p{L}\p{M}][\p{L}\p{M} /,'’-]{0,39})$/u;

const inputSchema = {
	pronouns: z
		.string()
		.max(40)
		.describe(
			'Your pronouns as you want them shown: "it/its", "she/her", or your own words in order of preference ("it, he"). Empty clears them.',
		),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

interface UserinfoResponse {
	query?: { userinfo?: { name?: string; anon?: boolean; options?: Record<string, unknown> } };
}

export const setMyPronouns: Tool<typeof inputSchema> = {
	name: 'set-my-pronouns',
	description:
		"Sets the pronouns of the account this session is signed in as -- yours, never anyone else's (MediaWiki's action=options only ever writes the caller's own preferences) -- shown on your user page and beside your name in magenta. Changes nothing else about the account.",
	inputSchema,
	annotations: {
		title: 'Set my pronouns',
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'set your pronouns',

	async handle(args: Args, ctx: ToolContext): Promise<CallToolResult> {
		const pronouns = args.pronouns.trim().replace(/\s+/gu, ' ');
		if (!PRONOUNS.test(pronouns)) {
			return ctx.format.invalidInput(
				'pronouns: words, with slashes, commas, apostrophes or hyphens between them, at most 40 characters',
			);
		}
		const mwn = await ctx.mwn();
		await mwn.request({
			action: 'options',
			optionname: PRONOUNS_OPTION,
			optionvalue: pronouns,
			token: await mwn.getCsrfToken(),
			formatversion: '2',
		});
		// Read back, as the wiki now has it: the wiki cleans what it keeps.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		const after = (await mwn.request({
			action: 'query',
			meta: 'userinfo',
			uiprop: 'options',
			formatversion: '2',
		})) as UserinfoResponse;
		const info = after.query?.userinfo;
		if (!info || info.anon === true) {
			throw new Error('not signed in: there is no account to set pronouns for');
		}
		const kept = info.options?.[PRONOUNS_OPTION];
		return ctx.format.ok({ username: info.name, pronouns: typeof kept === 'string' ? kept : '' });
	},
};
