import { dbWrapper } from '../db.js';

export const gtaoRepository = {
  getDaily(dateStr) {
    const stmt = dbWrapper.prepare('SELECT * FROM daily_resets WHERE reset_date = ?');
    const res = stmt.get(dateStr);
    return res ? { ...res, data: JSON.parse(res.data_json) } : null;
  },

  getLatestDaily() {
    const stmt = dbWrapper.prepare('SELECT * FROM daily_resets ORDER BY reset_date DESC LIMIT 1');
    const res = stmt.get();
    return res ? { ...res, data: JSON.parse(res.data_json) } : null;
  },

  saveDaily(dateStr, data) {
    const stmt = dbWrapper.prepare(`
      INSERT INTO daily_resets (reset_date, data_json)
      VALUES (?, ?)
      ON CONFLICT(reset_date) DO UPDATE SET
        data_json = excluded.data_json,
        created_at = CURRENT_TIMESTAMP
    `);
    return stmt.run(dateStr, JSON.stringify(data));
  },

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
