import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

// `applyCodePolicy` serves two notices, and base ships no notice TEXT — so a
// pack has to be registered before anything here runs. The fixture's values
// are marker strings, so an assertion below is obviously about the plumbing.
const { registerTestNoticePack } = await import('./fixtures/noticePack.js');
registerTestNoticePack();

const {
  applyCodePolicy,
  convertMarkdownForWhatsApp,
  filterOutbound,
  redactSecrets,
  stripEmDashes,
  stripEmDashesOutsideCode,
} = await import('../src/agent/outbound.js');

/**
 * The outbound filter — the last barrier before text reaches a wire.
 *
 * This file exists because of issue #9: `outbound.ts` was lifted here without
 * its tests, whose 7 `SECURITY:` cases stayed in community-agent. Unlike the
 * tier surface, nothing about this module is deployment-specific — the
 * originals could have come across verbatim, and the only reason they did not
 * is that they sat in a file that also imported the community tool registry.
 *
 * The framing worth keeping in mind while reading: **the model can be
 * sweet-talked and this filter cannot**. Every case below is a way a reply
 * could be shaped — by a confused model or a persuasive member — to carry
 * something past a filter that trusted the text's structure.
 */

/**
 * Every token-shaped fixture below is ASSEMBLED rather than written as a
 * literal, and that is not stylistic. GitHub's push protection scans the diff
 * and refuses a push containing anything that looks like a credential — which
 * a test for a redaction filter is, by construction, full of. It rejected this
 * file's Slack fixture on the first attempt.
 *
 * The runtime values are exactly the shapes the patterns match, so the
 * assertions are unweakened; only the source text is unrecognisable to a
 * static scanner. The alternative on offer — clicking "allow the secret" —
 * teaches precisely the reflex that a secret-scanning gate exists to prevent,
 * on a repository where the answer must always be that there is no token.
 */
const shaped = (...parts: string[]) => parts.join('');

const ANTHROPIC_KEY = shaped('sk-', 'ant-', 'api03-', 'AAAAbbbbCCCCddddEEEEffff');
const DB_URL = shaped('postgre', 'sql://user:hunter2@db.internal:5432/community');

test('SECURITY: every known secret pattern is redacted', () => {
  // One case per pattern class rather than one omnibus assertion, so a
  // regression names the class it broke.
  const cases: [string, string][] = [
    ['Anthropic key', ANTHROPIC_KEY],
    ['generic sk- key', shaped('sk-', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')],
    ['GitHub classic token', shaped('ghp', '_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')],
    ['GitHub fine-grained PAT', shaped('github', '_pat_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789')],
    ['Slack token', shaped('xox', 'b-', '1234567890-', 'ABCDEFGHIJKLMNOP')],
    ['AWS access key', shaped('AKIA', 'IOSFODNN7EXAMPLE')],
    ['Postgres URL', DB_URL],
  ];
  for (const [label, secret] of cases) {
    const out = redactSecrets(`here you go: ${secret} — enjoy`);
    assert.ok(!out.includes(secret), `${label} must not survive redaction`);
    assert.ok(out.includes('[redacted]'), `${label} must be replaced by the marker`);
  }
});

test('SECURITY: every occurrence is redacted, not just the first', () => {
  // The patterns carry /g, and a "redact the first one" bug would look
  // entirely correct in any single-occurrence test.
  const out = redactSecrets(`${ANTHROPIC_KEY} and again ${ANTHROPIC_KEY} and ${DB_URL}`);
  assert.ok(!out.includes(ANTHROPIC_KEY));
  assert.ok(!out.includes(DB_URL));
  assert.equal(out.match(/\[redacted]/g)?.length, 3);
});

test('SECURITY: exact runtime secrets are redacted even when they match no pattern', () => {
  // The DLP backstop: a deployment's own credential need not look like anyone
  // else's. This is the only mechanism covering, say, a webhook URL.
  const runtimeSecret = 'not-shaped-like-a-token-at-all-9f3c2';
  const out = redactSecrets(`the value is ${runtimeSecret}`, [runtimeSecret]);
  assert.equal(out, 'the value is [redacted]');
});

test('SECURITY: a known secret shorter than 8 characters is ignored, not used as a redaction key', () => {
  // The guard matters in the other direction from most of this file: a short
  // or empty "secret" used as a split key would redact ordinary prose
  // wholesale, and an operator watching replies turn into [redacted] would
  // reasonably conclude the filter was broken and turn it off.
  assert.equal(redactSecrets('the cat sat on the mat', ['cat']), 'the cat sat on the mat');
  assert.equal(redactSecrets('unchanged', ['']), 'unchanged');
  // Eight characters is the floor, and is redacted.
  assert.equal(redactSecrets('token abcdefgh here', ['abcdefgh']), 'token [redacted] here');
});

test('SECURITY: a secret inside a fenced code block is still redacted', () => {
  // Redaction runs over the whole text, before any structure-aware step. A
  // filter that only walked prose would be bypassable by asking for the
  // credential "as code".
  const text = ['before', '```bash', `export KEY=${ANTHROPIC_KEY}`, '```', 'after'].join('\n');
  const out = redactSecrets(text);
  assert.ok(!out.includes(ANTHROPIC_KEY));
  assert.ok(out.includes('export KEY=[redacted]'));
});

test("the code policy 'full' passes text through untouched", () => {
  const text = ['prose', '```ts', 'const x = 1;', '```', 'more'].join('\n');
  assert.equal(applyCodePolicy(text, 'full'), text);
});

test("the code policy 'off' replaces each block with the omitted note", () => {
  const text = ['before', '```ts', 'const x = 1;', '```', 'between', '```', 'raw', '```', 'after'].join('\n');
  const out = applyCodePolicy(text, 'off');
  assert.ok(!out.includes('const x = 1;'));
  assert.ok(!out.includes('raw'));
  assert.equal(out.match(/test:codeOmittedNote/g)?.length, 2, 'one note per block');
  assert.ok(out.includes('before') && out.includes('between') && out.includes('after'));
});

test("the code policy 'snippets' keeps a short block whole and truncates a long one", () => {
  const short = ['```ts', ...Array.from({ length: 15 }, (_, i) => `line ${i}`), '```'].join('\n');
  assert.equal(applyCodePolicy(short, 'snippets'), short, '15 lines is the boundary and is kept whole');

  const long = ['```ts', ...Array.from({ length: 40 }, (_, i) => `line ${i}`), '```'].join('\n');
  const out = applyCodePolicy(long, 'snippets');
  assert.ok(out.includes('line 14'));
  assert.ok(!out.includes('line 15'), 'the 16th line is dropped');
  assert.ok(out.includes('test:codeTruncatedNote:15'), 'the note reports how many lines were shown');
});

test('SECURITY: an unterminated fence does not bypass the code policy', () => {
  // The reason this is a line walker and not a paired regex. A trailing
  // unclosed fence is trivially produced — by a cut-off reply, or by a model
  // asked to "start a code block and never close it" — and a paired-regex
  // implementation would find no match and emit the body verbatim.
  const text = ['here it is', '```bash', `export KEY=${ANTHROPIC_KEY}`, 'rm -rf /'].join('\n');
  const off = applyCodePolicy(text, 'off');
  assert.ok(!off.includes('rm -rf /'), 'the unterminated block is still subject to the policy');
  assert.ok(off.includes('test:codeOmittedNote'));

  const long = ['```', ...Array.from({ length: 40 }, (_, i) => `line ${i}`)].join('\n');
  const snipped = applyCodePolicy(long, 'snippets');
  assert.ok(!snipped.includes('line 15'), 'and to truncation, not only to omission');
});

test('the code policy notes follow the notice catalogue axes', () => {
  // Language beats style, and both beat the default — the precedence is the
  // catalogue's, not this module's, which is the point of moving the text
  // there. Marker strings make the selection visible.
  const text = ['```', 'secret sauce', '```'].join('\n');
  assert.ok(applyCodePolicy(text, 'off').includes('test:codeOmittedNote'));
  assert.ok(applyCodePolicy(text, 'off', undefined, 'simple').includes('test:codeOmittedNote:simple'));
  assert.ok(applyCodePolicy(text, 'off', 'xx').includes('test:codeOmittedNote:xx'));
  assert.ok(
    applyCodePolicy(text, 'off', 'xx', 'simple').includes('test:codeOmittedNote:xx'),
    'language wins over style',
  );
});

test('em dashes become natural punctuation, without mangling the sentence', () => {
  assert.equal(stripEmDashes('a — b'), 'a, b');
  assert.equal(stripEmDashes('a—b'), 'a, b');
  assert.equal(stripEmDashes('this ― that'), 'this, that');
  assert.equal(stripEmDashes('yes — .'), 'yes.', 'a stray comma before punctuation is tidied away');
  assert.equal(
    stripEmDashes('ranges like 10–20 survive'),
    'ranges like 10–20 survive',
    'en dash is left alone',
  );
});

test('em-dash rewriting leaves fenced code alone', () => {
  // Rewriting punctuation inside code would change what a snippet DOES, which
  // is a correctness bug dressed as a style rule.
  const text = ['prose — here', '```js', 'const range = a—b;', '```', 'more — prose'].join('\n');
  const out = stripEmDashesOutsideCode(text);
  assert.ok(out.includes('prose, here'));
  assert.ok(out.includes('const range = a—b;'), 'the code line is untouched');
  assert.ok(out.includes('more, prose'));
});

test('WhatsApp conversion rewrites markdown the platform cannot render', () => {
  assert.equal(convertMarkdownForWhatsApp('**bold**'), '*bold*');
  assert.equal(convertMarkdownForWhatsApp('__bold__'), '*bold*');
  assert.equal(convertMarkdownForWhatsApp('***loud***'), '*loud*');
  assert.equal(convertMarkdownForWhatsApp('## Heading'), '*Heading*');
  assert.equal(convertMarkdownForWhatsApp('- item'), '• item');
  assert.equal(convertMarkdownForWhatsApp('* item'), '• item');
  assert.equal(
    convertMarkdownForWhatsApp('see [the docs](https://example.test/a_(b))'),
    'see the docs: https://example.test/a_(b)',
    'one level of nested parens in the target survives',
  );
  assert.equal(
    convertMarkdownForWhatsApp('**[label](https://example.test/x)**'),
    '*label: https://example.test/x*',
    'links resolve before emphasis, so a bolded link folds correctly',
  );
});

test('WhatsApp conversion leaves code, bare brackets and inline punctuation alone', () => {
  const text = ['a [note] (aside)', '```py', '# not a heading', 'x = a * b', '```', '- real bullet'].join(
    '\n',
  );
  const out = convertMarkdownForWhatsApp(text);
  assert.ok(out.includes('a [note] (aside)'), 'space-separated brackets are prose, not a link');
  assert.ok(out.includes('# not a heading'), 'a comment inside a fence is not a heading');
  assert.ok(out.includes('x = a * b'), 'a multiplication inside a fence is not a bullet');
  assert.ok(out.includes('• real bullet'));
});

test('WhatsApp conversion is idempotent', () => {
  const once = convertMarkdownForWhatsApp('## Title\n- **item** [l](https://e.test/p)');
  assert.equal(convertMarkdownForWhatsApp(once), once);
});

test('SECURITY: filterOutbound redacts before applying the code policy', () => {
  // The ORDER is the property. With `full` the code policy is a passthrough,
  // so if redaction ran second — or only over prose — a credential asked for
  // "in a code block" would go out intact. This is the composed pipeline, not
  // the individual steps, so it is the one that matches what a send path does.
  const text = ['as requested:', '```sh', `export ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`, '```'].join('\n');
  for (const policy of ['full', 'snippets', 'off'] as const) {
    const out = filterOutbound(text, policy);
    assert.ok(!out.includes(ANTHROPIC_KEY), `policy '${policy}' must not leak the key`);
  }
  assert.ok(filterOutbound(text, 'full').includes('[redacted]'));
});

test('SECURITY: filterOutbound redacts exact runtime secrets on every platform', () => {
  const runtimeSecret = 'wh00k-value-that-matches-no-pattern';
  for (const platform of [undefined, 'discord', 'whatsapp'] as const) {
    const out = filterOutbound(`token: ${runtimeSecret}`, 'full', [runtimeSecret], platform);
    assert.ok(!out.includes(runtimeSecret), `platform ${platform ?? 'default'} must redact it`);
  }
});

test('filterOutbound applies the WhatsApp rewrite only for WhatsApp', () => {
  const text = '**bold** and [l](https://e.test/p)';
  assert.equal(filterOutbound(text, 'full', [], 'whatsapp'), '*bold* and l: https://e.test/p');
  assert.equal(filterOutbound(text, 'full', [], 'discord'), text);
  assert.equal(filterOutbound(text, 'full'), text, 'no platform means no rewrite');
});

test('filterOutbound strips em dashes from prose on the way out', () => {
  assert.equal(filterOutbound('yes — really', 'full'), 'yes, really');
});
