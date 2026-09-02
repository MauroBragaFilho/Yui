/**
 * Schemas SQL separados por banco de dados. Cada domínio de dados vive no
 * seu próprio arquivo .db (veja src/database/db.js), permitindo separar
 * o GTA Online de futuros jogos sem misturar tabelas.
 */

// core.db — infraestrutura compartilhada entre TODOS os jogos/domínios:
// configuração de canais por servidor e rastreamento de mensagens
// publicadas (deduplicação). Não é exclusivo de nenhum jogo específico.
export const CORE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    news_channel_id TEXT,
    daily_channel_id TEXT,
    weekly_channel_id TEXT,
    vehicles_channel_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS published_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_type TEXT NOT NULL,
    content_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    published_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_published_lookup ON published_messages (content_type, content_id, guild_id);
`;

// newswire.db — histórico de notícias do Rockstar Newswire.
export const NEWSWIRE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS news_articles (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    category TEXT,
    thumbnail_url TEXT,
    published_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_news_published_at ON news_articles (published_at DESC);
`;

// gta-diario.db — snapshots dos resets diários do GTA Online
// (Van de Armas, Comerciantes, Colecionáveis, Desafios Contra o Relógio).
export const GTA_DAILY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS daily_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reset_date TEXT UNIQUE NOT NULL,
    data_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

// gta-semanal.db — snapshots dos eventos semanais do GTA Online
// (bônus, descontos, veículos, análise da IA).
export const GTA_WEEKLY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS weekly_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_week TEXT UNIQUE NOT NULL,
    data_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

// social-youtube.db — monitoramento de canais do YouTube
// (subscriptions por guilda + itens vistos para deduplicação/estado de live)
export const YOUTUBE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS youtube_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    youtube_channel_id TEXT NOT NULL,
    channel_name TEXT,
    uploads_playlist_id TEXT,
    discord_channel_id TEXT NOT NULL,
    mention_role_id TEXT,
    notify_videos INTEGER DEFAULT 1,
    notify_shorts INTEGER DEFAULT 1,
    notify_lives INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(guild_id, youtube_channel_id, discord_channel_id)
  );

  CREATE TABLE IF NOT EXISTS youtube_seen_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT UNIQUE NOT NULL,
    youtube_channel_id TEXT NOT NULL,
    last_known_state TEXT NOT NULL DEFAULT 'video',
    first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_yt_seen_channel ON youtube_seen_items (youtube_channel_id);
`;

// social-twitch.db — monitoramento de streamers da Twitch
// (subscriptions por guilda + estado de stream para detecção online/offline)
export const TWITCH_SCHEMA = `
  CREATE TABLE IF NOT EXISTS twitch_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    twitch_login TEXT NOT NULL,
    twitch_user_id TEXT,
    discord_channel_id TEXT NOT NULL,
    mention_role_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(guild_id, twitch_login, discord_channel_id)
  );

  CREATE TABLE IF NOT EXISTS twitch_stream_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    twitch_login TEXT UNIQUE NOT NULL,
    is_live INTEGER DEFAULT 0,
    last_stream_id TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;
