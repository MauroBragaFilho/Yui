import { getDbWrapper } from '../db.js';

const dbWrapper = getDbWrapper('gta-semanal');

export const weeklyRepository = {
  getWeekly(weekStr) {
    const stmt = dbWrapper.prepare('SELECT * FROM weekly_events WHERE event_week = ?');
    const res = stmt.get(weekStr);
    return res ? { ...res, data: JSON.parse(res.data_json) } : null;
  },

  getLatestWeekly() {
    const stmt = dbWrapper.prepare('SELECT * FROM weekly_events ORDER BY event_week DESC LIMIT 1');
    const res = stmt.get();
    return res ? { ...res, data: JSON.parse(res.data_json) } : null;
  },

  saveWeekly(weekStr, data) {
    const stmt = dbWrapper.prepare(`
      INSERT INTO weekly_events (event_week, data_json)
      VALUES (?, ?)
      ON CONFLICT(event_week) DO UPDATE SET
        data_json = excluded.data_json,
        created_at = CURRENT_TIMESTAMP
    `);
    return stmt.run(weekStr, JSON.stringify(data));
  },
};
