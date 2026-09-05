import {
  translateText,
  translateTitle,
  translateItems,
  translateDiscount,
  translateGunVanItem,
} from '../src/engines/gtao/systems/weekly/translate.js';

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

// Pré-trecho idêntico ao post real (conforme validação feita no parser).
// - periodo: 2026-09-03 → 2026-09-10
// - podium: Declasse Impaler SZ (manter)
// - prizeRide: Karin Woodlander (manter)
// - gunVan: 9 itens
// - descontos: 18
console.log('=== [TESTE] TRADUÇÃO EMBED SEMANAL (PT-BR) ===');

console.log('\n1. Título do post:');
const title = translateTitle(
  'Weekly Bonuses and Discounts - September 3rd to September 10th (Not live until ~5am ET on September 3rd)'
);
console.log(`   "${title}"`);
assert(title.includes('Bônus e Descontos da Semana'), 'título traduz cabeçalho');
assert(title.includes('3 de setembro'), 'título traduz mês/dia inicial');
assert(title.includes('10 de setembro'), 'título traduz mês/dia final');
assert(title.includes('disponível a partir de'), 'auxílio "not live" traduzido');

console.log('\n2. Veículos (mantidos em inglês):');
assert(translateTitle('Declasse Impaler SZ') === 'Declasse Impaler SZ', 'pódio mantém nome');
assert(translateText('Karin Woodlander') === 'Karin Woodlander', 'prize ride mantém nome');

console.log('\n3. Atividades de bônus:');
const atividades = {
  'Export Mixed Goods Missions': 'Missões de Exportação de Mercadorias Mistas',
  'Madrazo Hits': 'Contratos de Madrazo',
  'Diamond Adversary Series': 'Série Adversária Diamond',
  'Staff Sourcing Special Cargo': 'Compra de Carga Especial (Equipe)',
  'Drift Races': 'Corridas de Drift',
  'Transform Races': 'Corridas de Transformação',
  'Random Transform Races': 'Corridas de Transformação Aleatórias',
  'Gang Termination Contracts': 'Contratos de Extermínio de Gangues',
};
for (const [entrada, esperado] of Object.entries(atividades)) {
  const out = translateText(entrada);
  assert(out === esperado, `"${entrada}" → "${out}"`);
}

console.log('\n4. Descontos (mantém veículo/prédio):');
assert(
  translateDiscount('Coil Cyclone II - 70% Off') === 'Coil Cyclone II — 70% de desconto',
  'desconto de veículo mantém nome e traduz percentual'
);
const arcadius = translateDiscount('Arcadius Business Center Executive Office - Free');
assert(arcadius === 'Arcadius Business Center Executive Office — Grátis', `"${arcadius}" mantém prédio`);
const pickUp = translateDiscount('HVY Insurgent Pick-Up - 30% Off');
assert(pickUp === 'HVY Insurgent Pick-Up — 30% de desconto', `"${pickUp}" mantém hífen do nome do veículo`);

console.log('\n5. Van de Armas:');
assert(
  translateGunVanItem('Precision Rifle (50% off)') === 'Rifle de Precisão (50% de desconto)',
  'arma traduzida com percentual'
);
assert(
  translateGunVanItem('Stun Gun (30% off for GTA+ Members)') === 'Pistola de Choque (30% de desconto para Membros GTA+)',
  'arma + GTA+ Members traduzidos'
);

console.log('\n6. GTA+:');
assert(translateText('Free Thruster') === 'Thruster de graça', '"Free Thruster" → "Thruster de graça"');
assert(
  translateText('Free vehicle warehouse paint jobs') === 'vehicle warehouse paint jobs de graça',
  '"Free vehicle warehouse paint jobs" → traduz início por "de graça"'
);

console.log('\n7. Desafio (sentença longa):');
const desafio = translateText(
  'Earn GTA$1,000,000 from selling Special Cargo to get the Yeti x LS Customs Tracksuit and a 10X Reward of GTA$1,000,000'
);
console.log(`   "${desafio}"`);
assert(desafio.startsWith('Ganhe GTA$1,000,000 vendendo Carga Especial'), 'desafio: ganho inicial traduzido');
assert(desafio.includes('para obter o'), 'desafio: "to get the" traduzido');
assert(desafio.includes('e uma recompensa 10X de GTA$1,000,000'), 'desafio: recompensa 10X traduzida');

console.log('\n7b. Frases de contexto do 4x (post real):');
const ctx1 = translateText(
  'Get started down the Executive path by claiming the Arcadius Business Center Executive Office for free and arm your new Organization with some muscle while you source and sell by recruiting Associates.'
);
console.log(`   "${ctx1}"`);
assert(ctx1.startsWith('Comece o caminho Executivo ao reivindicar o Arcadius Business Center'), 'ctx: início executivo traduzido');
assert(ctx1.includes('armar sua nova Organização') || ctx1.includes('arme sua nova Organização'), 'ctx: organização traduzida');
assert(ctx1.includes('recrutando Associados'), 'ctx: "by recruiting Associates" traduzido');

const ctx2 = translateText(
  'Complete Weekly Challenges this month to earn a whopping 10X prize, plus rare, branded in-game gear, and a Penaud La Coureuse when you play between September 24-30 for free.'
);
console.log(`   "${ctx2}"`);
assert(ctx2.includes('Complete Desafios Semanais'), 'ctx2: desafios semanais traduzidos');
assert(ctx2.includes('prêmio 10X'), 'ctx2: prêmio 10X traduzido');
assert(ctx2.includes('Penaud La Coureuse'), 'ctx2: veículo preservado');
assert(/24 a 30 de setembro/.test(ctx2), 'ctx2: intervalo de datas traduzido');

console.log('\n8. Lista de itens (sem quebrar array):');
const arr = translateItems(['Drift Races', 'Coil Cyclone II - 40% Off']);
assert(Array.isArray(arr) && arr.length === 2, 'translateItems retorna array');
assert(arr[0] === 'Corridas de Drift', 'item 1 traduzido');

console.log('\n=== RESULTADO ===');
console.log(`   Pass: ${pass} | Fail: ${fail}`);
if (fail > 0) process.exitCode = 1;
else console.log('   ✅ TODOS OS TESTES PASSARAM');