// Testes dos limites da busca na web e das menções (TG-01, TG-15, TG-22, TG-23):
//  - HTML hostil lido por fetchPage: o parse roda numa worker thread com prazo e NÃO trava o laço de eventos;
//  - resolveMentions: no máximo 25 nomes, 10 buscas e 3 s de rede por mensagem;
//  - fenceUntrustedWeb sem regex quadrática (saída idêntica à antiga);
//  - o otimizador de busca recebe só o começo da pergunta.
// SEM rede externa: só um servidor em 127.0.0.1 (porta 0) e dublês. Execução: npm run test:searchlimits
import assert from 'assert';
import { execFile } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-search-limits-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_SEARCH_BUDGET_FILE = path.join(tmp, 'search-budget.json');
process.env.LOG_LEVEL = 'error';

const safe = await import('../src/search/safeFetch.js');
const { fenceUntrustedWeb, sanitizeUntrusted, UNTRUSTED_OPEN, UNTRUSTED_CLOSE } = await import('../src/handlers/llmSafety.js');
const { resolveMentions } = await import('../src/discord/mentions.js');
const cheerio = await import('cheerio');
// por último: o módulo carrega o .env (dotenv) ao ser importado e isso não pode mexer nas variáveis acima
const searchManager = await import('../src/handlers/searchManager.js');
delete process.env.YUI_SEARCH_PARSE_TIMEOUT_MS;
delete process.env.YUI_SEARCH_MAX_HTML_TAGS;
delete process.env.YUI_SEARCH_MAX_HTML_CHARS;

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FALHA  ${name}\n${err.stack}`);
    process.exit(1);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Roda fn medindo o maior atraso do laço de eventos durante a execução. */
async function withLagMonitor(fn) {
  let max = 0;
  let last = performance.now();
  const iv = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - 10);
    last = now;
  }, 10);
  const started = performance.now();
  try {
    const value = await fn();
    return { value, lag: max, ms: performance.now() - started };
  } finally {
    clearInterval(iv);
  }
}

// Cópia do extractPageText de ANTES do TG-01 (síncrono, sem guardas): a saída para páginas normais tem de ser idêntica.
const LEGACY_NOISE = 'script, style, noscript, template, nav, footer, header, aside, .ads, .cookie-banner, .menu, .sidebar, .comments, .related, .related-posts, .social-share, .modal, .popup';
function legacyExtract(html, maxChars = 2000) {
  const $ = cheerio.load(String(html ?? ''));
  $(LEGACY_NOISE).remove();
  let root = $('article');
  if (root.length === 0) root = $('main');
  if (root.length === 0) root = $('#content, .content, #main, .main');
  if (root.length === 0) root = $('body');
  let text = '';
  root.find('h1, h2, h3, p, li').each((_, el) => {
    if (text.length >= maxChars) return false;
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    const heading = $(el).is('h1, h2, h3');
    if ((heading && t.length > 5) || t.length > 40) text += `${t}\n`;
    return undefined;
  });
  if (text.length < 100) text = root.text().replace(/\s+/g, ' ').trim();
  return text.slice(0, maxChars);
}

const para = (i) => `<p>Parágrafo número ${i} com bastante texto útil sobre o assunto principal da notícia de hoje.</p>`;
const ARTICLE = `<html><head><title>t</title><script>var x = 'nao deve aparecer';</script></head><body>
<nav><p>menu de navegação que não importa nada para o texto principal do artigo</p></nav>
<article><h1>Título do artigo</h1>${Array.from({ length: 40 }, (_, i) => para(i)).join('')}<li>${'Item de lista bem comprido para passar do mínimo de caracteres. '.repeat(2)}</li></article>
<footer><p>rodapé que também deve sair do texto final da página lida pelo bot</p></footer></body></html>`;
const MEGA_MENU = `<html><body><nav>${'<li><a href="/x">item</a></li>'.repeat(3000)}</nav><div class="content"><h1>Título do artigo importante</h1>${Array.from({ length: 50 }, (_, i) => para(i)).join('')}</div></body></html>`;
const SVG_SPRITE = `<html><body><svg>${'<path d="M0 0h1"/>'.repeat(6000)}</svg><main><h1>Título principal do documento</h1>${Array.from({ length: 50 }, (_, i) => para(i)).join('')}</main></body></html>`;

// ---------------------------------------------------------------------------------------------
// TG-01: parse isolado
// ---------------------------------------------------------------------------------------------
console.log('Parse isolado (TG-01)');

await test('importar o módulo não cria worker; página normal sai IDÊNTICA à do código antigo', async () => {
  assert.deepEqual(safe.parseWorkerState(), { alive: false, ready: false, running: false, queued: 0 });
  for (const [name, html] of Object.entries({ artigo: ARTICLE, vazio: '', espacos: '   \n ', texto: 'só texto sem tags' })) {
    const antigo = legacyExtract(html);
    assert.equal(safe.extractPageText(html), antigo, `síncrono: ${name}`);
    assert.equal(await safe.extractPageTextIsolated(html), antigo, `isolado: ${name}`);
  }
  assert.ok((await safe.extractPageTextIsolated(ARTICLE)).includes('Título do artigo'));
  assert.equal((await safe.extractPageTextIsolated(ARTICLE, { maxChars: 50 })).length, 50);
});

await test('menu pesado (6000 tags antes do artigo) e sprite SVG: o artigo é PRESERVADO, igual ao código antigo', async () => {
  for (const [name, html] of Object.entries({ menu: MEGA_MENU, svg: SVG_SPRITE })) {
    const antigo = legacyExtract(html);
    assert.ok(antigo.length > 500, `${name}: o caso de comparação precisa ter conteúdo`);
    const r = await safe.parsePageIsolated(html, { timeoutMs: 10000 });
    assert.equal(r.status, 'ok', name);
    assert.equal(r.text, antigo, name);
  }
});

await test('o parse não roda na thread principal: o laço de eventos não para durante uma página pesada', async () => {
  const { value, lag } = await withLagMonitor(() => safe.parsePageIsolated(MEGA_MENU, { timeoutMs: 10000 }));
  assert.equal(value.status, 'ok');
  assert.ok(lag < 250, `atraso do laço de eventos: ${Math.round(lag)} ms`);
});

await test('prazo estourado: texto vazio, worker encerrada e a próxima página volta a funcionar', async () => {
  const hostile = `<body>${'<div x="<">'.repeat(20000)}`;
  await safe.extractPageTextIsolated(ARTICLE); // worker pronta
  assert.equal(safe.parseWorkerState().alive, true);
  const t0 = Date.now();
  const r = await safe.parsePageIsolated(hostile, { timeoutMs: 300 });
  const ms = Date.now() - t0;
  assert.deepEqual(r, { text: '', status: 'timeout' });
  assert.ok(ms >= 250 && ms < 1500, `${ms} ms`);
  assert.equal(safe.parseWorkerState().alive, false, 'a worker presa foi encerrada');
  assert.equal(safe.parseWorkerState().running, false);
  const again = await safe.parsePageIsolated(ARTICLE);
  assert.equal(again.status, 'ok');
  assert.ok(again.text.includes('Título do artigo'));
});

await test('YUI_SEARCH_PARSE_TIMEOUT_MS vale (e valor inválido volta ao padrão)', async () => {
  const hostile = `<body>${'<span x="<">'.repeat(20000)}`;
  process.env.YUI_SEARCH_PARSE_TIMEOUT_MS = '250';
  try {
    const t0 = Date.now();
    const r = await safe.parsePageIsolated(hostile);
    assert.equal(r.status, 'timeout');
    assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
    process.env.YUI_SEARCH_PARSE_TIMEOUT_MS = 'abc';
    assert.equal((await safe.parsePageIsolated(ARTICLE)).status, 'ok', 'valor inválido não quebra: usa o padrão de 1500 ms');
  } finally {
    delete process.env.YUI_SEARCH_PARSE_TIMEOUT_MS;
  }
});

await test('uma página hostil NÃO leva junto as páginas normais que esperam na fila', async () => {
  const hostile = `<body>${'<div a<!--x>'.repeat(20000)}`;
  await safe.extractPageTextIsolated(ARTICLE);
  const [a, b, c] = await Promise.all([
    safe.parsePageIsolated(hostile, { timeoutMs: 300 }),
    safe.parsePageIsolated(ARTICLE),
    safe.parsePageIsolated(ARTICLE),
  ]);
  assert.equal(a.status, 'timeout');
  assert.equal(b.status, 'ok');
  assert.equal(c.status, 'ok');
  assert.equal(b.text, legacyExtract(ARTICLE));
  assert.equal(c.text, b.text);
});

await test('erro do parser (RangeError por aninhamento profundo) vira texto vazio, sem lançar e sem derrubar a worker', async () => {
  const deep = `<body>${'<table><tr><td>'.repeat(3000)}`;
  const r = await safe.parsePageIsolated(deep, { timeoutMs: 8000 });
  assert.equal(r.text, '');
  assert.ok(r.status === 'error' || r.status === 'timeout', r.status);
  assert.equal((await safe.parsePageIsolated(ARTICLE)).status, 'ok', 'a próxima página funciona');
  assert.equal(safe.extractPageText(deep.slice(0, 3000 * 15)).length >= 0, true, 'o síncrono também nunca lança');
});

await test('fila cheia: o excedente vira "busy" com texto vazio, o resto é lido normalmente', async () => {
  const results = await Promise.all(Array.from({ length: 60 }, () => safe.parsePageIsolated(ARTICLE)));
  const busy = results.filter((r) => r.status === 'busy');
  const ok = results.filter((r) => r.status === 'ok');
  assert.ok(busy.length > 0, 'esperava recusar o excedente');
  assert.equal(busy.length + ok.length, 60);
  assert.ok(busy.every((r) => r.text === ''));
  assert.ok(ok.every((r) => r.text.includes('Título do artigo')));
});

await test('B8 a fila de parse aceita no máximo 10 esperando (antes 30: o último de uma enxurrada de páginas hostis esperava ~57 s); o excedente vira "busy" na hora', async () => {
  const results = await Promise.all(Array.from({ length: 60 }, () => safe.parsePageIsolated(ARTICLE)));
  const busy = results.filter((r) => r.status === 'busy');
  const ok = results.filter((r) => r.status === 'ok');
  assert.ok(ok.length <= 11, `${ok.length} aceitas (1 em andamento + 10 esperando, no máximo)`);
  assert.ok(busy.length >= 49, `${busy.length} recusadas`);
  assert.equal(busy.length + ok.length, 60);
});

await test('F5 script e style GRANDES antes do artigo não apagam o artigo (saem antes do corte de 300000 caracteres)', async () => {
  const page = (head) => `<html><head><title>t</title>${head}</head><body><article><h1>Título do artigo importante</h1><p>${'Texto do conteúdo do artigo com bastante informação útil para o leitor. '.repeat(8)}</p></article></body></html>`;
  const heads = [
    `<script>${'x'.repeat(800000)}</script>`,
    `<style>${'a{}'.repeat(300000)}</style>`,
    `<SCRIPT type="application/json">${'y'.repeat(500000)}</SCRIPT>`,
    `<script>${'y'.repeat(1000)}</script>`.repeat(2000),
    `<script>${'z'.repeat(400000)}</script><style>${'b'.repeat(400000)}</style>`,
  ];
  for (const [i, head] of heads.entries()) {
    const r = await safe.parsePageIsolated(page(head));
    assert.equal(r.status, 'ok', `caso ${i}: ${r.status}`);
    assert.ok(r.text.includes('Título do artigo importante'), `caso ${i}: o artigo foi perdido (${r.text.length} caracteres)`);
    assert.ok(!r.text.includes('xxxx') && !r.text.includes('yyyy') && !r.text.includes('{}a{}'), 'o conteúdo do script e do style não aparece no texto');
  }
  // HTML com o artigo DEPOIS de um script que nunca fecha: o parser HTML trataria tudo como texto do script, então vira "sem conteúdo"
  const unclosed = await safe.parsePageIsolated(page('<script>var x = 1;'));
  assert.equal(unclosed.text, '');
});

await test('F5 dropRawTextBlocks: tira script e style (qualquer caixa), preserva "<scripty>", descarta até o fim se não fecha; custo linear', async () => {
  const { dropRawTextBlocks, capHtml } = await import('../src/search/parseWorker.js');
  assert.equal(dropRawTextBlocks('<p>a</p><script>var x=1</script><p>b</p><STYLE type="x">p{}</STYLE><p>c</p>'), '<p>a</p><p>b</p><p>c</p>');
  assert.equal(dropRawTextBlocks('<p>a</p><script src="x.js"></script><p>b</p>'), '<p>a</p><p>b</p>');
  assert.equal(dropRawTextBlocks('<scripty>keep</scripty><styles>keep</styles><p>z</p>'), '<scripty>keep</scripty><styles>keep</styles><p>z</p>');
  assert.equal(dropRawTextBlocks('<p>a</p><script>sem fechar <p>b</p>'), '<p>a</p>');
  assert.equal(dropRawTextBlocks('<p>a</p><script>fecha sem ">" </script'), '<p>a</p>');
  assert.equal(dropRawTextBlocks('sem tags <b>nenhuma</b> de script'), 'sem tags <b>nenhuma</b> de script');
  assert.equal(dropRawTextBlocks(''), '');
  assert.equal(dropRawTextBlocks(null), '');
  assert.equal(dropRawTextBlocks(undefined), '');
  // o corte de caracteres e de tags continua valendo DEPOIS de tirar os blocos
  assert.equal(capHtml(`<script>${'x'.repeat(500000)}</script>${'a'.repeat(400000)}`, { maxChars: 300000 }).length, 300000);
  assert.equal(capHtml('<script>1</script><p>1</p><p>2</p><p>3</p>', { maxTags: 2 }), '<p>1</p><p>2</p>');
  // entradas hostis: nenhuma passa de 300 ms (todas lineares)
  for (const hostile of ['<'.repeat(2000000), '<s'.repeat(1000000), '<script'.repeat(300000), '<script></'.repeat(200000), `<style>${'</'.repeat(500000)}`, '<script>'.repeat(200000)]) {
    const t0 = performance.now();
    dropRawTextBlocks(hostile);
    assert.ok(performance.now() - t0 < 300, `${(performance.now() - t0).toFixed(0)} ms para ${hostile.slice(0, 12)}...`);
  }
});

await test('cortes antes do parse: 300000 caracteres e 20000 tags (variáveis YUI_SEARCH_MAX_HTML_*)', async () => {
  const { capHtml, htmlLimits } = await import('../src/search/parseWorker.js');
  assert.deepEqual(htmlLimits({}), { maxChars: 300000, maxTags: 20000 });
  assert.deepEqual(htmlLimits({ YUI_SEARCH_MAX_HTML_CHARS: '1000', YUI_SEARCH_MAX_HTML_TAGS: '5' }), { maxChars: 1000, maxTags: 5 });
  assert.deepEqual(htmlLimits({ YUI_SEARCH_MAX_HTML_CHARS: 'x', YUI_SEARCH_MAX_HTML_TAGS: '-3' }), { maxChars: 300000, maxTags: 20000 });
  assert.equal(capHtml('a'.repeat(400000), { maxChars: 300000 }).length, 300000);
  assert.equal(capHtml('<p>1</p><p>2</p><p>3</p>', { maxTags: 2 }), '<p>1</p><p>2</p>', 'corta antes da 3ª abertura de tag');
  assert.equal(capHtml(`${'a'.repeat(9)}😀`, { maxChars: 10 }), 'a'.repeat(9), 'não deixa meio par substituto no fim');
  assert.equal(capHtml(null), '');
  const t0 = performance.now();
  capHtml('<a'.repeat(200000));
  assert.ok(performance.now() - t0 < 100, 'o corte tem custo linear');
});

await test('shutdownParseWorker encerra a worker e resolve o que estava pendente', async () => {
  await safe.extractPageTextIsolated(ARTICLE);
  const pending = safe.parsePageIsolated(`<body>${'<div x="<">'.repeat(20000)}`, { timeoutMs: 5000 });
  await sleep(50);
  safe.shutdownParseWorker();
  const r = await pending;
  assert.equal(r.text, '');
  assert.equal(r.status, 'error');
  assert.deepEqual(safe.parseWorkerState(), { alive: false, ready: false, running: false, queued: 0 });
});

await test('worker que não sobe: cada página vira "sem conteúdo" (error), sem lançar nem ficar presa; depois volta ao normal', async () => {
  safe._setParseWorkerUrlForTest(new URL('./nao-existe.js', import.meta.url));
  try {
    const t0 = Date.now();
    const rs = await Promise.all(Array.from({ length: 6 }, () => safe.parsePageIsolated(ARTICLE)));
    assert.deepEqual(rs.map((r) => r.status), Array(6).fill('error'));
    assert.ok(rs.every((r) => r.text === ''));
    assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms: sem uma nova tentativa por página`);
    assert.equal(safe.parseWorkerState().alive, false);
    assert.equal(safe.parseWorkerState().queued, 0);
  } finally {
    safe._setParseWorkerUrlForTest(null);
  }
  const ok = await safe.parsePageIsolated(ARTICLE);
  assert.equal(ok.status, 'ok');
  assert.ok(ok.text.includes('Título do artigo'));
});

await test('a worker (unref) não segura o processo: um script que só lê uma página termina sozinho', async () => {
  const url = new URL('../src/search/safeFetch.js', import.meta.url).href;
  const code = `import { extractPageTextIsolated, parseWorkerState } from ${JSON.stringify(url)};
const t = await extractPageTextIsolated('<body><article><h1>Título grande</h1><p>' + 'texto útil '.repeat(30) + '</p></article></body>');
console.log('len=' + t.length + ' alive=' + parseWorkerState().alive);`;
  const started = Date.now();
  const out = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', code], { timeout: 20000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
  assert.match(out, /len=\d+ alive=true/);
  assert.ok(Date.now() - started < 15000);
});

// ---------------------------------------------------------------------------------------------
// TG-01: páginas hostis pelo fetchPage (servidor local)
// ---------------------------------------------------------------------------------------------
console.log('HTML hostil via fetchPage (TG-01)');

const N = 20000;
const HOSTILE = {
  'div x="<" (215 KB)': { html: `<body>${'<div x="<">'.repeat(N)}` },
  'div a<!--x>': { html: `<body>${'<div a<!--x>'.repeat(N)}` },
  'span x="<"': { html: `<body>${'<span x="<">'.repeat(N)}` },
  'div com fechamento falso em atributo': { html: `<body>${'<div x="</div>">'.repeat(N)}` },
  'div/ autofechado': { html: `<body>${'<div/>'.repeat(5000)}` },
  '16000 div aninhados': { html: `<body>${'<div>'.repeat(16000)}` },
  '50000 <p>short</p> (586 KB)': { html: `<body>${'<p>short</p>'.repeat(50000)}`, maybeText: true },
  '70000 <span> (957 KB)': { html: `<body>${'<span>x</span>'.repeat(70000)}`, maybeText: true },
  '200000 <b> sem fechar': { html: `<body>${'<b>'.repeat(200000)}` },
  '200000 <a sem ">"': { html: `<body>${'<a'.repeat(200000)}` },
};
const pages = { '/artigo': ARTICLE, '/menu': MEGA_MENU };
Object.keys(HOSTILE).forEach((name, i) => { pages[`/hostil-${i}`] = HOSTILE[name].html; });

const server = http.createServer((req, res) => {
  const html = pages[req.url.split('?')[0]];
  if (html === undefined) {
    res.writeHead(404).end('nada');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  await test('página normal e menu pesado pelo fetchPage: mesmo texto de antes, parse "ok"', async () => {
    const a = await safe.fetchPage(`${base}/artigo`, { allowPrivate: true });
    assert.equal(a.ok, true);
    assert.equal(a.parse, 'ok');
    assert.equal(a.content, legacyExtract(ARTICLE));
    assert.equal('text' in a, false, 'o HTML bruto não sai de fetchPage');
    const m = await safe.fetchPage(`${base}/menu`, { allowPrivate: true, parseTimeoutMs: 10000 });
    assert.equal(m.parse, 'ok');
    assert.equal(m.content, legacyExtract(MEGA_MENU));
    assert.ok(m.content.includes('Título do artigo importante'));
  });

  let idx = 0;
  for (const [name, spec] of Object.entries(HOSTILE)) {
    const url = `${base}/hostil-${idx++}`;
    await test(`hostil: ${name} resolve em < 2000 ms, sem lançar e sem travar o laço de eventos`, async () => {
      await safe.extractPageTextIsolated(ARTICLE); // worker pronta: o tempo medido é o do prazo, não o da partida
      const { value: page, lag, ms } = await withLagMonitor(() => safe.fetchPage(url, { allowPrivate: true }));
      assert.equal(page.ok, true, 'o download em si funciona');
      assert.ok(ms < 2000, `${Math.round(ms)} ms`);
      assert.ok(lag < 300, `atraso do laço de eventos: ${Math.round(lag)} ms`);
      assert.ok(['ok', 'timeout', 'error'].includes(page.parse), page.parse);
      if (!spec.maybeText) assert.equal(page.content, '', 'sem texto útil: conteúdo vazio');
      assert.ok(page.content.length <= 2000);
    });
  }

  await test('depois das páginas hostis a leitura normal continua funcionando', async () => {
    const a = await safe.fetchPageContent(`${base}/artigo`, { allowPrivate: true });
    assert.equal(a, legacyExtract(ARTICLE));
  });

  // ---------------------------------------------------------------------------------------------
  // smartSearch de ponta a ponta: a página hostil não derruba as outras
  // ---------------------------------------------------------------------------------------------
  await test('smartSearch: a página hostil vira "sem conteúdo" e as normais entram no contexto', async () => {
    pages['/carros-gta-b'] = ARTICLE;
    pages['/carros-gta-c'] = ARTICLE.replace('Título do artigo', 'Segundo artigo sobre carros');
    const results = ['hostil-0', 'carros-gta-b', 'carros-gta-c'].map((p, i) => ({
      url: `${base}/${p}`,
      title: `carros gta online ${i}`,
      snippet: `resumo ${i} sobre carros gta`,
    }));
    await safe.extractPageTextIsolated(ARTICLE);
    const { value: ctx, lag, ms } = await withLagMonitor(() => searchManager.smartSearch(
      'pesquise carros gta',
      async () => ({ text: 'SIM: carros gta online' }),
      { searchImpl: async () => ({ provider: 'x', results, errors: [] }), readPage: (url) => searchManager.fetchPageContent(url, { allowPrivate: true }) },
    ));
    assert.ok(typeof ctx === 'string' && ctx.length > 0);
    assert.ok(ctx.includes('Parágrafo número 3'), 'o artigo normal foi lido');
    assert.ok(ctx.includes('Segundo artigo sobre carros'), 'o segundo artigo também');
    assert.ok(ctx.includes('RESUMO (Site bloqueado/erro): resumo 0'), 'a hostil cai no resumo da busca');
    assert.ok(ms < 4500, `${Math.round(ms)} ms`);
    assert.ok(lag < 300, `atraso do laço de eventos: ${Math.round(lag)} ms`);
  });
} finally {
  server.closeAllConnections?.();
  server.close();
  safe.shutdownParseWorker();
}

// ---------------------------------------------------------------------------------------------
// TG-15: resolveMentions
// ---------------------------------------------------------------------------------------------
console.log('Menções com custo limitado (TG-15)');

const member = (id, username) => ({ id, user: { id, username, globalName: null }, nickname: null, displayName: username });
const tokensText = (n, prefix = 'fulano') => Array.from({ length: n }, (_, i) => `@${prefix}${String(i).padStart(2, '0')}`).join(' ');

function guildWith({ cached = [], search, onValues } = {}) {
  const calls = { search: 0, values: 0 };
  const cache = new Map(cached.map((m) => [m.id, m]));
  return {
    calls,
    members: {
      cache: { values: () => { calls.values++; onValues?.(); return cache.values(); } },
      search: search ? async (arg) => { calls.search++; return search(arg); } : undefined,
    },
  };
}

await test('30 nomes desconhecidos com busca lenta: no máximo 10 buscas e o texto sai igual', async () => {
  const g = guildWith({ search: async () => { await sleep(30); return new Map(); } });
  const text = `oi ${tokensText(30)} fim`;
  const t0 = Date.now();
  assert.equal(await resolveMentions(text, g), text);
  assert.ok(g.calls.search <= 10, `buscas: ${g.calls.search}`);
  assert.ok(g.calls.search >= 1);
  assert.ok(Date.now() - t0 < 3000);
});

await test('nome achado na API continua sendo resolvido (dentro do limite) e o resto fica como texto', async () => {
  const achado = member('555555555555555555', 'fulano03');
  const g = guildWith({ search: async ({ query }) => new Map(query === 'fulano03' ? [[achado.id, achado]] : []) });
  const out = await resolveMentions(`${tokensText(5)}`, g);
  assert.equal(out, '@fulano00 @fulano01 @fulano02 <@555555555555555555> @fulano04');
  assert.equal(g.calls.search, 5);
});

await test('busca pendurada: respeita o orçamento de tempo (não espera o timeout do REST) e mantém o texto', async () => {
  let lateRejections = 0;
  const onUnhandled = () => { lateRejections++; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const g = guildWith({ search: () => new Promise((_, reject) => setTimeout(() => reject(new Error('tarde demais')), 600)) });
    const text = 'oi @fulano00 e @fulano01';
    const t0 = Date.now();
    assert.equal(await resolveMentions(text, g, { searchBudgetMs: 200 }), text);
    const ms = Date.now() - t0;
    assert.ok(ms >= 150 && ms < 550, `${ms} ms`);
    assert.ok(g.calls.search <= 2, `estourado o orçamento, não há novas buscas de verdade (${g.calls.search})`);
    await sleep(700); // a busca solta rejeita depois: não pode virar erro não tratado
    assert.equal(lateRejections, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

await test('resposta tardia de uma busca que já passou do prazo é ignorada', async () => {
  const tardio = member('777777777777777777', 'fulano00');
  const g = guildWith({ search: () => new Promise((resolve) => setTimeout(() => resolve(new Map([[tardio.id, tardio]])), 400)) });
  assert.equal(await resolveMentions('oi @fulano00', g, { searchBudgetMs: 150 }), 'oi @fulano00');
});

await test('a lista de membros do cache é montada UMA vez por mensagem, não uma por nome', async () => {
  const g = guildWith({ cached: [member('1', 'maria01')], search: async () => new Map() });
  await resolveMentions(tokensText(8), g);
  assert.equal(g.calls.values, 1);
});

await test('no máximo 25 nomes distintos por mensagem: os 25 primeiros resolvem, os demais ficam como texto', async () => {
  const cached = Array.from({ length: 30 }, (_, i) => member(String(1000 + i), `fulano${String(i).padStart(2, '0')}`));
  const g = guildWith({ cached });
  const out = await resolveMentions(tokensText(30), g);
  const mentions = out.match(/<@\d+>/g) ?? [];
  assert.equal(mentions.length, 25);
  assert.ok(out.startsWith('<@1000> <@1001>'));
  assert.ok(out.endsWith('@fulano25 @fulano26 @fulano27 @fulano28 @fulano29'));
  // o mesmo nome repetido muitas vezes conta uma vez só
  const rep = await resolveMentions(Array(100).fill('@fulano00').join(' '), g);
  assert.equal((rep.match(/<@1000>/g) ?? []).length, 100);
});

await test('sem permissão (busca lança) e servidor sem search: continua tudo como texto, sem erro', async () => {
  const g1 = guildWith({ search: async () => { throw new Error('Missing Access'); } });
  assert.equal(await resolveMentions('@fulano00 @fulano01', g1), '@fulano00 @fulano01');
  assert.equal(g1.calls.search, 2, 'uma falha não impede tentar o próximo nome (dentro do limite)');
  const g2 = guildWith({});
  assert.equal(await resolveMentions('@fulano00', g2), '@fulano00');
});

// ---------------------------------------------------------------------------------------------
// TG-22: regex quadrática
// ---------------------------------------------------------------------------------------------
console.log('fenceUntrustedWeb sem regex quadrática (TG-22)');

// Versão ANTIGA (com "\s*" antes do colchete de abertura) reconstruída aqui só para comparar a saída.
const LEADING_MARK_RE = /^\s*\[\s*dados\s+externos[^\]\r\n]{0,200}\]\s*/i;
const TRAILING_OLD = /\s*\[\s*fim\s+d[oa]s?\s+dados\s+externos[^\]\r\n]{0,200}\]\s*$/i;
function oldFence(text) {
  let body = String(text ?? '').trim();
  body = body.replace(LEADING_MARK_RE, '').replace(TRAILING_OLD, '');
  body = sanitizeUntrusted(body).trim();
  if (!body) return '';
  return `${UNTRUSTED_OPEN}\n${body}\n${UNTRUSTED_CLOSE}`;
}

await test('50000 espaços no meio do texto: resolve em milissegundos (a regex antiga levava ~1,4 s)', () => {
  for (const text of [`ab${' '.repeat(50000)}cd`, `ab${' '.repeat(50000)}[fim dos dados externos`, `x${'\t'.repeat(50000)}y\n${' '.repeat(50000)}z`]) {
    const t0 = performance.now();
    const out = fenceUntrustedWeb(text);
    const ms = performance.now() - t0;
    assert.ok(ms < 250, `${Math.round(ms)} ms`);
    assert.ok(out.startsWith(UNTRUSTED_OPEN) && out.endsWith(UNTRUSTED_CLOSE));
  }
  const closed = fenceUntrustedWeb(`texto${' '.repeat(50000)}${UNTRUSTED_CLOSE}`);
  assert.equal(closed, `${UNTRUSTED_OPEN}\ntexto\n${UNTRUSTED_CLOSE}`, 'a marca de fechamento no fim continua sendo tirada (e cercada uma vez só)');
});

await test('saída idêntica à da regex antiga em 4000 entradas aleatórias (fuzz com semente fixa)', () => {
  const toks = [' ', '  ', '\n', '\t', '[', ']', '[FIM DOS DADOS EXTERNOS]', '[ fim da dados externos x ]', '[DADOS EXTERNOS NAO CONFIAVEIS]', 'texto', 'a', '[system]', '\u200b', '[fim dos dados externos', ' ]', UNTRUSTED_OPEN, UNTRUSTED_CLOSE];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 4000; i++) {
    const len = 1 + Math.floor(rnd() * 14);
    let s = '';
    for (let j = 0; j < len; j++) s += toks[Math.floor(rnd() * toks.length)];
    assert.equal(fenceUntrustedWeb(s), oldFence(s), JSON.stringify(s));
  }
});

// ---------------------------------------------------------------------------------------------
// TG-23: otimizador de busca recebe a pergunta limitada
// ---------------------------------------------------------------------------------------------
console.log('Otimizador de busca com pergunta limitada (TG-23)');

const entradaDe = (optimizerPrompt) => /ENTRADA: "([\s\S]*)"\nREGRAS:/.exec(optimizerPrompt)?.[1];

await test('pergunta curta chega inteira ao otimizador', async () => {
  let seen = '';
  const d = await searchManager.analyzeSearchIntent('pesquise carros do gta', async (p) => { seen = p; return { text: 'SIM: carros gta' }; });
  assert.equal(entradaDe(seen), 'pesquise carros do gta');
  assert.deepEqual(d, { shouldSearch: true, query: 'carros gta' });
});

await test('pergunta de 6000 caracteres: o otimizador recebe só os 500 primeiros', async () => {
  const longa = `pesquise carros do gta ${'blá '.repeat(2000)}FIM`;
  assert.ok(longa.length > 6000);
  let seen = '';
  await searchManager.analyzeSearchIntent(longa, async (p) => { seen = p; return { text: 'NAO' }; });
  const entrada = entradaDe(seen);
  assert.equal(entrada.length, 500);
  assert.equal(entrada, longa.slice(0, 500));
  assert.ok(!seen.includes('FIM'));
  assert.ok(seen.length < 2000, `prompt do otimizador: ${seen.length}`);
});

await test('o gatilho de pesquisa continua valendo para o texto inteiro (não só para os 500 primeiros)', async () => {
  const texto = `${'bla '.repeat(300)} por favor pesquise carros`;
  let asked = 0;
  await searchManager.analyzeSearchIntent(texto, async () => { asked++; return { text: 'NAO' }; });
  assert.equal(asked, 1);
  let asked2 = 0;
  await searchManager.analyzeSearchIntent('bla '.repeat(300), async () => { asked2++; return { text: 'SIM: x' }; });
  assert.equal(asked2, 0, 'sem gatilho nem pergunta ao modelo');
});

await test('o corte não parte um par substituto (emoji) ao meio', async () => {
  // palavras (não um bloco de 490 letras: um "token" de 32+ caracteres parece chave e o pedido seria barrado antes do otimizador)
  const texto = `pesquise ${'abcd '.repeat(97)}abcde😀${'b '.repeat(25)}`; // o emoji ocupa os índices 499 e 500
  let seen = '';
  await searchManager.analyzeSearchIntent(texto, async (p) => { seen = p; return { text: 'NAO' }; });
  const entrada = entradaDe(seen);
  assert.equal(entrada.length, 499);
  assert.ok(!/[\ud800-\udbff]$/.test(entrada), 'sobrou meia letra no fim');
});

await test('se o otimizador falhar, a consulta de reserva também sai limitada', async () => {
  const d = await searchManager.analyzeSearchIntent(`pesquise ${'carros do gta '.repeat(400)}`, async () => { throw new Error('provedor fora'); });
  assert.equal(d.shouldSearch, true);
  assert.ok(d.query.length > 0 && d.query.length <= 500, `${d.query.length}`);
});

console.log(`\n${passed} testes OK`);
process.exit(0);
