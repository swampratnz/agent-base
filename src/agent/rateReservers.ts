import { makeCalendarDayReserver, makeSlidingWindowReserver } from '../util/rateReservation.js';

// The two media-input reservation caps the platform adapters check before
// downloading anything. They live in their own leaf module (not tools.ts)
// because the adapters are their only callers — the caps bound inbound media
// handling, not any MCP tool.

/**
 * Discord image-attachment fetches per platform-qualified sender, for the
 * rolling calendar-day cap (IMAGE_INPUT_DAILY_LIMIT_PER_USER, issue #783) —
 * same calendar-day shape as reserveImageGenDaily/reserveDevTeamDispatchDaily,
 * bounding the real per-image multimodal token cost a single caller could run
 * up. Checked in the adapter BEFORE the MIME/byte check and any fetch, per
 * the acceptance criteria, so an at-cap sender never has their attachment
 * inspected further. `key` MUST be platform-qualified (`` `discord:${senderId}` ``)
 * even though only Discord implements image input today, matching the
 * defensive convention `reserveVoiceTranscriptionSlot` already established.
 */
export const reserveImageInputDaily = makeCalendarDayReserver();

/**
 * Discord text-attachment fetches per platform-qualified sender, for the
 * rolling calendar-day cap (TEXT_INPUT_DAILY_LIMIT_PER_USER). Its own bucket
 * rather than a share of `reserveImageInputDaily`: the two caps bound different
 * costs (a few hundred KB of prose against a multimodal image) and default to
 * different numbers, so pooling them would let a day of screenshots silently
 * exhaust someone's ability to attach a file. Checked in the adapter BEFORE the
 * MIME/byte check and any fetch, so an at-cap sender's attachment is never
 * inspected further. `key` MUST be platform-qualified (`` `discord:${senderId}` ``),
 * matching the convention the two reservers above already established.
 */
export const reserveTextInputDaily = makeCalendarDayReserver();

/**
 * Reserve one voice-transcription slot for `key` against a rolling hourly
 * cap (issue #507; platform-qualified in issue #732 —
 * `config.whatsapp.voice.rateLimitPerHour` /
 * `config.discord.voice.rateLimitPerHour`). Per-sender rather than
 * per-conversation (unlike `reserveWebSearchSlot`) since this bounds one
 * person's own audio volume, not a shared conversation. Returns false
 * without reserving if the sender already hit `limit` within the last hour.
 * Called from `BaileysAdapter`/`DiscordAdapter` BEFORE any media download,
 * so a refused slot never triggers a download/decode/model run. Callers must
 * skip this entirely when `limit` is 0 (unlimited) so the default
 * configuration does no bookkeeping. `key` MUST be platform-qualified
 * (e.g. `` `whatsapp:${senderId}` ``/`` `discord:${senderId}` ``) — a bare
 * sender id would let a WhatsApp phone number and a Discord snowflake that
 * happen to collide share one quota bucket across platforms (issue #732).
 */
export const reserveVoiceTranscriptionSlot = makeSlidingWindowReserver(60 * 60 * 1000);
