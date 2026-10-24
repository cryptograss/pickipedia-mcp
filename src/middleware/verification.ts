/**
 * PickiPedia's bot-edit verification, on the client side.
 *
 * The wiki's PickiPediaVerification extension refuses a bot's edit to an
 * article when a line it adds or changes carries no proposal marker
 * ({{Bot_proposes|...}}, or <proposed>...</proposed> around a template call).
 * This marks them, so an agent writes plain wikitext and never a marker by
 * hand: new and changed prose is wrapped, what the page already had is put
 * back as it was. A person verifies the proposals at Special:VerifyBotEdits.
 *
 * Every write reaches the wiki through EditServiceImpl.submit (update-page in
 * all its operations) or mwn.create (create-page), and each calls in here:
 * markEditParams() and markNewPage() below. What is left of this file is the
 * wrapping itself, unchanged from before upstream v0.19.0.
 */
import type { Mwn } from 'mwn';

/**
 * Namespaces exempt from verification.
 * These contain meta/organizational/discussion content, not factual claims.
 */
const EXEMPT_NAMESPACES = [
	'Template',
	'Talk',
	'User',
	'MediaWiki',
	'Special',
	'Module',
	'Form',
	'PickiPedia', // Bot config and meta pages
	// The agents' own notes, and the docs they read for their work: only the
	// owning agent and sysops can edit a page there (the wiki's agent-edit right
	// and PickiPediaContent's AgentPages), and what an agent keeps for itself is
	// not a claim waiting to be verified.
	'Agent',
];

/**
 * Pages exempt from verification wherever they are.
 *
 * A Mood's to-do list (memory-lane services/todo.py) is a working list of who
 * has to do what -- merges, reviews, deploys -- that agents keep current as
 * they go, not claims about the world. Marked as proposals, every tick and
 * every new item waited in the review queue, and the queue filled with
 * chores; the people who use the list asked for it to be exempt.
 */
const EXEMPT_PAGES = [/^Cryptograss:Moods\/[^/]+\/todo$/i];

/**
 * Strip a proposal marker to get back the content underneath.
 * Used for comparing old vs new content.
 *
 * Both markers have to be handled here, not just the template. What the caller
 * sends is always unmarked, while what the previous revision holds is marked in
 * whichever form was chosen when it was written. If this only knew one of them,
 * content wearing the other would never match its unmarked self, the wrapper
 * would read it as new, and it would be marked a second time — which is
 * pickipedia#43 all over again.
 *
 * @param {string} text Possibly-marked text.
 * @return {string} Text with the marker and any pipe escapes removed.
 */
function stripProposalMarkers(text: string): string {
	// The tag comes off first. Its payload may itself be a {{Bot_proposes}}
	// left by an older revision, and peeling outside-in leaves that exposed to
	// the template match below.
	const tagged = text.match(/<proposed\b[^>]*>([\s\S]*?)<\/proposed>/i);
	if (tagged) {
		text = tagged[1].trim();
	}

	// Match {{Bot_proposes|content|by=...}} and extract the content
	// Handle escaped pipes ({{!}})
	const templated = text.match(/\{\{Bot_proposes\|(.+?)\|by=[^}]+\}\}/i);
	if (templated) {
		// Unescape pipes
		text = templated[1].replace(/\{\{!\}\}/g, '|');
	}

	// {{verified}} and {{source}} sit *after* the sentence rather than around
	// it — they render a superscript tick or citation — so unlike the proposal
	// markers they are a suffix, not a wrapper.
	//
	// They have to come off for comparison all the same. A bot regenerating a
	// page sends the bare sentence; the page holds that sentence plus whatever
	// a human appended to it. Compared as-is the two never match, the sentence
	// reads as new, and the verification a person did by hand is replaced with
	// an unverified badge from a bot. Same claim, so: same key.
	return text.replace(/\{\{(?:verified|source)\s*\|[^}]*\}\}/gi, '').trim();
}

/**
 * Whether content already carries a proposal marker of either kind.
 *
 * @param {string} content Inline content, list prefix already removed.
 * @return {boolean} True if it is marked and should be left alone.
 */
function isAlreadyProposed(content: string): boolean {
	return content.startsWith('{{Bot_proposes') || /<proposed[\s>]/i.test(content);
}

/**
 * Mark inline content as bot-proposed, picking the marker its payload can survive.
 *
 * {{Bot_proposes}} carries its payload as a template parameter, so every pipe
 * inside has to be escaped to {{!}}. That is fine for prose and fatal for
 * anything holding a template call: {{!}} only becomes a pipe after the
 * preprocessor has already decided where each template's arguments begin and
 * end, so the escaped pipes never separate anything. The inner call is never
 * made and the reader is shown raw wikitext — a {{Src}} citation renders as
 * literally "{{Src|video|cid=...}}" in the middle of a sentence.
 *
 * The <proposed> tag carries its payload as tag content, which the preprocessor
 * lifts out before it parses templates at all. Nothing needs escaping and
 * nested calls survive. Same reasoning as markMarkupBlock(), which has used the
 * tag for block-level template calls since cryptograss/pickipedia#88; this is
 * that lesson applied to the inline case.
 *
 * @param {string} content Inline content to mark.
 * @return {string} The content, marked.
 */
function markInlineContent(content: string, by: string): string {
	if (content.includes('{{')) {
		return `<proposed by="${by}">${content}</proposed>`;
	}
	const escaped = content.replace(/\|/g, '{{!}}');
	return `{{Bot_proposes|${escaped}|by=${by}}}`;
}

/**
 * Normalize a line for comparison purposes.
 * Strips Bot_proposes wrappers and normalizes whitespace.
 *
 * @param {string} line Line to normalize.
 * @return {string} Comparable form of the line.
 */
function normalizeLine(line: string): string {
	return stripProposalMarkers(line.trim()).trim();
}

/**
 * Build a set of normalized paragraphs from content for quick lookup.
 * Handles multi-line paragraphs by joining consecutive non-markup lines.
 *
 * Segmentation here MUST match wrapProseWithBotProposes() exactly, protected
 * regions included. The two functions are the halves of one comparison: this
 * builds what the previous revision said, that decides what is new. Split a
 * paragraph differently on either side and the lookup misses, so unchanged
 * prose gets re-wrapped and previously-verified content silently reverts to
 * unverified — the complaint in pickipedia#43.
 *
 * @param {string} source Wikitext to index.
 * @return {Map<string,string>} Normalized text to the form the page holds it in,
 *   so a match can be restored with whatever marker it carried.
 */
export function buildLineSet(source: string): Map<string, string> {
	const lines = source.split('\n');
	const protectedLines = computeProtectedLines(lines);
	const found = new Map<string, string>();
	let currentParagraph: string[] = [];

	const flushParagraph = (): void => {
		if (currentParagraph.length > 0) {
			const text = currentParagraph.join(' ').trim();
			const normalized = normalizeLine(text);
			// First occurrence wins. A page holding the same sentence twice,
			// once verified and once not, should keep the verified one.
			if (normalized && !found.has(normalized)) {
				found.set(normalized, text);
			}
			currentParagraph = [];
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (protectedLines[i] || isNonWrappableLine(line)) {
			flushParagraph();
			// Don't add markup lines to the set
		} else if (MARKER_OPENS_LINE.test(line.trim())) {
			// Segment exactly as wrapProseWithBotProposes() segments: a marker
			// line is its own paragraph there, so it must be here too, or the
			// keys the two halves build stop matching and unchanged content
			// gets re-marked, which is pickipedia#43.
			flushParagraph();
			currentParagraph = [line];
			flushParagraph();
		} else if (isListItem(line)) {
			flushParagraph();
			// Add list item content
			const match = line.trim().match(/^[*#:;]+\s*(.*)$/);
			if (match && match[1]) {
				const normalized = normalizeLine(match[1]);
				if (normalized && !found.has(normalized)) {
					found.set(normalized, match[1]);
				}
			}
		} else {
			currentParagraph.push(line);
		}
	}

	flushParagraph();
	return found;
}

/**
 * Check if a page title is in an exempt namespace.
 *
 * @param {string} title Full page title, namespace prefix included.
 * @return {boolean} True if edits to this page skip verification.
 */
function isExemptNamespace(title: string): boolean {
	// Check for talk pages (any namespace ending in talk, as "User_talk:" or "User talk:")
	if (/[_ ]talk:/i.test(title)) {
		return true;
	}

	// Check for explicit exempt namespaces
	const colonIndex = title.indexOf(':');
	if (colonIndex === -1) {
		// Main namespace - not exempt
		return false;
	}

	// colonIndex is never -1 here; the early return above handles that.
	const namespace = title.slice(0, colonIndex);
	return EXEMPT_NAMESPACES.some((ns) => namespace.toLowerCase() === ns.toLowerCase());
}

/**
 * Check if edits to a page skip verification: its namespace is exempt, or it is.
 *
 * @param {string} title Full page title, namespace prefix included.
 * @return {boolean} True if edits to this page skip verification.
 */
export function isExemptPage(title: string): boolean {
	const normal = title.replace(/_/g, ' ').trim();
	return isExemptNamespace(title) || EXEMPT_PAGES.some((pattern) => pattern.test(normal));
}

/**
 * Templates that support the status parameter.
 * When content starts with one of these, we inject status=proposed.
 */
// These names are interpolated into RegExp sources below. That is only safe
// because this list is a literal — nothing here comes from a page, a tool
// argument, or config. If it ever becomes user-supplied, escape it first; the
// security/detect-non-literal-regexp suppressions below are justified solely
// by this array being hardcoded.
const TEMPLATES_WITH_STATUS = ['Show', 'Venue', 'Scene', 'Artist', 'Song', 'Album'];

/**
 * Check if a line/text has already been verified (not just proposed).
 * Verified content should not be re-wrapped.
 *
 * @param {string} text Text to inspect.
 * @return {boolean} True if a human has already attested to this.
 */
function isAlreadyVerified(text: string): boolean {
	// Check for {{verified|...}} or {{source|...}} templates
	return /\{\{(verified|source)\s*\|/i.test(text);
}

/**
 * Check if content uses a template that supports status parameter.
 * Returns the template name if found, null otherwise.
 *
 * @param {string} source Wikitext to inspect.
 * @return {string|null} Template name, or null if none of them opens the page.
 */
function getTemplateWithStatus(source: string): string | null {
	for (const template of TEMPLATES_WITH_STATUS) {
		// Match {{Template at start of content (with optional whitespace)
		// eslint-disable-next-line security/detect-non-literal-regexp -- hardcoded list
		const regex = new RegExp(`^\\s*\\{\\{${template}\\s*[\\n|]`, 'i');
		if (regex.test(source)) {
			return template;
		}
	}
	return null;
}

/**
 * Check if a specific template already has status=proposed.
 *
 * @param {string} source Wikitext to inspect.
 * @param {string} template Template name to look for.
 * @return {boolean} True if that template already carries status=proposed.
 */
function templateHasProposedStatus(source: string, template: string): boolean {
	// Look for the template followed eventually by |status=proposed before the closing }}
	// eslint-disable-next-line security/detect-non-literal-regexp -- hardcoded list
	const regex = new RegExp(`\\{\\{${template}[^}]*\\|\\s*status\\s*=\\s*proposed`, 'i');
	return regex.test(source);
}

/**
 * Inject status=proposed into a template at the start of content.
 *
 * @param {string} source Wikitext beginning with the template.
 * @param {string} template Template name to inject into.
 * @return {string} Source with status=proposed added, or unchanged if present.
 */
function injectTemplateStatus(source: string, template: string): string {
	// Check if this specific template already has status=proposed
	if (templateHasProposedStatus(source, template)) {
		return source; // Already has it, don't double-inject
	}
	// Insert status=proposed after the template opening
	// eslint-disable-next-line security/detect-non-literal-regexp -- hardcoded list
	const regex = new RegExp(`(^\\s*\\{\\{${template}\\s*\\n)`, 'i');
	return source.replace(regex, '$1|status=proposed\n');
}

/**
 * Find the end of a template block (matching closing }}).
 *
 * @param {string} source Wikitext to scan.
 * @param {number} startIndex Index of the opening braces.
 * @return {number} Index just past the closing braces, or the end of source
 *   if the template is never closed.
 */
function findTemplateEnd(source: string, startIndex: number): number {
	let depth = 0;
	let i = startIndex;

	while (i < source.length - 1) {
		if (source[i] === '{' && source[i + 1] === '{') {
			depth++;
			i += 2;
		} else if (source[i] === '}' && source[i + 1] === '}') {
			depth--;
			if (depth === 0) {
				return i + 2; // Return position after the closing }}
			}
			i += 2;
		} else {
			i++;
		}
	}
	return source.length; // Template not closed, return end of string
}

/**
 * Check if a line is wikitext markup that shouldn't be wrapped at all.
 * Note: List items (*, #) are handled separately - their content gets wrapped.
 *
 * @param {string} line Line to judge, in isolation.
 * @return {boolean} True if the line is markup rather than prose.
 */
const MARKER_OPENS_LINE = /^\{\{(Bot_proposes|verified|source)\s*\|/i;

function isNonWrappableLine(line: string): boolean {
	const trimmed = line.trim();

	// A marked paragraph is still a paragraph. {{Bot_proposes|…}} opens with
	// {{, which would otherwise file it as markup — so the same sentence lands
	// in a different bucket depending on whether anybody has marked it, and a
	// lookup of the unmarked form never finds the marked one. That mismatch is
	// what let a rewrite silently un-verify content, and it is the same shape
	// as pickipedia#94 and pickipedia-mcp#21.
	if (/^\{\{(Bot_proposes|verified|source)\s*\|/i.test(trimmed)) {
		return false;
	}

	return (
		trimmed === '' ||
		trimmed.startsWith('==') || // Headings
		trimmed.startsWith('[[Category:') ||
		trimmed.startsWith('{{') || // Templates
		trimmed === '}}' || // Template close on its own line
		trimmed.startsWith('|}') || // Table end
		trimmed.startsWith('{|') || // Table start
		trimmed.startsWith('|') || // Table row
		trimmed.startsWith('!') // Table header
	);
}

/**
 * Tags whose contents are verbatim wikitext and must never be rewritten.
 * ASCII art in <pre> is the case that keeps biting us.
 */
// 'proposed' is here for a different reason than the rest. The others hold
// content the parser must not touch; this one holds a claim that has already
// been marked. Rewriting inside it would wrap an existing marker in a second
// marker, and treating its opening line as prose would wrap *that* — the tag
// line is not a heading, category or template, so without this it reads as
// ordinary text. See cryptograss/pickipedia#88.
const PROTECTED_TAGS = ['pre', 'nowiki', 'syntaxhighlight', 'source', 'poem', 'math', 'proposed'];

/**
 * Open/close matchers per protected tag, compiled once from the constant list
 * above rather than rebuilt per line.
 */
const PROTECTED_TAG_PATTERNS: { tag: string; open: RegExp; close: RegExp }[] = PROTECTED_TAGS.map(
	(tag) => ({
		tag,
		// eslint-disable-next-line security/detect-non-literal-regexp -- built from the constant list above
		open: new RegExp(`<${tag}(\\s[^>]*)?>`, 'i'),
		// eslint-disable-next-line security/detect-non-literal-regexp -- built from the constant list above
		close: new RegExp(`</${tag}\\s*>`, 'i'),
	}),
);

/**
 * Count non-overlapping occurrences of a substring.
 *
 * @param {string} haystack String to search.
 * @param {string} needle Substring to count.
 * @return {number} Number of occurrences.
 */
function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/**
 * If this line opens a protected tag it doesn't also close, return the tag name.
 *
 * @param {string} line Single line of wikitext.
 * @return {string|null} Tag name left open by this line, or null.
 */
function openedProtectedTag(line: string): string | null {
	for (const { tag, open, close } of PROTECTED_TAG_PATTERNS) {
		if (open.test(line) && !close.test(line)) {
			return tag;
		}
	}
	return null;
}

/**
 * Closing matcher for a tag known to be in PROTECTED_TAGS.
 *
 * @param {string} tag Tag name.
 * @return {RegExp} Matcher for that tag's closing form.
 */
function closingPatternFor(tag: string): RegExp {
	const entry = PROTECTED_TAG_PATTERNS.find((p) => p.tag === tag);
	// Every caller passes a tag that came out of openedProtectedTag().
	return entry!.close;
}

/**
 * Mark lines that belong to a multi-line region and must be passed through
 * untouched.
 *
 * isNonWrappableLine() judges each line on its own, which is fine for a
 * heading or a table row but wrong for anything spanning lines. Two cases
 * broke real pages:
 *
 * - Content inside <pre> looks like prose line by line, so ASCII art was
 *   wrapped and destroyed.
 * - A template parameter whose value runs over several lines (say
 *   `| image = <pre>` with art beneath it) got a {{Bot_proposes}} injected
 *   into the middle of the template call, which shattered the whole
 *   infobox — see Cryptograss:Delivery-kid.
 *
 * A bare `}}` closing line is prose by the line-at-a-time test too, and
 * wrapping that swallows it into the parameter, where it closes the
 * Bot_proposes call early and spills the rest as literal text.
 *
 * @param {string[]} lines Source split on newlines.
 * @return {boolean[]} Array parallel to `lines`; true means "leave this line alone".
 */
export function computeProtectedLines(lines: string[]): boolean[] {
	const protectedLines: boolean[] = new Array(lines.length).fill(false);
	let openTag: string | null = null;
	let braceDepth = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Inside <pre> and friends, through and including the closing tag.
		if (openTag) {
			protectedLines[i] = true;
			if (closingPatternFor(openTag).test(line)) {
				openTag = null;
			}
			continue;
		}

		// Inside an unclosed template, through and including the line that
		// finally balances the braces.
		if (braceDepth > 0) {
			protectedLines[i] = true;
		}

		const opened = openedProtectedTag(line);
		if (opened) {
			protectedLines[i] = true;
			openTag = opened;
		}

		braceDepth += countOccurrences(line, '{{') - countOccurrences(line, '}}');
		if (braceDepth < 0) {
			// Unbalanced source; don't let a stray }} protect the rest of the page.
			braceDepth = 0;
		}
		if (braceDepth > 0) {
			protectedLines[i] = true;
		}
	}

	return protectedLines;
}

/**
 * Check if a line is a list item (bullet or numbered).
 *
 * @param {string} line Line to check.
 * @return {boolean} True if the line opens with a list marker.
 */
function isListItem(line: string): boolean {
	const trimmed = line.trim();
	return (
		trimmed.startsWith('*') ||
		trimmed.startsWith('#') ||
		trimmed.startsWith(':') ||
		trimmed.startsWith(';')
	);
}

/**
 * Wrap the content of a list item with Bot_proposes.
 * Preserves the list prefix (* or # etc) and wraps the rest.
 * Only wraps if the content is not in the existingLines set.
 *
 * @param {string} line List-item line.
 * @param {Map<string,string>} [existingLines] Content from the previous revision;
 *   anything found here is left alone.
 * @return {string} The line, wrapped if its content is new.
 */
function wrapListItemContent(
	line: string,
	by: string,
	existingLines?: Map<string, string>,
): string {
	const trimmed = line.trim();

	// Find the list prefix (may be multiple chars like ** or **)
	const match = trimmed.match(/^([*#:;]+)\s*(.*)$/);
	if (!match) {
		return line;
	}

	const prefix = match[1];
	const content = match[2];

	// Don't wrap if empty, already marked, or already verified
	if (!content || isAlreadyProposed(content) || isAlreadyVerified(content)) {
		return line;
	}

	// Don't wrap if it's just a wikilink with no descriptive text
	// e.g., "* [[Justin Holmes]]" - just a name link, not a claim
	if (/^\[\[[^\]]+\]\]$/.test(content)) {
		return line;
	}

	// Content already on the page goes back as the page had it, markers and
	// all. Emitting what the caller sent would strip whatever state a human
	// left the line in — see flushParagraph() for the same reasoning.
	const asStored = existingLines?.get(normalizeLine(content));
	if (asStored !== undefined) {
		return `${prefix} ${asStored}`;
	}

	return `${prefix} ${markInlineContent(content, by)}`;
}

/**
 * A template call the bot added, marked so a human can check it.
 *
 * Prose gets {{Bot_proposes}}; this is the equivalent for structured claims.
 * The <proposed> tag rather than a template because tag content is pulled out
 * by the preprocessor before templates and parameters are parsed, so the pipes
 * inside a template call need no escaping — see cryptograss/pickipedia#88.
 * Escaping into the middle of a template call is what produced
 * [[File:Instrument-icon-banjo[unverified].png]] in pickipedia#43.
 *
 * @param {string[]} blockLines The template call, as its own lines.
 * @return {string[]} The call, marked.
 */
function markMarkupBlock(blockLines: string[], by: string): string[] {
	const text = blockLines.join('\n');

	// Templates that render their own proposed state do it better than a
	// generic wrapper can — {{Show}} tints its infobox and sets an SMW
	// property. Prefer that, and only fall back to the tag.
	const template = TEMPLATES_WITH_STATUS.find((name) =>
		// eslint-disable-next-line security/detect-non-literal-regexp -- hardcoded list
		new RegExp(`^\\s*\\{\\{\\s*${name}\\s*[\\n|}]`, 'i').test(text),
	);
	if (template) {
		return injectTemplateStatus(text, template).split('\n');
	}

	return [`<proposed by="${by}">`, ...blockLines, '</proposed>'];
}

/**
 * Whether a markup block is a claim that wants marking.
 *
 * Template calls are claims: an {{Ensemble}} is an assertion about who was in
 * a band, a {{PodcastEpisode}} about who appeared on a show. Parser functions
 * are not — {{#ask:}} is a query and {{#hsgimg:}} is display, and marking
 * those would put an "unverified" badge on the furniture.
 *
 * Verbatim blocks are claims too. Whatever a bot puts inside <pre> or <nowiki>
 * is content it added and content somebody should be able to check — a block of
 * guest-name patterns, a tracklist, a quoted setlist. The tag stops the parser
 * touching what is inside it; it says nothing about whether the thing is true.
 *
 * Headings, categories and table rows are left alone deliberately. A category
 * carries no visible content to attach a marker to, and a table row cannot be
 * wrapped without breaking the table. Those stay gated by the wiki-side check
 * (cryptograss/pickipedia#86), which is the honest outcome: express the claim
 * as a template and it can be verified.
 *
 * @param {string[]} blockLines Lines of the block.
 * @return {boolean} True if the block should be marked when new.
 */
function isMarkableMarkup(blockLines: string[]): boolean {
	const first = blockLines[0]?.trim() ?? '';

	const isTemplateCall = first.startsWith('{{') && !first.startsWith('{{#');

	// A verbatim block — <pre>, <nowiki>, <poem> — is content a bot added and
	// content a human should be able to check, so it wants marking like
	// anything else. It was falling through unmarked, and since the wiki-side
	// gate now asks for a marker on every new line (pickipedia#91), the effect
	// was that a bot could not add a <pre> block to any page at all: the
	// middleware declined to mark it and the gate then refused the edit.
	//
	// 'proposed' is excluded because it is already a marker. Wrapping it would
	// nest one inside another.
	const isVerbatimBlock = PROTECTED_TAGS.some(
		(tag) =>
			tag !== 'proposed' &&
			// eslint-disable-next-line security/detect-non-literal-regexp -- hardcoded list
			new RegExp(`^<${tag}[\\s>]`, 'i').test(first),
	);

	if (!isTemplateCall && !isVerbatimBlock) {
		return false;
	}

	const text = blockLines.join('\n');
	return (
		!/\{\{Bot_proposes/i.test(text) &&
		!/<proposed[\s>]/i.test(text) &&
		!/\|\s*status\s*=\s*(proposed|unverified)/i.test(text) &&
		!isAlreadyVerified(text)
	);
}

/**
 * Wrap prose paragraphs and list items with Bot_proposes, and mark new
 * template calls with <proposed>.
 *
 * Only touches content that is NOT in the existing sets (i.e. new or changed).
 *
 * @param {string} source Wikitext being saved.
 * @param {Map<string,string>} [existingLines] Prose and list content from the
 *   previous revision, as built by buildLineSet(). Omit it and every paragraph
 *   is treated as new, which is what pickipedia#43 looked like from outside.
 * @param {Map<string,string[]>} [existingBlocks] Markup blocks from the previous
 *   revision, as built by buildBlockSet(). Omit it and every template call is
 *   treated as new — correct for page creation, where it is.
 * @return {string} Source with new content marked.
 */
export function wrapProseWithBotProposes(
	source: string,
	existingLines?: Map<string, string>,
	existingBlocks?: Map<string, string[]>,
	by = 'Magent',
): string {
	const lines = source.split('\n');
	const protectedLines = computeProtectedLines(lines);
	const result: string[] = [];
	let currentParagraph: string[] = [];

	const flushParagraph = (): void => {
		if (currentParagraph.length > 0) {
			const text = currentParagraph.join(' ').trim();
			if (text && !isAlreadyProposed(text) && !isAlreadyVerified(text)) {
				// Content that was already on the page goes back exactly as the
				// page had it, markers and all — not as the caller sent it.
				//
				// A bot regenerating a page sends plain prose. If that is
				// emitted verbatim, every marker the sentence carried is gone:
				// a pending proposal quietly loses its badge, and worse, a
				// claim somebody verified reverts to unverified with no error
				// anywhere. Putting the stored form back keeps whatever state a
				// human left it in.
				const normalizedText = normalizeLine(text);
				const asStored = existingLines?.get(normalizedText);
				if (asStored !== undefined) {
					result.push(asStored);
				} else {
					// New content - mark it
					result.push(markInlineContent(text, by));
				}
			} else if (text) {
				result.push(text);
			}
			currentParagraph = [];
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (protectedLines[i] || isNonWrappableLine(line)) {
			// Multi-line regions, headings, categories, templates, tables.
			// Never rewritten internally; a whole template call may be marked.
			flushParagraph();

			// Take the whole block, so a multi-line template call is judged
			// and marked as one thing rather than line by line.
			const block: string[] = [line];
			// Only consume while the *next* line is still inside the region.
			// Testing the current line and breaking after the push swallows
			// the first line past the block, which eats the paragraph after
			// a template.
			while (protectedLines[i] && protectedLines[i + 1]) {
				i++;
				block.push(lines[i]);
			}

			const key = normalizeLine(block.join(' '));
			const asStored = existingBlocks?.get(key);
			if (asStored === undefined && isMarkableMarkup(block)) {
				result.push(...markMarkupBlock(block, by));
			} else {
				// A block already on the page goes back as the page had it.
				// Pushing the incoming block instead drops its <proposed>
				// wrapper, so bot content that nobody has reviewed quietly
				// stops looking unreviewed — the marker disappears and no
				// review happened. That fails open, which is the wrong
				// direction for a thing whose whole job is to hold content
				// until a human looks at it.
				result.push(...(asStored ?? block));
			}
		} else if (MARKER_OPENS_LINE.test(line.trim())) {
			// A line that opens with {{Bot_proposes|, {{verified| or {{source|
			// is a paragraph on its own. isNonWrappableLine() deliberately
			// buckets it as prose so a marked sentence still answers a lookup
			// of its unmarked form -- but prose accumulates, so without this
			// the marker line merges with whatever prose sits immediately
			// above it. The join is then a line the page never held, and
			// because isAlreadyVerified() matches it, the restore-as-stored
			// path is skipped and the join goes out verbatim. The wiki's gate
			// sees new unmarked content and refuses the edit, naming a line no
			// bot wrote and none can fix: Cryptograss/Horseshoe Crab has a
			// {{verified}} call directly under its second line, and every bot
			// edit to it failed this way.
			flushParagraph();
			currentParagraph = [line];
			flushParagraph();
		} else if (isListItem(line)) {
			// List items - wrap the content after the prefix
			flushParagraph();
			result.push(wrapListItemContent(line, by, existingLines));
		} else {
			// It's prose - accumulate into current paragraph
			currentParagraph.push(line);
		}
	}

	flushParagraph();
	return result.join('\n');
}

/**
 * Index the markup blocks of a revision, so the wrapper can tell a template
 * call that was already there from one this edit is adding.
 *
 * Segmented exactly as wrapProseWithBotProposes() segments — same protected
 * regions, same block boundaries, same normalization. buildLineSet() carries
 * the same warning and for the same reason: when the two halves of this
 * comparison disagree, unchanged content gets re-marked, which is pickipedia#43.
 *
 * @param {string} source Wikitext to index.
 * @return {Map<string,string[]>} Normalized block text to the lines the page holds,
 *   so a match can be restored with whatever marker it carried.
 */
export function buildBlockSet(source: string): Map<string, string[]> {
	const lines = source.split('\n');
	const protectedLines = computeProtectedLines(lines);
	const found = new Map<string, string[]>();

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!protectedLines[i] && !isNonWrappableLine(line)) {
			continue;
		}

		const block: string[] = [line];
		// Only consume while the *next* line is still inside the region.
		// Testing the current line and breaking after the push swallows the
		// first line past the block, which would eat the paragraph after a
		// template.
		while (protectedLines[i] && protectedLines[i + 1]) {
			i++;
			block.push(lines[i]);
		}

		const key = normalizeLine(block.join(' '));
		// The block is kept, not just its key, so a later edit can put back
		// what the page had rather than what a bot sent. First occurrence wins,
		// for the same reason it does for prose.
		if (key && !found.has(key)) {
			found.set(key, block);
		}
	}

	return found;
}

/**
 * Apply verification to content.
 * If existingLines is provided, only new/changed content gets wrapped.
 *
 * @param {string} source Wikitext being saved.
 * @param {Map<string,string>} [existingLines] Prose from the previous revision.
 * @param {Map<string,string[]>} [existingBlocks] Markup blocks from the previous revision.
 * @return {string} Source with status=proposed and/or Bot_proposes applied.
 */
function applyVerification(
	source: string,
	existingLines?: Map<string, string>,
	existingBlocks?: Map<string, string[]>,
	by = 'Magent',
): string {
	const template = getTemplateWithStatus(source);

	if (template) {
		// Inject status=proposed into the template
		let modified = injectTemplateStatus(source, template);

		// Find where the template ends
		const templateStart = modified.search(/\{\{/i);
		if (templateStart !== -1) {
			const templateEnd = findTemplateEnd(modified, templateStart);
			// Both offsets are non-negative here: templateStart is guarded
			// above, and findTemplateEnd only ever returns an index or the
			// length of the source.
			const beforeTemplate = modified.slice(0, templateStart);
			const templateContent = modified.slice(templateStart, templateEnd);
			const afterTemplate = modified.slice(templateEnd);

			// Wrap any prose after the template
			if (afterTemplate.trim()) {
				const wrappedAfter = wrapProseWithBotProposes(
					afterTemplate,
					existingLines,
					existingBlocks,
					by,
				);
				modified = beforeTemplate + templateContent + wrappedAfter;
			}
		}

		return modified;
	}

	// No recognized template - mark new prose and new template calls
	return wrapProseWithBotProposes(source, existingLines, existingBlocks, by);
}

/** What a marked write says, beside the tool's result. */
export const PROPOSED_NOTE =
	'This edit was marked as proposed where it adds or changes prose, as the wiki requires of bot edits; a person verifies it at Special:VerifyBotEdits.';

/**
 * Mark the new and changed prose of `source`, as against `previous` (the
 * text it replaces, or nothing for a page or a passage that is all new).
 *
 * @param {string} source Wikitext about to be saved.
 * @param {string|null} [previous] What it replaces.
 * @return {string} The wikitext with its proposals marked.
 */
export function markSource(source: string, previous?: string | null, by = 'Magent'): string {
	if (previous === undefined || previous === null) {
		return applyVerification(source, undefined, undefined, by);
	}
	return applyVerification(source, buildLineSet(previous), buildBlockSet(previous), by);
}

const proposers = new WeakMap<Mwn, Promise<string>>();

/**
 * Who a marker names as proposing the edit: the account signed in. Each agent
 * edits as its own bot (Magent@magent, Re@re), so a bot-password login's name
 * before the @ is the user; otherwise (an OAuth token) the wiki is asked once
 * per client. Never a name that could break out of the marker.
 *
 * @param {Mwn} mwn Signed-in client.
 * @return {Promise<string>} The proposer's user name.
 */
export function proposerName(mwn: Mwn): Promise<string> {
	let pending = proposers.get(mwn);
	if (!pending) {
		pending = findProposer(mwn);
		proposers.set(mwn, pending);
	}
	return pending;
}

async function findProposer(mwn: Mwn): Promise<string> {
	const clean = (name: string): string => name.replace(/[|{}<>"=[\]\n]/g, '').trim();
	const login = (mwn as { options?: { username?: string } }).options?.username;
	if (typeof login === 'string' && login.trim() !== '') {
		return clean(login.split('@')[0]) || 'an unnamed bot';
	}
	try {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		const response = (await mwn.request({
			action: 'query',
			meta: 'userinfo',
			formatversion: '2',
		})) as { query?: { userinfo?: { name?: string; anon?: boolean } } } | undefined;
		const info = response?.query?.userinfo;
		if (info?.name && !info.anon) {
			return clean(info.name) || 'an unnamed bot';
		}
	} catch (error) {
		console.error(`[verification] could not tell who is signed in: ${String(error)}`);
	}
	return 'an unnamed bot';
}

/**
 * A new page's source, marked: every line of it is new.
 *
 * @param {Mwn} mwn Signed-in client, for who is proposing it.
 * @param {string} title The page.
 * @param {string} source Its wikitext.
 * @return {Promise<string>} The wikitext to create it with.
 */
export async function markNewPage(mwn: Mwn, title: string, source: string): Promise<string> {
	if (isExemptPage(title)) {
		return source;
	}
	const marked = markSource(source, null, await proposerName(mwn));
	console.error(
		`[verification] ${title}: ${marked === source ? 'nothing to mark' : 'new prose marked as proposed'}`,
	);
	return marked;
}

/**
 * The text a write replaces: the section it names, or the whole page, at
 * the revision it is based on, else the current one. Null if there is none
 * (a page not yet made) or it can't be read.
 *
 * @param {Mwn} mwn Signed-in client.
 * @param {string} title The page.
 * @param {unknown} section The edit's section parameter, if any.
 * @param {unknown} baserevid The revision the edit is based on, if any.
 * @return {Promise<string|null>}
 */
async function previousText(
	mwn: Mwn,
	title: string,
	section: unknown,
	baserevid: unknown,
): Promise<string | null> {
	const params: Record<string, string | number | boolean> = {
		action: 'query',
		prop: 'revisions',
		rvprop: 'content',
		rvslots: 'main',
		formatversion: '2',
	};
	if (typeof baserevid === 'number' || (typeof baserevid === 'string' && baserevid !== '')) {
		params.revids = String(baserevid);
	} else {
		params.titles = title;
	}
	if (typeof section === 'number' || (typeof section === 'string' && section !== '')) {
		params.rvsection = String(section);
	}
	try {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		const response = (await mwn.request(params)) as {
			query?: {
				pages?: Array<{
					missing?: boolean;
					revisions?: Array<{ slots?: { main?: { content?: string } } }>;
				}>;
			};
		};
		const page = response.query?.pages?.[0];
		const content = page?.revisions?.[0]?.slots?.main?.content;
		return typeof content === 'string' ? content : null;
	} catch (error) {
		console.error(
			`[verification] ${title}: could not read the text this edit replaces: ${String(error)}`,
		);
		return null;
	}
}

/**
 * Mark an action=edit request's new prose before it is sent. Anything else
 * (other actions, exempt pages) passes through as it came.
 *
 * - `appendtext` / `prependtext` are new in full: every line of them is marked.
 * - `text` replaces the page, or with `section` one section of it: it is
 *   compared with what it replaces, read at `baserevid` when the edit names
 *   one (so a section number means what it meant to the caller), else the
 *   current revision. Only what the old text didn't have is marked, so an
 *   edit that adds one line doesn't re-mark a page of verified prose
 *   (pickipedia#43). If that text can't be read, everything is marked.
 *
 * @param {Mwn} mwn Signed-in client.
 * @param {Record<string, unknown>} params The edit's API parameters.
 * @return {Promise<Record<string, unknown>>} Them, with the text marked.
 */
export async function markEditParams(
	mwn: Mwn,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const title = params.title;
	if (params.action !== 'edit' || typeof title !== 'string' || isExemptPage(title)) {
		return params;
	}
	for (const field of ['appendtext', 'prependtext']) {
		const delta = params[field];
		if (typeof delta === 'string') {
			console.error(`[verification] ${title}: ${field} marked as proposed`);
			return { ...params, [field]: markSource(delta, null, await proposerName(mwn)) };
		}
	}
	if (typeof params.text === 'string') {
		const previous = await previousText(mwn, title, params.section, params.baserevid);
		console.error(
			previous === null
				? `[verification] ${title}: no previous text to compare; all prose marked`
				: `[verification] ${title}: marked what the edit adds or changes`,
		);
		return { ...params, text: markSource(params.text, previous, await proposerName(mwn)) };
	}
	return params;
}
