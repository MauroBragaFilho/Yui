// Porta G (GTA Online por conversa): detecção + execução com dependências falsas (sem rede, sem banco). npm run test:gtachat
import assert from 'node:assert/strict';
const { detectGtaIntent } = await import('../src/handlers/chatIntents.js');
const { runGtaIntent, embedsToText } = await import('../src/handlers/gtaChat.js');

const ctx = { direct: true };
// frases dos prints reais
assert.equal(detectGtaIntent('Yui, você pode resumir como que está essa semana no GTA Online?\ndigo o que tem de bônus?', ctx).kind, 'weekly');
assert.equal(detectGtaIntent('o que tem de bônus no gta online essa semana?', ctx).kind, 'weekly');
assert.equal(detectGtaIntent('o que tem no gta hoje?', ctx).kind, 'daily');
assert.equal(detectGtaIntent('quais as noticias do gta?', ctx).kind, 'news');
assert.equal(detectGtaIntent('você gosta de gta?', ctx).kind, 'none');
assert.equal(detectGtaIntent('semanal do gta', { direct: false }).kind, 'none', 'só pedido direto à Yui');

// embeds -> texto
const t = embedsToText([{ title: 'Semana', description: 'Bônus 2x', fields: [{ name: 'Carro', value: 'Pegassi' }] }]);
assert.match(t, /\*\*Semana\*\*/); assert.match(t, /Bônus 2x/); assert.match(t, /\*\*Carro\*\*\nPegassi/);
assert.match(embedsToText([{ description: 'x'.repeat(5000) }]), /gta-semanal/, 'corta e avisa');

// semanal: usa o cache da semana (sem coletar)
const calls = [];
const deps = (over = {}) => ({
  getCurrentWeekKey: () => '2026-W46',
  gtaoRepository: { getLatestWeekly: () => ({ event_week: '2026-W46', data: { source: 'reddit', id: 'a' } }), getLatestDaily: () => ({ data: { d: 1 } }), getDaily: () => null },
  gtaoEngine: { collectWeekly: async () => { calls.push('collect'); return { source: 'reddit', id: 'b' }; }, collectDaily: async () => { calls.push('daily'); return { d: 2 }; } },
  weeklyService: { getLatest: async () => ({ id: 'a' }) },
  buildWeeklyCombinedEmbeds: (w) => [{ title: `Semanal ${w.id}`, description: 'bônus' }],
  createDailyEmbed: (d) => ({ title: `Diário ${d.d}` }),
  newsRepository: { getLatest: () => [{ t: 1 }] }, newswireEngine: { checkLatestNews: async () => {} }, createNewswireEmbed: () => ({ title: 'Notícia' }),
  ...over,
});
let r = await runGtaIntent('weekly', { deps: deps() });
assert.ok(r.ok && r.text.includes('Semanal a') && !calls.includes('collect'), 'cache da semana, sem coletar');
// post novo no Reddit: recoleta
r = await runGtaIntent('weekly', { deps: deps({ weeklyService: { getLatest: async () => ({ id: 'novo' }) } }) });
assert.ok(r.text.includes('Semanal b') && calls.includes('collect'), 'recolhe quando saiu post novo');
// coleta falha: cai no cache da semana
r = await runGtaIntent('weekly', { deps: deps({ weeklyService: { getLatest: async () => ({ id: 'novo' }) }, gtaoEngine: { collectWeekly: async () => { throw new Error('403'); } } }) });
assert.ok(r.ok && r.text.includes('Semanal a'), 'fallback para o cache');
// Reddit sem dados e sem cache: tenta o Newswire
r = await runGtaIntent('weekly', { deps: deps({ gtaoRepository: { getLatestWeekly: () => null, getLatestDaily: () => null }, gtaoEngine: { collectWeekly: async ({ source }) => (source === 'newswire' ? { source, id: 'nw' } : null) } }) });
assert.ok(r.ok && r.text.includes('Semanal nw'), 'fallback para o Newswire');
// sem nada: aviso, sem lançar
r = await runGtaIntent('weekly', { deps: deps({ gtaoRepository: { getLatestWeekly: () => null, getLatestDaily: () => null }, gtaoEngine: { collectWeekly: async () => null } }) });
assert.ok(!r.ok && r.text.includes('Não consegui'));
r = await runGtaIntent('daily', { deps: deps() });
assert.ok(r.ok && r.text.includes('Diário 2'), 'sem cache de hoje: coleta');
r = await runGtaIntent('news', { deps: deps() });
assert.ok(r.ok && r.text.includes('Notícia'));
r = await runGtaIntent('weekly', { deps: { gtaoRepository: { getLatestWeekly: () => { throw new Error('banco'); } }, getCurrentWeekKey: () => 'x' } });
assert.ok(!r.ok && r.text.length > 0, 'erro inesperado vira aviso');
console.log('test-gta-chat OK');
process.exit(0);
