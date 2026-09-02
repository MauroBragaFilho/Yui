import { getDbWrapper } from '../db.js';

const dbWrapper = getDbWrapper('social-twitch');

export const twitchRepository = {
  // ── Subscriptions ──────────────────────────────────────────────

  getAllSubscriptions() {
    const stmt = dbWrapper.prepare('SELECT * FROM twitch_subscriptions');
    return stmt.all();
  },

  getSubscriptionsByGuild(guildId) {
    const stmt = dbWrapper.prepare(
      'SELECT * FROM twitch_subscriptions WHERE guild_id = ?'
    );
    return stmt.all(guildId);
  },

  getSubscriptionsByLogin(twitchLogin) {
    const stmt = dbWrapper.prepare(
      'SELECT * FROM twitch_subscriptions WHERE twitch_login = ?'
    );
    return stmt.all(twitchLogin);
  },

  /**
   * Retorna todos os twitch_login únicos cadastrados em todas as guildas.
   * Usado pelo engine para consultar a Helix API em batch.
   */
  getAllTrackedLogins() {
    const stmt = dbWrapper.prepare(
      'SELECT DISTINCT twitch_login FROM twitch_subscriptions'
    );
    return stmt.all().map((r) => r.twitch_login);
  },

  addSubscription({
    guildId,
    twitchLogin,
    twitchUserId = null,
    discordChannelId,
    mentionRoleId = null,
  }) {
    const stmt = dbWrapper.prepare(`
      INSERT OR IGNORE INTO twitch_subscriptions
        (guild_id, twitch_login, twitch_user_id, discord_channel_id, mention_role_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    return stmt.run(guildId, twitchLogin, twitchUserId, discordChannelId, mentionRoleId);
  },

  removeSubscription(guildId, twitchLogin, discordChannelId) {
    const stmt = dbWrapper.prepare(
      'DELETE FROM twitch_subscriptions WHERE guild_id = ? AND twitch_login = ? AND discord_channel_id = ?'
    );
    return stmt.run(guildId, twitchLogin, discordChannelId);
  },

  removeByGuildAndLogin(guildId, twitchLogin) {
    const stmt = dbWrapper.prepare(
      'DELETE FROM twitch_subscriptions WHERE guild_id = ? AND twitch_login = ?'
    );
    return stmt.run(guildId, twitchLogin);
  },

  // ── Stream State (controle de transição online/offline) ─────────

  getStreamState(twitchLogin) {
    const stmt = dbWrapper.prepare(
      'SELECT * FROM twitch_stream_state WHERE twitch_login = ?'
    );
    return stmt.get(twitchLogin);
  },

  upsertStreamState(twitchLogin, isLive, streamId) {
    const stmt = dbWrapper.prepare(`
      INSERT INTO twitch_stream_state (twitch_login, is_live, last_stream_id, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(twitch_login) DO UPDATE SET
        is_live = excluded.is_live,
        last_stream_id = excluded.last_stream_id,
        updated_at = CURRENT_TIMESTAMP
    `);
    return stmt.run(twitchLogin, isLive ? 1 : 0, streamId);
  },
};