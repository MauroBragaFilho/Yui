const MEMORIES_TABLE = `
  CREATE TABLE IF NOT EXISTS memories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT    NOT NULL,
    type        TEXT    NOT NULL DEFAULT 'fact'
                CHECK (type IN ('fact','preference','project','decision','summary','note')),
    content     TEXT    NOT NULL,
    tags        TEXT    NOT NULL DEFAULT '',
    source      TEXT    NOT NULL DEFAULT '',
    importance  INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    expires_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, type);
  CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at);
`;

/** Memória permanente do proprietário. Nunca expira. */
export const MEMORY_PERSONAL_SCHEMA = MEMORIES_TABLE;

/** Memória temporária dos usuários do Discord (retenção por última interação). */
export const MEMORY_DISCORD_SCHEMA = `
  ${MEMORIES_TABLE}
  CREATE TABLE IF NOT EXISTS memory_users (
    user_id    TEXT PRIMARY KEY,
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );
`;
