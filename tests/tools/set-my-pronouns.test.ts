import { describe, it, expect, vi, type Mock } from 'vitest';
import { setMyPronouns, PRONOUNS_OPTION } from '../../src/tools/set-my-pronouns.ts';
import { fakeContext } from '../helpers/fakeContext.ts';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { assertStructuredData, assertStructuredError } from '../helpers/structuredResult.ts';

function ctxWith(request: Mock) {
	const mwn = createMockMwn({ request, getCsrfToken: vi.fn().mockResolvedValue('tok+\\') });
	return fakeContext({ mwn: () => Promise.resolve(mwn as never) });
}

describe('set-my-pronouns', () => {
	it('writes only the pronouns option, for the signed-in account, and reads it back', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ options: 'success' })
			.mockResolvedValueOnce({
				query: { userinfo: { name: 'Magent', options: { [PRONOUNS_OPTION]: 'it/its' } } },
			});
		const data = assertStructuredData(
			await dispatch(setMyPronouns, ctxWith(request))({ pronouns: ' it/its ' } as never),
		);
		expect(data.username).toBe('Magent');
		expect(data.pronouns).toBe('it/its');
		const write = request.mock.calls[0][0];
		expect(write.action).toBe('options');
		expect(write.optionname).toBe(PRONOUNS_OPTION);
		expect(write.optionvalue).toBe('it/its');
		expect(write.change).toBeUndefined();
		expect(write.token).toBe('tok+\\');
	});

	it('refuses what is not pronouns before asking the wiki anything', async () => {
		const request = vi.fn();
		for (const bad of ['[[User:X]]', '<b>he</b>', '{{tpl}}', '/him']) {
			assertStructuredError(
				await dispatch(setMyPronouns, ctxWith(request))({ pronouns: bad } as never),
				'invalid_input',
			);
		}
		expect(request).not.toHaveBeenCalled();
	});
});
