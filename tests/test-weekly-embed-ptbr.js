import { createWeeklyRedditEmbed } from '../src/discord/embeds/weeklyRedditEmbed.js';

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

console.log('=== [TESTE] EMBED SEMANAL REDDIT (PT-BR) ===\n');
console.log('Título:', data.title);
console.log('Descrição:', data.description);

// Título traduzido
assert(data.title.includes('Bônus e Descontos da Semana'), 'título em PT-BR');

// Veículos mantidos em inglês
const veiculosField = data.fields.find((f) => f.name === '🚗 Veículos');
console.log('\nVeículos:', veiculosField?.value);
assert(veiculosField.value.includes('Declasse Impaler SZ'), 'pódio mantém nome do veículo');
assert(veiculosField.value.includes('Karin Woodlander'), 'prize ride mantém nome do veículo');
assert(veiculosField.value.includes('Pódio'), 'rótulo "Pódio" traduzido');

// Bônus traduzidos
const bonusField = data.fields.find((f) => f.name === '💰 Bônus');
console.log('\nBônus:', bonusField?.value);
assert(bonusField.value.includes('Missões de Exportação de Mercadorias Mistas'), 'bônus 1 traduzido');
assert(bonusField.value.includes('Contratos de Madrazo'), 'bônus Madrazo traduzido');
assert(bonusField.value.includes('Corridas de Drift'), 'bônus Drift traduzido');

// Descontos traduzidos e agrupados por loja
const discField = data.fields.find((f) => f.name === '🏷️ Descontos');
console.log('\nDescontos:', discField?.value);
assert(discField.value.includes('Coil Cyclone II — 70% de desconto'), 'desconto veículo traduzido');
assert(discField.value.includes('Arcadius Business Center Executive Office — Grátis'), 'desconto prédio mantido + grátis');
assert(discField.value.includes('**🏎️ Legendary Motorsport**'), 'grupo Legendary Motorsport presente');
assert(discField.value.includes('**🏢 Maze Bank Foreclosures**'), 'grupo Maze Bank Foreclosures (prédio) presente');
assert(discField.value.includes('**🏪 Outros**'), 'grupo Outros presente (veículo fora do catálogo)');
assert(
  discField.value.indexOf('**🏎️ Legendary Motorsport**') < discField.value.indexOf('Coil Cyclone II'),
  'Coil Cyclone II aparece dentro do grupo correto'
);

// Van de Armas traduzida
const gunField = data.fields.find((f) => f.name === '🛻 Van de Armas');
console.log('\nVan de Armas:', gunField?.value);
assert(gunField.value.includes('Rifle de Precisão (50% de desconto)'), 'arma traduzida');
assert(gunField.value.includes('Pistola de Choque (30% de desconto para Membros GTA+)'), 'arma + GTA+ traduzidos');

// Fallback da Van de Armas: post sem seção → armas com desconto do snapshot diário.
const embedVanFallback = createWeeklyRedditEmbed(
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
const gunFallbackField = embedVanFallback.data.fields.find((f) => f.name === '🛻 Van de Armas');
console.log('\nVan de Armas (fallback diário):', gunFallbackField?.value);
assert(
  gunFallbackField && gunFallbackField.value.includes('• Heavy Sniper — 50% de desconto'),
  'fallback usa armas do snapshot diário determinístico'
);
assert(gunFallbackField && !gunFallbackField.value.includes('Combat MG'), 'fallback ignora armas sem desconto');

// Rodapé com fonte, ID do post e tempo relativo
console.log('\nRodapé:', data.footer?.text);
assert(String(data.footer?.text).includes('Fonte: r/gtaonline'), 'rodapé menciona a fonte');
assert(String(data.footer?.text).includes('Post 1w5l0gs'), 'rodapé mostra o ID do post');
assert(
  /• (agora mesmo|Hoje às \d{2}:\d{2}|Ontem|\d+ (min|h|dias) atrás)/.test(String(data.footer?.text)),
  'rodapé mostra o tempo relativo do post'
);

// GTA+ traduzido
const plusField = data.fields.find((f) => f.name === '⭐ GTA+');
console.log('\nGTA+:', plusField?.value);
assert(plusField.value.includes('Thruster de graça'), 'item GTA+ traduzido');

// Desafio traduzido
const challField = data.fields.find((f) => f.name === '🎯 Desafio da Semana');
console.log('\nDesafio:', challField?.value);
assert(challField && challField.value.startsWith('🎯 Ganhe GTA$1,000,000 vendendo Carga Especial'), 'desafio traduzido');

console.log('\n=== RESULTADO ===');
console.log(`   Pass: ${pass} | Fail: ${fail}`);
if (fail > 0) process.exitCode = 1;
else console.log('   ✅ TODOS OS TESTES PASSARAM');