import { dbWrapper } from '../db.js';

export const newsRepository = {
  getById(id) {
    const stmt = dbWrapper.prepare('SELECT * FROM news_articles WHERE id = ?');
    return stmt.get(id);
  },

  getByUrl(url) {
    const stmt = dbWrapper.prepare('SELECT * FROM news_articles WHERE url = ?');
    return stmt.get(url);
  },

  getLatest(limit = 10) {
    const stmt = dbWrapper.prepare('SELECT * FROM news_articles ORDER BY published_at DESC LIMIT ?');
    return stmt.all(limit);
  },

  /**
   * Salva artigos novos e retorna apenas os que foram inseridos (não existiam antes)
   * @param {Array<{id: string, title: string, url: string, category: string, thumbnailUrl: string, publishedAt: string}>} articles 
   */
  insertMany(articles) {
    const insertStmt = dbWrapper.prepare(`
      INSERT OR IGNORE INTO news_articles (id, title, url, category, thumbnail_url, published_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const inserted = [];
    const transaction = dbWrapper.transaction((items) => {
      for (const item of items) {
        const info = insertStmt.run(
          item.id,
          item.title,
          item.url,
          item.category,
          item.thumbnailUrl,
          item.publishedAt
        );
        if (info.changes > 0) {
          inserted.push(item);
        }
      }
    });

    transaction(articles);
    return inserted;
  },
};
