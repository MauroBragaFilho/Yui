import { dbWrapper } from '../db.js';

export const guildRepository = {
  get(guildId) {
    const stmt = dbWrapper.prepare('SELECT * FROM guild_settings WHERE guild_id = ?');
    return stmt.get(guildId);
  },

  getAll() {
    const stmt = dbWrapper.prepare('SELECT * FROM guild_settings');
    return stmt.all();
  },

  setChannel(guildId, channelType, channelId) {
    const allowed = ['news_channel_id', 'daily_channel_id', 'weekly_channel_id', 'vehicles_channel_id'];
    if (!allowed.includes(channelType)) {
      throw new Error(`Tipo de canal inválido: ${channelType}`);
    }

    const stmt = dbWrapper.prepare(`
      INSERT INTO guild_settings (guild_id, ${channelType}, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id) DO UPDATE SET
        ${channelType} = excluded.${channelType},
        updated_at = CURRENT_TIMESTAMP
    `);

    return stmt.run(guildId, channelId);
  },

  delete(guildId) {
    const stmt = dbWrapper.prepare('DELETE FROM guild_settings WHERE guild_id = ?');
    return stmt.run(guildId);
  },
};
