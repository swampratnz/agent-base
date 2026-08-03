-- ---------------------------------------------------------------------------
-- Standing language-reply preference (issue #189), set by a module's
-- member/guest-tier `set_language_preference` tool so a caller who wants every reply in a
-- specific language doesn't need to re-ask each message. Keyed on raw
-- (platform, user_id) like `response_style_prefs` above, not
-- the users table, so it works for a guest in open mode too. No row (or
-- 'auto') means today's default per-message language-mirroring behaviour
-- (issue #68) — see `getLanguagePreference` in repository.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS language_prefs (
  platform      TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,
  -- Shape CHECK, not a value allowlist — see 17-prefs.sql's `style` column.
  -- community-agent pinned CHECK (language IN ('auto', 'en', 'mi')) here;
  -- 'mi' is that community's content, not a framework fact.
  language      TEXT        NOT NULL DEFAULT 'auto' CHECK (language ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(language) <= 32),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, user_id)
);
