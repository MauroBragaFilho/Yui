import { createWeeklyRedditEmbed, buildWeeklyDetailSections } from '../src/discord/embeds/weeklyRedditEmbed.js';

/**
 * Valida o embed enxuto final (fonte Reddit) com os dados extraídos do post
 * real, conferindo que o conteúdo aparece traduzido para PT-BR.
 */
const weeklyReal = {
  id: '1w5l0gs',
  url: 'https://www.reddit.com/r/gtaonline/comments/1w5l0gs/',
  createdUtc: Math.floor(Date.now() / 1000) - 600,
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

const embed = createWeeklyRedditEmbed(weeklyReal);
const data = embed.data;
const sections = buildWeeklyDetailSections(weeklyReal);
const allFields = (secs) => secs.flatMap((sec) => sec.fields);
const sectionByTitle = (secs, t) => secs.find((sec) => sec.title.startsWith(t));

console.log('=== [TESTE] EMBED SEMANAL REDDIT (PT-BR) — RESUMO + DETALHES ===\n');
console.log('Título:', data.title);
console.log('Descrição:', data.description);

// ── PÁGINA 1: resumo enxuto ─────────────────────────────────────────────
console.log('\n--- Página 1 (resumo) ---');
assert(data.title.includes('Bônus e Descontos da Semana'), 'título em PT-BR');
assert(!/\(.*(ET|disponível).*\)/i.test(data.title), 'título sem o ruído "(Not live until ~5am ET...)"');
assert(data.description.includes('03/09/2026 — 10/09/2026'), 'período em formato BR');
assert(data.description.includes('▶'), 'descrição orienta a navegar para os detalhes');

const veiculosField = data.fields.find((f) => f.name === '🚗 Veículos');
console.log('\nVeículos:', veiculosField?.value);
assert(veiculosField.value.includes('Declasse Impaler SZ'), 'pódio mantém nome do veículo');
assert(veiculosField.value.includes('Karin Woodlander'), 'prize ride mantém nome do veículo');
assert(veiculosField.value.includes('Pódio'), 'rótulo "Pódio" traduzido');

const bonusField = data.fields.find((f) => f.name === '💰 Bônus');
console.log('\nBônus (resumo):', bonusField?.value);
assert(bonusField.value.includes('**2x GTA$ & RP**') && bonusField.value.includes('**3x GTA$ & RP**'), 'um bloco por multiplicador');
assert(bonusField.value.includes('Missões de Exportação de Mercadorias Mistas'), 'bônus 1 traduzido');
assert(bonusField.value.includes('Contratos de Madrazo'), 'bônus Madrazo traduzido');
assert(bonusField.value.includes('Corridas de Drift'), 'bônus Drift traduzido');
assert(bonusField.value.includes('**+1**'), 'bônus 2x mostra "+1" para a atividade omitida (4 atividades, mostra 3)');
assert(bonusField.value.split('\n').length === 2, 'resumo de bônus ocupa só 1 linha por multiplicador');

const destaques = data.fields.find((f) => f.name === '🔥 Destaques de Desconto');
console.log('\nDestaques:', destaques?.value);
assert(destaques, 'página 1 tem destaques de desconto');
assert(destaques.value.includes('🆓 Arcadius Business Center Executive Office'), 'item grátis é destaque');
assert(destaques.value.includes('🔥 Coil Cyclone II — **70%**'), 'desconto >= 50% é destaque');
assert(!destaques.value.includes('Karin Woodlander'), 'desconto pequeno (40%) NÃO entra nos destaques');
assert(destaques.value.includes('+1 descontos nas próximas páginas'), 'indica quantos descontos ficaram para as próximas páginas');
assert(!data.fields.some((f) => f.name.includes('Van de Armas') || f.name.includes('GTA+')), 'Van de Armas e GTA+ NÃO ficam na página 1');
assert(!data.fields.some((f) => f.name.includes('Legendary')), 'lista completa por loja NÃO fica na página 1');

const challField = data.fields.find((f) => f.name === '🎯 Desafio da Semana');
console.log('\nDesafio (resumo):', challField?.value);
assert(challField && challField.value.startsWith('🎯 Ganhe GTA$1,000,000 vendendo Carga Especial'), 'desafio traduzido');

const summaryChars =
  data.title.length + data.description.length + data.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
console.log(`\nTamanho da página 1: ${summaryChars} caracteres`);
assert(summaryChars <= 1100, `página 1 é enxuta (${summaryChars} <= 1100 caracteres)`);

// Rodapé com fonte, ID do post e tempo relativo
console.log('\nRodapé:', data.footer?.text);
assert(String(data.footer?.text).includes('Fonte: r/gtaonline'), 'rodapé menciona a fonte');
assert(String(data.footer?.text).includes('Post 1w5l0gs'), 'rodapé mostra o ID do post');
assert(
  /• (agora mesmo|Hoje às \d{2}:\d{2}|Ontem|\d+ (min|h|dias) atrás)/.test(String(data.footer?.text)),
  'rodapé mostra o tempo relativo do post'
);

// ── PÁGINAS DE DETALHE ──────────────────────────────────────────────────
console.log('\n--- Páginas de detalhe ---');
console.log('Seções:', sections.map((x) => x.title).join(' | '));

const bonusSec = sectionByTitle(sections, 'Bônus da Semana');
assert(bonusSec, 'página de Bônus completos existe quando o resumo omitiu atividade');
assert(allFields([bonusSec]).some((f) => f.value.includes('Compra de Carga Especial (Equipe)')), 'bônus completo traz a atividade omitida no resumo');
assert(allFields([bonusSec]).reduce((n, f) => n + f.value.split('\n').length, 0) === 7, 'bônus completo lista as 7 atividades (4 + 3)');

const discSec = sectionByTitle(sections, 'Descontos da Semana');
assert(discSec, 'página de Descontos completos existe');
const discFields = discSec.fields;
const flat = discFields.map((f) => `${f.name}\n${f.value}`).join('\n');
console.log('\nDescontos (detalhe):\n' + flat);
assert(flat.includes('Coil Cyclone II — 70% de desconto'), 'desconto veículo traduzido');
assert(flat.includes('Arcadius Business Center Executive Office — Grátis'), 'desconto prédio mantido + grátis');
assert(discFields.some((f) => f.name === '🏎️ Legendary Motorsport'), 'campo Legendary Motorsport presente');
assert(discFields.some((f) => f.name === '🏢 Maze Bank Foreclosures'), 'campo Maze Bank Foreclosures (prédio) presente');
assert(discFields.some((f) => f.name === '🏪 Outros'), 'campo Outros presente (veículo fora do catálogo)');
const legendary = discFields.find((f) => f.name === '🏎️ Legendary Motorsport');
assert(legendary.value.includes('Coil Cyclone II'), 'Coil Cyclone II aparece dentro da loja correta');
assert(flat.includes('Karin Woodlander'), 'desconto pequeno aparece na lista completa');

const extrasSec = sectionByTitle(sections, 'Van de Armas');
const extras = allFields([extrasSec]);
const gunField = extras.find((f) => f.name === '🛻 Van de Armas');
console.log('\nVan de Armas:', gunField?.value);
assert(gunField.value.includes('Rifle de Precisão (50% de desconto)'), 'arma traduzida');
assert(gunField.value.includes('Pistola de Choque (30% de desconto para Membros GTA+)'), 'arma + GTA+ traduzidos');

const plusField = extras.find((f) => f.name === '⭐ GTA+');
console.log('\nGTA+:', plusField?.value);
assert(plusField.value.includes('Thruster de graça'), 'item GTA+ traduzido');

const challFull = extras.find((f) => f.name === '🎯 Desafios da Semana');
assert(challFull && challFull.value.includes('Ganhe GTA$1,000,000 vendendo Carga Especial'), 'desafios completos na página de detalhe');

// Fallback da Van de Armas: post sem seção → armas com desconto do snapshot diário.
const fallbackSections = buildWeeklyDetailSections(
  { ...weeklyReal, gunVan: [], _i18n: null },
  {
    dailyData: {
      gunVan: {
        weapons: [
          { name: 'Heavy Sniper', discountPercent: 50 },
          { name: 'Combat MG', discountPercent: 0 },
        ],
      },
    },
  }
);
const gunFallbackField = allFields(fallbackSections).find((f) => f.name === '🛻 Van de Armas');
console.log('\nVan de Armas (fallback diário):', gunFallbackField?.value);
assert(
  gunFallbackField && gunFallbackField.value.includes('• Heavy Sniper — 50% de desconto'),
  'fallback usa armas do snapshot diário determinístico'
);
assert(gunFallbackField && !gunFallbackField.value.includes('Combat MG'), 'fallback ignora armas sem desconto');

// ── Limites do Discord ──────────────────────────────────────────────────
console.log('\n--- Limites do Discord ---');
for (const sec of sections) {
  const size = sec.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  assert(sec.fields.length <= 25 && size <= 6000, `seção "${sec.title}" respeita 25 fields / 6000 chars (${size})`);
  assert(sec.fields.every((f) => f.value.length <= 1024 && f.name.length <= 256), `seção "${sec.title}" respeita 1024/256 por field`);
}

// Post enorme: muitos descontos → continua dentro dos limites e não perde itens.
const manyDiscounts = Array.from({ length: 120 }, (_, i) => `Veículo Teste ${i + 1} - ${10 + (i % 6) * 10}% Off`);
const bigSections = buildWeeklyDetailSections({ ...weeklyReal, descontos: manyDiscounts });
const bigDisc = bigSections.filter((x) => x.title.startsWith('Descontos da Semana'));
const bigText = bigDisc.flatMap((x) => x.fields).map((f) => f.value).join('\n');
assert(bigDisc.length >= 1, 'muitos descontos geram páginas de descontos');
assert(manyDiscounts.every((_, i) => bigText.includes(`Veículo Teste ${i + 1} `) || bigText.includes(`Veículo Teste ${i + 1}\n`)), 'nenhum desconto é perdido quando a lista é enorme');
assert(bigDisc.every((x) => x.fields.reduce((n, f) => n + f.name.length + f.value.length, 0) <= 6000), 'cada página de descontos respeita 6000 chars');

// Sem nada para detalhar → sem páginas de detalhe e sem a dica "▶".
const minimal = { id: 'x', title: 'Weekly Bonuses and Discounts', periodo: { inicio: '2026-09-03', fim: '2026-09-10' }, veiculos: { podium: 'A B' } };
assert(buildWeeklyDetailSections(minimal).length === 0, 'sem dados extras não há páginas de detalhe');
assert(!createWeeklyRedditEmbed(minimal).data.description.includes('▶'), 'sem detalhes, o resumo não manda navegar');

console.log('\n=== RESULTADO ===');
console.log(`   Pass: ${pass} | Fail: ${fail}`);
if (fail > 0) process.exitCode = 1;
else console.log('   ✅ TODOS OS TESTES PASSARAM');
