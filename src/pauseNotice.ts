/**
 * Pause notice (issue #128): the shared `shouldNotifyAfterWindow` debounce
 * (util/noticeDebounce.ts) under a domain name, debounced against a longer
 * window than the rate-limit notice: a pause is typically longer-lived than
 * a rate-limit burst, so re-notifying on every addressed message would be
 * noisy — once per window is enough to reassure a member the bot isn't
 * broken.
 *
 * The TEXT is served from the strings catalogue at the router's call site
 * (`notice('pauseNotice', { language, style })`); see rateLimitNotice.ts for
 * why no derived constants live here any more.
 */

export { shouldNotifyAfterWindow as shouldNotifyPaused } from './util/noticeDebounce.js';
