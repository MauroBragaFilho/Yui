import { getDbWrapper } from '../db.js';

const dbWrapper = getDbWrapper('core');

export const publicationRepository = {
  isPublished(contentType, contentId, guildId) {
    const stmt = dbWrapper.prepare(`
      SELECT id FROM published_messages 
      WHERE content_type = ? AND content_id = ? AND guild_id = ?
    `);
    return !!stmt.get(contentType, contentId, guildId);
  },

  recordPublication(contentType, contentId, guildId, channelId, messageId) {
    const stmt = dbWrapper.prepare(`
      INSERT INTO published_messages (content_type, content_id, guild_id, channel_id, message_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    return stmt.run(contentType, contentId, guildId, channelId, messageId);
  },
};
