import { logger } from '../src/utils/logger.js';
import { parseWeekly, extractPeriod } from '../src/engines/gtao/systems/weekly/parser.js';
import { validateWeekly, isValidWeekly } from '../src/engines/gtao/systems/weekly/validator.js';
import { readCache, writeCache } from '../src/engines/gtao/systems/weekly/service.js';
import { isWeeklyPostTitle, isValidWeeklyItem, normalizePost } from '../src/engines/gtao/systems/weekly/reddit.js';

/**
 * POST SEMANAL EXEMPLO (simula o selftext do r/gtaonline "Weekly Bonuses
 * and Discounts"). A formatação segue o padrão típico do post, com
 * variações propositais para testar a tolerância do parser.
 */
const SAMPLE_SELFTEXT = `
**GTA Online Weekly Update**
This week: September 3, 2026 - September 9, 2026

**3X GTA$ & RP**
* Drift Races
* Transform Races
* Random Transform Races

**2X GTA$ & RP**
- Gang Termination Contracts
- The Agency Contract "The Lost Contract"

**Weekly Challenge**
* Complete a Drift Race to earn the Black Stetson and GTA$100,000

**Podium Vehicle**
Karin Sultan Classic

**Prize Ride**
Dinka Veto Classic

**Discounts**
* 30% Off — Cheval Taipan
* 30% Off — Vapid Flash GT
* 40% Off — Progen Emerus

**Gun Van**
* Assault SMG -30%
* Grenade Launcher

**GTA+**
* Free Thruster
* Free vehicle warehouse paint jobs
`;

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

async function run() {
  logger.info('=== [TESTE] PARSER WEEKLY (r/gtaonline) ===');

  console.log('\n1. Período extraído:');
  const period = extractPeriod(SAMPLE_SELFTEXT);
  console.log('   ', JSON.stringify(period));
  assert(period.inicio === '2026-09-03', 'início = 2026-09-03');
  assert(period.fim === '2026-09-09', 'fim = 2026-09-09');

  console.log('\n2. Parse do post:');
  const parsed = parseWeekly(SAMPLE_SELFTEXT);
  console.log(JSON.stringify(parsed, null, 2));

  // Multiplicadores
  const bonusMap = Object.fromEntries(parsed.bonus.map((b) => [b.multiplicador, b.atividades.length]));
  assert(bonusMap[3] === 3, 'existe bônus 3x com 3 atividades');
  assert(bonusMap[2] === 2, 'existe bônus 2x com 2 atividades');
  assert(parsed.bonus.length === 2, '2 grupos de multiplicador');

  // Veículos
  assert(parsed.veiculos.podium === 'Karin Sultan Classic', 'podium correto');
  assert(parsed.veiculos.prizeRide === 'Dinka Veto Classic', 'prizeRide correto');

  // Descontos
  assert(parsed.descontos.length === 3, '3 descontos encontrados');
  assert(parsed.descontos.some((d) => /Cheval Taipan/.test(d) && /30%/.test(d)), 'desconto Taipan 30%');

  // Desafios / recompensas
  assert(parsed.desafios.length > 0, 'desafios preenchidos');

  // Van de Armas / GTA+
  assert(parsed.gunVan.length === 2, 'gunVan com 2 itens');
  assert((parsed.gtaPlus.items || []).length === 2, 'gtaPlus com 2 itens');

  console.log('\n3. Validação:');
  const post = { id: 'abc123', title: 'Weekly Bonuses and Discounts for GTA Online...', selftext: SAMPLE_SELFTEXT };
  const v = validateWeekly(parsed, post);
  console.log('   ok =', v.ok, '| reasons =', v.reasons);
  assert(v.ok === true, 'Weekly válido passa na validação');

  const badPost = { id: 'x', title: 'Qualquer coisa', selftext: '' };
  const vBad = validateWeekly({ bonus: [], descontos: [] }, badPost);
  assert(vBad.ok === false, 'resultado vazio é rejeitado');

  console.log('\n4. Cache (leitura/escrita):');
  writeCache({ postId: 'abc123' });
  const cache = readCache();
  console.log('   ', JSON.stringify(cache));
  assert(cache.postId === 'abc123', 'cache persiste postId');
  // Restaura para não interferir em execução real do bot.
  writeCache({ postId: null });

  console.log('\n5. Reddit (normalização/validação estática):');
  assert(isWeeklyPostTitle('Weekly Bonuses and Discounts for GTA Online'), 'título correspondente é reconhecido');
  assert(!isWeeklyPostTitle('Alguma notícia qualquer'), 'título não correspondente é rejeitado');
  const rawItem = {
    id: 'ab12', title: 'Weekly Bonuses and Discounts for GTA Online', author: 'user',
    created_utc: 1720000000, permalink: '/r/gtaonline/comments/ab12/x/', url: 'https://reddit.com/x', selftext: 'texto',
  };
  assert(isValidWeeklyItem(rawItem), 'item bruto válido');
  const norm = normalizePost(rawItem);
  assert(norm.id === 'ab12' && norm.url.includes('reddit.com'), 'normalização preserva id/url');
  assert(!isValidWeeklyItem({ id: 'x', title: 'Outro título', selftext: '' }), 'item com título errado é rejeitado');

  console.log('\n6. Reddit (conexão real — pode falhar por bloqueio de rede):');
  await runNetworkTest();

  console.log('\n=== RESULTADO ===');
  console.log(`   Pass: ${pass} | Fail: ${fail}`);
  if (fail > 0) process.exitCode = 1;
  else console.log('   ✅ TODOS OS TESTES PASSARAM');
}

async function runNetworkTest() {
  try {
    const { getLatestWeekly } = await import('../src/engines/gtao/systems/weekly/reddit.js');
    const post = await getLatestWeekly();
    if (post && post.id) {
      console.log(`   ✅ Reddit acessível — post mais recente: ${post.id} ("${post.title.slice(0, 60)}")`);
      logger.info(`[Weekly] Post mais recente (teste rede): ${post.id}`);
    } else {
      console.log('   ℹ️  Reddit respondeu, mas nenhum post Weekly válido no momento.');
    }
  } catch (err) {
    console.log(`   ⚠️  Conexão ao Reddit bloqueada/indisponível (${err.message}). Teste de rede ignorado — não conta como falha.`);
  }
}

run();
