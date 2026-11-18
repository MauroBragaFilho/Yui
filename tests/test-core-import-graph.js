// Grafo de imports do Core (etapa 1 do cérebro único, docs/ANALISE_COMPARATIVA_CEREBRO_YUI.md §3 e §6.1).
// Execução: npm run test:importgraph
//
// O núcleo do cérebro (src/core, menos a API) e o Gateway NÃO podem alcançar o Discord, a voz (TTS/STT), o rádio,
// os motores nem os handlers do bot, nem na subida (imports estáticos) nem na hora do uso (imports dinâmicos).
// A API (src/core/api) ainda tem rotas do painel que dependem do bot: elas ficam numa lista FECHADA de dívidas
// conhecidas, que só pode diminuir (aresta nova falha; aresta que sumiu também falha, para a lista não mentir).
import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '..');
const rel = (f) => path.relative(root, f).replaceAll('\\', '/');
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };

// ── O que é "do bot" ──────────────────────────────────────────────────────────────────────────
const FORBIDDEN_PACKAGES = ['discord.js', '@discordjs/voice', '@discordjs/opus', '@discordjs/ws', '@discordjs/rest', 'prism-media', 'opusscript', 'msedge-tts', 'puppeteer', '@gradio/client'];
const FORBIDDEN_DIRS = ['src/discord/', 'src/events/', 'src/music/', 'src/services/tts/', 'src/engines/', 'src/handlers/', 'src/scheduler/', 'src/commands/'];
const FORBIDDEN_FILES = ['src/services/sttService.js', 'src/index.js'];
// Módulos dentro das pastas do bot que são PUROS (sem Discord, sem voz): o Core pode usar. Cada um é conferido abaixo.
const PURE_EXCEPTIONS = {
  'src/handlers/currencyHandler.js': 'cotação de moeda (só axios)',
  'src/services/tts/reasons.js': 'textos dos motivos da voz desligada, sem imports',
  'src/handlers/listStore.js': 'listas pessoais do dono (só fs e path), usado pelo relatório matinal dos lembretes',
};

// Dívidas conhecidas da API: rotas do painel que ainda carregam código do bot NA HORA DO USO (a aresta pode estar no
// caminho, não só no arquivo da rota). Saem quando as rotas virarem ações do adaptador do Discord (etapa 3). Só pode diminuir.
const KNOWN_API_DEBT = [
  'src/services/deezerMusicService.js -> src/discord/embedLimits.js', // integrations.js (estado do Deezer) -> clampText -> discord.js
  'src/core/api/admin.js -> src/handlers/banHandler.js',
  'src/core/api/admin.js -> src/handlers/tosHandler.js',
  'src/core/api/admin.js -> src/handlers/youtubeApiHandler.js',
  'src/core/api/admin.js -> src/handlers/twitchApiHandler.js',
  'src/core/api/radioAdmin.js -> src/music/radioDatabase.js',
  'src/core/api/radioAdmin.js -> src/music/radioAudioPlayer.js',
  'src/core/api/radioAdmin.js -> src/music/radioManager.js',
  'src/core/api/radioAdmin.js -> pacote @discordjs/voice',
  'src/core/api/integrations.js -> src/services/tts/index.js',
];

// ── Leitura do grafo ──────────────────────────────────────────────────────────────────────────
const STATIC_RE = /(?:^|\n)[ \t]*(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g;
const DYN_LITERAL_RE = /\bimport\(\s*(['"`])([^'"`$]+)\1\s*\)/g;
const DYN_ANY_RE = /\bimport\(/g;
const REQUIRE_RE = /\brequire\(\s*['"`]|\bcreateRequire\(/g;
const BUILTINS = new Set(['fs', 'path', 'url', 'crypto', 'http', 'https', 'os', 'child_process', 'events', 'stream', 'util', 'zlib', 'net', 'tls', 'dns', 'readline', 'worker_threads', 'buffer', 'timers', 'assert', 'querystring', 'process', 'module', 'v8', 'perf_hooks', 'string_decoder', 'dgram', 'cluster', 'async_hooks', 'timers/promises', 'fs/promises', 'stream/promises', 'dns/promises']);

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const pkgOf = (spec) => {
  if (spec.startsWith('node:') || BUILTINS.has(spec)) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};
function resolveRel(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}
const cache = new Map();
function edgesOf(file) {
  if (cache.has(file)) return cache.get(file);
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const out = { edges: [], opaque: [] }; // opaque = import() não literal ou require (não dá para saber o alvo)
  const add = (spec, dynamic) => {
    if (spec.startsWith('.')) {
      const r = resolveRel(file, spec);
      if (r) out.edges.push({ to: rel(r), file: r, dynamic });
      else out.edges.push({ to: `?${spec}`, file: null, dynamic });
    } else {
      const p = pkgOf(spec);
      if (p) out.edges.push({ to: `pacote ${p}`, pkg: p, file: null, dynamic });
    }
  };
  for (const m of src.matchAll(STATIC_RE)) add(m[1] || m[2], false);
  let literal = 0;
  for (const m of src.matchAll(DYN_LITERAL_RE)) { add(m[2], true); literal++; }
  const anyDyn = [...src.matchAll(DYN_ANY_RE)].length;
  if (anyDyn > literal) out.opaque.push(`${anyDyn - literal} import() com alvo não literal`);
  if ([...src.matchAll(REQUIRE_RE)].length) out.opaque.push('require()/createRequire');
  cache.set(file, out);
  return out;
}
const forbiddenReason = (edge) => {
  if (edge.pkg) return FORBIDDEN_PACKAGES.includes(edge.pkg) ? `pacote do bot (${edge.pkg})` : null;
  if (!edge.file) return null;
  if (Object.hasOwn(PURE_EXCEPTIONS, edge.to)) return null;
  if (FORBIDDEN_FILES.includes(edge.to)) return 'arquivo do bot';
  const dir = FORBIDDEN_DIRS.find((d) => edge.to.startsWith(d));
  return dir ? `pasta do bot (${dir})` : null;
};

/** Percorre a partir das entradas, seguindo estáticos e dinâmicos. Para nas violações (não entra nelas). */
function walk(entries, { followDynamic = true, stopAt = () => false } = {}) {
  const seen = new Set();
  const queue = entries.map((e) => path.resolve(root, e));
  const violations = [];
  const opaque = [];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const { edges, opaque: op } = edgesOf(f);
    for (const o of op) opaque.push(`${rel(f)}: ${o}`);
    for (const e of edges) {
      if (e.dynamic && !followDynamic) continue;
      const why = forbiddenReason(e);
      if (why) { violations.push({ from: rel(f), to: e.to, dynamic: e.dynamic, why }); continue; }
      if (e.file && !stopAt(e.to)) queue.push(e.file);
    }
  }
  return { files: [...seen].map(rel), violations, opaque };
}
const listJs = (dir) => fs.readdirSync(path.join(root, dir), { recursive: true })
  .map((f) => `${dir}/${String(f).replaceAll('\\', '/')}`)
  .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
const show = (vs) => vs.map((v) => `${v.from} -> ${v.to} (${v.dynamic ? 'dinâmico' : 'estático'}: ${v.why})`).join('\n    ');

// Núcleo do cérebro: todo src/core menos a API (que tem a lista de dívidas) + o Gateway.
const CORE_ENTRIES = [...listJs('src/core').filter((f) => !f.startsWith('src/core/api/')), ...listJs('src/gateway')];
const API_ENTRIES = listJs('src/core/api');

console.log('Núcleo do cérebro (src/core sem a API, e o Gateway)');
await test('nenhum import estático alcança Discord, voz, rádio, motores ou handlers do bot', () => {
  const r = walk(CORE_ENTRIES, { followDynamic: false });
  assert.deepEqual(r.violations, [], `\n    ${show(r.violations)}`);
});
await test('nem os imports dinâmicos (na hora do uso): legacy-chain só pela ponte; a pesquisa sem a ponte usa o adaptador do Core', () => {
  const r = walk(CORE_ENTRIES, { followDynamic: true });
  assert.deepEqual(r.violations, [], `\n    ${show(r.violations)}`);
  assert.ok(r.files.length > 40, `poucos arquivos percorridos (${r.files.length}): o leitor de imports quebrou?`);
});
await test('nenhum import() com alvo não literal nem require() no núcleo (não dariam para conferir)', () => {
  const r = walk(CORE_ENTRIES, { followDynamic: true, stopAt: (to) => to.startsWith('src/core/api/') });
  assert.deepEqual(r.opaque, []);
});
await test('o manager não cita mais o llmHandler (a cadeia legada vem da ponte)', () => {
  const src = stripComments(fs.readFileSync(path.join(root, 'src/core/ai/manager.js'), 'utf8'));
  assert.doesNotMatch(src, /handlers\/llmHandler/);
});

console.log('API (src/core/api)');
await test('a subida da API (só imports estáticos) não carrega Discord nem voz: o TTS saiu da subida', () => {
  const r = walk(API_ENTRIES, { followDynamic: false });
  assert.deepEqual(r.violations, [], `\n    ${show(r.violations)}`);
  assert.ok(!r.files.some((f) => f.startsWith('src/services/tts/') && f !== 'src/services/tts/reasons.js'), 'algum arquivo do TTS entrou na subida da API');
});
await test('na hora do uso, só as dívidas conhecidas do painel (lista fechada, só diminui)', () => {
  const r = walk(API_ENTRIES, { followDynamic: true });
  const found = [...new Set(r.violations.map((v) => `${v.from} -> ${v.to}`))].sort();
  const novas = found.filter((e) => !KNOWN_API_DEBT.includes(e));
  const sumiram = KNOWN_API_DEBT.filter((e) => !found.includes(e));
  assert.deepEqual(novas, [], `aresta NOVA da API para o bot:\n    ${novas.join('\n    ')}`);
  assert.deepEqual(sumiram, [], `aresta que não existe mais (tire de KNOWN_API_DEBT):\n    ${sumiram.join('\n    ')}`);
  // Que nenhuma delas sobe junto com a API já é conferido no teste anterior (caminho só com imports estáticos).
});

// Etapa 3: a ENTRADA do processo do cérebro (src/cerebro.js e src/cerebro/). Ela sobe a API (que ainda tem as dívidas
// conhecidas acima, na hora do uso); no cérebro essas telas viram pedidos ao bot pelo canal e as dependências do painel são
// injetadas (src/cerebro/painel.js), então os imports dinâmicos das dívidas nunca rodam lá. Fora da API, nada do bot.
const CEREBRO_ENTRIES = ['src/cerebro.js', ...listJs('src/cerebro')];
console.log('Entrada do cérebro (src/cerebro.js)');
await test('a subida do cérebro (só imports estáticos) não carrega Discord, voz, rádio, motores nem handlers do bot', () => {
  const r = walk(CEREBRO_ENTRIES, { followDynamic: false });
  assert.deepEqual(r.violations, [], `\n    ${show(r.violations)}`);
  assert.ok(r.files.includes('src/core/api/server.js') && r.files.includes('src/core/channel/server.js'), 'o cérebro sobe a API e o canal');
});
await test('nem na hora do uso (imports dinâmicos), fora da API; e nenhum import() não literal nem require()', () => {
  const r = walk(CEREBRO_ENTRIES, { followDynamic: true, stopAt: (to) => to.startsWith('src/core/api/') });
  assert.deepEqual(r.violations, [], `\n    ${show(r.violations)}`);
  assert.deepEqual(r.opaque, []);
  assert.ok(!r.files.some((f) => f === 'src/index.js' || f.startsWith('src/discord/')), 'o cérebro não pode chegar ao bot');
});
await test('passando pela API, só as dívidas conhecidas, e o painel do cérebro troca essas telas por pedidos ao bot', () => {
  const r = walk(CEREBRO_ENTRIES, { followDynamic: true });
  const found = [...new Set(r.violations.map((v) => `${v.from} -> ${v.to}`))];
  assert.deepEqual(found.filter((e) => !KNOWN_API_DEBT.includes(e)), [], 'aresta do cérebro para o bot fora das dívidas conhecidas da API');
  assert.ok(r.violations.every((v) => v.from.startsWith('src/core/api/') || v.from === 'src/services/deezerMusicService.js'), show(r.violations));
  const painel = stripComments(fs.readFileSync(path.join(root, 'src/cerebro/painel.js'), 'utf8'));
  // (etapa 10: o createAdmin do cérebro também recebe o `reinicio`, o pedido ao supervisor; as dependências do painel continuam injetadas)
  assert.match(painel, /createAdmin\(\{ client: null, deps: CEREBRO_ADMIN_DEPS(?:,[^}]*)?\}\)/, 'o cérebro injeta as dependências do painel (nada do bot carregado)');
  for (const tela of ['guilds', 'guildDetail', 'setGuildChannel', 'setAutomod', 'bans', 'addBan', 'removeBan', 'addYoutubeFollow', 'removeYoutubeFollow', 'addTwitchFollow', 'removeTwitchFollow', 'radio', 'radioAction', 'integrations']) {
    assert.match(painel, new RegExp(`\\b${tela}\\b`), `a tela ${tela} precisa ir ao bot pelo canal`);
  }
  const entry = stripComments(fs.readFileSync(path.join(root, 'src/cerebro.js'), 'utf8'));
  assert.doesNotMatch(entry, /setLegacyBridge/, 'o cérebro não instala a ponte do bot');
});

console.log('Módulos movidos e exceções');
await test('pesquisa e llmSafety moram no Core; os caminhos antigos só reexportam', () => {
  for (const name of ['researchAgent', 'searchIntent', 'llmSafety']) {
    assert.ok(fs.existsSync(path.join(root, `src/core/ai/${name}.js`)), `${name} não está em src/core/ai`);
    const shim = stripComments(fs.readFileSync(path.join(root, `src/handlers/${name}.js`), 'utf8')).trim();
    assert.equal(shim, `export * from '../core/ai/${name}.js';`, `src/handlers/${name}.js deveria só reexportar`);
  }
  // Etapa 3: os buscadores e o leitor de páginas (searchManager) também. Ele tem export default ({ smartSearch }), que o `export *` não leva.
  // O caminho antigo continua em CRLF (o test-research-fixes confere o fim de linha dele).
  assert.ok(fs.existsSync(path.join(root, 'src/core/ai/searchManager.js')), 'searchManager não está em src/core/ai');
  const smShim = stripComments(fs.readFileSync(path.join(root, 'src/handlers/searchManager.js'), 'utf8')).trim().replace(/\r\n/g, '\n');
  assert.equal(smShim, "export * from '../core/ai/searchManager.js';\nexport { default } from '../core/ai/searchManager.js';", 'src/handlers/searchManager.js deveria só reexportar');
});
await test('as palavras proibidas moram no Core sem imports; o banHandler só reexporta a mesma lista (sem cópia)', () => {
  assert.deepEqual(edgesOf(path.join(root, 'src/core/forbiddenKeywords.js')).edges, [], 'core/forbiddenKeywords.js não pode ter imports');
  const ban = stripComments(fs.readFileSync(path.join(root, 'src/handlers/banHandler.js'), 'utf8'));
  assert.match(ban, /import \{ forbiddenKeywords \} from '\.\.\/core\/forbiddenKeywords\.js';/);
  assert.doesNotMatch(ban, /const forbiddenKeywords\s*=/, 'o banHandler não pode ter uma cópia da lista');
});
await test('as exceções "puras" não importam nada do bot', () => {
  for (const f of Object.keys(PURE_EXCEPTIONS)) {
    const r = walk([f], { followDynamic: true });
    assert.deepEqual(r.violations, [], `${f}:\n    ${show(r.violations)}`);
  }
  assert.deepEqual(edgesOf(path.join(root, 'src/services/tts/reasons.js')).edges, [], 'reasons.js não pode ter imports');
});
await test('o leitor de imports enxerga estático, dinâmico literal e não literal (autoteste)', () => {
  const tmp = path.join(root, 'tests', '.tmp-import-graph.js');
  fs.writeFileSync(tmp, "import a from './x.js';\nimport {\n  b,\n} from 'discord.js';\nconst c = await import('../src/music/radioManager.js');\nconst d = await import(nome);\n// import e from 'puppeteer';\n");
  try {
    cache.delete(tmp);
    const { edges, opaque } = edgesOf(tmp);
    assert.ok(edges.some((e) => e.pkg === 'discord.js' && !e.dynamic), 'import estático em várias linhas');
    assert.ok(edges.some((e) => e.to === 'src/music/radioManager.js' && e.dynamic), 'import dinâmico literal');
    assert.ok(!edges.some((e) => e.pkg === 'puppeteer'), 'comentário não conta');
    assert.equal(opaque.length, 1, 'import() não literal');
  } finally { fs.rmSync(tmp, { force: true }); cache.delete(tmp); }
});

console.log('Cérebro sem o bot (Core pronto para o Gateway) e com a ponte (como o bot roda hoje)');
const ai = await import('../src/core/ai/manager.js');
const researchCfg = () => ({ enabled: true, guard: 'on', preRoute: true, privateSearch: 'owner', totalDeadlineMs: 5000 });
const ownerCtx = { userId: 'dono', role: 'OWNER', memoryScope: 'personal', platform: 'api' };
const ASK_WEB = 'pesquise na internet o preço da placa de vídeo RTX 5090';
await test('sem a ponte: os mesmos backends de sempre aparecem (o /v1/health não muda) e o legacy-chain avisa que está indisponível', async () => {
  assert.equal(ai.hasLegacyBridge(), false);
  const names = ai.listBackends().map((b) => b.name);
  assert.ok(names.includes('legacy-chain') && names.includes('gateway'), `backends: ${names.join(', ')}`);
  if (!String(process.env.AI_BACKEND || '').trim()) assert.equal(ai.listBackends().find((b) => b.active)?.name, 'legacy-chain', 'o padrão continua legacy-chain');
  ai.setActiveBackend('legacy-chain');
  await assert.rejects(ai.chat({ prompt: 'oi', ctx: ownerCtx }), /ponte do bot/);
});
await test('sem a ponte: a pesquisa explícita do app vai ao adaptador do Core (síntese pelo backend do cérebro) e o turno segue pelo cérebro', async () => {
  // Sem rede: buscador e leitor de páginas são dublês injetados no adaptador do Core (deps.research).
  const searched = [];
  const research = {
    search: async (q, o) => { searched.push({ q, private: o?.private }); return { provider: 'dublê', errors: [], results: [
      { title: 'Preço da RTX 5090 no Brasil', url: 'https://loja.exemplo.test/hardware/rtx-5090-preco', snippet: 'A placa de vídeo RTX 5090 custa por volta de R$ 15 mil no Brasil.' },
      { title: 'RTX 5090: preço da placa de vídeo', url: 'https://noticias.exemplo.test/placas/rtx-5090', snippet: 'O preço da placa de vídeo RTX 5090 caiu nas lojas brasileiras.' },
    ] }; },
    readPage: async () => null,
  };
  const synth = [];
  ai.registerBackend({ name: 'cerebro-falso', local: false, async chat(a) { synth.push(a); return 'Resposta do cérebro.'; } }, { activate: true });
  const cfg = () => ({ ...researchCfg(), totalDeadlineMs: 60_000 });
  const routed = await ai.appResearchRoute({ ctx: ownerCtx, text: ASK_WEB }, { config: cfg, research });
  assert.equal(routed.handled, true);
  assert.equal(routed.kind, 'answer', routed.text);
  assert.ok(routed.text.startsWith('Resposta do cérebro.'), routed.text);
  assert.equal(searched.length, 1);
  assert.equal(searched[0].private, true, 'o app é conversa privada');
  assert.equal(synth.length, 1, 'uma síntese, pelo backend ativo do cérebro');
  assert.deepEqual([synth[0].history, synth[0].memoryBlock, synth[0].sensitive], [[], '', true]);
  const out = await ai.chatTurn({ prompt: 'me conta uma curiosidade sobre gatos', ctx: ownerCtx }, { config: cfg, research });
  assert.equal(out.text, 'Resposta do cérebro.');
  assert.equal(searched.length, 1, 'conversa sem pedido de pesquisa não pesquisa');
});
await test('com a ponte: legacy-chain e pesquisa do app chegam à cadeia do bot com as mesmas opções de antes', async () => {
  const calls = [];
  ai.setLegacyBridge(async () => ({
    generateResponse: async (prompt, channel, o) => { calls.push({ channel, allowSearch: o.allowSearch, disableTools: o.disableTools, guildId: o.guildId, sensitive: o.sensitive }); return 'resposta da cadeia legada'; },
    runResearchFor: async (o) => { calls.push({ pesquisa: o.question, sensitive: o.sensitive, isOwner: o.isOwner }); return { kind: 'answer', text: 'achei na web', private: true, historyLine: 'pesquisa feita' }; },
    isToolDisabled: () => false,
  }));
  try {
    assert.equal(ai.hasLegacyBridge(), true);
    ai.setActiveBackend('legacy-chain');
    assert.equal(await ai.chat({ prompt: 'oi', ctx: ownerCtx }), 'resposta da cadeia legada');
    assert.deepEqual(calls[0], { channel: 'api:dono', allowSearch: false, disableTools: true, guildId: null, sensitive: true });
    const routed = await ai.appResearchRoute({ ctx: ownerCtx, text: ASK_WEB }, { config: researchCfg });
    assert.equal(routed.handled, true);
    assert.equal(routed.text, 'achei na web');
    assert.deepEqual(calls[1], { pesquisa: ASK_WEB, sensitive: true, isOwner: true });
  } finally {
    ai.setLegacyBridge(null);
  }
});
await test('o bot instala a ponte na subida (src/index.js), apontando para o llmHandler', () => {
  const src = fs.readFileSync(path.join(root, 'src/index.js'), 'utf8');
  assert.match(src, /setLegacyBridge\(\(\) => import\('\.\/handlers\/llmHandler\.js'\)\);/);
});

console.log(`\n${passed} testes OK`);
process.exit(0);
