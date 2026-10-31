import { z } from 'zod';

export const ErrorEnvelopeSchema = z.object({
	category: z.enum([
		'not_found',
		'permission_denied',
		'invalid_input',
		'conflict',
		'authentication',
		'rate_limited',
		'upstream_failure',
		// The wiki accepted the write and saved none of it: the submitted text is
		// byte-identical to what the page already holds (edit.nochange). A caller
		// that meant to change the page must hear that it did not.
		'no_change',
	]),
	message: z.string(),
	code: z.string().optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
