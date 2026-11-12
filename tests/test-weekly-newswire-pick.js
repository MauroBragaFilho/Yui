// Escolha do artigo semanal do Newswire (por pontuação) e envelhecimento do cache. Sem rede. npm run test:newswirepick
import assert from 'node:assert/strict';
const { scoreWeeklyArticle, pickWeeklyArticle, WEEKLY_MIN_SCORE } = await import('../src/engines/gtao/systems/weeklyEvents.js');
const { weeklyRowAgeHours, NEWSWIRE_CACHE_HOURS } = await import('../src/utils/weekKey.js');

// Lista real do Newswire em 11/11/2026 (do mais novo para o mais antigo)
const A = (publishedAt, category, title) => ({ publishedAt, category, title, url: `https://www.rockstargames.com/newswire/article/${title.length}` });
const lista = [
  A('11/10/26, 3:00 PM', 'Grand Theft Auto', 'Pre-Load Grand Theft Auto VI Now'),
  A('11/9/26, 2:00 PM', 'Grand Theft Auto', 'Grand Theft Auto VI: The Festival'),
  A('11/6/26, 8:00 PM', 'GTA Online', 'GTA+ Members Can Now Claim a Free Grotti Itali RSX'),
  A('11/5/26, 3:00 PM', 'Grand Theft Auto', 'Explore the Grand Theft Auto VI Launch Gallery'),
  A('11/5/26, 10:00 AM', 'GTA Online', 'Take Down the Kortz Center and More High-Value Targets in This Week’s Heist Event'),
  A('11/3/26, 3:00 PM', 'Red Dead Online', 'Celebrate Thanksgiving with Bonuses for Traders in Red Dead Online'),
  A('10/8/26, 11:00 AM', 'GTA Online', 'Claim a Free Pegassi Oppressor with GTA+'),
  A('10/1/26, 10:00 AM', 'GTA Online', 'Experience Halloween Thrills All Throughout October in GTA Online'),
];
const NOW = Date.parse('11/11/26, 11:00 PM');

// o caso real: o brinde do GTA+ é mais novo, mas o artigo certo é o do evento semanal
const escolhido = pickWeeklyArticle(lista, { now: NOW });
assert.ok(escolhido.title.includes('This Week’s Heist Event'), `escolheu: ${escolhido?.title}`);
assert.ok(scoreWeeklyArticle(lista[2].title, lista[2].category) < WEEKLY_MIN_SCORE, 'brinde do GTA+ não é o semanal');
assert.ok(scoreWeeklyArticle(lista[4].title, lista[4].category) >= WEEKLY_MIN_SCORE);

// categoria fora de GTA Online nunca pontua (GTA VI, Red Dead)
assert.equal(scoreWeeklyArticle('This Week in Red Dead Online: Bonuses', 'Red Dead Online'), -Infinity);
assert.equal(scoreWeeklyArticle('Weekly bonuses', 'Grand Theft Auto'), -Infinity);
assert.equal(scoreWeeklyArticle('Weekly bonuses', undefined), -Infinity);

// o artigo semanal que a Rockstar costuma publicar (títulos reais comuns)
for (const t of ['Triple GTA$ & RP on Hostile Takeover and More This Week in GTA Online', 'GTA Online Weekly Update: Bonuses and Discounts', 'Double Rewards on Bunker Series and 40% Off Vehicles This Week']) {
  assert.ok(scoreWeeklyArticle(t, 'GTA Online') >= WEEKLY_MIN_SCORE, t);
}
// notícia geral de GTA Online sem pista semanal não é o semanal
assert.ok(scoreWeeklyArticle('Experience Halloween Thrills All Throughout October in GTA Online', 'GTA Online') < WEEKLY_MIN_SCORE);

// empate: o mais novo ganha
const empate = [A('11/12/26, 10:00 AM', 'GTA Online', 'Double Rewards This Week'), A('11/5/26, 10:00 AM', 'GTA Online', 'Double Rewards This Week')];
assert.equal(pickWeeklyArticle(empate, { now: Date.parse('11/12/26, 6:00 PM') }), empate[0]);
// artigo velho demais não vale (mais de 10 dias)
assert.equal(pickWeeklyArticle([A('10/1/26, 10:00 AM', 'GTA Online', 'Double Rewards This Week')], { now: NOW }), null);
// sem candidato: null (melhor sem dado do que o artigo errado); entradas ruins não quebram
assert.equal(pickWeeklyArticle([lista[0], lista[2]], { now: NOW }), null);
assert.equal(pickWeeklyArticle([], { now: NOW }), null);
assert.equal(pickWeeklyArticle(null), null);
assert.equal(pickWeeklyArticle([null, {}, { title: 5 }], { now: NOW }), null);
// data ilegível: não descarta o artigo
assert.ok(pickWeeklyArticle([{ publishedAt: 'ontem', category: 'GTA Online', title: 'This Week in GTA Online: Bonuses' }], { now: NOW }));

// envelhecimento do cache do Newswire (created_at do SQLite, UTC)
const n = Date.UTC(2026, 10, 12, 12, 0, 0);
assert.equal(Math.round(weeklyRowAgeHours({ created_at: '2026-11-12 06:00:00' }, n)), 6);
assert.equal(Math.round(weeklyRowAgeHours({ created_at: '2026-11-12T06:00:00Z' }, n)), 6);
assert.equal(weeklyRowAgeHours({}, n), Infinity);
assert.equal(weeklyRowAgeHours({ created_at: 'lixo' }, n), Infinity);
assert.equal(weeklyRowAgeHours({ created_at: '2026-11-13 00:00:00' }, n), 0, 'data no futuro não dá idade negativa');
assert.equal(NEWSWIRE_CACHE_HOURS, 6);

// ── /gta-semanal com Newswire sem análise da IA: o texto do artigo vira página (nunca só a página vazia de descontos) ──
{
  const { articleFields, buildWeeklyCombinedEmbeds } = await import('../src/engines/gtao/weeklyAnalysis.js');
  const longo = Array.from({ length: 60 }, (_, i) => `Frase número ${i + 1} do artigo oficial sobre o evento da semana.`).join(' ');
  const fields = articleFields(longo);
  assert.ok(fields.length >= 2 && fields.length <= 4, `divide em campos (veio ${fields.length})`);
  assert.ok(fields.every((f) => f.value.length <= 1000), 'cada campo cabe no limite do Discord');
  assert.equal(articleFields('').length, 0);
  const pages = buildWeeklyCombinedEmbeds({ source: 'newswire', title: 'Heist Event', url: 'https://www.rockstargames.com/newswire/x', fullText: longo }, null);
  const json = pages.map((p) => p.toJSON());
  assert.ok(json.some((j) => /Artigo oficial/.test(j.title)), 'tem a página do artigo oficial');
  assert.ok(JSON.stringify(json).includes('Frase número 1 '), 'o texto do artigo aparece');
  // com análise da IA, a página do artigo NÃO entra (a análise já cobre)
  const comIa = buildWeeklyCombinedEmbeds({ source: 'newswire', title: 'Heist Event', fullText: longo, analysis: { destaques: 'Muito bônus', itensGratuitos: 'Nada' } }, null).map((p) => p.toJSON());
  assert.ok(!comIa.some((j) => /Artigo oficial/.test(j.title)), 'com análise da IA o artigo não vira página');
  console.log('test-weekly-newswire-pick OK');
  process.exit(0);
}
