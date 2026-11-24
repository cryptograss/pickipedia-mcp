/**
 * PickiPedia's bot-edit verification: where it meets upstream's write path.
 *
 * EditServiceImpl.submit hands every action=edit request to markEditParams,
 * and create-page hands its source to markNewPage (src/middleware/verification.ts).
 * These check what each sends: which text is marked, against what previous
 * text, and in whose name.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Mwn } from 'mwn';
import {
	buildBlockSet,
	buildLineSet,
	isExemptPage,
	markEditParams,
	markNewPage,
	proposerName,
	PROPOSED_NOTE,
	verificationNote,
	wrapProseWithBotProposes,
} from '../../src/middleware/verification.ts';

type Request = (params: Record<string, unknown>) => Promise<unknown>;

function fakeMwn(
	request: Request,
	username: string | null = 'Re@re',
): Mwn & { request: ReturnType<typeof vi.fn> } {
	return { options: username ? { username } : {}, request: vi.fn(request) } as never;
}

function revision(content: string): Request {
	return async () => ({ query: { pages: [{ revisions: [{ slots: { main: { content } } }] }] } });
}

describe('markEditParams', () => {
	it('leaves other actions alone', async () => {
		const mwn = fakeMwn(revision('x'));
		const params = { action: 'protect', title: 'Banjo', protections: 'edit=sysop' };
		expect(await markEditParams(mwn, params)).toBe(params);
		expect(mwn.request).not.toHaveBeenCalled();
	});

	it('leaves exempt pages alone, reading nothing', async () => {
		const mwn = fakeMwn(revision('x'));
		for (const title of [
			'User:Magent/Notes',
			'Agent:Magent/Deploys',
			'Cryptograss:Moods/general/todo',
			'Template:Show',
		]) {
			const params = { action: 'edit', title, text: 'A note.' };
			expect(await markEditParams(mwn, params)).toBe(params);
		}
		expect(mwn.request).not.toHaveBeenCalled();
	});

	it('marks an append in full, in the name of whoever is signed in', async () => {
		const mwn = fakeMwn(revision('never read'));
		const out = await markEditParams(mwn, {
			action: 'edit',
			title: 'Banjo',
			appendtext: '\n\n== History ==\n\nIt came from West Africa.',
		});
		expect(out.appendtext).toBe(
			'\n\n== History ==\n\n{{Bot_proposes|It came from West Africa.|by=Re}}',
		);
		// It asks what kind of page this is, and never reads the page itself.
		expect(mwn.request).toHaveBeenCalledTimes(1);
		expect(mwn.request).toHaveBeenCalledWith(expect.objectContaining({ prop: 'info' }));
	});

	it('marks a prepend in full', async () => {
		const out = await markEditParams(fakeMwn(revision('never read')), {
			action: 'edit',
			title: 'Banjo',
			prependtext: 'A lead sentence.\n',
		});
		expect(out.prependtext).toBe('{{Bot_proposes|A lead sentence.|by=Re}}\n');
	});

	it('marks only what a replace adds, against the revision it is based on', async () => {
		const mwn = fakeMwn(revision('Verified prose.\n\nMore verified prose.'));
		const out = await markEditParams(mwn, {
			action: 'edit',
			title: 'Banjo',
			text: 'Verified prose.\n\nMore verified prose.\n\nA new claim.',
			baserevid: 41,
		});
		expect(out.text).toBe(
			'Verified prose.\n\nMore verified prose.\n\n{{Bot_proposes|A new claim.|by=Re}}',
		);
		expect(mwn.request).toHaveBeenCalledWith(
			expect.objectContaining({ action: 'query', prop: 'revisions', revids: '41' }),
		);
	});

	it('compares a section replace with that section of that revision', async () => {
		const mwn = fakeMwn(revision('== Players ==\nEarl Scruggs.'));
		const out = await markEditParams(mwn, {
			action: 'edit',
			title: 'Banjo',
			section: '2',
			text: '== Players ==\nEarl Scruggs.\nBéla Fleck.',
			baserevid: 41,
		});
		// Adjacent lines are one paragraph in wikitext, and the paragraph is what
		// changed: it goes up marked whole, as the wrapper has always done.
		expect(out.text).toBe('== Players ==\n{{Bot_proposes|Earl Scruggs. Béla Fleck.|by=Re}}');
		expect(mwn.request).toHaveBeenCalledWith(
			expect.objectContaining({ revids: '41', rvsection: '2' }),
		);
	});

	it('without a base revision, compares with the current one', async () => {
		const mwn = fakeMwn(revision('Old line.'));
		const out = await markEditParams(mwn, {
			action: 'edit',
			title: 'Banjo',
			text: 'Old line.\n\nNew line.',
		});
		expect(out.text).toBe('Old line.\n\n{{Bot_proposes|New line.|by=Re}}');
		expect(mwn.request).toHaveBeenCalledWith(expect.objectContaining({ titles: 'Banjo' }));
	});

	it('marks everything when the previous text cannot be read', async () => {
		const failing = fakeMwn(async () => {
			throw new Error('wiki down');
		});
		const out = await markEditParams(failing, {
			action: 'edit',
			title: 'Banjo',
			text: 'One.\n\nTwo.',
		});
		expect(out.text).toBe('{{Bot_proposes|One.|by=Re}}\n\n{{Bot_proposes|Two.|by=Re}}');
	});

	it('marks everything on a page with no revision yet', async () => {
		const missing = fakeMwn(async () => ({ query: { pages: [{ missing: true }] } }));
		const out = await markEditParams(missing, { action: 'edit', title: 'Banjo', text: 'One.' });
		expect(out.text).toBe('{{Bot_proposes|One.|by=Re}}');
	});

	it('keeps the other parameters as they were', async () => {
		const out = await markEditParams(fakeMwn(revision('')), {
			action: 'edit',
			title: 'Banjo',
			text: 'One.',
			summary: 'why',
			baserevid: 7,
		});
		expect(out).toMatchObject({ action: 'edit', title: 'Banjo', summary: 'why', baserevid: 7 });
	});
});

describe('markNewPage', () => {
	it('marks a new page in full', async () => {
		expect(await markNewPage(fakeMwn(revision('')), 'Banjo', 'A claim.')).toBe(
			'{{Bot_proposes|A claim.|by=Re}}',
		);
	});

	it('leaves an exempt one alone', async () => {
		expect(await markNewPage(fakeMwn(revision('')), 'Agent:Re/Hunter', 'A note.')).toBe('A note.');
	});
});

describe('proposerName', () => {
	it("is a bot password's user, before the @", async () => {
		const mwn = fakeMwn(revision(''), 'Magent@magent');
		expect(await proposerName(mwn)).toBe('Magent');
		expect(mwn.request).not.toHaveBeenCalled();
	});

	it('otherwise asks the wiki once', async () => {
		const mwn = fakeMwn(async () => ({ query: { userinfo: { name: 'Blu' } } }), null);
		expect(await proposerName(mwn)).toBe('Blu');
		expect(await proposerName(mwn)).toBe('Blu');
		expect(mwn.request).toHaveBeenCalledTimes(1);
	});

	it('never names an anonymous session', async () => {
		const mwn = fakeMwn(
			async () => ({ query: { userinfo: { name: '1.2.3.4', anon: true } } }),
			null,
		);
		expect(await proposerName(mwn)).toBe('an unnamed bot');
	});

	it('cannot break out of the marker', async () => {
		const mwn = fakeMwn(revision(''), 'Evil|by=Magent}}<x>@evil');
		expect(await proposerName(mwn)).toBe('EvilbyMagentx');
	});
});

describe('exempt pages', () => {
	it("an agent's own pages, and their talk pages", () => {
		expect(isExemptPage('Agent:Magent')).toBe(true);
		expect(isExemptPage('Agent:Re/Hunter docs')).toBe(true);
		expect(isExemptPage('Agent talk:Magent')).toBe(true);
		expect(isExemptPage('Agent_talk:Magent')).toBe(true);
	});

	it('not a main-namespace page about agents', () => {
		expect(isExemptPage('Agents of cryptograss')).toBe(false);
	});
});

describe('a marker line is its own paragraph', () => {
	// The Cryptograss/Horseshoe Crab shape: a {{verified}} call sitting
	// directly under a line of prose, with no blank line between them.
	const page = [
		'Horseshoe Crab is the sprint after [[Cryptograss/Horny Toad]].',
		'',
		"Days are [[Skyler Golden|Skyler]]'s to number. Short points only.",
		'{{verified|by SkymanJenkins}}',
		'',
		'==Day 1==',
	].join('\n');

	it('does not merge it into the prose above it', () => {
		const out = wrapProseWithBotProposes(page, buildLineSet(page), buildBlockSet(page));

		expect(out).not.toContain('only. {{verified');
		expect(out).toBe(page);
	});

	it('leaves an unrelated edit free of unmarked new lines', () => {
		// What the wiki's gate checks: every non-empty line the middleware
		// emits is either one the page already held, or carries a marker.
		const edited = page + '\n\n<proposed by="Magent">\n* A new claim.\n</proposed>';
		const out = wrapProseWithBotProposes(edited, buildLineSet(page), buildBlockSet(page));

		const held = new Set(page.split('\n').map((line) => line.trim()));
		let inProposed = false;
		for (const line of out.split('\n')) {
			const trimmed = line.trim();
			if (/<proposed[\s>]/i.test(trimmed)) {
				inProposed = true;
			}
			const marked = inProposed || /\{\{Bot_proposes/i.test(trimmed);
			if (/<\/proposed\s*>/i.test(trimmed)) {
				inProposed = false;
			}
			if (trimmed === '' || trimmed.startsWith('==') || marked) {
				continue;
			}
			expect(held).toContain(trimmed);
		}
	});
});

describe('a redirect is never wrapped', () => {
	// '#REDIRECT' opens with #, which reads as a numbered-list item: wrapped, it is
	// no redirect at all (Cryptograss:Agents/Index rev 13963, 3 Nov 2026).
	it('leaves the redirect line alone, whatever its spacing or case', () => {
		for (const line of [
			'#REDIRECT [[Cryptograss:Emergents/Index]]',
			'# redirect [[A]]',
			'#Redirect[[A]]',
		]) {
			expect(wrapProseWithBotProposes(line, undefined, undefined, 'Re')).toBe(line);
		}
	});

	it('still marks prose after it', () => {
		const out = wrapProseWithBotProposes(
			'#REDIRECT [[A]]\n\nMoved here on 3 Nov.',
			undefined,
			undefined,
			'Re',
		);
		expect(out).toBe('#REDIRECT [[A]]\n\n{{Bot_proposes|Moved here on 3 Nov.|by=Re}}');
	});

	it('still marks a numbered list item', () => {
		expect(wrapProseWithBotProposes('# A claim.', undefined, undefined, 'Re')).toContain(
			'Bot_proposes',
		);
	});

	it('leaves a new redirect page unmarked', async () => {
		expect(
			await markNewPage(fakeMwn(revision('')), 'Banjo', '#REDIRECT [[Banjo (instrument)]]'),
		).toBe('#REDIRECT [[Banjo (instrument)]]');
	});
});

describe('a proposed removal goes through as written', () => {
	// Magenta:Tour, 4 Nov: a step the bot had proposed held a <code> tag the
	// overlay shows literally. The bot's rewording and its withdrawal were
	// both handed back as the page's own copy, so the wiki saw no change.
	const page = [
		'== Around the Mood ==',
		'<proposed by="Re">',
		'{{Tour step|at=search|text=Pressing <code>/</code> opens it too.|try=yes}}',
		'</proposed>',
	].join('\n');

	it('keeps the action="remove" wrapper instead of restoring the stored block', () => {
		const edited = page.replace('<proposed by="Re">', '<proposed by="Re" action="remove">');
		const out = wrapProseWithBotProposes(edited, buildLineSet(page), buildBlockSet(page));

		expect(out).toContain('<proposed by="Re" action="remove">');
		expect(out).toBe(edited);
	});

	it('still restores an unchanged pending block as the page holds it', () => {
		const bare = page.replace('<proposed by="Re">\n', '').replace('\n</proposed>', '');
		const out = wrapProseWithBotProposes(bare, buildLineSet(page), buildBlockSet(page));

		expect(out).toBe(page);
	});
});

/**
 * re, uploads-and-embeds, 21 Nov 2026: three lines added to a ReleaseDraft
 * (status, final_cid, finalized_at) went up wrapped in proposal markers, and
 * the wiki refused the page as invalid YAML. A marker is wikitext; a page
 * that isn't wikitext is sent as written.
 */
describe('a page that is not wikitext is never marked', () => {
	const DRAFT = 'ReleaseDraft:21408374-b2cc-4bd5-83de-9822f3488bbc';
	const YAML = 'draft_id: 21408374\ntype: video\nupload_blockheight: 26459469\n';
	const FINALIZED = YAML + 'status: finalized\nfinal_cid: QmT5VW5\n';

	/** A wiki whose pages have `model`; `content` is what the page holds. */
	function wiki(model: string | null, content = YAML): Request {
		return async (params) => {
			if (params.prop === 'info') {
				if (model === null) {
					throw new Error('the wiki is not answering');
				}
				return { query: { pages: [{ contentmodel: model }] } };
			}
			return { query: { pages: [{ revisions: [{ slots: { main: { content } } }] }] } };
		};
	}

	it('sends a replace of a YAML page as written, without reading what it replaces', async () => {
		const mwn = fakeMwn(wiki('release-draft-yaml'));
		const params = { action: 'edit', title: DRAFT, text: FINALIZED, summary: 'Finalized' };
		expect(await markEditParams(mwn, params)).toBe(params);
		expect(mwn.request).toHaveBeenCalledTimes(1);
		expect(mwn.request).toHaveBeenCalledWith(
			expect.objectContaining({ prop: 'info', titles: DRAFT }),
		);
	});

	it('sends an append and a prepend to one as written', async () => {
		for (const field of ['appendtext', 'prependtext']) {
			const params = { action: 'edit', title: DRAFT, [field]: 'status: finalized\n' };
			expect(await markEditParams(fakeMwn(wiki('release-draft-yaml')), params)).toBe(params);
		}
	});

	it('goes by the model the edit itself names, asking the wiki nothing', async () => {
		const mwn = fakeMwn(wiki('wikitext'));
		const params = {
			action: 'edit',
			title: 'Banjo/data.json',
			text: '{"a": 1}',
			contentmodel: 'json',
		};
		expect(await markEditParams(mwn, params)).toBe(params);
		expect(mwn.request).not.toHaveBeenCalled();
	});

	it('still marks a wikitext page', async () => {
		const out = await markEditParams(fakeMwn(wiki('wikitext', 'Old prose.')), {
			action: 'edit',
			title: 'Banjo',
			text: 'Old prose.\n\nNew prose.',
		});
		expect(out.text).toBe('Old prose.\n\n{{Bot_proposes|New prose.|by=Re}}');
	});

	it('marks as before when the model cannot be read', async () => {
		const out = await markEditParams(fakeMwn(wiki(null)), {
			action: 'edit',
			title: 'Banjo',
			appendtext: 'New prose.',
		});
		expect(out.appendtext).toBe('{{Bot_proposes|New prose.|by=Re}}');
	});

	it('makes a new YAML page as written: by the model named, or the one its namespace gives', async () => {
		const named = fakeMwn(wiki('wikitext'));
		expect(await markNewPage(named, 'Banjo/data.json', '{"a": 1}', 'json')).toBe('{"a": 1}');
		expect(named.request).not.toHaveBeenCalled();
		expect(await markNewPage(fakeMwn(wiki('release-draft-yaml')), DRAFT, YAML)).toBe(YAML);
		expect(await markNewPage(fakeMwn(wiki('wikitext')), 'Banjo', 'New prose.')).toBe(
			'{{Bot_proposes|New prose.|by=Re}}',
		);
	});

	it('says so beside the result, since no queue will', () => {
		expect(verificationNote('Banjo', 'wikitext')).toEqual({ verification: PROPOSED_NOTE });
		expect(verificationNote('Banjo')).toEqual({ verification: PROPOSED_NOTE });
		expect(verificationNote('User:Magent/Notes', 'wikitext')).toEqual({});
		const note = verificationNote(DRAFT, 'release-draft-yaml').verification;
		expect(note).toContain('release-draft-yaml');
		expect(note).toContain('saved exactly as written');
		expect(note).toContain('not in the queue');
	});
});
