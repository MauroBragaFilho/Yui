// A VERSÃO DA CI do teste ponta a ponta do Weekly do GTA Online (etapa 8, rodada depois da revisão da Liz, §12): a MESMA cadeia do tests/test-weekly-e2e-real.js
// (Reddit -> normalização -> parser -> embed enxuto em PT-BR -> composição combinada), mas com a RESPOSTA GRAVADA do feed do r/gtaonline
// (tests/fixtures/reddit-weekly.rss.xml, uma resposta real guardada) no lugar da rede. Nenhum acesso externo, nenhum navegador, nenhuma IA.
// O teste que lê o post de VERDADE continua existindo, só que fora da CI e opt-in: `YUI_TESTES_EXTERNOS=true npm run test:weekly-e2e-real` (tests/externos.json).
// Execução: npm run test:weeklygravado
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.LOG_LEVEL = 'error';
const raiz = path.resolve(import.meta.dirname, '..');
const { parseAtomFeed } = await import('../src/engines/gtao/systems/weekly/reddit-browser.js');
const { isValidWeeklyItem, normalizePost } = await import('../src/engines/gtao/systems/weekly/reddit.js');
const { parseWeekly } = await import('../src/engines/gtao/systems/weekly/parser.js');
const { createWeeklyRedditEmbed } = await import('../src/discord/embeds/weeklyRedditEmbed.js');
const { buildWeeklyCombinedEmbeds } = await import('../src/engines/gtao/weeklyAnalysis.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✔ ${name}`); };

// A resposta gravada: o mesmo caminho do searchWeeklyPosts (itens válidos, normalizados, o mais novo primeiro), sem a rede.
const xml = fs.readFileSync(path.join(raiz, 'tests', 'fixtures', 'reddit-weekly.rss.xml'), 'utf8');
const posts = parseAtomFeed(xml).filter(isValidWeeklyItem).map(normalizePost).sort((a, b) => (b.createdUtc ?? 0) - (a.createdUtc ?? 0));

console.log('A resposta gravada do Reddit (sem rede)');
await test('o feed gravado tem posts Weekly válidos e o mais novo vem primeiro (a escolha do post mais recente)', () => {
  assert.ok(posts.length >= 3, `posts: ${posts.length}`);
  assert.ok(posts.every((p) => p.id && p.title && p.selftext && /^https:\/\/www\.reddit\.com\/r\/gtaonline\/comments\//.test(p.url)));
  const ts = posts.map((p) => p.createdUtc ?? 0);
  assert.deepEqual([...ts].sort((a, b) => b - a), ts);
});

console.log('A cadeia do e2e real, com o post gravado');
for (const [i, raw] of posts.entries()) {
  await test(`post ${i + 1} (${raw.id}): normaliza, passa no parser e vira o embed enxuto em PT-BR e a composição combinada`, () => {
    const post = normalizePost(raw);
    assert.equal(post.id, raw.id);
    const parsed = parseWeekly(post.selftext, post.title);
    // o parser (o que o e2e real imprime)
    assert.ok(parsed.periodo?.inicio && parsed.periodo?.fim, 'período');
    assert.ok(parsed.veiculos?.podium, 'podium');
    assert.ok(parsed.bonus.length >= 1, 'bônus');
    assert.ok(parsed.descontos.length >= 3, 'descontos');
    // o embed enxuto traduzido (a página 1)
    const embed = createWeeklyRedditEmbed({ id: post.id, url: post.url, title: post.title, ...parsed });
    assert.ok(embed.data.title && embed.data.description, 'título e descrição do embed');
    assert.ok(embed.data.fields.length >= 3, 'campos do embed');
    assert.ok(embed.data.fields.every((f) => f.name && f.value), 'todo campo tem nome e valor');
    assert.ok(embed.data.fields.some((f) => /Bônus/.test(f.name)), 'o campo de bônus');
    assert.ok(embed.data.fields.some((f) => /Desconto/.test(f.name)), 'o campo de descontos');
    // a composição combinada (o resumo enxuto + as páginas da análise; a análise é um texto fixo, nenhuma IA)
    const combined = buildWeeklyCombinedEmbeds({
      id: post.id, url: post.url, title: post.title, createdUtc: raw.createdUtc, ...parsed,
      analysis: { titulo: 'Bônus da Semana em PT-BR', destaques: 'Resumo principal dos eventos da semana.', itensGratuitos: 'Itens disponíveis de graça.', melhorFarm: 'Melhores formas de farmar GTA$/RP.', novidades: 'Novidades lançadas nesta atualização.', avaliacao: 'Semana Boa 🟢' },
    });
    assert.ok(combined.length >= 2, `páginas: ${combined.length}`);
    assert.ok(combined.every((p) => p.data.title), 'cada página tem título');
  });
}

console.log('Nada de fora');
await test('este teste nunca abre rede, navegador nem processo: o feed vem do arquivo e só os módulos do parser e do embed rodam', () => {
  const fonte = fs.readFileSync(import.meta.filename, 'utf8').replace(/\/\/.*$/gm, '');
  // (os nomes vêm em pedaços para este teste não se achar a si mesmo)
  const proibidos = ['fet' + 'ch(', 'getLatest' + 'Weekly', 'searchWeekly' + 'Posts', 'pupp' + 'eteer', 'fetchWeeklyFeedVia' + 'Browser', 'child' + '_process'];
  for (const p of proibidos) assert.ok(!fonte.replace(/'[^']*' \+ '[^']*'/g, '').includes(p), `só a resposta gravada: nada de ${p}`);
});
console.log(`\n${passed} testes OK`);
