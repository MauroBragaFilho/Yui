// Testes da LISTA DE MODS (Minecraft): src/handlers/modListResolver.js + as portas em ask.js (/yui, +yui) e llmHandler.js (menção/DM).
// Respondem ao pedido real do dono ("yui pode anotar os mods que eu mandar e enviar a lista com o download de cada?" + 71 nomes), em que a Yui
// só repetiu os nomes: agora o CÓDIGO procura cada nome na API pública do Modrinth, calcula o par (loader, versão) em comum e devolve os links.
// Rodam SEM rede: o fetch é um dublê alimentado por respostas REAIS da API do Modrinth (tests/fixtures/modrinth/*.json, copiadas da API em 14/10)
// e por um pacote reduzido dessas respostas para a lista inteira do dono (tests/fixtures/modrinth/_pack-owner-list.json). Banco e log ficam em %TEMP%.
// Execução: npm run test:modlist   (node tests/test-mod-list.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const FIX = path.join(here, 'fixtures', 'modrinth');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-modlist-'));
Object.assign(process.env, {
  DATABASE_DIR: tmp,
  YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'),
  YUI_OWNER_ID: '111',
  LOG_LEVEL: 'error',
  YUI_PRIVATE_SEARCH: 'off',
  YUI_PRIVATE_CHANNEL_IDS: 'priv1',
  YUI_MEMORY_ENABLED: 'true',
  YUI_ALERTS: 'false',
  YUI_GATEWAY_IN_CHAIN: 'false',
  YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'search-budget.json'),
  YUI_SEARCH_PROVIDERS: 'searxng',
  SEARXNG_URL: 'http://searx.invalid/',
  YUI_CONTEXT_ENABLED: 'false',
  YUI_RESEARCH_ENABLED: 'true',
  YUI_RESEARCH_PRE_ROUTE: 'false',
  GROQ_API_KEY: 'gsk_chave_falsa_so_para_o_teste_1234567890',
});
for (const k of ['YUI_MODLIST_ENABLED', 'YUI_MODLIST_MAX_ITEMS', 'YUI_MODLIST_DEADLINE_MS', 'YUI_MODLIST_CONCURRENCY']) delete process.env[k];
process.chdir(tmp); // logs/ fica no temporário
fs.mkdirSync(path.join(tmp, 'persona'), { recursive: true });
for (const f of ['yui-publica.md', 'yui-voz.md']) {
  try { fs.copyFileSync(path.join(repoRoot, 'persona', f), path.join(tmp, 'persona', f)); } catch { /* texto de reserva */ }
}
// Nada sai da máquina: o fetch global e o padrão do resolvedor (safeFetchText) nunca devem ser usados; tudo entra por injeção.
globalThis.fetch = () => { throw new Error('rede bloqueada no teste'); };

const mod = await import(pathToFileURL(path.join(repoRoot, 'src/handlers/modListResolver.js')).href);
const longReply = await import(pathToFileURL(path.join(repoRoot, 'src/discord/longReply.js')).href);
const {
  readModlistConfig, detectModListRequest, parseModList, splitParts, extractHints, normalizeName, nameTokens, editDistance, scoreName, bandOf, pickBest,
  acceptableCandidates, compareMcVersion, choosePair, searchLinks, modPageUrl, versionPageUrl, projectPageUrl, resolveModList, formatModListReply,
  createModlistContext, createModlistGate, createLimiter, routeModList, MODRINTH_USER_AGENT, MODLIST_TEXT,
} = mod;

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    failures.push(name);
    console.log(`  FALHA - ${name}\n      ${String(err?.stack || err).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

// ── Dublê do Modrinth (fixtures reais) ─────────────────────────────────────────────────────────────────────
const normReq = (u) => {
  const x = new URL(u, 'https://api.modrinth.com');
  const p = [...x.searchParams.entries()].map(([k, v]) => `${k}=${v}`).sort();
  return x.pathname + (p.length ? `?${p.join('&')}` : '');
};
const table = new Map();
const projects = new Map();
for (const f of fs.readdirSync(FIX)) {
  if (!f.endsWith('.json') || f.startsWith('_')) continue;
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
  table.set(normReq(fx.request), { status: fx.status, body: fx.body });
  if (f.startsWith('projects_')) for (const p of fx.body) projects.set(p.id, p);
}
const pack = JSON.parse(fs.readFileSync(path.join(FIX, '_pack-owner-list.json'), 'utf8'));
const packTable = new Map(pack.requests.map((e) => [normReq(e.request), { status: e.status, body: e.body }]));
for (const p of pack.projects) projects.set(p.id, p);

/**
 * fetch no formato do safeFetchText: (url, opts) => { ok, status, text, truncated, error, code, rate? }.
 * `usePack`: acrescenta o pacote da lista inteira do dono. Busca/versão SEM resposta gravada vira "0 resultados"/"lista vazia" (e entra em `misses`).
 */
function makeModrinth({ usePack = false, delayMs = 0, wrap = null } = {}) {
  const calls = [];
  const misses = [];
  let inFlight = 0;
  const stats = { maxInFlight: 0 };
  const respond = (status, body, extra = {}) => ({ ok: status < 400, status, url: '', contentType: 'application/json', text: JSON.stringify(body), truncated: false, error: status < 400 ? '' : `HTTP ${status}`, code: status < 400 ? '' : 'HTTP', ...extra });
  const fetch = async (url, opts = {}) => {
    inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    try {
      const u = new URL(String(url));
      calls.push({ url: String(url), host: u.host, ua: opts.userAgent, accept: opts.headers?.Accept, types: opts.allowedContentTypes, maxBytes: opts.maxBytes });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (wrap) {
        const w = await wrap(String(url), calls.length, respond);
        if (w) return w;
      }
      if (u.host !== 'api.modrinth.com') throw new Error(`host não permitido no teste: ${u.host}`);
      if (u.pathname === '/v2/projects') {
        const ids = JSON.parse(u.searchParams.get('ids'));
        return respond(200, ids.map((i) => projects.get(i)).filter(Boolean));
      }
      const key = normReq(String(url));
      const hit = table.get(key) ?? (usePack ? packTable.get(key) : undefined);
      if (hit) return respond(hit.status, hit.body);
      misses.push(String(url));
      if (u.pathname === '/v2/search') return respond(200, { hits: [], total_hits: 0 });
      return respond(200, []);
    } finally {
      inFlight--;
    }
  };
  return { fetch, calls, misses, stats };
}

// Relógio e sono falsos: o tempo só anda quando o teste manda.
function makeClock(costPerCall = 0) {
  const clock = { t: 1_000_000, sleeps: [] };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => { clock.sleeps.push(ms); clock.t += ms; };
  clock.cost = costPerCall;
  return clock;
}
const baseOpts = (extra = {}) => ({ forbiddenKeywords: [], researchConfig: { privateSearch: 'off' }, random: () => 0, ctx: createModlistContext(), ...extra });
const cfgOf = (over = {}) => ({ enabled: true, maxItems: 120, deadlineMs: 120_000, concurrency: 3, ...over });
const logs = [];
const captureLog = (level, msg) => { logs.push(`${level}: ${msg}`); };

const OWNER_TEXT = fs.readFileSync(path.join(FIX, 'owner-request.txt'), 'utf8');
const SMALL = (extra = '') => `me manda o download desses mods\nWaystones\nCooking for blockheads\nchisel\nApple Skin\nFancy Menu\nSuplementaries\nDungeons Enchaced\nThe Sims Mod\nCosmetic Armor Reworked\nIndustrial Craft + addons\nRats\nMore Chests\nMajrusz's Acessories\n${extra}`;
const urlsIn = (text) => [...text.matchAll(/https?:\/\/[^\s)>\]]+/g)].map((m) => m[0]);
const hostOf = (u) => new URL(u).host;

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('1. Leitura da lista e detector');

await test('o texto EXATO do dono: 71 nomes, um por linha, a prosa fora, "A + B" dividido e "HUD+" inteiro', () => {
  const det = detectModListRequest(OWNER_TEXT);
  assert.equal(det.isRequest, true, det.reason);
  assert.equal(det.items.length, 71);
  const labels = det.items.map((i) => i.label);
  assert.equal(labels[0], 'chisel');
  assert.equal(labels[70], 'XP tome');
  assert.ok(labels.includes('Dungeons'), 'linha com espaço no fim virou "Dungeons"');
  assert.ok(labels.includes('Dragons Any'), 'as linhas quebradas NÃO são juntadas');
  const ind = det.items.find((i) => i.label.startsWith('Industrial Craft'));
  assert.deepEqual(ind.parts, ['Industrial Craft']);
  assert.deepEqual(ind.generic, ['addons'], '"addons" é genérico: avisado, nunca procurado');
  assert.deepEqual(det.items.find((i) => i.label.startsWith('Embelium')).parts, ['Embelium', 'Embelium 2']);
  assert.deepEqual(det.items.find((i) => i.label.startsWith('Invetory')).parts, ['Invetory HUD+'], '"HUD+" não divide (só " + " com espaços)');
  assert.deepEqual(det.items.find((i) => i.label.startsWith('Decorative blocks')).parts, ['Decorative blocks', 'Decorative Blocks modded compat']);
  assert.ok(!labels.some((l) => /Lembrando|continua/.test(l)), 'a prosa do pedido não vira item');
  assert.deepEqual(det.hints, { loader: null, mcVersion: null, ambiguous: false });
});

await test('parseModList: marcadores, numeração, negrito, CRLF, linhas em branco, repetidos e "Starlight x Create" inteiro', () => {
  const p = parseModList('- **Sodium**,\r\n\r\n2. Lithium\r\n[ ] Iris;\r\n• Create\r\n`JEI`\r\nsodium\r\nStarlight x Create\r\n');
  assert.deepEqual(p.items.map((i) => i.label), ['Sodium', 'Lithium', 'Iris', 'Create', 'JEI', 'Starlight x Create']);
  assert.equal(p.duplicates, 1);
  assert.deepEqual(splitParts('Starlight x Create').parts, ['Starlight x Create']);
  assert.deepEqual(splitParts('A + mods'), { parts: ['A'], generic: ['mods'] });
  assert.deepEqual(splitParts('Embelium+Embelium 2').parts, ['Embelium+Embelium 2'], 'sem espaços em volta do + não divide');
});

const names6 = 'Sodium\nLithium\nIris Shaders\nCreate\nJust Enough Items\nModernFix';
const POSITIVES = {
  'link e mods': `me manda o link de download desses mods\n${names6}`,
  'marcadores e cabeçalho com loader': `lista de mods forge 1.20.1, preciso dos links:\n${names6.split('\n').map((n) => `- ${n}`).join('\n')}`,
  numerada: `links dos mods:\n${names6.split('\n').map((n, i) => `${i + 1}. ${n}`).join('\n')}`,
  curseforge: `baixar do curseforge:\n${names6}`,
  'maiúsculas e acento': `LISTA DE MODS (PRECISO DOS LINKS):\n${names6}\nÁrvores Mágicas`,
  'linhas em branco': `onde baixar esses mods?\n\n${names6.split('\n').join('\n\n')}`,
  CRLF: `link dos mods:\r\n${names6.split('\n').join('\r\n')}`,
  inglês: `can you send me the download links for these minecraft mods?\n${names6}`,
  'pedido depois da lista': `${names6}\nme manda o link desses mods`,
  'menção ao bot': `<@123456789012345678> link dos mods:\n${names6}`,
  'mod no singular com minecraft': `qual o link desses mods de minecraft?\n${names6}`,
  'checkbox e negrito': `links dos mods:\n${names6.split('\n').map((n) => `[ ] **${n}**`).join('\n')}`,
  'só modrinth': `modrinth, links:\n${names6}`,
  'itens com vírgula e ponto': `lista dos mods com download:\n${names6.split('\n').map((n) => `${n},`).join('\n')}.`,
  'cita GTA mas é minecraft': `no minecraft, link dos mods (não é de GTA):\n${names6}`,
};
const NEGATIVES = {
  cumprimento: 'oi yui',
  'pergunta de uma linha': 'yui qual o melhor mod de minecraft?',
  'conversa curta com mod': 'esse mod\nfunciona?\nnao sei\nvamos ver\nok\nbeleza',
  'sem pedido de link': `olha os mods que eu uso\n${names6}`,
  'bloco de código': `links dos mods\n\`\`\`\n${names6}\n\`\`\``,
  'log colado': Array.from({ length: 10 }, (_, i) => `[2026-10-14 10:0${i}:00] [error] Exception in thread main: java.lang.NullPointerException at net.minecraft.mods.Loader.start(Loader.java:${100 + i}) falha ao carregar o mod`).join('\n'),
  'lista de compras': 'compras, me manda a lista:\narroz\nfeijão\nmacarrão\nleite\novo\npão',
  'jogos para baixar': 'preciso de links para baixar estes jogos:\nHades\nCeleste\nCeleste 64\nTunic\nCuphead\nInside',
  'só 3 itens': 'link dos mods\nSodium\nLithium\nIris',
  'só 2 itens': 'link dos mods\nSodium\nLithium',
  'parágrafos longos': Array.from({ length: 6 }, () => 'Eu estava pensando nos mods do servidor e queria saber se alguém consegue me passar o link para baixar porque o meu computador não abre nenhum deles direito').join('\n'),
  'palavra modo': 'modo história\nmodo difícil\nmodo online\nmodo livre\nmodo criativo\nmodo sobrevivência\nlink do jogo',
  'mod como moderador': 'preciso de um mod aqui\nbanir o fulano\nbanir o ciclano\nbanir o beltrano\nbanir o sicrano\nbanir o outro\nlista de bans',
  'mods como moderadores': 'os mods do servidor, lista de quem tem cargo:\nFulano\nCiclano\nBeltrano\nSicrano\nOutro\nMais um',
  'itens repetidos': 'links dos mods\nSodium\nSodium\nsodium\nSODIUM\nSodium',
  músicas: 'baixa essas músicas pra mim, me manda os links:\nBohemian Rhapsody\nImagine\nHey Jude\nYesterday\nLet It Be\nBlackbird',
  'links já colados': 'mods:\nhttps://modrinth.com/mod/sodium\nhttps://modrinth.com/mod/lithium\nhttps://modrinth.com/mod/iris\nhttps://modrinth.com/mod/create\nhttps://modrinth.com/mod/jei',
  vazio: '   ',
  'muita prosa': 'preciso dos links dos mods\neu estava pensando no jogo de ontem e queria saber como foi a sua semana inteira\nvocê viu o que aconteceu com aquele servidor que a gente jogava junto antes\nque calor hoje está fazendo por aí, aqui não dá para ficar na rua nenhum minuto\nSodium\nLithium\nIris\nCreate\nJEI\nfoi mal pela bagunça toda que eu fiz no canal de ontem à noite, não era a minha intenção\nvaleu por tudo mesmo, até mais tarde então pessoal',
  'texto enorme': `link dos mods\n${Array.from({ length: 3000 }, (_, i) => `Mod Numero ${i}`).join('\n')}`,
  'mods de GTA': `link dos mods de GTA V:\n${names6}`,
  'perguntas numeradas': '1. Qual o link do mod?\n2. Como baixar?\n3. Tem download pra mac?\n4. Funciona no forge?\n5. Quando sai?\n6. Quanto custa?',
  'mods de Skyrim': `lista de mods do skyrim, preciso dos links:\n${names6}`,
  'uma linha com vírgulas': 'link dos mods: Sodium, Lithium, Iris, Create, JEI, ModernFix',
  'download sem mods': `me manda o download desses programas:\n${names6}`,
};

await test(`detector: ${Object.keys(POSITIVES).length} mensagens que SÃO pedido de lista`, () => {
  for (const [name, text] of Object.entries(POSITIVES)) {
    const d = detectModListRequest(text);
    assert.equal(d.isRequest, true, `${name}: deveria ser pedido (motivo: ${d.reason})`);
    assert.ok(d.items.length >= 5, name);
  }
});

await test(`detector: ${Object.keys(NEGATIVES).length} mensagens que NÃO são (conversa normal nunca é pega)`, () => {
  for (const [name, text] of Object.entries(NEGATIVES)) {
    const d = detectModListRequest(text);
    assert.equal(d.isRequest, false, `${name}: NÃO deveria ser pedido`);
    assert.ok(d.reason && d.reason !== 'ok', `${name}: sem motivo`);
  }
});

await test('detector: a menção ao bot some do texto; o corpo de um bloco de código nunca é lista', () => {
  const d = detectModListRequest(POSITIVES['menção ao bot']);
  assert.equal(d.items[0].label, 'Sodium');
  assert.equal(detectModListRequest(NEGATIVES['bloco de código']).reason, 'bloco-de-codigo');
});

await test('corpus de texto de verdade: toda a documentação, o README, o .env_example, a persona e o código do projeto, colados como mensagem, NUNCA são pedido de lista', () => {
  const files = [
    ...fs.readdirSync(path.join(repoRoot, 'docs/content_pt')).filter((f) => f.endsWith('.md')).map((f) => `docs/content_pt/${f}`),
    'README.md', 'README_TESTES.md', '.env_example', 'persona/yui-publica.md', 'src/handlers/modListResolver.js', 'src/discord/commands/ask.js', 'tests/test-mod-list.js',
  ];
  let messages = 0;
  for (const rel of files) {
    const lines = fs.readFileSync(path.join(repoRoot, rel), 'utf8').split(/\r?\n/);
    // mensagens do tamanho que o /yui aceita (4000 caracteres), em janelas de linhas seguidas e também em janelas curtas de 12 linhas
    for (const size of [12, 40]) {
      for (let i = 0; i < lines.length; i += size) {
        const text = lines.slice(i, i + size).join('\n').slice(0, 4000);
        messages++;
        assert.equal(detectModListRequest(text).isRequest, false, `${rel} linhas ${i + 1}-${i + size} virou pedido de lista: ${text.slice(0, 80)}`);
      }
    }
  }
  assert.ok(messages > 500, `mensagens examinadas: ${messages}`);
});

await test('dicas de loader e versão: "Forge 1.20.1" numa linha, "fabric" e "1.21" na prosa; ambíguo vira nulo', () => {
  assert.deepEqual(detectModListRequest(`links dos mods\nForge 1.20.1\n${names6}`).hints, { loader: 'forge', mcVersion: '1.20.1', ambiguous: false });
  assert.deepEqual(detectModListRequest(`links dos mods, quero fabric na versão 1.21\n${names6}`).hints, { loader: 'fabric', mcVersion: '1.21', ambiguous: false });
  const amb = detectModListRequest(`links dos mods, forge ou fabric? 1.20.1 ou 1.21\n${names6}`).hints;
  assert.deepEqual(amb, { loader: null, mcVersion: null, ambiguous: true });
  assert.equal(extractHints('neoforge 1.21.1').loader, 'neoforge', 'neoforge não vira forge');
  assert.ok(!detectModListRequest(`links dos mods\nForge 1.20.1\n${names6}`).items.some((i) => /forge/i.test(i.label)), 'a linha de dica não é item');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('2. Correspondência de nomes');

await test('normalização e palavras: apóstrofo, "+", "\'II" digitado com i maiúsculo, "2" no meio faz papel de "to"', () => {
  assert.equal(normalizeName("Oh The Biomes You'II Go"), normalizeName("Oh The Biomes You'll Go"));
  assert.equal(normalizeName("Majrusz's Accessories"), 'majruszs accessories');
  assert.equal(normalizeName('Invetory HUD+'), 'invetory hud plus');
  assert.deepEqual(nameTokens('Waystones 2 Waypoints'), ['waystones', 'waypoints']);
  assert.deepEqual(nameTokens('Elenai Dodge 2'), ['elenai', 'dodge', '2'], 'o 2 do FIM é parte do nome');
  assert.equal(editDistance('suplementaries', 'supplementaries'), 1);
  assert.equal(editDistance('ab', 'ba'), 1, 'troca de letras vizinhas custa 1');
});

await test('pontuação: nome colado (AppleSkin), sigla no título (JEI), prefixo (Chisel Reborn), erro de digitação e os falsos conhecidos ficam nas faixas certas', () => {
  const s = scoreName;
  assert.ok(s('Apple Skin', 'AppleSkin', 'appleskin') >= 0.88);
  assert.ok(s('Just Enough Items', 'Just Enough Items (JEI)', 'jei') >= 0.88);
  assert.ok(s('Fancy Menu', 'FancyMenu', 'fancymenu') >= 0.88);
  assert.equal(bandOf(s('Cooking for blockheads', 'Cooking for Blockheads', 'cooking-for-blockheads')), 'achado');
  assert.ok(s('Dungeons Enchaced', 'Dungeons Enhanced', 'dungeons-enhanced') >= 0.88, 'a pontuação pura é alta; só a ESCADA a rebaixa para aviso (veja a seção 4)');
  assert.ok(s('Suplementaries', 'Supplementaries', 'supplementaries') >= 0.88);
  assert.equal(bandOf(s('Lost Trinkets', 'Lost Trinkets Renewed', 'lost-trinkets-renewed')), 'aviso');
  // os que NÃO podem passar por achados
  assert.equal(bandOf(s('More portals', 'No More Portals', 'no-more-portals')), 'nao', 'palavra a mais ANTES do trecho');
  assert.equal(bandOf(s('Dungeons Mobs', 'Dungeons Mobs Content', 'x')), 'aviso', 'extensão por prefixo é só aviso');
  assert.equal(bandOf(s('Upgrade core', 'Trim Upgrade : Core', 'trim-upgrade-core')), 'nao');
  assert.ok(s('Eye of Dragons', 'Dragon Eye', 'dragon-eye') < 0.88, 'palavras invertidas nunca são "achado" cheio');
  assert.equal(bandOf(s('Alex mobs', 'Zombie Mobs', 'zombie')), 'nao');
});

await test('com a busca REAL de "chisel": o 1º hit é um mod minúsculo só de Fabric; os candidatos trazem o Chisel Reborn (o par decide depois)', () => {
  const hits = table.get(normReq('/v2/search?query=chisel&facets=[["project_type:mod"]]&limit=10&index=relevance')).body.hits;
  const { best } = pickBest('chisel', hits);
  assert.equal(best.h.slug, 'psejas-chisel');
  const cands = acceptableCandidates('chisel', hits);
  assert.ok(cands.some((c) => c.h.slug === 'chisel-reborn'), 'Chisel Reborn é candidato por extensão de prefixo');
});

await test('compareMcVersion compara NÚMEROS (26.1 vem depois de 1.21.11); choosePair escolhe o par de maior cobertura e respeita o pedido', () => {
  assert.ok(compareMcVersion('26.1', '1.21.11') > 0);
  assert.ok(compareMcVersion('1.20.1', '1.20') > 0);
  assert.ok(compareMcVersion('1.9', '1.10') < 0);
  const hit = (cats, vs, downloads = 100) => ({ h: { categories: cats, versions: vs, downloads } });
  const entries = [
    { cands: [hit(['forge', 'fabric'], ['1.20.1', '1.21'])] },
    { cands: [hit(['forge'], ['1.20.1'])] },
    { cands: [hit(['fabric'], ['1.21'])] },
    { cands: [hit(['forge'], ['1.19.2']), hit(['forge'], ['1.20.1'])] }, // um candidato alternativo basta
  ];
  const free = choosePair(entries, {});
  assert.deepEqual([free.best.loader, free.best.version, free.best.covered], ['forge', '1.20.1', 3]);
  const asked = choosePair(entries, { loader: 'fabric' });
  assert.deepEqual([asked.best.loader, asked.best.version, asked.best.covered], ['fabric', '1.21', 2]);
  const none = choosePair(entries, { loader: 'quilt', mcVersion: '1.20.1' });
  assert.equal(none.best.covered, 0);
  assert.equal(choosePair([], {}).best, null);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('3. Links (host fixo, nada inventado)');

await test('links de busca: host fixo, nome codificado, sem nada do usuário além do nome; slug e id de versão validados', () => {
  const s = searchLinks("Smelthering & Co (v2)! 'x'");
  assert.ok(s.modrinth.startsWith('https://modrinth.com/mods?q='));
  assert.ok(s.curseforge.startsWith('https://www.curseforge.com/minecraft/search?search='));
  assert.ok(s.curseforge.endsWith('&class=mc-mods'));
  assert.equal(hostOf(s.modrinth), 'modrinth.com');
  assert.equal(hostOf(s.curseforge), 'www.curseforge.com');
  assert.ok(!/[ '()!]/.test(s.modrinth.split('q=')[1]), 'nome totalmente codificado');
  const hostile = searchLinks('https://evil.test/x?a=b#c @everyone <@123>');
  assert.equal(hostOf(hostile.modrinth), 'modrinth.com');
  assert.ok(!hostile.modrinth.includes('evil.test/') && !hostile.modrinth.includes('@') && !hostile.modrinth.includes('<'), hostile.modrinth);
  assert.equal(modPageUrl('chisel-reborn'), 'https://modrinth.com/mod/chisel-reborn');
  assert.equal(modPageUrl('../../etc'), '');
  assert.equal(modPageUrl('a b'), '');
  assert.equal(projectPageUrl('balm'), 'https://modrinth.com/project/balm');
  assert.equal(versionPageUrl('balm', 'dDN38ae7'), 'https://modrinth.com/mod/balm/version/dDN38ae7');
  assert.equal(versionPageUrl('balm', 'x/../y'), '');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('4. Resolução com a API (fixtures reais)');

await test('lista pequena, pedido SEM versão: o par é escolhido, cada link vem da API, e "Important Complements" fica à frente de quem precisa', async () => {
  const api = makeModrinth();
  const clock = makeClock();
  const r = await resolveModList(SMALL(), baseOpts({ fetch: api.fetch, now: clock.now, sleep: clock.sleep, config: cfgOf(), log: captureLog }));
  assert.equal(r.mode, 'normal');
  assert.deepEqual([r.compat.loader, r.compat.version], ['forge', '1.20.1']);
  assert.equal(r.compat.pinned, false);
  const text = r.text;
  assert.match(text, /Lista de mods: 13 nomes/);
  // links vindos da API
  assert.match(text, /\[Waystones\]\(<https:\/\/modrinth\.com\/mod\/waystones>\) · \[baixar 14\.1\.21\+forge-1\.20\.1\]\(<https:\/\/modrinth\.com\/mod\/waystones\/version\/Y0IgdaoP>\)/);
  // complemento à frente do mod que precisa, entre parênteses
  assert.match(text, /Waystones[^\n]*\(Important Complements: \[Balm\]\(<https:\/\/modrinth\.com\/project\/balm>\)\)/);
  assert.match(text, /Rats[^\n]*\(Important Complements: \[Citadel\]/);
  // Chisel: o 1º hit é só Fabric, o Chisel Reborn (do par) entra no lugar, com aviso
  assert.match(text, /\[Chisel Reborn\][^\n]*troquei «Chisel» por este para caber em Forge 1\.20\.1[^\n]*\(Important Complements: \[Architectury API\][^\n]*\[Cryonic Config\]/);
  // erro de digitação recuperado pela escada: aviso "achei como"
  assert.match(text, /\[Supplementaries\][^\n]*achei como «Supplementaries» \(você escreveu «Suplementaries»\), confira/);
  assert.match(text, /\[Dungeons Enhanced\][^\n]*achei como «Dungeons Enhanced» \(você escreveu «Dungeons Enchaced»\)/);
  assert.match(text, /\[Majrusz's Accessories\][^\n]*você escreveu «Majrusz's Acessories»/);
  // não achado: só link de busca, marcado
  assert.match(text, /The Sims Mod — não achei no Modrinth; busca \(não é download\): \[Modrinth\]\(<https:\/\/modrinth\.com\/mods\?q=The%20Sims%20Mod>\) · \[CurseForge\]\(<https:\/\/www\.curseforge\.com\/minecraft\/search\?search=The%20Sims%20Mod&class=mc-mods>\)/);
  // fora do par, com o motivo
  assert.match(text, /\[Industrial Craft\][^\n]*sem versão para Forge 1\.20\.1 \(existe para: Forge, versões até 1\.12\.2\)/);
  assert.match(text, /\[More Chests\][^\n]*sem versão para Forge 1\.20\.1/);
  assert.match(text, /\[Cosmetic Armor Reworked Forked\][^\n]*sem versão para Forge 1\.20\.1/);
  // "addons" é genérico demais
  assert.match(text, /addons — genérico demais para procurar/);
  // a linha de compatibilidade honesta e a pergunta
  assert.match(text, /Compatibilidade: \*\*Forge 1\.20\.1\*\* é a combinação que reúne mais mods \(\d+ dos \d+ encontrados\)\. Ficam de fora: [^\n]*Industrial Craft[^\n]*More Chests/);
  assert.match(text, /Faltam \(não achei\): The Sims Mod/);
  assert.ok(text.includes(MODLIST_TEXT.ask) && /Fabric 1\.21/.test(MODLIST_TEXT.ask));
  // complementos consolidados
  assert.match(text, /\*\*Important Complements\*\* \(obrigatórios que não estavam na sua lista\):/);
  assert.ok(r.complements.length >= 7);
  for (const c of r.complements) assert.match(c.versionUrl, /^https:\/\/modrinth\.com\/mod\/[\w.-]+\/version\/\w+$/);
  // contas
  assert.equal(r.compat.found, r.compat.covered + r.compat.missing.length);
  assert.ok(r.stats.requests > 0 && r.stats.requests < 60, `pedidos: ${r.stats.requests}`);
});

await test('TODA requisição: só GET em api.modrinth.com, com o User-Agent do projeto, Accept JSON e limite de bytes', async () => {
  const api = makeModrinth();
  await resolveModList(SMALL(), baseOpts({ fetch: api.fetch, config: cfgOf(), log: captureLog }));
  assert.ok(api.calls.length > 10);
  for (const c of api.calls) {
    assert.equal(c.host, 'api.modrinth.com');
    assert.ok(c.url.startsWith('https://api.modrinth.com/v2/'));
    assert.equal(c.ua, 'Yui-Discord-Bot/1.0 (https://github.com/MauroBragaFilho/Yui)');
    assert.equal(c.ua, MODRINTH_USER_AGENT);
    assert.equal(c.accept, 'application/json');
    assert.deepEqual(c.types, ['application/json']);
    assert.ok(c.maxBytes > 0 && c.maxBytes <= 2_000_000);
  }
  assert.ok(api.calls.some((c) => /\/search\?/.test(c.url)) && api.calls.some((c) => /include_changelog=false/.test(c.url)));
  assert.ok(!api.calls.some((c) => /\/versions\?ids=|\/dependencies/.test(c.url)), 'endpoints caros não são usados');
});

await test('pedido COM par ("Fabric 1.21" no texto): o resolvedor usa esse par, e diz quando ninguém tem a combinação', async () => {
  const api = makeModrinth();
  const text = `${SMALL()}fabric 1.21\n`;
  const r = await resolveModList(`${SMALL()}Forge 1.20.1\n`, baseOpts({ fetch: api.fetch, config: cfgOf(), log: captureLog }));
  assert.deepEqual([r.compat.loader, r.compat.version, r.compat.pinned], ['forge', '1.20.1', true]);
  assert.match(r.text, /Você pediu \*\*Forge 1\.20\.1\*\*: \d+ dos 12 mods encontrados existem para ela\. Ficam de fora: /);
  const rf = await resolveModList(text, baseOpts({ fetch: makeModrinth().fetch, config: cfgOf(), log: captureLog }));
  assert.deepEqual([rf.compat.loader, rf.compat.version, rf.compat.pinned, rf.compat.covered], ['fabric', '1.21', true, 0]);
  assert.match(rf.text, /nenhum dos \d+ mods achados tem versão para \*\*Fabric 1\.21\*\*/);
  // par impossível: nada cobre
  const r2 = await resolveModList(`${SMALL()}quilt 1.8\n`, baseOpts({ fetch: makeModrinth().fetch, config: cfgOf(), log: captureLog }));
  assert.equal(r2.compat.covered, 0);
  assert.match(r2.text, /nenhum dos \d+ mods achados tem versão para \*\*Quilt 1\.8\*\*/);
  assert.match(r2.text, /A combinação que reúne mais mods é \*\*Forge 1\.20\.1\*\*/);
});

await test('a lista INTEIRA do dono (71 nomes, 73 partes): 59 achados, Forge 1.20.1 cobre 47, 10 complementos, sem rede', async () => {
  const api = makeModrinth({ usePack: true });
  const clock = makeClock();
  const r = await resolveModList(OWNER_TEXT, baseOpts({ fetch: api.fetch, now: clock.now, sleep: clock.sleep, config: cfgOf(), log: captureLog }));
  assert.equal(r.stats.items, 71);
  assert.equal(r.stats.found, 59);
  assert.deepEqual([r.compat.loader, r.compat.version, r.compat.covered, r.compat.found], ['forge', '1.20.1', 47, 59]);
  assert.ok(r.compat.coverage > 0.79 && r.compat.coverage < 0.8);
  assert.equal(r.stats.skipped, 1, 'só o "addons" genérico foi ignorado');
  assert.deepEqual(r.complements.map((c) => c.title).sort(), ['Architectury API', 'Balm', 'CoFH Core', 'Citadel', 'Cryonic Config', 'Curios API', 'Konkrete', 'Majrusz Library', 'Melody', 'Structure Gel API'].sort());
  // nenhum complemento já estava na lista (Placebo, JEI e Moonlight Lib estão)
  assert.ok(!r.complements.some((c) => /placebo|jei|moonlight/i.test(c.title)));
  assert.ok(r.stats.requests >= 120 && r.stats.requests <= 250, `pedidos: ${r.stats.requests}`);
  for (const c of api.calls) assert.equal(c.host, 'api.modrinth.com');
  const notSearch = api.misses.filter((m) => !/\/v2\/search\?/.test(m));
  assert.ok(notSearch.length <= 1, `só degraus extras da escada não foram gravados (viram "0 resultados"): ${notSearch.join(' ')}`);
  // os casos conhecidos da lista
  const t = r.text;
  assert.match(t, /\[Waystones\][^\n]*14\.1\.21\+forge-1\.20\.1/);
  assert.match(t, /Embelium[^\n]*\n\s+- \[Embeddium\][^\n]*achei como «Embeddium»/);
  assert.match(t, /Embelium 2 — não achei no Modrinth/);
  assert.match(t, /\[Dragon Eye\][^\n]*para «Eye of Dragons» só achei algo parecido e pode ser outro mod/);
  assert.match(t, /Starlight x Create\n\s+- \[Starlight \(Forge\)\][^\n]*\n\s+- \[Create\][^\n]*separei o nome em dois, confira/);
  assert.match(t, /\[Sledgehammer\][^\n]*sem versão para Forge 1\.20\.1/);
  assert.match(t, /\[The Undergarden\]\(<[^>]+>\) · \[baixar [^\]]*\(beta\)\]/, 'versão beta é marcada');
  // Placebo é da lista: nunca aparece como complemento de ninguém
  assert.ok(!/Important Complements: [^\n]*Placebo/.test(t));
});

await test('o texto final da lista do dono cabe no divisor: partes de até 2000 caracteres, e vira anexo .md em vez de estourar o chat', async () => {
  const r = await resolveModList(OWNER_TEXT, baseOpts({ fetch: makeModrinth({ usePack: true }).fetch, config: cfgOf(), log: captureLog }));
  const parts = longReply.splitForDiscord(r.text);
  assert.ok(parts.length > 4, `partes: ${parts.length} (mais de 4 vai para o anexo .md)`);
  for (const p of parts) assert.ok(p.length <= 2000, `parte com ${p.length}`);
  assert.ok(r.text.length < longReply.MAX_REPLY_CHARS * 2);
  assert.ok(r.text.trimEnd().endsWith(MODLIST_TEXT.footer), 'o rodapé "-# ..." fecha o texto');
});

await test('120 itens (o limite) sem nada achado: só links de busca, e o texto continua cabendo no divisor sem parte acima de 2000', async () => {
  const names = Array.from({ length: 120 }, (_, i) => `Mod Inventado Numero ${String(i + 1).padStart(3, '0')}`);
  const api = makeModrinth();
  const clock = makeClock();
  const r = await resolveModList(`links dos mods:\n${names.join('\n')}`, { ...baseOpts({ fetch: api.fetch, now: clock.now, sleep: clock.sleep, config: cfgOf(), log: captureLog }), ctx: createModlistContext({ maxPerMinute: 100000 }) });
  assert.equal(r.items.length, 120);
  assert.equal(r.stats.found, 0);
  assert.equal(r.stats.notFound, 120);
  const parts = longReply.splitForDiscord(r.text);
  assert.ok(parts.length > 4);
  for (const p of parts) assert.ok(p.length <= 2000);
  // nenhum link além dos de busca
  for (const u of urlsIn(r.text)) assert.ok(/^https:\/\/(modrinth\.com\/mods\?q=|www\.curseforge\.com\/minecraft\/search\?search=)/.test(u), u);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('5. Segurança do texto (nomes e títulos hostis)');

await test('nomes hostis (@everyone, <@id>, ](url), crases, javascript:) nunca viram menção, link do usuário nem markdown quebrado', async () => {
  const hostile = [
    '@everyone', '@here pegadinha', 'Fulano <@123456789012345678>', 'evil](https://evil.test/x) mod', '[click](https://evil.test/y)', 'java`script`:alert(1)',
    '**negrito** __x__ ~~y~~ ||spoiler||', '# titulo <#123456789012345678>', '<@&123456789012345678> cargo', 'www.evil.test/baixar', 'discord.gg/convite', 'Mod Normal',
  ];
  const parsed = parseModList(`links dos mods:\n${hostile.join('\n')}`);
  assert.ok(parsed.items.length >= 5);
  const api = makeModrinth();
  const r = await resolveModList('', baseOpts({ fetch: api.fetch, config: cfgOf(), log: captureLog, parsed: { items: hostile.map((label, i) => ({ index: i + 1, label, parts: [label], generic: [] })), prose: [], hintLines: [] } }));
  const t = r.text;
  assert.ok(!/@everyone|@here/.test(t.replace(/@\u200b(everyone|here)/g, '')), 'sem @everyone/@here crus');
  assert.ok(!/<@!?&?\d+>|<#\d+>/.test(t), 'sem menção de usuário, cargo ou canal');
  assert.ok(!t.includes('evil.test'), 'link do usuário nunca é repetido');
  assert.ok(!/\]\(https?:/.test(t), 'todo link mascarado usa <>');
  assert.ok(!t.includes('```'));
  for (const u of urlsIn(t)) assert.ok(['modrinth.com', 'www.curseforge.com'].includes(hostOf(u)), `host fora da lista: ${u}`);
  for (const line of t.split('\n')) assert.ok(line.length < 700, 'linha enorme');
});

await test('título hostil vindo da API (menção, link e markdown no nome) é neutralizado; slug estranho não vira link', async () => {
  const evilHit = { project_id: 'AAAAAAAA', slug: 'good-slug', title: 'Evil <@123456789012345678> @everyone [x](https://evil.test) `code`', categories: ['forge'], versions: ['1.20.1'], downloads: 5 };
  const badSlug = { project_id: 'BBBBBBBB', slug: '../../admin', title: 'Bad Slug', categories: ['forge'], versions: ['1.20.1'], downloads: 5 };
  const wrap = async (url, n, respond) => {
    const u = new URL(url);
    if (u.pathname === '/v2/search') {
      const q = u.searchParams.get('query');
      return respond(200, { hits: q === 'Evil' ? [evilHit] : q === 'Bad Slug' ? [badSlug] : [] });
    }
    if (/\/project\/AAAAAAAA\/version/.test(u.pathname)) return respond(200, [{ id: 'VERSION1', version_number: '1.0 @everyone <@1234567890>', version_type: 'release', date_published: '2026-01-01', dependencies: [{ project_id: 'CCCCCCCC', dependency_type: 'required' }] }]);
    if (/\/project\/BBBBBBBB\/version/.test(u.pathname)) return respond(200, [{ id: 'VERSION2', version_number: '2.0', version_type: 'release', date_published: '2026-01-01', dependencies: [] }]);
    if (u.pathname === '/v2/projects') return respond(200, [{ id: 'CCCCCCCC', slug: 'lib-ok', title: 'Lib @everyone [y](https://evil2.test)' }]);
    return respond(200, []);
  };
  const api = makeModrinth({ wrap });
  const labels = ['Evil', 'Bad Slug', 'Outro Um', 'Outro Dois', 'Outro Tres'];
  const r = await resolveModList('', baseOpts({ fetch: api.fetch, config: cfgOf(), log: captureLog, hints: { loader: 'forge', mcVersion: '1.20.1' },
    parsed: { items: labels.map((label, i) => ({ index: i + 1, label, parts: [label], generic: [] })), prose: [], hintLines: [] } }));
  const t = r.text;
  assert.ok(!/@everyone|@here/.test(t.replace(/@\u200b(everyone|here)/g, '')));
  assert.ok(!/<@!?&?\d+>/.test(t));
  assert.ok(!t.includes('evil.test') && !t.includes('evil2.test'));
  assert.ok(!t.includes('../../admin'));
  assert.match(t, /https:\/\/modrinth\.com\/mod\/good-slug/);
  assert.match(t, /Lib/, 'o complemento aparece com o título neutralizado');
  assert.match(t, /Bad Slug — não achei no Modrinth; busca/, 'slug inválido: sem link de projeto, só busca');
  for (const u of urlsIn(t)) assert.ok(['modrinth.com', 'www.curseforge.com'].includes(hostOf(u)), u);
});

await test('dado pessoal e palavra proibida na lista viram "ignorado": o texto nunca sai para a API nem volta na resposta', async () => {
  const names = ['Sodium', 'Lithium', 'Iris', 'meu cpf 123.456.789-09', 'chave sk-abcdefghijklmnopqrstuvwxyz123456', 'porn mod', 'Create', 'ModernFix'];
  const api = makeModrinth();
  const r = await resolveModList(`links dos mods:\n${names.join('\n')}`, baseOpts({ fetch: api.fetch, config: cfgOf(), log: captureLog, forbiddenKeywords: ['porn'] }));
  assert.equal(r.stats.skipped, 3);
  const allCalls = api.calls.map((c) => decodeURIComponent(c.url)).join('\n');
  assert.ok(!/123\.456|sk-abc|porn/i.test(allCalls), 'nada disso foi para a API');
  assert.ok(!/123\.456|sk-abc|porn/i.test(r.text), 'nada disso voltou na resposta');
  assert.equal((r.text.match(/item ignorado \(não consultei\)/g) || []).length, 3);
  assert.ok(!r.text.includes('modrinth.com/mods?q=meu'), 'sem link de busca para o texto barrado');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('6. Limites, prazo, 429 e falha da API');

await test('YUI_MODLIST_MAX_ITEMS: o excedente fica de fora e a resposta diz quantos', async () => {
  const names = Array.from({ length: 9 }, (_, i) => `Nome Qualquer ${i + 1}`);
  const r = await resolveModList(`links dos mods:\n${names.join('\n')}`, baseOpts({ fetch: makeModrinth().fetch, config: cfgOf({ maxItems: 5 }), log: captureLog }));
  assert.equal(r.items.length, 5);
  assert.match(r.text, /Você mandou mais nomes do que o limite \(5\): procurei os 5 primeiros e deixei 4 de fora/);
  assert.deepEqual(readModlistConfig({}), { enabled: true, maxItems: 120, deadlineMs: 120000, concurrency: 3 });
  assert.deepEqual(readModlistConfig({ YUI_MODLIST_MAX_ITEMS: '9999', YUI_MODLIST_DEADLINE_MS: '10', YUI_MODLIST_CONCURRENCY: '0', YUI_MODLIST_ENABLED: 'off' }), { enabled: false, maxItems: 300, deadlineMs: 120000, concurrency: 3 });
});

await test('prazo total (relógio falso): estourou, sai o PARCIAL honesto, o resto vira link de busca e nada é pedido depois', async () => {
  const clock = makeClock();
  const api = makeModrinth({ wrap: async () => { clock.t += 6000; return null; } });
  const r = await resolveModList(`links dos mods:\nWaystones\nCooking for blockheads\nchisel\nApple Skin\nFancy Menu`, baseOpts({
    fetch: api.fetch, now: clock.now, sleep: clock.sleep, config: cfgOf({ deadlineMs: 20_000, concurrency: 1 }), log: captureLog,
  }));
  assert.equal(r.stats.stopAt, 3);
  assert.equal(r.stats.stopReason, 'deadline');
  assert.equal(r.stats.partial, true);
  assert.match(r.text, /Passei do prazo de 20 s: do item 3 em diante saíram só os links de busca\./);
  assert.match(r.text, /^1\. \[Waystones\]/m);
  assert.match(r.text, /^3\. chisel — não consultei; busca \(não é download\)/m);
  assert.match(r.text, /^5\. Fancy Menu — não consultei/m);
  assert.ok(api.calls.length <= 6, `pedidos: ${api.calls.length}`);
  assert.ok(!api.calls.some((c) => /query=chisel/.test(decodeURIComponent(c.url))), 'o item 3 não foi consultado');
});

await test('429 com Retry-After: espera o prazo pedido (mais folga) e continua; o ritmo é respeitado', async () => {
  const clock = makeClock();
  let n = 0;
  const api = makeModrinth({ wrap: async (url, count, respond) => { n++; return n === 2 ? respond(429, { error: 'rate' }, { rate: { retryAfter: '7', remaining: '0', reset: '7', limit: '300' } }) : null; } });
  const r = await resolveModList(SMALL(), baseOpts({ fetch: api.fetch, now: clock.now, sleep: clock.sleep, config: cfgOf({ concurrency: 1 }), log: captureLog }));
  assert.ok(clock.sleeps.some((ms) => ms >= 7000), `esperas: ${clock.sleeps}`);
  assert.equal(r.stats.rateLimited, false);
  assert.equal(r.stats.count429, 1);
  assert.equal(r.compat.loader, 'forge');
});

await test('429 que não passa: abandono ORDENADO (para de pedir, entrega o que já tem e diz por quê)', async () => {
  const clock = makeClock();
  let n = 0;
  let after = 0;
  const api = makeModrinth({ wrap: async (url, count, respond) => {
    n++;
    if (n <= 4) return null;
    after++;
    return respond(429, { error: 'rate' }, { rate: { retryAfter: '1' } });
  } });
  const r = await resolveModList(SMALL(), baseOpts({ fetch: api.fetch, now: clock.now, sleep: clock.sleep, config: cfgOf({ concurrency: 1 }), log: captureLog }));
  assert.equal(r.stats.rateLimited, true);
  assert.equal(r.stats.stopReason, 'ratelimit');
  assert.ok(after <= 3, `429 seguidos: ${after}`);
  assert.equal(api.calls.length, 4 + after, 'depois do abandono nenhum pedido novo');
  assert.match(r.text, /O Modrinth pediu para eu esperar \(limite de acessos\) no item \d+: de lá em diante saíram só os links de busca\./);
  assert.ok(r.stats.found >= 1, 'o que já tinha saiu');
});

await test('429 logo de cara em tudo: resposta honesta de "fora do ar", só links de busca, poucos pedidos', async () => {
  const clock = makeClock();
  const api = makeModrinth({ wrap: async (url, c, respond) => respond(429, { error: 'rate' }, { rate: { retryAfter: '2' } }) });
  const r = await resolveModList(SMALL(), baseOpts({ fetch: api.fetch, now: clock.now, sleep: clock.sleep, config: cfgOf({ concurrency: 1 }), log: captureLog }));
  assert.equal(r.mode, 'fora-do-ar');
  assert.match(r.text, /O Modrinth não respondeu agora \(fora do ar ou limitando acessos\)/);
  assert.ok(api.calls.length <= 4);
  assert.ok(!/modrinth\.com\/mod\//.test(r.text));
});

await test('falha TOTAL da API (503, rede): resposta honesta, links de busca locais, nenhum link de projeto inventado, pedidos limitados', async () => {
  for (const wrap of [async (u, c, respond) => respond(503, { error: 'x' }), async () => { throw new Error('ECONNRESET'); }]) {
    const clock = makeClock();
    const api = makeModrinth({ wrap });
    const r = await resolveModList(SMALL(), baseOpts({ fetch: api.fetch, now: clock.now, sleep: clock.sleep, config: cfgOf(), log: captureLog }));
    assert.equal(r.mode, 'fora-do-ar');
    assert.match(r.text, /O Modrinth não respondeu agora/);
    assert.match(r.text, /modrinth\.com\/mods\?q=Waystones/);
    assert.ok(!/modrinth\.com\/(mod|project)\//.test(r.text), 'nenhum link de projeto');
    assert.ok(api.calls.length <= 40, `pedidos: ${api.calls.length}`);
  }
});

await test('resposta cortada (truncated) ou JSON inválido vira falha daquele nome, nunca exceção', async () => {
  const api = makeModrinth({ wrap: async (url, c, respond) => (c % 2 ? respond(200, {}, { truncated: true }) : respond(200, {}, { text: '<html>não é json' })) });
  const r = await resolveModList(SMALL(), baseOpts({ fetch: api.fetch, now: makeClock().now, sleep: makeClock().sleep, config: cfgOf(), log: captureLog }));
  assert.ok(['fora-do-ar', 'normal'].includes(r.mode));
  assert.ok(typeof r.text === 'string' && r.text.length > 50);
});

await test('concorrência: no máximo YUI_MODLIST_CONCURRENCY pedidos ao mesmo tempo (3 e 1); o 2º trabalho divide o mesmo semáforo', async () => {
  for (const conc of [3, 1]) {
    const api = makeModrinth({ delayMs: 3 });
    await resolveModList(SMALL(), baseOpts({ fetch: api.fetch, config: cfgOf({ concurrency: conc }), log: captureLog }));
    assert.ok(api.stats.maxInFlight <= conc, `simultâneos: ${api.stats.maxInFlight} (limite ${conc})`);
    if (conc === 3) assert.ok(api.stats.maxInFlight >= 2, 'de fato paralelo');
  }
  // dois trabalhos ao mesmo tempo, mesmo contexto: o limite vale para a SOMA
  const shared = createModlistContext();
  const api = makeModrinth({ delayMs: 3 });
  await Promise.all([1, 2].map(() => resolveModList(SMALL(), { ...baseOpts({ fetch: api.fetch, config: cfgOf({ concurrency: 3 }), log: captureLog }), ctx: shared })));
  assert.ok(api.stats.maxInFlight <= 3, `simultâneos (2 trabalhos): ${api.stats.maxInFlight}`);
  // o limitador em si
  const lim = createLimiter(2);
  let cur = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 8 }, () => lim.run(async () => { cur++; peak = Math.max(peak, cur); await new Promise((r) => setTimeout(r, 2)); cur--; })));
  assert.equal(peak, 2);
});

await test('cache compartilhado: a mesma lista pela 2ª vez quase não pede nada à API', async () => {
  const ctx = createModlistContext();
  const api = makeModrinth();
  const clock = makeClock();
  const a = await resolveModList(SMALL(), { ...baseOpts({ fetch: api.fetch, now: clock.now, sleep: clock.sleep, config: cfgOf(), log: captureLog }), ctx });
  const before = api.calls.length;
  const b = await resolveModList(SMALL(), { ...baseOpts({ fetch: api.fetch, now: clock.now, sleep: clock.sleep, config: cfgOf(), log: captureLog }), ctx });
  assert.ok(api.calls.length - before <= 2, `2ª lista pediu ${api.calls.length - before}`);
  assert.ok(b.stats.cacheHits > 10);
  assert.equal(a.text.split('\n').length, b.text.split('\n').length);
});

await test('o ritmo próprio (240 por minuto) segura uma rajada: o excesso ESPERA em vez de bater no limite do Modrinth', async () => {
  const clock = makeClock();
  const ctx = createModlistContext({ maxPerMinute: 10 });
  const api = makeModrinth();
  await resolveModList(SMALL(), { ...baseOpts({ fetch: api.fetch, now: clock.now, sleep: clock.sleep, config: cfgOf({ concurrency: 1, deadlineMs: 300_000 }), log: captureLog }), ctx });
  assert.ok(clock.sleeps.length > 0 && clock.sleeps.some((ms) => ms > 1000), 'houve espera por causa do ritmo');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('7. Conversa privada e ferramenta desligada');

await test('conversa PRIVADA com YUI_PRIVATE_SEARCH=off: NENHUMA requisição; só links de busca locais, dizendo por quê', async () => {
  const api = makeModrinth();
  const r = await resolveModList(SMALL(), baseOpts({ fetch: api.fetch, config: cfgOf(), log: captureLog, sensitive: true, isOwner: true, researchConfig: { privateSearch: 'off' } }));
  assert.equal(api.calls.length, 0);
  assert.equal(r.mode, 'sem-consulta');
  assert.match(r.text, /Não consultei o Modrinth: numa conversa privada eu só consulto serviços externos quando o dono libera\./);
  assert.match(r.text, /Waystones — não consultei; busca \(não é download\): \[Modrinth\]\(<https:\/\/modrinth\.com\/mods\?q=Waystones>\)/);
  assert.ok(!/modrinth\.com\/(mod|project)\//.test(r.text), 'nenhum link de projeto');
  assert.ok(!MODLIST_TEXT.footer.includes('undefined'));
});

await test('YUI_PRIVATE_SEARCH=owner: só o dono consulta; all: qualquer um; fora do privado sempre consulta', async () => {
  const run = async (privateSearch, { sensitive = true, isOwner = false } = {}) => {
    const api = makeModrinth();
    const r = await resolveModList(SMALL(), baseOpts({ fetch: api.fetch, config: cfgOf(), log: captureLog, sensitive, isOwner, researchConfig: { privateSearch } }));
    return { calls: api.calls.length, mode: r.mode };
  };
  assert.equal((await run('owner', { isOwner: false })).calls, 0);
  assert.equal((await run('owner', { isOwner: true })).mode, 'normal');
  assert.ok((await run('owner', { isOwner: true })).calls > 0);
  assert.ok((await run('all', { isOwner: false })).calls > 0);
  assert.equal((await run('off', { sensitive: false })).mode, 'normal');
  assert.equal((await run('valor-estranho', { sensitive: true, isOwner: true })).calls, 0, 'valor desconhecido vale off');
});

await test('search_web desligada no servidor: nenhuma requisição e o motivo é dito', async () => {
  const api = makeModrinth();
  const r = await resolveModList(SMALL(), baseOpts({ fetch: api.fetch, config: cfgOf(), log: captureLog, searchDisabled: true }));
  assert.equal(api.calls.length, 0);
  assert.equal(r.mode, 'desativada');
  assert.match(r.text, /A pesquisa na web está desativada neste servidor/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('8. Porta de entrada: trava, progresso, log e falso positivo');

const entryOf = (over = {}) => ({ text: SMALL(), sensitive: false, isOwner: false, userId: 'u1', guildId: 'g1', channelId: 'c1', progress: () => false, ...over });
const routeDeps = (api, over = {}) => ({ fetch: api.fetch, ctx: createModlistContext(), now: makeClock().now, sleep: async () => {}, random: () => 0, gate: createModlistGate(), env: {}, log: captureLog, forbiddenKeywords: [], researchConfig: { privateSearch: 'off' }, llm: { isToolDisabled: () => false }, ...over });

await test('routeModList: pedido real devolve o contrato da Porta A (handled, researched, sem histórico); conversa normal, desligado e erro devolvem handled:false', async () => {
  const api = makeModrinth();
  const ok = await routeModList(entryOf(), routeDeps(api));
  assert.equal(ok.handled, true);
  assert.equal(ok.researched, true);
  assert.equal(ok.kind, 'modlist');
  assert.equal(ok.historyLine, null);
  assert.equal(ok.private, false);
  assert.match(ok.text, /^\*\*Lista de mods: 13 nomes\*\*/);
  const chat = await routeModList(entryOf({ text: 'oi yui, tudo bem?' }), routeDeps(api));
  assert.deepEqual(chat, { handled: false, reason: 'poucas-linhas' });
  const off = await routeModList(entryOf(), routeDeps(api, { env: { YUI_MODLIST_ENABLED: 'false' } }));
  assert.deepEqual(off, { handled: false, reason: 'desligado' });
  const broken = await routeModList({ text: SMALL(), progress: 'não é função' }, routeDeps(api, { fetch: () => { throw new Error('boom'); } }));
  assert.equal(typeof broken.handled, 'boolean', 'nunca lança');
});

await test('uma lista por pessoa por vez, no máximo duas no total; a vaga volta ao terminar', async () => {
  let release;
  const hold = new Promise((r) => { release = r; });
  const inner = makeModrinth();
  const slow = { ...inner, fetch: async (...a) => { await hold; return inner.fetch(...a); } };
  const deps = routeDeps(slow);
  const p1 = routeModList(entryOf({ userId: 'u1' }), deps);
  const p2 = routeModList(entryOf({ userId: 'u2' }), deps);
  const same = await routeModList(entryOf({ userId: 'u1' }), deps);
  assert.equal(same.handled, true);
  assert.equal(same.text, MODLIST_TEXT.userBusy);
  const third = await routeModList(entryOf({ userId: 'u3' }), deps);
  assert.equal(third.text, MODLIST_TEXT.busy);
  assert.equal(deps.gate.size(), 2);
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.match(a.text, /Lista de mods/);
  assert.match(b.text, /Lista de mods/);
  assert.equal(deps.gate.size(), 0, 'vagas devolvidas');
  const again = await routeModList(entryOf({ userId: 'u1' }), deps);
  assert.match(again.text, /Lista de mods/);
});

await test('resolveModList com userId: a trava vale na própria função (segunda lista da mesma pessoa e terceira pessoa recebem o aviso, sem requisição)', async () => {
  let release;
  const hold = new Promise((r) => { release = r; });
  const inner = makeModrinth();
  const slow = { ...inner, fetch: async (...a) => { await hold; return inner.fetch(...a); } };
  const gate = createModlistGate();
  const mk = (userId, api = slow) => resolveModList(SMALL(), { ...baseOpts({ fetch: api.fetch, config: cfgOf(), log: captureLog }), userId, gate });
  const p1 = mk('ana');
  const p2 = mk('bia');
  const again = await mk('ana', makeModrinth());
  assert.deepEqual([again.ok, again.mode, again.busy, again.text], [false, 'ocupado', 'user', MODLIST_TEXT.userBusy]);
  const third = await mk('caio', makeModrinth());
  assert.deepEqual([third.mode, third.busy, third.text], ['ocupado', 'busy', MODLIST_TEXT.busy]);
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a.mode, 'normal');
  assert.equal(b.mode, 'normal');
  assert.equal(gate.size(), 0);
  const free = await mk('ana', makeModrinth());
  assert.equal(free.mode, 'normal');
  // a vaga também volta quando o trabalho falha por dentro
  const clock = makeClock();
  const boom = await resolveModList(SMALL(), { ...baseOpts({ fetch: async () => { throw new Error('x'); }, now: clock.now, sleep: clock.sleep, config: cfgOf(), log: captureLog }), userId: 'dani', gate });
  assert.ok(['fora-do-ar', 'normal'].includes(boom.mode));
  assert.equal(gate.size(), 0);
});

await test('a vaga esquecida expira (5 min) e a trava libera mesmo se ninguém chamar release', () => {
  let t = 0;
  const gate = createModlistGate({ now: () => t, ttlMs: 1000, maxJobs: 2 });
  assert.equal(gate.tryAcquire('a').ok, true);
  assert.equal(gate.tryAcquire('a').reason, 'user');
  assert.equal(gate.tryAcquire('b').ok, true);
  assert.equal(gate.tryAcquire('c').reason, 'busy');
  t = 1500;
  assert.equal(gate.tryAcquire('c').ok, true);
  const anon = createModlistGate({ maxJobs: 1 });
  const x = anon.tryAcquire(null);
  assert.equal(x.ok, true);
  assert.equal(anon.tryAcquire(null).reason, 'busy');
  x.release();
  assert.equal(anon.tryAcquire(null).ok, true);
});

await test('progresso: no máximo 4 linhas "-# ...", sempre o texto fixo do código (nunca nomes) e a última com last:true', async () => {
  const lines = [];
  const names = Array.from({ length: 24 }, (_, i) => `Mod Teste ${i + 1}`);
  const entry = entryOf({ text: `links dos mods:\n${names.join('\n')}`, progress: (line, opts) => { lines.push({ line, opts }); return true; } });
  const r = await routeModList(entry, routeDeps(makeModrinth()));
  assert.ok(r.handled === true || r.reason === 'sem-acertos');
  assert.ok(lines.length >= 2 && lines.length <= 4, `linhas: ${lines.length}`);
  for (const l of lines) {
    assert.ok(l.line.startsWith('-# '), l.line);
    assert.ok(!/Mod Teste/.test(l.line), 'o progresso não repete nome do usuário');
  }
  assert.match(lines[0].line, /Procurando os mods: 0\/24/);
  const last = lines[lines.length - 1];
  if (r.handled) assert.equal(last.opts?.last, true);
});

await test('falso positivo: o Modrinth RESPONDEU e não achou nada (ex.: mods de outro jogo) -> handled:false, a IA responde como antes', async () => {
  const text = 'me manda o link dos mods do minecraft bedrock\nAlfa Zeta\nBeta Omega\nGama Delta\nEpsilon Theta\nKappa Lambda\nMi Ni';
  const r = await routeModList(entryOf({ text }), routeDeps(makeModrinth()));
  assert.deepEqual(r, { handled: false, reason: 'sem-acertos' });
});

await test('conversa privada pela porta: sem YUI_PRIVATE_SEARCH responde só com links de busca (handled:true, private:true) e sem consultar', async () => {
  const api = makeModrinth();
  const r = await routeModList(entryOf({ sensitive: true, isOwner: true }), routeDeps(api));
  assert.equal(r.handled, true);
  assert.equal(r.private, true);
  assert.equal(api.calls.length, 0);
  assert.match(r.text, /numa conversa privada eu só consulto serviços externos quando o dono libera/);
  const api2 = makeModrinth();
  const r2 = await routeModList(entryOf({ sensitive: true, isOwner: false }), routeDeps(api2, { researchConfig: { privateSearch: 'all' } }));
  assert.ok(api2.calls.length > 0);
  assert.match(r2.text, /Lista de mods/);
});

await test('ferramenta search_web desligada no servidor (isToolDisabled) é respeitada pela porta', async () => {
  const api = makeModrinth();
  let asked = null;
  const r = await routeModList(entryOf(), routeDeps(api, { llm: { isToolDisabled: (guild, tool) => { asked = [guild, tool]; return true; } } }));
  assert.deepEqual(asked, ['g1', 'search_web']);
  assert.equal(api.calls.length, 0);
  assert.match(r.text, /desativada neste servidor/);
});

await test('log SÓ com metadados: nenhum nome da lista aparece e há contagens', async () => {
  logs.length = 0;
  await routeModList(entryOf({ text: OWNER_TEXT }), routeDeps(makeModrinth({ usePack: true })));
  assert.ok(logs.length >= 1);
  const joined = logs.join('\n');
  for (const n of ['Waystones', 'Chisel', 'chisel', 'Sodium', 'Embelium', 'Supplementaries', 'Starlight']) assert.ok(!joined.includes(n), `o log tem o nome "${n}"`);
  assert.match(joined, /itens=71 achados=59 no_par=47 complementos=10 pedidos=\d+ cache=\d+ ms=\d+/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('8b. Correções da revisão (par real, nomes duvidosos, complementos, redirecionamento, fila, acertos mínimos)');

await test('nome duvidoso: "Dungeons Mobs" não vira "Dungeons Plus"; "Eye of Dragons" -> "Dragon Eye" sai só com a página, sem "baixar" e sem complementos', async () => {
  assert.ok(scoreName('Dungeons Mobs', 'Dungeons Plus', 'dungeons-plus') < 0.75, 'palavra distintiva sem par no título');
  assert.ok(scoreName('Dungeons Plus', 'Dungeons Plus', 'dungeons-plus') >= 0.88);
  assert.ok(scoreName('Fast Suite', 'FastSuite', 'fastsuite') >= 0.88 && scoreName('Invetory HUD+', 'InventoryHUD+', 'inventoryhudplus') >= 0.75, 'colados e erros de digitação continuam valendo');
  const r = await resolveModList(OWNER_TEXT, baseOpts({ fetch: makeModrinth({ usePack: true }).fetch, config: cfgOf(), log: captureLog }));
  assert.match(r.text, /^24\. Dungeons Mobs — não achei no Modrinth/m);
  assert.match(r.text, /^25\. \[Dungeons Plus\][^\n]*baixar/m);
  const eye = r.text.split('\n').find((l) => /^29\. /.test(l));
  assert.match(eye, /\[Dragon Eye\]\(<https:\/\/modrinth\.com\/mod\/dragon-eye>\) — para «Eye of Dragons» só achei algo parecido e pode ser outro mod: confira antes de baixar; busca \(não é download\)/);
  assert.ok(!/\/version\/|Important Complements/.test(eye), 'sem link de versão nem complementos');
  // os números da lista não mudam
  assert.deepEqual([r.stats.found, r.compat.covered], [59, 47]);
});

await test('par ESCOLHIDO com conferência real: a união de loaders/versões do hit empata em 26.1.2 e 1.20.1, mas só 1.20.1 existe de verdade -> escolhe 1.20.1', async () => {
  const mk = (i, name) => ({ project_id: `PROJ000${i}`, slug: `mod-${i}`, title: name, categories: ['forge'], versions: ['1.20.1', '26.1.2'], downloads: 1000 - i });
  const names = ['Alfa Um', 'Beta Dois', 'Gama Tres', 'Delta Quatro', 'Epsilon Cinco'];
  const hits = names.map((n, i) => mk(i + 1, n));
  const wrap = async (url, n, respond) => {
    const u = new URL(url);
    if (u.pathname === '/v2/search') {
      const q = u.searchParams.get('query');
      return respond(200, { hits: hits.filter((h) => h.title.toLowerCase() === q.toLowerCase()) });
    }
    const m = u.pathname.match(/\/project\/(PROJ\d+)\/version/);
    if (m) {
      const gv = JSON.parse(u.searchParams.get('game_versions'))[0];
      if (gv !== '1.20.1') return respond(200, []); // 26.1.2 só existe na união, não de verdade
      return respond(200, [{ id: `VER${m[1].slice(-4)}`, version_number: '1.0', version_type: 'release', date_published: '2026-01-01', dependencies: [] }]);
    }
    return respond(200, []);
  };
  const api = makeModrinth({ wrap });
  const r = await resolveModList(`links dos mods:\n${names.join('\n')}`, baseOpts({ fetch: api.fetch, config: cfgOf(), log: captureLog }));
  assert.deepEqual([r.compat.loader, r.compat.version, r.compat.covered, r.compat.found], ['forge', '1.20.1', 5, 5]);
  assert.equal(r.compat.pinned, false);
  assert.ok(r.stats.requests <= 5 + 6 + 5, `pedidos: ${r.stats.requests}`); // buscas + amostra (3 por par) + verificação (cache)
  assert.ok(choosePair([{ cands: [{ h: hits[0] }] }], {}).rows.length >= 2, 'choosePair devolve as linhas ordenadas');
});

await test('Important Complements nunca some em silêncio: acima do teto de consultas o texto avisa, e o que coube continua listado', async () => {
  const N = 110;
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const hits = Array.from({ length: N }, (_, i) => ({ project_id: `M${String(i).padStart(7, '0')}`, slug: `mod-${i}`, title: `Mod Numero ${letters[i % 26]}${letters[Math.floor(i / 26)]}`, categories: ['forge'], versions: ['1.20.1'], downloads: 100 }));
  const wrap = async (url, n, respond) => {
    const u = new URL(url);
    if (u.pathname === '/v2/search') return respond(200, { hits: hits.filter((h) => h.title.toLowerCase() === u.searchParams.get('query').toLowerCase()) });
    const m = u.pathname.match(/\/project\/(M\d+)\/version/);
    if (m) return respond(200, [{ id: `V${m[1].slice(1)}`, version_number: '1', version_type: 'release', date_published: '2026-01-01', dependencies: [{ project_id: `D${m[1].slice(1)}`, dependency_type: 'required' }] }]);
    if (u.pathname === '/v2/projects') return respond(200, JSON.parse(u.searchParams.get('ids')).map((id) => ({ id, slug: `dep-${id.toLowerCase()}`, title: `Dep ${id}` })));
    return respond(200, []);
  };
  const r = await resolveModList(`links dos mods:\n${hits.map((h) => h.title).join('\n')}`, baseOpts({ fetch: makeModrinth({ wrap }).fetch, config: cfgOf(), log: captureLog }));
  assert.equal(r.stats.complementsSkipped, true);
  assert.ok(r.complements.length > 0 && r.complements.length <= 100, `complementos: ${r.complements.length}`);
  assert.ok(r.text.includes(MODLIST_TEXT.complementsPartial), 'o aviso está no texto');
  assert.match(r.text, /Important Complements/);
  // sem estouro, sem aviso
  const owner = await resolveModList(OWNER_TEXT, baseOpts({ fetch: makeModrinth({ usePack: true }).fetch, config: cfgOf(), log: captureLog }));
  assert.equal(owner.stats.complementsSkipped, false);
  assert.ok(!owner.text.includes(MODLIST_TEXT.complementsPartial));
});

await test('redirecionamento: a requisição pede maxRedirects 0; 3xx ou resposta de OUTRO host é falha (sem repetir), nunca dado', async () => {
  const seen = [];
  const mk = (res) => async (url, opts) => { seen.push({ url, maxRedirects: opts.maxRedirects }); return res(url); };
  const body = JSON.stringify({ hits: [{ project_id: 'AAAAAAAA', slug: 'x-mod', title: 'Alfa Um', categories: ['forge'], versions: ['1.20.1'], downloads: 1 }] });
  const text = 'links dos mods:\nAlfa Um\nBeta Dois\nGama Tres\nDelta Quatro\nEpsilon Cinco';
  // (a) safeFetchText com maxRedirects 0 lança REDIRECTS: uma tentativa só por pedido
  const a = await resolveModList(text, baseOpts({ fetch: mk(() => ({ ok: false, status: 0, code: 'REDIRECTS', error: 'redirecionamentos demais', text: '' })), sleep: async () => {}, config: cfgOf(), log: captureLog }));
  assert.ok(seen.length > 0 && seen.every((s) => s.maxRedirects === 0), 'sempre maxRedirects 0');
  assert.ok(seen.length <= 8, `sem repetição: ${seen.length}`);
  assert.equal(a.mode, 'fora-do-ar');
  // (b) 200 que veio de outro host: descartado
  seen.length = 0;
  const b = await resolveModList(text, baseOpts({ fetch: mk(() => ({ ok: true, status: 200, url: 'https://evil.example/v2/search', text: body, truncated: false })), sleep: async () => {}, config: cfgOf(), log: captureLog }));
  assert.equal(b.mode, 'fora-do-ar');
  assert.ok(!b.text.includes('x-mod') && !b.text.includes('evil.example'));
  // (c) 200 do host certo continua valendo
  const c = await resolveModList(text, baseOpts({ fetch: mk(() => ({ ok: true, status: 200, url: 'https://api.modrinth.com/v2/search?x=1', text: body, truncated: false })), sleep: async () => {}, config: cfgOf(), log: captureLog }));
  assert.notEqual(c.mode, 'fora-do-ar');
  assert.match(c.text, /modrinth\.com\/mod\/x-mod/);
});

await test('fila serial: a porta aceita um teto de prazo (deadlineCapMs) e o llmHandler o usa; passou do teto, sai parcial dizendo o prazo', async () => {
  const clock = makeClock();
  const api = makeModrinth({ wrap: async () => { clock.t += 4000; return null; } });
  const text = 'links dos mods:\nWaystones\nCooking for blockheads\nchisel\nApple Skin\nFancy Menu\nRats\nMore Chests\nSodium\nLithium\nBalm\nJade';
  const r = await routeModList(entryOf({ text }), routeDeps(api, { now: clock.now, sleep: clock.sleep, deadlineCapMs: 20_000, env: { YUI_MODLIST_CONCURRENCY: '1' } }));
  assert.equal(r.handled, true);
  assert.match(r.text, /Passei do prazo de 20 s/);
  assert.ok(api.calls.length < 12, `pedidos: ${api.calls.length}`);
  assert.match(fs.readFileSync(path.join(repoRoot, 'src/handlers/llmHandler.js'), 'utf8'), /deadlineCapMs: 45_000/);
});

await test('poucos acertos de verdade ("mods" = moderadores e nomes de pessoas): menos de 30% dos itens e nenhum acerto cheio -> segue para a IA', async () => {
  const wrap = async (url, n, respond) => {
    const u = new URL(url);
    if (u.pathname === '/v2/search') {
      const q = u.searchParams.get('query');
      return respond(200, { hits: q === 'Maria Silva' ? [{ project_id: 'PESSOA01', slug: 'maria-silva-costa-lima', title: 'Maria Silva Costa Lima', categories: ['forge'], versions: ['1.20.1'], downloads: 3 }] : [] });
    }
    return respond(200, []);
  };
  const text = 'yui, lista dos mods do servidor com o link de cada um:\nMaria Silva\nJoao Pereira\nPedro Alves\nAna Souza\nLucas Prado\nCarla Dias';
  const r = await routeModList(entryOf({ text }), routeDeps(makeModrinth({ wrap })));
  assert.deepEqual(r, { handled: false, reason: 'poucos-acertos' });
  // lista de mods de verdade (59 de 71) continua tratada
  const ok = await routeModList(entryOf({ text: OWNER_TEXT }), routeDeps(makeModrinth({ usePack: true })));
  assert.equal(ok.handled, true);
});

await test('texto: um mod só ("o único mod"), endereço puro não gera link de busca vazio e linha enorme com vírgulas não trava', async () => {
  const wrap = async (url, n, respond) => {
    const u = new URL(url);
    if (u.pathname === '/v2/search') return respond(200, { hits: u.searchParams.get('query') === 'Alfa Um' ? [{ project_id: 'AAAAAAAA', slug: 'alfa-um', title: 'Alfa Um', categories: ['forge'], versions: ['1.20.1'], downloads: 1 }] : [] });
    if (/\/project\/AAAAAAAA\/version/.test(u.pathname)) return respond(200, [{ id: 'VERSAO01', version_number: '1', version_type: 'release', date_published: '2026-01-01', dependencies: [] }]);
    return respond(200, []);
  };
  const itemsOf = (labels) => labels.map((label, i) => ({ index: i + 1, label, parts: [label], generic: [] }));
  const r = await resolveModList('', baseOpts({ fetch: makeModrinth({ wrap }).fetch, config: cfgOf(), log: captureLog,
    parsed: { items: itemsOf(['Alfa Um', 'Beta', 'Gama', 'Delta', 'Epsilon']), prose: [], hintLines: [] } }));
  assert.match(r.text, /o único mod encontrado existe para \*\*Forge 1\.20\.1\*\*/);
  assert.ok(!/todos os 1 mods/.test(r.text));
  const dom = await resolveModList('', baseOpts({ fetch: makeModrinth().fetch, config: cfgOf(), log: captureLog, searchDisabled: true,
    parsed: { items: itemsOf(['discord.gg/abc', 'Beta', 'Gama', 'Delta', 'Epsilon']), prose: [], hintLines: [] } }));
  assert.ok(!/\?q=[)>]|search=&/.test(dom.text), 'nada de q= vazio');
  assert.match(dom.text, /1\. discord[^\n]*abc — não consultei; sem link de busca/);
  const t0 = Date.now();
  const huge = `${'a'.repeat(5)}${','.repeat(150000)}x`;
  const parsed = parseModList(`links dos mods\n${huge}\nA1\nB2\nC3\nD4\nE5`);
  assert.ok(Date.now() - t0 < 500, `levou ${Date.now() - t0} ms`);
  assert.equal(parsed.items.length, 5);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('9. Fiação (código-fonte), persona e documentação');

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const counts = (rel) => { const b = fs.readFileSync(path.join(repoRoot, rel)); let cr = 0; let lf = 0; for (const x of b) { if (x === 13) cr++; else if (x === 10) lf++; } return { cr, lf }; };

await test('ask.js (/yui e +yui) chama a Porta M ANTES da Porta A e a resposta dela segue o mesmo caminho de entrega; arquivos mantêm o fim de linha', () => {
  const ask = read('src/discord/commands/ask.js');
  assert.match(ask, /import \{ routeModList \} from '\.\.\/\.\.\/handlers\/modListResolver\.js';/);
  assert.ok(ask.indexOf('await routeModList(entry, deps)') > 0 && ask.indexOf('await routeModList(entry, deps)') < ask.indexOf('await routeExplicitResearch(entry, deps)'));
  assert.match(ask, /const routed = modRouted\.handled \? modRouted : await routeExplicitResearch\(entry, deps\);/);
  assert.equal(counts('src/discord/commands/ask.js').cr, 0, 'ask.js é LF puro');
  assert.equal(counts('src/handlers/modListResolver.js').cr, 0, 'o resolvedor é LF puro');
  const llm = counts('src/handlers/llmHandler.js');
  assert.equal(llm.cr, llm.lf, 'llmHandler.js é CRLF puro');
});

await test('llmHandler.js (menção e DM): a Porta M vem antes da Porta A, só para pedido direto em texto, entrega e sai sem histórico/memória', () => {
  const llm = read('src/handlers/llmHandler.js');
  const iM = llm.indexOf('await routeModList({');
  const iA = llm.indexOf('if (preResearch.explicit) {');
  assert.ok(iM > 0 && iM < iA, 'Porta M antes da Porta A');
  const block = llm.slice(llm.lastIndexOf('if (directToYui && !isVoice', iM), iA);
  assert.match(block, /options\.radioMode !== true/);
  assert.match(block, /options\.thirdPartyPrompt !== true/);
  assert.match(block, /sensitive: privateChat/);
  assert.match(block, /await unifiedReply\(modRouted\.text\)/);
  assert.match(block, /\n\s+return;\r?\n/);
  assert.ok(!/addToHistory|savePromptToHistory|captureFromUserText|recordMainExchange/.test(block), 'nada é gravado');
  assert.match(llm, /import \{ routeModList \} from '\.\/modListResolver\.js';/);
  // o modo voz, o TTS-HOOK e a pesquisa continuam onde estavam
  assert.ok(llm.includes('[TTS-HOOK]') && llm.includes('Porta B') && llm.includes('speakVoiceReply('));
});

await test('o resolvedor não usa console.*, não importa llmHandler/ask/messageCreate e só lê as 4 variáveis YUI_MODLIST_*', () => {
  const src = read('src/handlers/modListResolver.js');
  assert.ok(!/console\.(log|warn|error|info)/.test(src));
  assert.ok(!/^import .*(llmHandler|commands\/ask|messageCreate|prefixRouter)/m.test(src), 'sem ciclo de importação');
  const vars = new Set([...src.matchAll(/\bYUI_MODLIST_[A-Z_]*[A-Z]\b/g)].map((m) => m[0]));
  assert.deepEqual([...vars].sort(), ['YUI_MODLIST_CONCURRENCY', 'YUI_MODLIST_DEADLINE_MS', 'YUI_MODLIST_ENABLED', 'YUI_MODLIST_MAX_ITEMS']);
  assert.ok(!/execSync|spawn|exec\(/.test(src));
});

await test('persona: a regra de "anotei" agora manda trabalhar com o conteúdo da própria mensagem, sem prometer guardar, nos 5 lugares', () => {
  const phrase = /Se a pessoa mandar o conteúdo na própria mensagem \((?:uma )?lista, (?:um )?texto\), trabalhe com ele agora e entregue o resultado na resposta: não recuse nem prometa guardar\./;
  assert.match(read('persona/yui-publica.md'), phrase);
  const persona = read('src/core/persona.js');
  assert.equal((persona.match(new RegExp(phrase.source, 'g')) || []).length, 3, 'fallback público, perfil pessoal e perfil do assistente');
  assert.match(read('src/handlers/llmHandler.js'), phrase);
  // continua proibindo a promessa
  for (const f of ['persona/yui-publica.md', 'src/core/persona.js', 'src/handlers/llmHandler.js']) assert.match(read(f), /não agenda avisos nem guarda nada por conta própria/);
  assert.ok(!phrase.test('Anotei sua lista!') && longReply.promisesFutureAction('Anotei sua lista! Te mando depois.'), 'o filtro de promessas continua pegando o "anotei"');
  assert.ok(!longReply.promisesFutureAction('Se a pessoa mandar o conteúdo na própria mensagem (lista, texto), trabalhe com ele agora e entregue o resultado na resposta: não recuse nem prometa guardar.'));
});

await test('variáveis, script e documentação: .env_example (comentadas), ENVIRONMENT.md, package.json, FEATURES.md e COMMANDS.md', () => {
  const env = read('.env_example');
  const doc = read('docs/content_pt/ENVIRONMENT.md');
  for (const [name, def] of [['YUI_MODLIST_ENABLED', 'true'], ['YUI_MODLIST_MAX_ITEMS', '120'], ['YUI_MODLIST_DEADLINE_MS', '120000'], ['YUI_MODLIST_CONCURRENCY', '3']]) {
    assert.ok(new RegExp(`^# ${name}=${def}\\r?$`, 'm').test(env), `${name} comentada no .env_example com o padrão ${def}`);
    assert.ok(!new RegExp(`^${name}=`, 'm').test(env), `${name} não pode estar ativa`);
    assert.ok(doc.includes(`\`${name}\``), `${name} no ENVIRONMENT.md`);
  }
  const defaults = readModlistConfig({});
  assert.deepEqual([defaults.enabled, defaults.maxItems, defaults.deadlineMs, defaults.concurrency], [true, 120, 120000, 3]);
  assert.equal(JSON.parse(read('package.json')).scripts['test:modlist'], 'node tests/test-mod-list.js');
  assert.match(read('docs/content_pt/FEATURES.md'), /Lista de mods/);
  assert.match(read('docs/content_pt/FEATURES.md'), /Important Complements/);
  assert.match(read('docs/content_pt/COMMANDS.md'), /Lista de mods/);
  assert.match(doc, /### 🧩 Lista de mods \(Minecraft\)/);
  assert.match(read('README_TESTES.md'), /test:modlist/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('10. Entradas REAIS: menção e DM na fila do llmHandler, /yui e +yui (sem rede, sem os arquivos reais do projeto)');

// Escritas em arquivos REAIS do projeto são desviadas (server_tools, bans, historico.txt...). Tudo o mais fica no temporário.
const realWriteFileSync = fs.writeFileSync;
const realAppendFile = fs.appendFile;
const appended = [];
fs.writeFileSync = function guardedWrite(file, ...rest) {
  if (/[\\/]data[\\/](server_tools|bans|currency_cache|channel_settings|server_prompts|server_settings)\.json$/.test(String(file))) return undefined;
  return realWriteFileSync.call(this, file, ...rest);
};
fs.appendFile = function guardedAppend(file, data, cb) {
  if (String(file).endsWith(path.join('data', 'historico.txt'))) { appended.push(String(data)); if (typeof cb === 'function') cb(null); return undefined; }
  return realAppendFile.call(this, file, data, cb);
};
const net = await import('node:net');
const dnsMod = await import('node:dns');
net.default.Socket.prototype.connect = function blocked() { throw new Error('rede bloqueada no teste'); };
dnsMod.default.promises.lookup = async () => { const e = new Error('ENOTFOUND (teste)'); e.code = 'ENOTFOUND'; throw e; };
dnsMod.default.lookup = (host, opts, cb) => { const e = new Error('ENOTFOUND (teste)'); e.code = 'ENOTFOUND'; (typeof opts === 'function' ? opts : cb)(e); };
const { default: axios } = await import('axios');
const aiCalls = []; // qualquer chamada a um modelo (a lista de mods NUNCA consulta o modelo)
axios.post = async (url) => { aiCalls.push(String(url)); throw new Error('offline (teste)'); };
axios.get = async () => { throw new Error('offline (teste)'); };

const { default: appConfig } = await import(pathToFileURL(path.join(repoRoot, 'src/config/index.js')).href);
appConfig.saveHistory = false;
const llm = await import(pathToFileURL(path.join(repoRoot, 'src/handlers/llmHandler.js')).href);
const { askCommand } = await import(pathToFileURL(path.join(repoRoot, 'src/discord/commands/ask.js')).href);
const { handlePrefixCommand } = await import(pathToFileURL(path.join(repoRoot, 'src/discord/prefixRouter.js')).href);
const { initMemory } = await import(pathToFileURL(path.join(repoRoot, 'src/core/index.js')).href);
await initMemory();
// O /yui monta o contexto do GTA com os repositórios do jogo (como no bootstrap): bancos VAZIOS, só na pasta temporária.
const { initDatabase } = await import(pathToFileURL(path.join(repoRoot, 'src/database/db.js')).href);
const { GTA_DAILY_SCHEMA, GTA_WEEKLY_SCHEMA } = await import(pathToFileURL(path.join(repoRoot, 'src/database/schemas.js')).href);
await initDatabase('gta-diario', GTA_DAILY_SCHEMA);
await initDatabase('gta-semanal', GTA_WEEKLY_SCHEMA);
const realConsole = { log: console.log, warn: console.warn, error: console.error };
const quiet = () => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; };
const loud = () => { console.log = realConsole.log; console.warn = realConsole.warn; console.error = realConsole.error; };
quiet();
const say = (s) => process.stdout.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
const isProgress = (c) => /^🧠 \*\*Processando/.test(c) || /Sua solicitação está na fila/.test(c);
const contentsOf = (it) => it.outputs.map((p) => (typeof p?.content === 'string' ? p.content : '')).filter(Boolean);
const finalOf = (it) => [...contentsOf(it)].reverse().find((c) => !isProgress(c)) ?? '';
const filesOf = (it) => it.outputs.flatMap((p) => p?.files ?? []);
const fileTextOf = (file) => Buffer.from(file.attachment).toString('utf8');
/** Tudo que a pessoa receberia: o texto das mensagens e o conteúdo dos anexos. */
const fullDelivery = (it) => [...contentsOf(it).filter((c) => !isProgress(c)), ...filesOf(it).map(fileTextOf)].join('\n');

function fakeMention({ userId, channelId, guildId = 'g1', content }) {
  const edits = [];
  const msg = {
    id: `msg-${++seq}`, content, channelId, guildId, guild: guildId ? { id: guildId, name: 'Servidor Teste' } : null,
    author: { id: userId, tag: `u${userId}#0001`, bot: false }, client: { user: { id: '999' } },
    mentions: { has: () => true, everyone: false, repliedUser: null },
    channel: { id: channelId, name: 'geral', send: async (p) => { edits.push(p); return { id: 'sent' }; } },
    edits, replies: [],
    async reply(opts) { this.replies.push(opts); return replyMsg; },
    get outputs() { return [...this.replies, ...this.edits]; },
  };
  const replyMsg = { id: 'proc', channel: msg.channel, async edit(p) { edits.push(p); return replyMsg; }, async delete() { return undefined; } };
  return msg;
}
function fakeSlash({ userId, channelId, guildId = 'g1', pergunta }) {
  const it = {
    user: { id: userId, tag: `u${userId}#0001` }, channelId, guildId, guild: guildId ? { id: guildId, name: 'Servidor Teste' } : null,
    deferred: false, replied: false, ephemeral: false, createdTimestamp: Date.now(), edits: [], replies: [], sends: [],
    isChatInputCommand: () => true,
    options: { getString: (n) => (n === 'mensagem' ? pergunta : null) },
    async deferReply(o) { this.deferred = true; this.ephemeral = Boolean(o?.ephemeral); },
    async editReply(p) { this.edits.push(p); return { id: 'e1', channel: this.channel }; },
    async reply(p) { this.replied = true; this.replies.push(p); return { id: 'r1' }; },
    async followUp(p) { this.edits.push(p); return { id: 'f1', channel: this.channel }; },
    get outputs() { return [...this.replies, ...this.edits, ...this.sends]; },
  };
  it.channel = { id: channelId, name: 'geral', async send(p) { it.sends.push(p); return { id: 'sent' }; } };
  return it;
}
function fakePrefix(content, { authorId, channelId, guildId = null }) {
  const m = {
    content, author: { id: authorId, username: 'bob', bot: false }, guild: guildId ? { id: guildId } : null, member: null, channelId, guildId,
    mentions: { channels: { first: () => null } }, sent: [], edits: [], replies: [],
    channel: { id: channelId, send: async (p) => { m.sent.push(p); return { id: `w${seq++}`, edit: async (e) => { m.edits.push(e); return { id: 'w1' }; }, channel: m.channel }; } },
    reply: async (p) => { m.replies.push(p); return { id: `r${seq++}` }; },
    get outputs() { return [...m.sent, ...m.edits, ...m.replies]; },
  };
  return m;
}
/** Instala o Modrinth falso como fetch PADRÃO do resolvedor (as portas reais não recebem fetch) e zera o estado entre cenários. */
function modrinthFor(scenario) {
  const api = makeModrinth({ usePack: true });
  mod._setDefaultFetchForTest(api.fetch);
  aiCalls.length = 0;
  appended.length = 0;
  return api;
}
async function viaMention({ content, text, userId, guildId = 'g1', channelId }) {
  const uid = userId ?? `m${++seq}`;
  const it = fakeMention({ userId: uid, channelId: channelId ?? `chan-m${seq}`, guildId, content: content ?? `<@999> ${text}` });
  await llm.addToQueue(`--- MENSAGEM ATUAL ---\nuser: "${text}"`, it, 'mention', { allowSearch: true, searchPrompt: text, guildId: it.guildId ?? undefined });
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && !(finalOf(it) && !isProgress(finalOf(it)))) await sleep(30);
  await sleep(300);
  return it;
}
const withEnv = async (vars, fn) => {
  const before = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const T = async (name, fn) => { loud(); try { await test(name, fn); } finally { quiet(); } };

await T('menção no servidor com a lista do dono: a fila entrega a lista dos links (anexo .md), SEM chamar modelo e SEM gravar histórico', async () => {
  const api = modrinthFor();
  const it = await viaMention({ text: OWNER_TEXT, guildId: 'g1' });
  const delivered = fullDelivery(it);
  assert.match(delivered, /Lista de mods: 71 nomes/);
  assert.match(delivered, /Forge 1\.20\.1/);
  assert.match(delivered, /\(Important Complements: /);
  assert.ok(filesOf(it).length === 1 && /resposta-yui\.md$/.test(filesOf(it)[0].name), 'lista longa vai em anexo .md');
  assert.equal(aiCalls.length, 0, 'nenhum modelo foi chamado');
  assert.ok(api.calls.length > 100 && api.calls.every((c) => c.host === 'api.modrinth.com'));
  assert.deepEqual(appended, [], 'nada foi para o historico.txt');
  assert.ok(contentsOf(it).some((c) => isProgress(c) && /-# 🔎/.test(c)), 'o progresso "-# 🔎" apareceu na mensagem Processando');
  for (const c of contentsOf(it)) assert.ok(c.length <= 2000, `parte com ${c.length}`);
  assert.ok(!/@everyone|<@&?\d+>/.test(delivered.replace(/@​(everyone|here)/g, '')));
});

await T('DM de qualquer pessoa com YUI_PRIVATE_SEARCH=off: só links de busca, nenhuma consulta ao Modrinth e nenhum modelo; com all consulta', async () => {
  await withEnv({ YUI_PRIVATE_SEARCH: 'off' }, async () => {
    const api = modrinthFor();
    const it = await viaMention({ text: OWNER_TEXT, guildId: null, userId: '222', content: OWNER_TEXT });
    const delivered = fullDelivery(it);
    assert.match(delivered, /numa conversa privada eu só consulto serviços externos quando o dono libera/);
    assert.equal(api.calls.length, 0);
    assert.equal(aiCalls.length, 0);
    assert.ok(!/modrinth\.com\/(mod|project)\//.test(delivered));
    assert.match(delivered, /https:\/\/modrinth\.com\/mods\?q=/);
  });
  await withEnv({ YUI_PRIVATE_SEARCH: 'all' }, async () => {
    const api = modrinthFor();
    const it = await viaMention({ text: OWNER_TEXT, guildId: null, userId: '333', content: OWNER_TEXT });
    assert.ok(api.calls.every((c) => c.host === 'api.modrinth.com'), 'só o Modrinth'); // o cache do processo pode ter respondido tudo (a 1ª lista já gravou)
    assert.match(fullDelivery(it), /Lista de mods: 71 nomes[\s\S]*Forge 1\.20\.1/);
    assert.equal(aiCalls.length, 0);
    assert.deepEqual(appended, [], 'conversa privada: nada vai ao historico.txt');
  });
});

await T('conversa normal na menção NÃO é pega: segue o caminho da IA e o Modrinth nem é tocado', async () => {
  const api = modrinthFor();
  const it = await viaMention({ text: 'yui, qual o melhor mod de minecraft pra performance?', guildId: 'g1' });
  assert.equal(api.calls.length, 0);
  assert.ok(aiCalls.length >= 1, 'o modelo foi chamado (e falhou "offline" no teste)');
  assert.ok(!/Lista de mods/.test(fullDelivery(it)));
});

await T('/yui com a lista: o ask.js entrega a lista (Porta M) sem consultar o modelo, com no máximo 3 edições de progresso', async () => {
  const api = modrinthFor();
  const it = fakeSlash({ userId: 'y1', channelId: 'chan-y1', pergunta: SMALL() });
  await askCommand.execute(it);
  await sleep(100);
  assert.ok(it.deferred);
  assert.match(fullDelivery(it), /Lista de mods: 13 nomes/);
  assert.equal(aiCalls.length, 0);
  assert.match(fullDelivery(it), /https:\/\/modrinth\.com\/mod\/waystones\/version\//);
  const prog = contentsOf(it).filter((c) => /-# 🔎/.test(c));
  assert.ok(prog.length <= 3, `edições de progresso: ${prog.length}`);
});

await T('+yui perguntar com a lista em várias linhas (prefixo): mesma Porta M do /yui', async () => {
  const api = modrinthFor();
  const m = fakePrefix(`+yui perguntar ${SMALL()}`, { authorId: 'p1', channelId: 'chan-p1', guildId: 'g1' });
  await handlePrefixCommand(m);
  await sleep(150);
  const delivered = [...m.outputs.flatMap((p) => [typeof p?.content === 'string' ? p.content : '', ...(p?.files ?? []).map(fileTextOf)])].join('\n');
  assert.match(delivered, /Lista de mods: 13 nomes/);
  assert.equal(aiCalls.length, 0);
  assert.match(delivered, /https:\/\/modrinth\.com\/mod\/waystones\/version\//);
});

await T('/yui com conversa curta: a Porta M devolve handled:false e o pedido segue para a IA (o Modrinth nem é tocado)', async () => {
  modrinthFor();
  const chat = fakeSlash({ userId: 'y9', channelId: 'chan-y9', pergunta: 'oi yui, tudo bem?' });
  await askCommand.execute(chat);
  await sleep(100);
  assert.ok(aiCalls.length >= 1, 'conversa curta chamou o modelo');
  assert.ok(!/Lista de mods/.test(fullDelivery(chat)));
});

mod._setDefaultFetchForTest(null);
loud();
fs.writeFileSync = realWriteFileSync;
fs.appendFile = realAppendFile;

console.log(failed ? `\nFALHA: ${passed} teste(s) passaram, ${failed} falharam.\nFalharam: ${failures.join(' | ')}` : `\n${passed} teste(s) passaram, 0 falharam.`);
process.exit(failed ? 1 : 0);
