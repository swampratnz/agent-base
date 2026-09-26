import type { CodeAnswersPolicy } from '../storage/policyStore.js';
import { notice } from '../strings/catalogue.js';

/**
 * Outbound reply filter (DLP + behaviour policy), applied to every message
 * the bot sends. The model can be sweet-talked; this filter cannot.
 */

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[\w-]{8,}\b/g, // Anthropic keys/tokens
  /\bsk-[A-Za-z0-9]{20,}\b/g, // generic sk- API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub classic tokens (ghp_/gho_/…)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PATs (audit M2)
  /\bxox[baprs]-[\w-]{10,}\b/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access keys
  /\bpostgres(?:ql)?:\/\/\S+/gi, // connection strings
];

const REDACTED = '[redacted]';
const SNIPPET_MAX_LINES = 15;

// The code-policy note texts (default base plus per-axis variants, issue #339,
// plain-language variant issue #657) live in the strings catalogue
// (`strings/catalogue.ts`), which also owns the language-over-style selection
// precedence the two ternaries here used to encode. Same trust level as
// before: fixed, human-authored text, no model call, no translation, no
// injection surface beyond the interpolated line count.

/**
 * Redact secrets. `knownSecrets` are exact runtime values (tokens, DB URLs)
 * that must never appear in output regardless of pattern matching.
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Enforce the code_answers policy on fenced code blocks. Implemented as a
 * line walker (not a paired regex) so an UNTERMINATED fence — trivially
 * produced by a sweet-talked model or a cut-off reply — is treated as
 * running to end-of-text instead of bypassing the policy.
 */
export function applyCodePolicy(
  text: string,
  policy: CodeAnswersPolicy,
  language?: string,
  style?: string,
): string {
  if (policy === 'full') return text;

  const omittedNote = notice('codeOmittedNote', { language, style });
  const truncatedNote = notice('codeTruncatedNote', { language, style });

  const out: string[] = [];
  let fenceHeader: string | null = null;
  let body: string[] = [];

  const flushBlock = () => {
    if (policy === 'off') {
      out.push(omittedNote);
    } else if (body.length <= SNIPPET_MAX_LINES) {
      out.push(fenceHeader as string, ...body, '```');
    } else {
      out.push(
        fenceHeader as string,
        ...body.slice(0, SNIPPET_MAX_LINES),
        '```' + truncatedNote(SNIPPET_MAX_LINES),
      );
    }
    fenceHeader = null;
    body = [];
  };

  for (const line of text.split('\n')) {
    if (fenceHeader === null) {
      if (/^\s*```/.test(line)) fenceHeader = line;
      else out.push(line);
    } else if (/^\s*```\s*$/.test(line)) {
      flushBlock();
    } else {
      body.push(line);
    }
  }
  // Unterminated fence: apply the policy to the trailing block anyway.
  if (fenceHeader !== null) flushBlock();

  return out.join('\n');
}

// One run of em dashes (U+2014) or horizontal bars (U+2015) with the spaces
// around it. The en dash (U+2013) is never matched, so "10–20" survives.
const DASH_RUN = /[ \t]*[—―]+[ \t]*/g;
// What may sit between the start of a line and its first word without that
// word stopping being the line's first: indentation, blockquote markers, a
// list bullet or number. A dash here is a lead-in ("— Sam"), not a joint.
const LINE_LEAD = /^\s*(?:>\s*)*(?:[-*+•]\s+|\d+[.)]\s+)?$/;
// Inline markdown emphasis/code markers. A dash wrapped in them on both sides
// ("**—**") is a placeholder standing on its own, typically an empty cell.
const MARKER = /[*_~`]/;
// A markdown table row. Every dash in one is kept as a plain hyphen: a cell
// is copied as data, and ", " there reads as a corrupted value.
const TABLE_ROW = /^\s*\|/;

function dashReplacement(before: string, after: string, tableRow: boolean): string {
  const prev = before.at(-1) ?? '';
  const next = after[0] ?? '';
  if (tableRow) return '-';
  if (/\d/.test(prev) && /\d/.test(next)) return '–'; // a numeric range
  if (MARKER.test(prev) && MARKER.test(next)) return '-'; // "**—**" placeholder
  if (LINE_LEAD.test(before)) return ''; // "— Sam" lead-in: drop the dash
  if (after.trim() === '') return ''; // trailing dash: drop it
  if (/[.!?]/.test(prev)) return '\n'; // "next time. — Sam" is a sign-off
  if (/[,;:]/.test(prev)) return ' '; // punctuation already joins the halves
  // Straight quotes are in neither set: `"` may open or close, and a quoted
  // title between two dashes ("#9 — "topic" — filed") reads as a list.
  if (/[([{“‘]/.test(prev)) return ''; // "(— aside" -> "(aside"
  if (/[.,!?;:)\]}”’]/.test(next)) return ''; // "yes — ." -> "yes."
  return ', '; // "a — b" -> "a, b"
}

function stripEmDashesInProse(segment: string, before: string, tableRow: boolean): string {
  return segment.replace(DASH_RUN, (match, offset: number) => {
    const lead = before + segment.slice(0, offset);
    const trail = segment.slice(offset + match.length);
    const replacement = dashReplacement(lead, trail, tableRow);
    // In a table the spacing is the author's layout; keep it.
    if (tableRow) return match.replace(/[—―]+/, replacement);
    // A dash that was a lead-in keeps the indentation in front of it.
    if (replacement === '' && LINE_LEAD.test(lead)) return match.match(/^[ \t]*/)?.[0] ?? '';
    return replacement;
  });
}

/**
 * Rewrite em dashes into natural punctuation. The system prompt asks the model
 * not to use them; this guarantees none reach the community even when it
 * disobeys. Targets the em dash (U+2014) and horizontal bar (U+2015) only —
 * the en dash (U+2013) is left alone so numeric ranges like "10–20" survive.
 *
 * Each dash is replaced by what reads naturally where it stands, and the rest
 * of the line is never touched: the rule once ran blanket comma-tidying over
 * every line, and a blanket ", " turned a table cell's "**—**" into "**, **"
 * and a sign-off "next time. — Sam" into "next time., Sam" (WattoBot #289).
 * So: a table row keeps a hyphen, a dash wrapped in markers is a hyphen, a
 * lead-in or trailing dash goes, a dash after a full stop starts a new line,
 * one after a comma or colon becomes a space, one before punctuation goes, a
 * digit-to-digit dash becomes an en dash, and only a dash between two words
 * becomes ", ". Inline code spans are left alone, like fenced blocks.
 */
export function stripEmDashes(line: string): string {
  if (!/[—―]/.test(line)) return line;
  const tableRow = TABLE_ROW.test(line);
  // Odd-indexed parts are inline code spans (`...`); only prose is rewritten.
  const parts = line.split(/(`[^`]*`)/);
  let done = '';
  for (let i = 0; i < parts.length; i++) {
    done += i % 2 === 1 ? parts[i] : stripEmDashesInProse(parts[i], done, tableRow);
  }
  return done;
}

/** Apply {@link stripEmDashes} to prose only, leaving fenced code blocks untouched. */
export function stripEmDashesOutsideCode(text: string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : stripEmDashes(line);
    })
    .join('\n');
}

const BOLD_TRIPLE = /\*\*\*(.+?)\*\*\*/g;
const UNDERSCORE_TRIPLE = /___(.+?)___/g;
const BOLD_DOUBLE = /\*\*(.+?)\*\*/g;
const UNDERSCORE_DOUBLE = /__(.+?)__/g;
const HEADING_LINE = /^(\s*)#{1,6}\s+(.*)$/;
const BULLET_LINE = /^(\s*)[-*]\s+(.*)$/;
// `[label](http(s)://url)` -> `label: http(s)://url`. Constrained to an
// http(s) target immediately inside the parens (no space after `]`) so bare
// `[]`/`()` prose and space-separated shapes like `[note] (aside)` never
// match. The URL segment allows one level of nested `(...)` so a target like
// a Wikipedia `.../Foo_(bar)` link isn't truncated at the inner `)`.
const MARKDOWN_LINK = /\[([^\]]+)\]\((https?:\/\/(?:[^()\s]|\([^()]*\))+)\)/g;

function convertInlineEmphasis(line: string): string {
  return line
    .replace(BOLD_TRIPLE, '*$1*')
    .replace(UNDERSCORE_TRIPLE, '*$1*')
    .replace(BOLD_DOUBLE, '*$1*')
    .replace(UNDERSCORE_DOUBLE, '*$1*');
}

function convertMarkdownLinks(line: string): string {
  return line.replace(MARKDOWN_LINK, '$1: $2');
}

/**
 * Rewrite Discord/GFM-flavoured markdown into WhatsApp-readable formatting:
 * `[label](url)` -> `label: url`, `**bold**`/`__bold__` -> `*bold*`,
 * `# Heading` -> `*Heading*`, `- item`/`* item` bullets -> `• item`. Line-anchored
 * and fence-aware (same walker style as {@link stripEmDashesOutsideCode}) so code
 * blocks and inline `*`/`#`/`[]`/`()` in prose are never touched. Links are
 * resolved before emphasis so a bolded link label (`**[label](url)**`) still
 * folds correctly. Idempotent: re-running on already-converted text is a no-op.
 */
export function convertMarkdownForWhatsApp(text: string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;

      const linked = convertMarkdownLinks(line);

      const heading = linked.match(HEADING_LINE);
      if (heading) return `${heading[1]}*${convertInlineEmphasis(heading[2])}*`;

      const emphasised = convertInlineEmphasis(linked);
      const bullet = emphasised.match(BULLET_LINE);
      if (bullet) return `${bullet[1]}• ${bullet[2]}`;

      return emphasised;
    })
    .join('\n');
}

export type OutboundPlatform = 'discord' | 'whatsapp';

// `language`/`style` are OPEN strings (agent-base plan item 6): the caller's
// standing preferences are passed raw, and `strings/catalogue.ts`'s registered
// axes decide what they select — unregistered values mean the default text.
// The DB-facing preference unions and the set_* tool input enums stay closed
// (see strings/catalogue.ts's note on that tension).
export function filterOutbound(
  text: string,
  policy: CodeAnswersPolicy,
  knownSecrets: readonly string[] = [],
  platform?: OutboundPlatform,
  language?: string,
  style?: string,
): string {
  const filtered = stripEmDashesOutsideCode(
    applyCodePolicy(redactSecrets(text, knownSecrets), policy, language, style),
  );
  return platform === 'whatsapp' ? convertMarkdownForWhatsApp(filtered) : filtered;
}
