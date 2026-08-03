/**
 * Debounce for the caveat DM sent to a voice-note sender whose standing
 * language preference names a REGISTERED language variant (issue #655): the
 * configured voice model is English-only (docs/SECURITY.md), so their
 * transcript may be garbled with zero other signal that anything went wrong.
 *
 * The TEXT is served from the strings catalogue at each adapter's call site
 * (`notice('voiceLanguageCaveat', { language })`) — a fixed, human-authored
 * pack value, never built from the transcript or any runtime input. The
 * adapters decide WHETHER to send it with `isRegisteredLanguage()`, so base
 * names no locale; community-agent's `=== 'mi'` check and its
 * `VOICE_LANGUAGE_CAVEAT_TEXT_MI` constant are both gone.
 */

export { shouldNotifyAfterWindow as shouldNotify } from './util/noticeDebounce.js';
