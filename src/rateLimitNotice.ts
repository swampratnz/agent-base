/**
 * Per-user rate-limit notice: the shared `shouldNotifyAfterWindow` debounce
 * (util/noticeDebounce.ts) under a domain name, debounced against the
 * rate-limit window so a burst of over-limit messages produces exactly one
 * notice per episode.
 *
 * The TEXT is not here: it is served from the strings catalogue at the
 * router's call site (`notice('rateLimitNotice', { language, style })`) with
 * the caller's standing preferences passed raw. community-agent additionally
 * derived `RATE_LIMIT_NOTICE_TEXT`/`_MI`/`_PLAIN` here; both the locale
 * naming and the import-time rendering had to go (see strings/catalogue.ts).
 */

export { shouldNotifyAfterWindow as shouldNotifyRateLimited } from './util/noticeDebounce.js';
