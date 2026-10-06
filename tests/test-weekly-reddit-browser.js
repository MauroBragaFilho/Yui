// Testes do acesso ao Reddit via navegador (feed RSS) — offline, com fixture real.
// Execução: npm run test:weekly-browser          (offline)
//           LIVE=1 npm run test:weekly-browser   (também abre o Chrome e consulta o Reddit)
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { parseAtomFeed, htmlToMarkdown, findBrowserExecutable } = await import('../src/engines/gtao/systems/weekly/reddit-browser.js');
const { isValidWeeklyItem, normalizePost } = await import('../src/engines/gtao/systems/weekly/reddit.js');
const { parseWeekly } = await import('../src/engines/gtao/systems/weekly/parser.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };

const xml = fs.readFileSync(path.join(here, 'fixtures', 'reddit-weekly.rss.xml'), 'utf8');
const items = parseAtomFeed(xml);

console.log('Feed Atom');
await test('lê os 5 posts com os campos no formato do .json do Reddit', () => {
  assert.equal(items.length, 5);
  for (const it of items) {
    assert.match(it.id, /^[a-z0-9]{5,10}$/, 'id sem o prefixo t3_');
    assert.ok(!it.author.startsWith('/u/') && it.author.length > 0);
    assert.match(it.permalink, /^\/r\/gtaonline\/comments\//);
    assert.equal(typeof it.created_utc, 'number');
    assert.ok(it.selftext.length > 500);
  }
});
await test('todos passam no filtro de título e normalizam', () => {
  assert.ok(items.every(isValidWeeklyItem));
  const n = normalizePost(items[0]);
  assert.equal(n.id, items[0].id);
  assert.match(n.url, /^https:\/\/www\.reddit\.com\/r\/gtaonline\/comments\//);
});
await test('o rodapé do feed ("submitted by", [link], [comments]) não vaza para o texto', () => {
  for (const it of items) assert.ok(!/submitted by|\[comments\]|SC_OFF|SC_ON/.test(it.selftext));
});
await test('o parser do Weekly extrai período, bônus, veículos e descontos de TODOS os posts', () => {
  for (const it of items) {
    const p = parseWeekly(it.selftext, it.title);
    assert.ok(p.periodo?.inicio && p.periodo?.fim, `período em ${it.title}`);
    assert.ok(p.bonus?.length >= 1, `bônus em ${it.title}`);
    assert.ok(p.veiculos?.podium, `podium em ${it.title}`);
    assert.ok(p.descontos?.length >= 3, `descontos em ${it.title}`);
  }
});
await test('posts ordenáveis por data (mais novo primeiro no feed)', () => {
  const ts = items.map((i) => i.created_utc);
  assert.deepEqual([...ts].sort((a, b) => b - a), ts);
});

console.log('HTML → markdown');
await test('títulos, negrito, itálico, links e listas aninhadas', () => {
  const md = htmlToMarkdown('<!-- SC_OFF --><div class="md"><h1>Título</h1><p>Texto <strong>forte</strong> e <em>leve</em>.</p><ul><li><a href="https://x.com/a">Chave</a>: Valor<ul><li>Filho</li></ul></li><li>Outro</li></ul></div><!-- SC_ON --> submitted by <a href="u">/u/x</a>');
  assert.match(md, /^# Título$/m);
  assert.match(md, /\*\*forte\*\*/);
  assert.match(md, /\*leve\*/);
  assert.match(md, /^\* \[Chave\]\(https:\/\/x\.com\/a\): Valor$/m);
  assert.match(md, /^  \* Filho$/m);
  assert.match(md, /^\* Outro$/m);
  assert.ok(!md.includes('submitted by'));
});
await test('HTML vazio ou nulo não quebra', () => {
  assert.equal(htmlToMarkdown(''), '');
  assert.equal(htmlToMarkdown(null), '');
});

console.log('Navegador');
await test('REDDIT_BROWSER_PATH tem prioridade quando o arquivo existe', () => {
  const fake = path.join(os.tmpdir(), 'fake-browser.exe');
  fs.writeFileSync(fake, '');
  process.env.REDDIT_BROWSER_PATH = fake;
  assert.equal(findBrowserExecutable(), fake);
  delete process.env.REDDIT_BROWSER_PATH;
  fs.rmSync(fake);
});

console.log('Embed com posts reais');
const { buildWeeklyCombinedEmbeds } = await import('../src/engines/gtao/weeklyAnalysis.js');
const embedSize = (e) => {
  const d = e.data;
  return (d.title || '').length + (d.description || '').length + (d.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);
};
await test('em todos os posts reais a página 1 é um resumo curto e as páginas respeitam os limites do Discord', () => {
  for (const it of items) {
    const parsed = parseWeekly(it.selftext, it.title);
    const weekly = { id: it.id, url: it.url, title: it.title, createdUtc: it.created_utc, ...parsed, discounts: parsed.descontos };
    const pages = buildWeeklyCombinedEmbeds(weekly);
    const first = embedSize(pages[0]);
    assert.ok(first <= 1300, `página 1 de "${it.id}" tem ${first} caracteres (máx. 1300)`);
    assert.ok(pages[0].data.fields.length <= 4, 'página 1 tem no máximo 4 blocos');
    for (const pg of pages) {
      assert.ok(embedSize(pg) <= 6000, 'embed dentro de 6000 caracteres');
      assert.ok((pg.data.fields || []).length <= 25, 'embed dentro de 25 fields');
      assert.ok((pg.data.fields || []).every((f) => f.value.length <= 1024 && f.name.length <= 256), 'fields dentro de 1024/256');
    }
    // nenhum desconto se perde: todos aparecem nas páginas de detalhe
    const detailText = pages.slice(1).flatMap((pg) => pg.data.fields || []).map((f) => f.value).join(' ');
    const total = parsed.descontos.length;
    const listed = parsed.descontos.filter((d) => detailText.includes(d.split(' - ')[0].trim())).length;
    assert.ok(listed >= total - 1, `descontos listados no detalhe: ${listed}/${total}`);
  }
});

if (process.env.LIVE === '1') {
  console.log('Ao vivo (abre o navegador)');
  const { searchWeeklyPosts } = await import('../src/engines/gtao/systems/weekly/reddit.js');
  await test('searchWeeklyPosts devolve posts válidos pelo navegador', async () => {
    process.env.REDDIT_FETCH_MODE = 'browser';
    const posts = await searchWeeklyPosts();
    assert.ok(posts.length >= 1);
    const p = parseWeekly(posts[0].selftext, posts[0].title);
    assert.ok(p.periodo?.inicio && p.bonus?.length);
    console.log(`     mais recente: ${posts[0].title.slice(0, 70)}`);
  });
}

console.log(`\n${passed} testes OK`);
process.exit(0);
