-- ---------------------------------------------------------------------------
-- Conversation <-> Claude session mapping (for multi-turn continuity).
-- One Claude session id per (platform, conversation).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform      TEXT        NOT NULL,
  conversation_id TEXT      NOT NULL,
  claude_session_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, conversation_id)
);

DROP TRIGGER IF EXISTS sessions_set_updated_at ON sessions;
CREATE TRIGGER sessions_set_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Session hygiene: cap resumed-session length (see agent/core.ts).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turn_count INT NOT NULL DEFAULT 0;
-- Fingerprint (sha256) of the system prompt the stored session was started
-- under. A resumed Agent SDK session keeps its ORIGINAL system prompt and
-- ignores the one passed on resume, so a session is only resumable while the
-- prompt is byte-identical (same requester tier, persona, preferences, day).
-- NULL (a pre-fingerprint row) is never resumed. See agent/core.ts.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS prompt_hash TEXT;
