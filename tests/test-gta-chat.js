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
// Reddit e Newswire sem dados e sem cache da semana: usa o ÚLTIMO semanal válido (de outra semana) e AVISA
{
  const sources = [];
  const old = { event_week: '2026-W45', data: { source: 'reddit', id: 'velho', periodo: 'November 5th to November 12th', bonus: [], descontos: [] } };
  r = await runGtaIntent('weekly', { deps: deps({
    gtaoRepository: { getLatestWeekly: () => null, getLatestDaily: () => null, getLatestValidWeekly: () => old, purgeInvalidWeekly: () => 0 },
    gtaoEngine: { collectWeekly: async ({ source }) => { sources.push(source); return null; } },
  }) });
  assert.ok(r.ok && r.stale === true, 'usa o último semanal válido');
  assert.ok(r.text.includes('semana anterior') && r.text.includes('2026-W45') && r.text.includes('November 5th'), 'avisa que é da semana anterior, com o período');
  assert.ok(r.data.includes('semana anterior') && r.data.includes('Semanal velho'), 'a IA também recebe o aviso');
  assert.deepEqual(sources, ['reddit', 'gtabase', 'newswire'], 'tenta o Reddit, o GTABase e o Newswire (oficial) antes de cair no semanal antigo');
  // registro inválido (artigo do Newswire gravado como semanal) é apagado antes de tudo
  let purged = 0;
  await runGtaIntent('weekly', { deps: deps({ gtaoRepository: { getLatestWeekly: () => ({ event_week: '2026-W46', data: { source: 'reddit', id: 'a' } }), getLatestDaily: () => null, getLatestValidWeekly: () => null, purgeInvalidWeekly: () => { purged += 1; return 1; } } }) });
  assert.equal(purged, 1, 'limpa registro inválido a cada consulta do semanal');
}

// Reddit bloqueado: o Newswire entrega o artigo semanal; o texto do artigo oficial vai para a IA e para o texto direto
{
  const nw = { source: 'newswire', title: 'Eventos desta semana', fullText: 'Bônus dobrados no evento de assalto. Missões de contato de 12/11 a 2/12. Veleno GT com 25% de desconto. '.repeat(2), publishedAt: '11/5/26, 10:00 AM', url: 'https://www.rockstargames.com/newswire/article/x' };
  const calls2 = [];
  r = await runGtaIntent('weekly', { deps: deps({
    gtaoRepository: { getLatestWeekly: () => null, getLatestDaily: () => null, getLatestValidWeekly: () => null, purgeInvalidWeekly: () => 0 },
    gtaoEngine: { collectWeekly: async ({ source }) => { calls2.push(source); return source === 'newswire' ? nw : null; } },
  }) });
  assert.deepEqual(calls2, ['reddit', 'gtabase', 'newswire']);
  assert.ok(r.ok && r.source === 'newswire' && r.stale === false);
  assert.ok(r.data.includes('Artigo oficial da Rockstar') && r.data.includes('Veleno GT') && r.data.includes('11/5/26') && r.data.includes('rockstargames.com'), 'a IA recebe o artigo oficial');
  assert.ok(r.text.includes('Veleno GT'), 'o texto direto também leva o artigo');

  // cache do Newswire recente (menos de 6 h) da semana: usa, sem coletar de novo
  const cacheDeps = (idadeH) => deps({
    gtaoRepository: { getLatestWeekly: () => ({ event_week: '2026-W46', created_at: 'x', data: nw }), getLatestDaily: () => null, getLatestValidWeekly: () => null, purgeInvalidWeekly: () => 0 },
    gtaoEngine: { collectWeekly: async ({ source }) => { calls3.push(source); return source === 'newswire' ? { ...nw, title: 'Artigo novo' } : null; } },
    weeklyRowAgeHours: () => idadeH, NEWSWIRE_CACHE_HOURS: 6,
  });
  const calls3 = [];
  r = await runGtaIntent('weekly', { deps: cacheDeps(2) });
  assert.deepEqual(calls3, [], 'cache do Newswire de 2 h: não coleta');
  assert.ok(r.ok && r.data.includes('Eventos desta semana'));
  // cache do Newswire velho (mais de 6 h): recoleta (a Rockstar publica o artigo novo na quinta)
  r = await runGtaIntent('weekly', { deps: cacheDeps(30) });
  assert.deepEqual(calls3, ['reddit', 'gtabase', 'newswire'], 'cache do Newswire de 30 h: tenta de novo');
  assert.ok(r.data.includes('Artigo novo'), 'mostra o artigo novo');
  // Newswire velho e as fontes falham: ainda usa a cópia guardada (melhor do que nada)
  calls3.length = 0;
  r = await runGtaIntent('weekly', { deps: deps({
    gtaoRepository: { getLatestWeekly: () => ({ event_week: '2026-W46', data: nw }), getLatestDaily: () => null, getLatestValidWeekly: () => null, purgeInvalidWeekly: () => 0 },
    gtaoEngine: { collectWeekly: async () => null }, weeklyRowAgeHours: () => 99, NEWSWIRE_CACHE_HOURS: 6,
  }) });
  assert.ok(r.ok && r.data.includes('Eventos desta semana'), 'fontes fora: usa o cache guardado');
}
// sem nada: aviso, sem lançar
r = await runGtaIntent('weekly', { deps: deps({ gtaoRepository: { getLatestWeekly: () => null, getLatestDaily: () => null }, gtaoEngine: { collectWeekly: async () => null } }) });
assert.ok(!r.ok && r.text.includes('Não consegui'));
r = await runGtaIntent('daily', { deps: deps() });
assert.ok(r.ok && r.text.includes('Diário 2'), 'sem cache de hoje: coleta');
r = await runGtaIntent('news', { deps: deps() });
assert.ok(r.ok && r.text.includes('Notícia'));
r = await runGtaIntent('weekly', { deps: { gtaoRepository: { getLatestWeekly: () => { throw new Error('banco'); } }, getCurrentWeekKey: () => 'x' } });
assert.ok(!r.ok && r.text.length > 0, 'erro inesperado vira aviso');

// A IA recebe os dados de TODAS as páginas (bem acima do corte do texto direto) e o prompt cerca os dados como externos
{
  const { buildGtaModelPrompt, GTA_MODEL_MAX_CHARS } = await import('../src/handlers/gtaChat.js');
  const pages = [1, 2, 3].map((n) => ({ title: `Página ${n}/3`, description: `item-${n} ` + 'x'.repeat(2500) }));
  const r2 = await runGtaIntent('weekly', { deps: deps({ buildWeeklyCombinedEmbeds: () => pages }) });
  assert.ok(r2.text.length < r2.data.length, 'o texto direto é cortado, o da IA não');
  assert.ok(['item-1', 'item-2', 'item-3'].every((k) => r2.data.includes(k)), 'todas as páginas chegam à IA');
  assert.ok(r2.data.length <= GTA_MODEL_MAX_CHARS + 120);
  const prompt = buildGtaModelPrompt({ data: r2.data.slice(0, 50), question: 'como está a semana?', kind: 'weekly' }, (t) => `<<${t}>>`);
  assert.match(prompt, /<<\*\*Página 1\/3/);
  assert.match(prompt, /SOMENTE os dados acima/);
  assert.match(prompt, /Nenhuma informação disponível/);
  assert.match(prompt, /como está a semana\?$/);
  assert.equal((await runGtaIntent('daily', { deps: deps() })).data.includes('Diário 2'), true);
  assert.equal((await runGtaIntent('news', { deps: deps() })).data.includes('Notícia'), true);
}
console.log('test-gta-chat OK');
process.exit(0);
