import { buildWeeklyCombinedEmbeds } from '../src/engines/gtao/weeklyAnalysis.js';

/**
 * Valida a composição ÚNICA do embed semanal (resumo enxuto do r/gtaonline +
 * páginas da análise da IA), usada no /gta-semanal, Reddit e Newswire.
 * Nenhuma chamada de rede ou IA real é feita aqui.
 */

const analysisFake = {
  titulo: 'Bônus e Descontos da Semana - 3 a 10 de setembro',
  destaques: 'Eventos principais\n• 2x em Export Mixed Goods',
  itensGratuitos: '• Karin Woodlander de graça',
  veiculosDesconto: '• Coil Cyclone II (-70%)',
  melhorFarm: '• Venda de Carga Especial em 2x',
  novidades: '• Modos novos e ajustes',
  avaliacao: 'Semana Boa 🟢 — bônus 2x e 3x rolando a semana toda',
};

// Fonte Reddit: dados estruturados (parser) + análise da IA.
const weeklyReddit = {
  id: '1w5l0gs',
  url: 'https://www.reddit.com/r/gtaonline/comments/1w5l0gs/',
  title:
    'Weekly Bonuses and Discounts - September 3rd to September 10th (Not live until ~5am ET on September 3rd)',
  periodo: { inicio: '2026-09-03', fim: '2026-09-10' },
  bonus: [
    {
      multiplicador: '2',
      atividades: ['Export Mixed Goods Missions', 'Madrazo Hits'],
    },
  ],
  veiculos: { podium: 'Declasse Impaler SZ', prizeRide: 'Karin Woodlander' },
  descontos: [
    'Coil Cyclone II - 70% Off',
    'Arcadius Business Center Executive Office - Free',
    'Karin Woodlander - 40% Off',
  ],
  gunVan: ['Precision Rifle (50% off)', 'Stun Gun (30% off for GTA+ Members)'],
  gtaPlus: { items: ['Free Thruster'] },
  analysis: { ...analysisFake },
};

// Fonte Newswire: apenas texto + análise da IA (sem dados estruturados).
const weeklyNewswire = {
  id: 'nw-2026-w36',
  url: 'https://www.rockstargames.com/newswire/article/gta-online-this-week',
  title: 'GTA Online: Everything You Need to Know This Week',
  source: 'newswire',
  analysis: { ...analysisFake },
};

let pass = 0;
let fail = 0;
function assert(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}`);
  }
}

console.log('=== [TESTE] COMPOSIÇÃO ÚNICA DO EMBED SEMANAL (ENXUTO + IA) ===\n');

// ── 1. Fonte Reddit (dados estruturados + análise da IA) ────────────────
console.log('1. Reddit → resumo enxuto + detalhes + páginas da IA:');
const redditPages = buildWeeklyCombinedEmbeds(weeklyReddit);
console.log('   Títulos:');
for (const [i, p] of redditPages.entries()) console.log(`   [${i + 1}] ${p.data.title}`);
assert(redditPages.length === 6, `composição tem ${redditPages.length} páginas (esperado 6)`);
assert(
  redditPages[0].data.title.startsWith('🎉 GTA Online —'),
  'página 1 é o resumo enxuto (formato r/gtaonline)'
);
assert(
  !redditPages[0].data.fields.some((f) => f.name.includes('Legendary') || f.name === '🏷️ Descontos'),
  'página 1 NÃO traz a lista completa de descontos por loja'
);
assert(
  redditPages[0].data.fields.some((f) => f.name === '🔥 Destaques de Desconto'),
  'página 1 traz só os destaques de desconto'
);
const discPage = redditPages.find((p) => p.data.title.includes('Página') && p.data.title.includes('Descontos da Semana'));
assert(Boolean(discPage), 'existe uma página de descontos completos');
assert(
  discPage.data.fields.some((f) => f.name === '🏎️ Legendary Motorsport' && f.value.includes('Coil Cyclone II')),
  'descontos completos agrupados por loja na página de detalhe'
);
assert(discPage.data.fields.some((f) => f.name === '🏪 Outros'), 'página de detalhe mantém o grupo Outros');
assert(
  redditPages[1].data.title === '🏷️ Página 2/6 — Descontos da Semana',
  'página 2 é Descontos da Semana (detalhe)'
);
assert(
  redditPages[2].data.title === '🛻 Página 3/6 — Van de Armas, GTA+ e Desafios',
  'página 3 é Van de Armas, GTA+ e Desafios (detalhe)'
);
assert(
  redditPages[3].data.title === '📰 Página 4/6 — Destaques & Itens Gratuitos',
  'página 4 é Destaques & Itens Gratuitos (IA)'
);
assert(
  redditPages[4].data.title === '💰 Página 5/6 — Farm & Novidades',
  'página 5 é Farm & Novidades (IA)'
);
assert(
  redditPages[5].data.title === '📊 Página 6/6 — Avaliação da Semana',
  'página 6 é Avaliação da Semana (IA)'
);
assert(
  redditPages.filter((p) => p.data.title.includes('Página') && p.data.title.includes('Descontos da Semana')).length === 1,
  'página de descontos da IA NÃO entra quando já há descontos estruturados (evita duplicidade)'
);

// ── 2. Fonte Newswire (sem dados estruturados) ───────────────────────────
console.log('\n2. Newswire → todas as páginas vêm da análise da IA:');
const newswirePages = buildWeeklyCombinedEmbeds(weeklyNewswire);
assert(newswirePages.length === 4, `composição tem ${newswirePages.length} páginas (esperado 4)`);
assert(
  !newswirePages.some((p) => p.data.title.startsWith('🎉 GTA Online —')),
  'sem dados estruturados → não há página de resumo'
);
const discountsPage = newswirePages.find((p) => p.data.title.includes('Descontos da Semana'));
assert(Boolean(discountsPage), 'página de descontos da IA entra na Newswire');
assert(
  discountsPage.data.fields.some((f) => f.value.includes('• Coil Cyclone II (-70%)')),
  'veículos com desconto vêm da análise da IA'
);
assert(
  discountsPage.data.fields.some((f) => f.value.includes('Nenhuma arma com desconto')),
  'Van de Armas informa ausência sem dados do snapshot'
);

// ── 3. Reddit sem análise da IA → só o resumo enxuto ─────────────────────
console.log('\n3. Reddit sem análise → resumo enxuto + páginas de detalhe:');
const noAnalysisPages = buildWeeklyCombinedEmbeds({ ...weeklyReddit, analysis: null });
assert(noAnalysisPages.length === 3, `composição tem ${noAnalysisPages.length} páginas (esperado 3: resumo + 2 de detalhe)`);
assert(
  noAnalysisPages[0].data.title.startsWith('🎉 GTA Online —'),
  'a primeira página é o resumo enxuto'
);

// ── 4. Sem dados nenhum → página de fallback ─────────────────────────────
console.log('\n4. Sem dados nenhum → fallback seguro:');
const emptyPages = buildWeeklyCombinedEmbeds({});
assert(emptyPages.length === 1, 'sempre retorna ao menos 1 página');
assert(
  emptyPages[0].data.title.includes('Sem dados disponíveis'),
  'fallback explícito quando nada chegou'
);

// ── 5. Determinismo da paginação (Reddit) ────────────────────────────────
console.log('\n5. Determinismo: duas chamadas geram o mesmo resultado:');
const redditPages2 = buildWeeklyCombinedEmbeds(weeklyReddit);
assert(
  JSON.stringify(redditPages.map((p) => p.data.title)) ===
    JSON.stringify(redditPages2.map((p) => p.data.title)),
  'mesma sequência de títulos nas duas chamadas'
);

console.log('\n=== RESULTADO ===');
console.log(`   Pass: ${pass} | Fail: ${fail}`);
if (fail > 0) process.exitCode = 1;
else console.log('   ✅ TODOS OS TESTES PASSARAM');
process.exit(process.exitCode ?? 0);
