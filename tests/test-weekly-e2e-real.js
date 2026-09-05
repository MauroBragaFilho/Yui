import { getLatestWeekly, normalizePost } from '../src/engines/gtao/systems/weekly/reddit.js';
import { parseWeekly } from '../src/engines/gtao/systems/weekly/parser.js';
import { createWeeklyRedditEmbed } from '../src/discord/embeds/weeklyRedditEmbed.js';
import { buildWeeklyCombinedEmbeds } from '../src/engines/gtao/weeklyAnalysis.js';

/**
 * Validação fim-a-fim com o POST REAL do r/gtaonline:
 *   Reddit (rede) → parser → embed enxuto traduzido (PT-BR).
 */
async function run() {
  console.log('=== [TESTE] FIM-A-FIM POST REAL (Reddit → Parser → Embed PT-BR) ===');

  const raw = await getLatestWeekly();
  if (!raw?.id) {
    console.log('⚠️  Nenhum post weekly obtido. Abortando (rede bloqueada?).');
    return;
  }
  console.log(`\n1. Post real obtido: ${raw.id}`);
  console.log(`   Título original: ${raw.title}`);

  const post = normalizePost(raw);
  const parsed = parseWeekly(post.selftext, post.title);
  console.log('\n2. Parser (resumo):');
  console.log(`   periodo: ${parsed.periodo.inicio} → ${parsed.periodo.fim}`);
  console.log(`   podium: ${parsed.veiculos.podium}`);
  console.log(`   prizeRide: ${parsed.veiculos.prizeRide}`);
  console.log(`   bonus grupos: ${parsed.bonus.length} (${parsed.bonus.map((b) => b.multiplicador + 'x:' + b.atividades.length).join(', ')})`);
  console.log(`   descontos: ${parsed.descontos.length}`);
  console.log(`   gunVan: ${parsed.gunVan.length}`);
  console.log(`   gtaPlus: ${(parsed.gtaPlus.items || []).length}`);
  console.log(`   desafios: ${parsed.desafios.length}`);

  const embed = createWeeklyRedditEmbed({
    id: post.id,
    url: post.url,
    title: post.title,
    ...parsed,
  });

  console.log('\n3. EMBED TRADUZIDO (PT-BR):');
  console.log('   Título:', embed.data.title);
  console.log('   Descrição:', embed.data.description);
  for (const f of embed.data.fields) {
    console.log(`   [${f.name}]`);
    console.log(`   ${f.value.split('\n').join('\n   ')}`);
  }

  console.log('\n4. Descontos agrupados por loja:');
  const discField = embed.data.fields.find((f) => f.name === '🏷️ Descontos');
  const groupHeaders = (discField?.value.match(/\*\*[^\n]*\*\*/g) || []).filter((h) => h.includes(' •') === false);
  for (const h of groupHeaders) console.log(`   ${h}`);

  console.log('\n5. Composição combinada (resumo enxuto + páginas da IA):');
  const combined = buildWeeklyCombinedEmbeds({
    id: post.id,
    url: post.url,
    title: post.title,
    createdUtc: raw.createdUtc,
    ...parsed,
    analysis: {
      titulo: 'Bônus da Semana em PT-BR',
      destaques: 'Resumo principal dos eventos da semana.',
      itensGratuitos: 'Itens disponíveis de graça.',
      melhorFarm: 'Melhores formas de farmar GTA$/RP.',
      novidades: 'Novidades lançadas nesta atualização.',
      avaliacao: 'Semana Boa 🟢',
    },
  });
  console.log(`   Páginas: ${combined.length}`);
  for (const [i, p] of combined.entries()) {
    console.log(`   [${i + 1}/${combined.length}] ${p.data.title}`);
  }

  console.log('\n✅ FIM DO TESTE — tudo processado com o post real.');

  // Fecha o dispatcher global do fetch (undici) para liberar os sockets
  // keep-alive que seguram o event loop e impedem a saída natural do node.
  try {
    const { getGlobalDispatcher } = await import('undici');
    await getGlobalDispatcher().close();
  } catch {
    // Dispatcher indisponível: cai no timeout de segurança abaixo.
  }

  // Timeout de segurança (só dispara se algo ainda segurar o loop).
  setTimeout(() => process.exit(0), 30000).unref();
}

run().catch((e) => {
  console.error('❌ Erro:', e.message);
  process.exitCode = 1;
});