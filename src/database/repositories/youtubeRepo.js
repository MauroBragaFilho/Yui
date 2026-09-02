import { getDbWrapper } from '../db.js';

const dbWrapper = getDbWrapper('social-youtube');

export const youtubeRepository = {
  // ── Subscriptions ──────────────────────────────────────────────

  getAllSubscriptions() {
    const stmt = dbWrapper.prepare('SELECT * FROM youtube_subscriptions');
    return stmt.all();
  },

  getSubscriptionsByGuild(guildId) {
    const stmt = dbWrapper.prepare(
      'SELECT * FROM youtube_subscriptions WHERE guild_id = ?'
    );
    return stmt.all(guildId);
  },

  getSubscriptionsByChannel(youtubeChannelId) {
    const stmt = dbWrapper.prepare(
      'SELECT * FROM youtube_subscriptions WHERE youtube_channel_id = ?'
    );
    return stmt.all(youtubeChannelId);
  },

  /**
   * Retorna todos os canais únicos cadastrados em todas as guildas,
   * já com a uploads playlist para consulta eficiente na API.
   * Usado pelo engine para saber quais canais consultar.
   */
  getAllTrackedChannels() {
    const stmt = dbWrapper.prepare(`
      SELECT DISTINCT youtube_channel_id, channel_name, uploads_playlist_id
      FROM youtube_subscriptions
    `);
    return stmt.all();
  },

  addSubscription({
    guildId,
    youtubeChannelId,
    channelName,
    uploadsPlaylistId = null,
    discordChannelId,
    mentionRoleId = null,
    notifyVideos = 1,
    notifyShorts = 1,
    notifyLives = 1,
  }) {
    const stmt = dbWrapper.prepare(`
      INSERT OR IGNORE INTO youtube_subscriptions
        (guild_id, youtube_channel_id, channel_name, uploads_playlist_id,
         discord_channel_id, mention_role_id, notify_videos, notify_shorts, notify_lives)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(
      guildId,
      youtubeChannelId,
      channelName,
      uploadsPlaylistId,
      discordChannelId,
      mentionRoleId,
      notifyVideos,
      notifyShorts,
      notifyLives
    );
  },

  removeSubscription(guildId, youtubeChannelId, discordChannelId) {
    const stmt = dbWrapper.prepare(
      'DELETE FROM youtube_subscriptions WHERE guild_id = ? AND youtube_channel_id = ? AND discord_channel_id = ?'
    );
    return stmt.run(guildId, youtubeChannelId, discordChannelId);
  },

  removeByGuildAndChannel(guildId, youtubeChannelId) {
    const stmt = dbWrapper.prepare(
      'DELETE FROM youtube_subscriptions WHERE guild_id = ? AND youtube_channel_id = ?'
    );
    return stmt.run(guildId, youtubeChannelId);
  },

  // ── Seen Items (dedupe + estado de live) ───────────────────────

  getSeenItem(videoId) {
    const stmt = dbWrapper.prepare(
      'SELECT * FROM youtube_seen_items WHERE video_id = ?'
    );
    return stmt.get(videoId);
  },

  upsertSeenItem(videoId, youtubeChannelId, state) {
    const stmt = dbWrapper.prepare(`
      INSERT INTO youtube_seen_items (video_id, youtube_channel_id, last_known_state, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(video_id) DO UPDATE SET
        last_known_state = excluded.last_known_state,
        updated_at = CURRENT_TIMESTAMP
    `);
    return stmt.run(videoId, youtubeChannelId, state);
  },
};