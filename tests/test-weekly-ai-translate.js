import {
  translateWeeklyForEmbed,
  buildTranslatePrompt,
  extractProtectedNames,
  normalizeAiResult,
  isAiAvailable,
} from '../src/engines/gtao/systems/weekly/aiTranslate.js';
import { createWeeklyRedditEmbed } from '../src/discord/embeds/weeklyRedditEmbed.js';

/**
 * Testa a camada de tradução via IA do embed semanal (fonte Reddit):
 *   - extração de nomes protegidos (veículos/prédios que NUNCA traduzem);
 *   - prompt com regras de nomes próprios;
 *   - normalização/validação da resposta da IA (com fallback por campo);
 *   - fluxo completo translateWeeklyForEmbed com mock de IA e cache;
 *   - fallback determinístico para o glossário (sem IA).
 * Nenhuma chamada real de API é feita aqui.
 */

// ── Fixture (mesmo formato do weeklyService, post real da semana) ───────
const weeklyReal = {
  id: '1w5l0gs',
  url: 'https://www.reddit.com/r/gtaonline/comments/1w5l0gs/',
  title:
    'Weekly Bonuses and Discounts - September 3rd to September 10th (Not live until ~5am ET on September 3rd)',
  periodo: { inicio: '2026-09-03', fim: '2026-09-10' },
  bonus: [
    {
      multiplicador: '2',
      atividades: [
        'Export Mixed Goods Missions',
        'Madrazo Hits',
        'Diamond Adversary Series',
        'Staff Sourcing Special Cargo',
      ],
    },
    {
      multiplicador: '3',
      atividades: ['Drift Races', 'Transform Races', 'Random Transform Races'],
    },
  ],
  veiculos: {
    podium: 'Declasse Impaler SZ',
    prizeRide: 'Karin Woodlander',
  },
  descontos: [
    'Coil Cyclone II - 70% Off',
    'Arcadius Business Center Executive Office - Free',
    'Karin Woodlander - 40% Off',
  ],
  gunVan: [
    'Precision Rifle (50% off)',
    'Stun Gun (30% off for GTA+ Members)',
    'Railgun (50% off)',
  ],
  gtaPlus: { items: ['Free Thruster', 'Free vehicle warehouse paint jobs'] },
  desafios: [
    'Earn GTA$1,000,000 from selling Special Cargo to get the Yeti x LS Customs Tracksuit and a 10X Reward of GTA$1,000,000',
  ],
};

// Resposta "da IA" simulada: frases naturais em PT-BR mantendo os nomes.
const aiRawJson = JSON.stringify({
  titulo:
    'Bônus e Descontos da Semana - 3 de setembro a 10 de setembro (disponível a partir de ~5h ET em 3 de setembro)',
  bonus: [
    {
      multiplicador: 2,
      atividades: [
        'Missões de Exportação de Mercadorias Mistas',
        'Contratos de Madrazo',
        'Série Adversária Diamond',
        'Compra de Carga Especial (Equipe)',
      ],
    },
    {
      multiplicador: 3,
      atividades: ['Corridas de Drift', 'Corridas de Transformação', 'Corridas de Transformação Aleatórias'],
    },
  ],
  descontos: [
    'Coil Cyclone II — 70% de desconto',
    'Arcadius Business Center Executive Office — Grátis',
    'Karin Woodlander — 40% de desconto',
  ],
  gunVan: [
    'Rifle de Precisão (50% de desconto)',
    'Pistola de Choque (30% de desconto para Membros GTA+)',
    'Railgun (50% de desconto)',
  ],
  gtaPlus: ['Thruster de graça', 'paint jobs de warehouse de graça'],
  desafios: [
    'Ganhe GTA$1,000,000 vendendo Carga Especial para obter o Yeti x LS Customs Tracksuit e uma recompensa 10X de GTA$1,000,000',
  ],
});

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

console.log('=== [TESTE] TRADUÇÃO VIA IA (EMBED SEMANAL REDDIT) ===\n');

console.log('1. Nomes protegidos extraídos dos dados:');
const protectedNames = extractProtectedNames(weeklyReal);
console.log(`   ${JSON.stringify(protectedNames)}`);
assert(protectedNames.includes('Declasse Impaler SZ'), 'pódio protegido');
assert(protectedNames.includes('Karin Woodlander'), 'prize ride protegido');
assert(protectedNames.includes('Coil Cyclone II'), 'veículo dos descontos protegido');
assert(protectedNames.includes('Arcadius Business Center Executive Office'), 'prédio dos descontos protegido');

console.log('\n2. Prompt de tradução:');
const prompt = buildTranslatePrompt(weeklyReal, protectedNames);
assert(prompt.includes('PORTUGUÊS DO BRASIL'), 'prompt pede pt-BR');
assert(prompt.includes('NUNCA traduza, altere ou adapte NOMES PRÓPRIOS'), 'regra de nomes próprios presente');
assert(prompt.includes('"Declasse Impaler SZ"'), 'nomes protegidos embutidos no prompt');
assert(prompt.includes('FORMATO DE RESPOSTA (JSON'), 'formato JSON exigido');
assert(prompt.includes('~~~') === false, 'sem code fences');
console.log('\n3. Normalização da resposta da IA (válida):');
const parsedAi = JSON.parse(aiRawJson);
const tr = normalizeAiResult(parsedAi, weeklyReal);
assert(tr !== null, 'resposta válida normalizada');
assert(tr._i18n.by === 'ai', 'flag _i18n.by = ai');
assert(tr.title.startsWith('Bônus e Descontos da Semana'), 'título vindo da IA');
assert(tr.bonus.length === 2 && tr.bonus[0].multiplicador === 2, 'multiplicador preservado');
assert(tr.bonus[1].atividades[0] === 'Corridas de Drift', 'atividades traduzidas pela IA');
assert(tr.descontos[0] === 'Coil Cyclone II — 70% de desconto', 'desconto da IA com nome preservado');
assert(tr.descontos[1] === 'Arcadius Business Center Executive Office — Grátis', 'prédio preservado');
assert(tr.gunVan[0] === 'Rifle de Precisão (50% de desconto)', 'Van de Armas traduzida');
assert(tr.gtaPlus.items[0] === 'Thruster de graça', 'GTA+ traduzido');
assert(tr.desafios[0].includes('Ganhe GTA$1,000,000 vendendo Carga Especial'), 'desafio traduzido');
assert(tr.veiculos.podium === 'Declasse Impaler SZ' && tr.veiculos.prizeRide === 'Karin Woodlander', 'veículos intactos');

console.log('\n4. Revalidação de nomes (IA que mudou o nome do veículo):');
const parsedBadName = {
  ...JSON.parse(aiRawJson),
  descontos: [
    'Coil Cyclone II — 70% de desconto',
    'Escritório Executivo Arcadius Business Center — Grátis', // nome reorganizado/traduzido
    'Karin Woodlander — 40% de desconto',
  ],
};
const trBad = normalizeAiResult(parsedBadName, weeklyReal);
assert(
  trBad.descontos[1] === 'Arcadius Business Center Executive Office — Grátis',
  'item com nome alterado cai para o glossário (que preserva o nome)'
);
assert(trBad.descontos[0] === 'Coil Cyclone II — 70% de desconto', 'demais descontos da IA mantidos');

console.log('\n5. Resposta vazia/inválida → null:');
assert(normalizeAiResult(null, weeklyReal) === null, 'null retorna null');
assert(normalizeAiResult({}, weeklyReal) === null, 'objeto vazio retorna null');
assert(normalizeAiResult({ titulo: '' }, weeklyReal) === null, 'sem conteúdo retorna null');

console.log('\n6. Fluxo completo sem IA (forceGlossary → glossário):');
(async () => {
  let aiCalled = false;
  const gloss = await translateWeeklyForEmbed(weeklyReal, {
    forceGlossary: true,
    aiCall: async () => {
      aiCalled = true;
      return aiRawJson;
    },
  });
  assert(aiCalled === false, 'IA NÃO é chamada em forceGlossary');
  assert(gloss._i18n.by === 'glossary', '_i18n.by = glossary');
  assert(gloss.title.includes('Bônus e Descontos da Semana'), 'título via glossário');
  assert(gloss.bonus[0].atividades[0] === 'Missões de Exportação de Mercadorias Mistas', 'bônus via glossário');
  assert(gloss.descontos[0] === 'Coil Cyclone II — 70% de desconto', 'desconto via glossário preserva nome');
  assert(gloss.veiculos.podium === 'Declasse Impaler SZ', 'veículo intacto no glossário');

  console.log('\n7. Fluxo com IA (mock) + cache:');
  let calls = 0;
  const out1 = await translateWeeklyForEmbed(weeklyReal, {
    forceAI: true,
    cacheFile: null,
    aiCall: async (p) => {
      calls++;
      assert(p.includes('protected_names'), 'prompt recebido tem nomes protegidos');
      return aiRawJson;
    },
  });
  assert(calls === 1, 'IA chamada uma vez na primeira execução');
  assert(out1._i18n.by === 'ai', 'primeira execução: by = ai');
  assert(out1.title.startsWith('Bônus e Descontos da Semana'), 'título traduzido pela IA');

  const out2 = await translateWeeklyForEmbed(weeklyReal, {
    forceAI: true,
    cacheFile: null,
    aiCall: async () => {
      calls++;
      return aiRawJson;
    },
  });
  assert(calls === 1, 'segunda execução veio do cache (IA não chamada de novo)');
  assert(out2._i18n.by === 'cache', 'segunda execução: by = cache');
  assert(out2.title === out1.title, 'mesmo conteúdo traduzido (cache)');

  console.log('\n8. IA retorna lixo → fallback glossário:');
  const out3 = await translateWeeklyForEmbed(weeklyReal, {
    forceAI: true,
    bypassCache: true,
    cacheFile: null,
    aiCall: async () => 'resposta sem JSON nenhum aqui',
  });
  assert(out3._i18n.by === 'glossary', 'lixo da IA cai no glossário');
  assert(out3.descontos[0] === 'Coil Cyclone II — 70% de desconto', 'descontos do fallback corretos');

  console.log('\n9. Embed final construído sobre a tradução da IA:');
  const embedAbstrato = await translateWeeklyForEmbed(
    { ...weeklyReal, id: 'outro_post' },
    { forceAI: true, cacheFile: null, aiCall: async () => aiRawJson }
  );
  const embed2 = createWeeklyRedditEmbed(embedAbstrato);
  const data2 = embed2.data;
  assert(data2.title.includes('Bônus e Descontos da Semana'), 'título do embed traduzido');
  const discF = data2.fields.find((f) => f.name === '🏷️ Descontos');
  assert(discF.value.includes('Coil Cyclone II — 70% de desconto'), 'descontos do embed da IA');
  assert(discF.value.includes('**🏎️ Legendary Motorsport**'), 'descontos do embed da IA agrupados por loja');
  assert(discF.value.includes('**🏪 Outros**'), 'grupo Outros (veículo fora do catálogo)');
  const vehF = data2.fields.find((f) => f.name === '🚗 Veículos');
  assert(vehF.value.includes('Declasse Impaler SZ'), 'veículos mantidos em inglês no embed');

  console.log(`\n10. isAiAvailable() é booleano: ${isAiAvailable()}`);
  assert(typeof isAiAvailable() === 'boolean', 'isAiAvailable retorna boolean');

  console.log('\n=== RESULTADO ===');
  console.log(`   Pass: ${pass} | Fail: ${fail}`);
  if (fail > 0) console.log('   ❌ HOUVE FALHAS');
  else console.log('   ✅ TODOS OS TESTES PASSARAM');
  process.exit(fail > 0 ? 1 : 0);
})();