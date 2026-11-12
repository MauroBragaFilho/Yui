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

  /** O registro é um semanal de verdade (bônus, descontos...)? Um artigo de notícia gravado como semanal não é. */
  isValidWeekly(data) {
    if (!data || typeof data !== 'object') return false;
    if ('descontos' in data || 'bonus' in data || 'discounts' in data) return true; // dados estruturados (Reddit)
    return data.source === 'newswire' && typeof data.fullText === 'string' && data.fullText.length > 80 && typeof data.title === 'string'; // artigo do Newswire com texto
  },

  /** O semanal MAIS RECENTE que é válido (pode ser de uma semana anterior), ou null. */
  getLatestValidWeekly() {
    const rows = dbWrapper.prepare('SELECT * FROM weekly_events ORDER BY event_week DESC LIMIT 8').all();
    for (const r of rows) {
      try {
        const data = JSON.parse(r.data_json);
        if (weeklyRepository.isValidWeekly(data)) return { ...r, data };
      } catch { /* linha ilegível: pula */ }
    }
    return null;
  },

  /** Apaga registros que não são semanais (ex.: artigo do Newswire gravado como semanal). Devolve quantos saíram. */
  purgeInvalidWeekly() {
    let removed = 0;
    for (const r of dbWrapper.prepare('SELECT id, data_json FROM weekly_events').all()) {
      let ok = false;
      try { ok = weeklyRepository.isValidWeekly(JSON.parse(r.data_json)); } catch { ok = false; }
      if (!ok) { dbWrapper.prepare('DELETE FROM weekly_events WHERE id = ?').run(r.id); removed += 1; }
    }
    return removed;
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
