// Testes das respostas longas (S2): divisão automática, envio sequencial, continuação por limite de tokens,
// filtro de promessas, ANTI-ECO e contexto do Discord. SEM Discord real, SEM rede e SEM os bancos reais:
// o diretório de trabalho e os bancos ficam numa pasta temporária; axios/fetch/DNS/sockets são dublês.
// Execução: npm run test:longreply   (node tests/test-longreply.js)
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'node:net';
import dns from 'node:dns';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ── Ambiente isolado ────────────────────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-longreply-'));
Object.assign(process.env, {
  DATABASE_DIR: tmp,
  YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'), // o chdir abaixo já isola logs/, mas o arquivo fica explícito
  YUI_OWNER_ID: '111',
  YUI_PRIVATE_CHANNEL_IDS: 'priv1',
  YUI_MEMORY_ENABLED: 'true',
  YUI_ALERTS: 'false',
  YUI_GATEWAY_IN_CHAIN: 'false',
  YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'search-budget.json'),
  LOG_LEVEL: 'error',
});
for (const k of ['GEMINI_API_KEY', 'GEMINI_API_KEYS', 'GROQ_API_KEY', 'GROQ_API_KEYS', 'HF_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN',
  'LM_STUDIO_API_KEY', 'AI_API_KEY', 'AI_BASE_URL', 'LOCAL_LLM_URL', 'BRAVE_API_KEY', 'TAVILY_API_KEY', 'YUI_REPLY_MAX_TOKENS', 'YUI_REPLY_MAX_PARTS']) delete process.env[k];
process.chdir(tmp); // logs/, secrets/ e .env (nenhum) ficam no temporário

// Nada sai da máquina: axios, fetch, DNS e sockets viram dublês que falham.
const { default: axios } = await import('axios');
const calls = []; // { method, url, body }
let postHook = null; // (url, body) => resposta falsa de axios, ou undefined para falhar como o resto
axios.post = async (url, body) => {
  calls.push({ method: 'post', url: String(url), body });
  const fake = postHook ? postHook(String(url), body) : undefined;
  if (fake) return fake;
  throw new Error('offline (teste)');
};
axios.get = async (url) => { calls.push({ method: 'get', url: String(url) }); throw new Error('offline (teste)'); };
let fetchImpl = async () => { throw new Error('offline (teste)'); };
globalThis.fetch = (...a) => fetchImpl(...a);
net.Socket.prototype.connect = function blocked() { throw new Error('rede bloqueada no teste'); };
dns.promises.lookup = async () => { const e = new Error('ENOTFOUND (teste)'); e.code = 'ENOTFOUND'; throw e; };
dns.lookup = (host, opts, cb) => { const e = new Error('ENOTFOUND (teste)'); e.code = 'ENOTFOUND'; (typeof opts === 'function' ? opts : cb)(e); };

// ── Mini-runner ─────────────────────────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 6).join('\n        ')}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const count = (text, part) => text.split(part).length - 1;
const waitFor = async (pred, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !pred()) await sleep(20); return pred(); };

const lr = await import('../src/discord/longReply.js');
const {
  splitDetailed, splitForDiscord, splitFooter, splitReply, firstChunk, capSingleMessage, sendLongReply, createUnifiedReply,
  isPermanentDiscordError, parseMaxParts, parseAttachExt, collectUserMentions, parseReplyMaxTokens, isTruncatedFinish, looksLikeToolJson, mergeContinuation,
  promisesFutureAction, applyPromiseNotice, antiEchoExempt, historyCopy, clipContextText, longContextIds, formatDeliveryLog, countUrls,
  DISCORD_LIMIT, TRUNCATION_NOTICE, PROMISE_NOTICE, CONTINUE_INSTRUCTION, LONG_CONTEXT_LIMIT, SHORT_CONTEXT_LIMIT,
} = lr;
const { SAFE_ALLOWED_MENTIONS } = await import('../src/discord/mentions.js');
const { MessageFlags, AttachmentBuilder } = await import('discord.js');

// ── utilitários ─────────────────────────────────────────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seg = new Intl.Segmenter('pt-BR', { granularity: 'grapheme' });
const graphemes = (s) => [...seg.segment(s)].length;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const listLines = (n, label = 'Mod') => Array.from({ length: n }, (_, i) => `${i + 1}. [${label} número ${i + 1}](https://www.exemplo.com/mods/${i + 1}-nome-longo) - descrição do item ${i + 1}`);
const markerLine = /\n-# parte \d+\/\d+$/;
const stripMarker = (c) => c.replace(markerLine, '');
const FOOT = '-# Gemini | 🔎 Search | ⏱️ 3.2s';
const check = (parts, { max = DISCORD_LIMIT } = {}) => {
  for (const p of parts) {
    assert.ok(p.content.length <= max, `parte com ${p.content.length} caracteres`);
    assert.ok(p.content.trim().length > 0, 'parte vazia');
    assert.ok(!LONE_SURROGATE.test(p.content), 'surrogate solto (emoji partido)');
  }
};
const fenceCount = (s) => s.split('\n').filter((l) => /^ {0,3}`{3,}/.test(l)).length;

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('A. Divisor puro (splitForDiscord)');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('texto curto = 1 parte, sem marcador; o rodapé fica junto', () => {
  assert.deepEqual(splitForDiscord('oi, tudo bem?'), ['oi, tudo bem?']);
  assert.deepEqual(splitForDiscord('oi', { footer: FOOT }), [`oi\n${FOOT}`]);
  assert.deepEqual(splitForDiscord(''), ['']);
  const exato = 'a'.repeat(2000);
  assert.equal(splitForDiscord(exato).length, 1, 'até 2000 cabe numa mensagem só (o limite real do Discord)');
  assert.equal(splitForDiscord('a'.repeat(2001)).length, 2);
});
await test('CASO DO INCIDENTE: lista de 74 itens (> 3000 caracteres) sai com os 74 itens, em ordem, cada parte <= 2000', () => {
  const body = ['Aqui está a lista completa:', '', ...listLines(74)].join('\n');
  assert.ok(body.length > 3000);
  const parts = splitDetailed(body, { footer: FOOT }).parts;
  assert.ok(parts.length >= 2);
  check(parts);
  const joined = parts.map((p) => stripMarker(p.content)).join('\n');
  const nums = [...joined.matchAll(/^(\d+)\. \[Mod número/gm)].map((m) => Number(m[1]));
  assert.deepEqual(nums, Array.from({ length: 74 }, (_, i) => i + 1));
  // nenhum item partido: cada linha de item aparece inteira
  for (const line of listLines(74)) assert.ok(joined.includes(line), `item partido: ${line.slice(0, 30)}`);
});
await test('juntar as fatias (raw) devolve o texto original; os marcadores são "-# parte i/N"', () => {
  const body = ['Introdução curta.', '', ...listLines(60), '', 'Fim do texto.'].join('\n');
  const d = splitDetailed(body);
  assert.equal(d.parts.map((p) => p.raw).join(''), d.body);
  assert.equal(d.body, body);
  d.parts.forEach((p, i) => assert.ok(p.content.endsWith(`\n-# parte ${i + 1}/${d.parts.length}`)));
});
await test('marker:false não acrescenta "-# parte"', () => {
  const parts = splitForDiscord('palavra '.repeat(600), { marker: false });
  assert.ok(parts.length >= 2 && parts.every((p) => !/-# parte/.test(p)));
});
await test('RODAPÉ: separado antes de dividir e só na ÚLTIMA parte, com espaço reservado (varredura de tamanhos)', () => {
  for (let len = 1500; len <= 2300; len += 7) {
    const parts = splitForDiscord(('palavra ').repeat(Math.ceil(len / 8)).slice(0, len).trim(), { footer: FOOT });
    for (const [i, c] of parts.entries()) {
      assert.ok(c.length <= DISCORD_LIMIT, `len=${len} parte ${i}: ${c.length}`);
      assert.equal(c.includes(FOOT), i === parts.length - 1, `rodapé na parte errada (len=${len})`);
    }
  }
  const { body, footer } = splitFooter(`texto\n${FOOT}`);
  assert.equal(body, 'texto');
  assert.equal(footer, FOOT);
  assert.deepEqual(splitFooter('-# só subtexto'), { body: '-# só subtexto', footer: '' });
  const r = splitReply(`${'frase longa. '.repeat(300)}\n${FOOT}`);
  assert.ok(r.parts.at(-1).content.includes(FOOT) && r.parts.slice(0, -1).every((p) => !p.content.includes(FOOT)));
});
await test('rodapé de 400 caracteres ainda cabe: nenhuma parte passa de 2000', () => {
  const big = `-# ${'x'.repeat(380)}`;
  for (let len = 1500; len <= 2300; len += 13) {
    const parts = splitForDiscord('palavra '.repeat(Math.ceil(len / 8)).slice(0, len).trim(), { footer: big });
    parts.forEach((c) => assert.ok(c.length <= DISCORD_LIMIT));
  }
});
await test('linha única longa sem espaços (corte duro) e texto sem quebras de linha', () => {
  const d = splitDetailed('a'.repeat(5000));
  check(d.parts);
  assert.ok(d.parts.length >= 3);
  assert.equal(d.parts.map((p) => p.raw).join(''), 'a'.repeat(5000));
  const d2 = splitDetailed('Uma frase curta aqui. '.repeat(400));
  check(d2.parts);
  // corta em fim de frase, não no meio dela
  assert.ok(d2.parts.slice(0, -1).every((p) => /\.$/.test(stripMarker(p.content))), 'deveria cortar em fim de frase');
});
await test('PARÁGRAFO tem preferência: não corta no meio de um parágrafo que cabe numa parte', () => {
  const paras = Array.from({ length: 8 }, (_, i) => `Parágrafo ${i + 1}: ${'texto de enchimento '.repeat(40)}fim.`);
  const d = splitDetailed(paras.join('\n\n'));
  check(d.parts);
  for (const p of d.parts) {
    const c = stripMarker(p.content);
    for (const para of c.split('\n\n')) assert.ok(/^Parágrafo \d+: .*fim\.$/s.test(para), `parágrafo partido: ${para.slice(0, 40)}...${para.slice(-20)}`);
  }
});
await test('EMOJI na fronteira: ZWJ, bandeira, keycap e tom de pele nunca se partem (varredura de posições)', () => {
  const clusters = ['👨‍👩‍👧‍👦', '🇧🇷', '1️⃣', '👍🏽', '🏳️‍🌈', '❤️', '😀'];
  for (const cl of clusters) {
    for (let offset = 1880; offset <= 1905; offset++) {
      const text = `${'x'.repeat(offset)}${cl.repeat(40)} fim`;
      const d = splitDetailed(text);
      check(d.parts);
      assert.equal(d.parts.map((p) => p.raw).join(''), d.body);
      const total = d.parts.reduce((n, p) => n + graphemes(p.raw), 0);
      assert.equal(total, graphemes(d.body), `grafema partido (cluster ${cl}, offset ${offset})`);
    }
  }
});
await test('BLOCO DE CÓDIGO atravessando o corte: fecha com ``` e reabre com a mesma linguagem; o marcador vem DEPOIS do fechamento', () => {
  const code = Array.from({ length: 220 }, (_, i) => `  const valor${i} = calcular(${i}); // linha ${i}`).join('\n');
  const text = `Veja o exemplo:\n\n\`\`\`python\n${code}\n\`\`\`\n\nPronto, é isso.`;
  const d = splitDetailed(text);
  check(d.parts);
  assert.ok(d.parts.length >= 3);
  assert.equal(d.parts.map((p) => p.raw).join(''), d.body);
  d.parts.forEach((p, i) => {
    assert.equal(fenceCount(p.content) % 2, 0, `parte ${i + 1} com cerca desbalanceada`);
    if (i > 0 && i < d.parts.length - 1) assert.ok(p.content.startsWith('```python\n'), 'não reabriu com a linguagem');
    if (i < d.parts.length - 1) assert.ok(/\n```\n-# parte \d+\/\d+$/.test(p.content), 'o marcador deve vir depois do fechamento');
  });
  // todas as linhas de código aparecem, em ordem
  const all = d.parts.map((p) => p.content).join('\n');
  let last = -1;
  for (let i = 0; i < 220; i++) { const at = all.indexOf(`linha ${i}\n`, last + 1); assert.ok(at > last, `linha ${i} fora de ordem`); last = at; }
});
await test('bloco de código que cabe numa parte não é partido (corta ANTES dele)', () => {
  const code = Array.from({ length: 30 }, (_, i) => `x${i} = ${i}`).join('\n');
  const text = `${'Texto antes do código. '.repeat(70)}\n\n\`\`\`js\n${code}\n\`\`\`\n\n${'Texto depois. '.repeat(70)}`;
  const d = splitDetailed(text);
  check(d.parts);
  const withCode = d.parts.filter((p) => p.content.includes('x0 = 0'));
  assert.equal(withCode.length, 1);
  assert.ok(withCode[0].content.includes('x29 = 29') && withCode[0].raw.includes('```js') && withCode[0].raw.includes('\n```'));
});
await test('TOKENS indivisíveis (link com título, URL, <@id>, <@&id>, <#id>, <:e:id>, <a:e:id>, <t:..>, <https://..>) nunca são partidos', () => {
  const tokens = [
    '[texto do link](https://exemplo.com/a/b "título")',
    'https://exemplo.com/um/caminho/bem/longo/ate/aqui?x=1&y=2',
    '<@123456789012345678>', '<@&123456789012345678>', '<#123456789012345678>',
    '<:wow:123456789012345678>', '<a:dance:123456789012345678>', '<t:1700000000:R>', '<https://exemplo.com/x>',
  ];
  for (const tok of tokens) {
    for (let offset = 1850; offset <= 1905; offset++) {
      let filler = '';
      while (filler.length < offset) filler += 'abcde ';
      const text = `${filler.slice(0, offset)}${tok} ${'resto '.repeat(400)}`;
      const d = splitDetailed(text);
      check(d.parts);
      assert.equal(d.parts.filter((p) => p.content.includes(tok)).length, 1, `token partido: ${tok} (offset ${offset})`);
    }
  }
});
await test('pares ** __ ~~ || não são partidos (nenhuma parte fica com marcador ímpar)', () => {
  for (const mk of ['**', '__', '~~', '||']) {
    const tok = `${mk}frase importante aqui${mk}`;
    for (let offset = 1860; offset <= 1905; offset++) {
      let filler = '';
      while (filler.length < offset) filler += 'abcde ';
      const d = splitDetailed(`${filler.slice(0, offset)}${tok} ${'resto '.repeat(400)}`);
      check(d.parts);
      for (const p of d.parts) assert.equal(count(p.content, mk) % 2, 0, `${mk} ímpar numa parte (offset ${offset})`);
    }
  }
});
await test('CITAÇÃO ">": a linha longa continua com "> " na parte seguinte; ">>>" vira citação por linha e o marcador fica fora', () => {
  const longQuote = `> ${'palavra de citação '.repeat(220)}`;
  const d = splitDetailed(longQuote);
  check(d.parts);
  d.parts.forEach((p, i) => { if (i > 0) assert.ok(p.content.startsWith('> '), 'a citação não foi reaberta'); });
  const multi = `Intro\n>>> ${Array.from({ length: 120 }, (_, i) => `linha citada número ${i} com algum texto`).join('\n')}`;
  const d2 = splitDetailed(multi);
  check(d2.parts);
  assert.ok(d2.parts.length >= 2);
  for (const p of d2.parts) {
    assert.ok(!p.content.includes('>>>'), '">>>" deveria ter virado ">" por linha');
    const lines = p.content.split('\n');
    assert.ok(/^-# parte/.test(lines.at(-1)), 'o marcador deve ser a última linha');
    assert.ok(!lines.at(-1).startsWith('>'), 'o marcador ficou dentro da citação');
  }
});
await test('LISTA: item (com linhas de continuação) nunca é partido; título e "...:" não ficam órfãos no fim da parte', () => {
  const items = Array.from({ length: 60 }, (_, i) => `${i + 1}. Item ${i + 1} com um texto razoável\n   continuação do item ${i + 1} numa segunda linha\n   e uma terceira linha do item ${i + 1}`);
  const d = splitDetailed(items.join('\n'));
  check(d.parts);
  assert.ok(d.parts.length >= 2);
  for (const p of d.parts) {
    const c = stripMarker(p.content);
    assert.ok(!/^\s/.test(c), 'a parte começa por uma linha de continuação');
    const its = c.split(/\n(?=\d+\. )/);
    for (const it of its) assert.equal(it.split('\n').length, 3, `item partido: ${it.slice(0, 40)}`);
  }
  const intro = `${'Texto de enchimento. '.repeat(85)}\n**Lista de jogos:**\n${listLines(45).join('\n')}`;
  const d2 = splitDetailed(intro);
  check(d2.parts);
  for (const p of d2.parts.slice(0, -1)) assert.ok(!/:\*{0,2}$/.test(stripMarker(p.content)), 'um título/"...:" ficou órfão no fim da parte');
});
await test('nenhuma parte vazia ou só com espaços (muitas linhas em branco)', () => {
  const text = Array.from({ length: 40 }, (_, i) => `bloco ${i} ${'texto '.repeat(30)}${'\n'.repeat(1 + (i % 7))}`).join('') + '   \n\n   fim';
  const d = splitDetailed(text);
  check(d.parts);
  assert.equal(d.parts.map((p) => p.raw).join(''), d.body);
});
await test('firstChunk respeita o limite pedido e capSingleMessage cabe numa mensagem só (mantém o rodapé)', () => {
  const c = firstChunk('palavra '.repeat(500), 600);
  assert.ok(c.length <= 600 && c.length > 300);
  const capped = capSingleMessage(`${'frase longa de voz. '.repeat(200)}\n${FOOT}`);
  assert.ok(capped.length <= DISCORD_LIMIT && capped.endsWith(FOOT) && capped.includes('[…]'));
  assert.equal(capSingleMessage('curto'), 'curto');
});
await test('PROPRIEDADE (semente fixa): textos aleatórios com listas, código, citações, links, menções, emoji e textos sem espaço', () => {
  const WORDS = ['jogo', 'missão', 'carro', 'Los', 'Santos', 'semana', 'bônus', 'dinheiro', 'GTA$', 'rápido', 'é', 'de', 'a', 'o', 'para', 'com', 'mod', 'servidor', 'lista', 'item'];
  const EMOJI = ['😀', '👨‍👩‍👧‍👦', '🇧🇷', '1️⃣', '👍🏽', '❤️', '🏳️‍🌈'];
  for (let seed = 1; seed <= 150; seed++) {
    const r = mulberry32(seed * 7919);
    const pick = (a) => a[Math.floor(r() * a.length)];
    const words = (n) => Array.from({ length: n }, () => (r() < 0.04 ? pick(EMOJI) : pick(WORDS))).join(' ');
    const tokens = [];
    const pieces = [];
    const target = 2100 + Math.floor(r() * 9000);
    let len = 0;
    while (len < target) {
      let piece;
      switch (Math.floor(r() * 9)) {
        case 0: piece = `${words(5 + Math.floor(r() * 120))}.`; break;
        case 1: piece = Array.from({ length: 2 + Math.floor(r() * 12) }, (_, i) => `${i + 1}. ${words(3 + Math.floor(r() * 12))}`).join('\n'); break;
        case 2: piece = `\`\`\`js\n${Array.from({ length: 3 + Math.floor(r() * 60) }, (_, i) => `  const v${i} = ${i}; // ${words(3)}`).join('\n')}\n\`\`\``; break;
        case 3: piece = Array.from({ length: 1 + Math.floor(r() * 3) }, () => `> ${words(5 + Math.floor(r() * 40))}`).join('\n'); break;
        case 4: { const t = `[${pick(WORDS)}](https://exemplo.com/${Math.floor(r() * 1e9)})`; tokens.push(t); piece = `${words(10 + Math.floor(r() * 150))} ${t} ${words(8)}`; break; }
        case 5: { const t = `<@${String(Math.floor(r() * 1e17) + 1e17)}>`; tokens.push(t); piece = `${words(10 + Math.floor(r() * 150))} ${t} ${words(8)}`; break; }
        case 6: piece = 'x'.repeat(100 + Math.floor(r() * 2400)); break;
        case 7: piece = ''; break;
        default: piece = Array.from({ length: 3 + Math.floor(r() * 30) }, () => pick(EMOJI)).join(''); break;
      }
      pieces.push(piece);
      len += piece.length + 2;
    }
    const text = pieces.join(r() < 0.5 ? '\n\n' : '\n');
    const footer = r() < 0.6 ? FOOT : '';
    const d = splitDetailed(text, { footer });
    check(d.parts);
    assert.equal(d.parts.map((p) => p.raw).join(''), d.body, `seed ${seed}: as fatias não reconstroem o texto`);
    assert.equal(d.parts.reduce((n, p) => n + graphemes(p.raw), 0), graphemes(d.body), `seed ${seed}: grafema partido`);
    d.parts.forEach((p, i) => assert.equal(fenceCount(p.content) % 2, 0, `seed ${seed} parte ${i + 1}: cerca desbalanceada`));
    d.parts.forEach((p, i) => { if (i > 0 && d.parts.length > 1) assert.ok(p.content.length > 0); });
    if (footer) d.parts.forEach((p, i) => assert.equal(p.content.includes(FOOT), i === d.parts.length - 1, `seed ${seed}: rodapé`));
    for (const tok of new Set(tokens)) assert.equal(d.parts.filter((p) => p.content.includes(tok)).length, 1, `seed ${seed}: token partido ${tok}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('B. Envio sequencial com dublês (sendLongReply)');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const discordError = (status, code = 0, message = 'erro do Discord') => Object.assign(new Error(message), { status, code });
function makeLogger() {
  const logs = { info: [], warn: [], error: [] };
  return { logs, info: (m) => logs.info.push(String(m)), warn: (m) => logs.warn.push(String(m)), error: (m) => logs.error.push(String(m)), debug() {} };
}
/** Mundo falso: canal, mensagem "Processando...", mensagem do usuário e interação slash. `fail` injeta erros por operação. */
function makeWorld({ delay = () => 0, fail = {}, ephemeral = false, tokenAgeMs = 0, canDelete = false } = {}) {
  const timeline = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let seq = 0;
  const counters = {};
  const op = async (name, payload) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const n = ++seq;
    counters[name] = (counters[name] ?? 0) + 1;
    const entry = { n, name, payload, call: counters[name] };
    timeline.push(entry);
    try {
      await sleep(delay(n, name));
      const f = fail[name];
      const err = typeof f === 'function' ? f(counters[name], payload) : Array.isArray(f) ? f[counters[name] - 1] : null;
      if (err) throw err;
      return { id: `${name}-${n}`, content: payload.content, channel, edit: (pp) => op('edit', pp), ...(canDelete ? { delete: () => op('delete', {}) } : {}), __entry: entry };
    } finally {
      inFlight--;
    }
  };
  const channel = { id: 'chan1', send: (p) => op('send', p) };
  // canDelete: dá `delete` à mensagem de "Processando..." e `deleteReply` à interação (a limpeza da mensagem de progresso antiga só age se existir)
  const replyMessage = { id: 'proc1', channel, edit: (p) => op('edit', p), ...(canDelete ? { delete: () => op('delete', {}) } : {}) };
  const message = { id: 'orig1', channel, channelId: 'chan1', guildId: 'g1', guild: { id: 'g1' }, reply: (p) => op('reply', p), author: { id: 'u1', tag: 'u#1' } };
  const slash = {
    id: 'int1', channel, channelId: 'chan1', guildId: 'g1', guild: { id: 'g1' }, deferred: true, replied: false, ephemeral,
    createdTimestamp: Date.now() - tokenAgeMs,
    editReply: (p) => op('editReply', p), followUp: (p) => op('followUp', p), reply: (p) => op('reply', p),
    ...(canDelete ? { deleteReply: () => op('deleteReply', {}) } : {}),
    user: { id: 'u1', tag: 'u#1' },
  };
  return { timeline, channel, replyMessage, message, slash, get maxInFlight() { return maxInFlight; }, ops: (name) => timeline.filter((t) => t.name === name) };
}
const noWait = { sleep: async () => {}, retryDelayMs: 0 };
const bodyOf = (n = 74) => ['Aqui está a lista completa:', '', ...listLines(n)].join('\n');
const joinedText = (payloads) => payloads.map((p) => stripMarker(p.content)).join('\n');

await test('menção: a parte 1 EDITA o "Processando...", as demais saem por channel.send em ordem estrita (atraso aleatório, nunca em paralelo)', async () => {
  const r = mulberry32(42);
  const w = makeWorld({ delay: () => Math.floor(r() * 20) });
  const logger = makeLogger();
  const text = `${bodyOf(80)}\n${FOOT}`;
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text, logger, ...noWait });
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'split');
  assert.ok(res.parts >= 3 && res.sentParts === res.parts, `partes: ${res.parts}`);
  assert.equal(w.maxInFlight, 1, 'houve envio em paralelo');
  assert.deepEqual(w.timeline.map((t) => t.name), ['edit', ...Array(res.parts - 1).fill('send')]);
  const sent = w.timeline.map((t) => t.payload);
  assert.ok(sent.every((p) => p.content.length <= DISCORD_LIMIT));
  assert.ok(sent.every((p) => p.allowedMentions === SAFE_ALLOWED_MENTIONS), 'allowedMentions seguro em TODAS as partes');
  assert.equal((sent[0].flags ?? 0) & MessageFlags.SuppressNotifications, 0, 'a parte 1 é um edit: não pode ser silenciosa');
  const nonces = new Set();
  w.ops('send').forEach((t, i) => {
    assert.equal(t.payload.flags & MessageFlags.SuppressNotifications, MessageFlags.SuppressNotifications, 'partes 2..N sem notificação');
    assert.equal(t.payload.enforceNonce, true);
    assert.ok(typeof t.payload.nonce === 'string' && t.payload.nonce.length <= 25);
    nonces.add(t.payload.nonce);
    const prev = w.timeline[w.timeline.indexOf(t) - 1];
    assert.equal(t.payload.reply.messageReference.id, `${prev.name}-${prev.n}`, 'cada parte responde à anterior');
    assert.equal(t.payload.reply.failIfNotExists, false);
  });
  assert.equal(nonces.size, w.ops('send').length, 'nonces repetidos');
  // o texto inteiro chega, em ordem
  const nums = [...joinedText(sent).matchAll(/^(\d+)\. \[Mod/gm)].map((m) => Number(m[1]));
  assert.deepEqual(nums, Array.from({ length: 80 }, (_, i) => i + 1));
  assert.equal(count(sent.map((p) => p.content).join('\n'), FOOT), 1);
  assert.ok(sent.at(-1).content.includes(FOOT) && sent.at(-1).content.endsWith(`-# parte ${res.parts}/${res.parts}`));
  assert.equal(res.message.id, `send-${w.timeline.at(-1).n}`, 'devolve a ÚLTIMA mensagem (a que carrega botões)');
});
await test('arquivos, botões e embeds vão SÓ na última parte (as anteriores limpam os da mensagem de "Processando...")', async () => {
  const w = makeWorld();
  const files = [new AttachmentBuilder(Buffer.from('x'), { name: 'a.txt' })];
  const components = [{ type: 1 }];
  const embeds = [{ title: 'e' }];
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text: bodyOf(80), files, components, embeds, ...noWait });
  assert.ok(res.parts >= 3);
  const last = w.timeline.at(-1).payload;
  assert.deepEqual([last.files, last.components, last.embeds], [files, components, embeds]);
  const edit = w.timeline[0].payload;
  assert.deepEqual([edit.files, edit.components, edit.embeds], [[], [], []]);
  for (const t of w.timeline.slice(1, -1)) assert.ok(!t.payload.files && !t.payload.components && !t.payload.embeds);
});
await test('slash público: editReply na parte 1 e followUp (sem channel.send) nas demais, silenciosas', async () => {
  const w = makeWorld();
  const res = await sendLongReply({ kind: 'slash', interaction: w.slash, text: bodyOf(80), ...noWait });
  assert.ok(res.ok && res.parts >= 3);
  assert.deepEqual(w.timeline.map((t) => t.name), ['editReply', ...Array(res.parts - 1).fill('followUp')]);
  assert.equal(w.ops('send').length, 0);
  for (const t of w.ops('followUp')) {
    assert.ok(t.payload.flags & MessageFlags.SuppressNotifications);
    assert.equal(t.payload.allowedMentions, SAFE_ALLOWED_MENTIONS);
    assert.equal(t.payload.flags & MessageFlags.Ephemeral, 0);
  }
});
await test('slash EFÊMERO: followUp com flag Ephemeral e NUNCA channel.send (mesmo com falhas)', async () => {
  const w = makeWorld({ ephemeral: true });
  const res = await sendLongReply({ kind: 'slash', interaction: w.slash, text: bodyOf(80), ...noWait });
  assert.ok(res.ok);
  for (const t of w.ops('followUp')) assert.equal(t.payload.flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
  assert.equal(w.ops('send').length, 0);
  // agora o followUp falha para sempre: o conteúdo privado não pode vazar para o canal
  const w2 = makeWorld({ ephemeral: true, fail: { followUp: () => discordError(403, 50013) } });
  const logger = makeLogger();
  const res2 = await sendLongReply({ kind: 'slash', interaction: w2.slash, text: bodyOf(80), logger, ...noWait });
  assert.equal(res2.sentParts, 1);
  assert.equal(w2.ops('send').length, 0, 'conteúdo efêmero vazou para channel.send');
  assert.equal(w2.ops('reply').length, 0);
  assert.ok(logger.logs.error.length >= 1);
});
await test('token de interação expirado: público cai para channel.send; efêmero não envia nada para o canal', async () => {
  const w = makeWorld({ tokenAgeMs: 20 * 60 * 1000 });
  const res = await sendLongReply({ kind: 'slash', interaction: w.slash, text: bodyOf(80), ...noWait });
  assert.ok(res.ok);
  assert.equal(w.ops('followUp').length, 0, 'followUp com token vencido');
  assert.ok(w.ops('send').length >= 2);
  const e = makeWorld({ ephemeral: true, tokenAgeMs: 20 * 60 * 1000 });
  await sendLongReply({ kind: 'slash', interaction: e.slash, text: bodyOf(80), logger: makeLogger(), ...noWait });
  assert.equal(e.ops('send').length, 0, 'efêmero vazou para o canal');
  assert.equal(e.ops('followUp').length, 0);
});
await test('a parte 1 não pôde ser editada (Unknown Message): vai como mensagem nova, em resposta a quem perguntou, e o resto segue', async () => {
  const w = makeWorld({ fail: { edit: [discordError(404, 10008, 'Unknown Message')] } });
  const logger = makeLogger();
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text: bodyOf(80), logger, ...noWait });
  assert.ok(res.ok && res.sentParts === res.parts, 'deveria entregar todas as partes');
  assert.deepEqual(w.timeline.map((t) => t.name).slice(0, 3), ['edit', 'send', 'send']);
  const first = w.ops('send')[0].payload;
  assert.equal(first.reply.messageReference, w.message, 'a parte 1 de fallback responde à mensagem original');
  assert.equal(first.flags & MessageFlags.SuppressNotifications, 0, 'a parte 1 não é silenciosa');
  assert.ok(logger.logs.warn.some((l) => /parte 1/.test(l)));
});
await test('erro PERMANENTE na parte 2: não repete; o restante vai como UM anexo (partes 2 a N) e o resto das partes não é enviado', async () => {
  const w = makeWorld({ fail: { send: [discordError(403, 50013, 'Missing Permissions')] } });
  const logger = makeLogger();
  const text = `${bodyOf(80)}\n${FOOT}`;
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text, logger, ...noWait });
  assert.equal(res.degraded, true);
  assert.equal(w.ops('send').length, 2, 'parte 2 (falhou, sem repetir) + anexo');
  const att = w.ops('send')[1].payload;
  assert.match(att.content, new RegExp(`partes 2 a ${res.parts}`));
  assert.equal(att.files.length, 1);
  const sentText = att.files[0].attachment.toString('utf8');
  const d = splitDetailed(splitFooter(text).body, { footer: FOOT });
  assert.equal(sentText, `${d.body.slice(d.parts[1].start)}\n${FOOT}`, 'o anexo deveria ter TODO o restante, a partir da parte 2');
  assert.ok(logger.logs.error.some((l) => /parte 2\/\d+/.test(l) && /status=403/.test(l) && /codigo=50013/.test(l)), logger.logs.error.join('|'));
});
await test('o anexo também falha: manda o aviso "não consegui enviar as partes k a N"; se nem isso sai, não lança', async () => {
  const w = makeWorld({ fail: { send: [discordError(403), discordError(403), null] } });
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text: bodyOf(80), logger: makeLogger(), ...noWait });
  assert.equal(w.ops('send').length, 3);
  assert.match(w.ops('send')[2].payload.content, /Não consegui enviar as partes 2 a \d+\./);
  assert.ok(res.ok, 'a parte 1 foi entregue');
  const w2 = makeWorld({ fail: { send: () => discordError(403) } });
  const res2 = await sendLongReply({ kind: 'mention', interaction: w2.message, replyMessage: w2.replyMessage, text: bodyOf(80), logger: makeLogger(), ...noWait });
  assert.equal(res2.sentParts, 1);
});
await test('erro TRANSITÓRIO (5xx): uma repetição com o MESMO nonce e enforceNonce; permanente (4xx) não repete', async () => {
  const w = makeWorld({ fail: { send: [discordError(500)] } });
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text: bodyOf(80), logger: makeLogger(), ...noWait });
  assert.ok(res.ok && res.sentParts === res.parts && !res.degraded);
  const [a, b] = w.ops('send');
  assert.equal(a.payload.nonce, b.payload.nonce, 'a repetição precisa do mesmo nonce');
  assert.equal(b.payload.enforceNonce, true);
  assert.equal(w.ops('send').length, res.parts - 1 + 1);
  assert.equal(isPermanentDiscordError(discordError(404)), true);
  assert.equal(isPermanentDiscordError(discordError(429)), false);
  assert.equal(isPermanentDiscordError(discordError(500)), false);
  assert.equal(isPermanentDiscordError(new Error('rede')), false);
});
await test('acima do máximo de partes: introdução + texto COMPLETO como anexo .md (uma única chamada); teto de 20000 caracteres', async () => {
  const text = `${bodyOf(300)}\n${FOOT}`;
  assert.ok(splitReply(text).parts.length > 4);
  const w = makeWorld();
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text, ...noWait });
  assert.ok(res.ok);
  assert.equal(res.mode, 'attachment');
  assert.deepEqual(w.timeline.map((t) => t.name), ['edit']);
  const p = w.timeline[0].payload;
  assert.ok(p.content.length <= DISCORD_LIMIT && /anexo/.test(p.content));
  assert.equal(p.files.length, 1);
  assert.equal(p.files[0].name, 'resposta-yui.md', 'o anexo padrão é .md (o Discord renderiza a prévia)');
  // YUI_REPLY_ATTACH_EXT=txt volta ao anexo .txt; valor estranho cai no padrão .md
  assert.equal(parseAttachExt({ YUI_REPLY_ATTACH_EXT: 'txt' }), 'txt');
  assert.equal(parseAttachExt({ YUI_REPLY_ATTACH_EXT: '.TXT' }), 'txt');
  assert.equal(parseAttachExt({ YUI_REPLY_ATTACH_EXT: 'exe' }), 'md');
  assert.equal(parseAttachExt({}), 'md');
  const wTxt = makeWorld();
  await sendLongReply({ kind: 'mention', interaction: wTxt.message, replyMessage: wTxt.replyMessage, text, attachExt: 'txt', ...noWait });
  assert.equal(wTxt.timeline[0].payload.files[0].name, 'resposta-yui.txt');
  assert.equal(p.files[0].attachment.toString('utf8'), text, 'o anexo precisa ter o texto COMPLETO');
  assert.ok(p.content.includes('Aqui está a lista completa:') && p.content.endsWith(FOOT));
  // maxParts=2 com 3 partes
  const w2 = makeWorld();
  const r2 = await sendLongReply({ kind: 'slash', interaction: w2.slash, text: bodyOf(80), maxParts: 2, ...noWait });
  assert.equal(r2.mode, 'attachment');
  // mais de 20000 caracteres: só anexo, mesmo com limite de partes alto
  const w3 = makeWorld();
  const huge = 'palavra '.repeat(3200);
  const r3 = await sendLongReply({ kind: 'slash', interaction: w3.slash, text: huge, maxParts: 10, ...noWait });
  assert.equal(r3.mode, 'attachment');
  assert.equal(w3.timeline[0].payload.files[0].attachment.toString('utf8'), huge);
});
await test('modo anexo: quem foi citado vai como TEXTO na mensagem (menção em arquivo não notifica); código, cargos e @everyone ficam de fora', async () => {
  const u1 = '123456789012345678', u2 = '223456789012345678', role = '323456789012345678';
  const BT = String.fromCharCode(96), F3 = BT + BT + BT;
  assert.deepEqual(collectUserMentions('oi <@' + u1 + '> e <@!' + u2 + '> e <@&' + role + '> e ' + BT + '<@999999999999999999>' + BT), [u1, u2]);
  assert.deepEqual(collectUserMentions(F3 + '\n<@999999999999999999>\n' + F3 + ' ok <@' + u1 + '> <@' + u1 + '>'), [u1], 'sem repetição e sem bloco de código');
  assert.deepEqual(collectUserMentions('sem menções @everyone'), []);
  assert.equal(collectUserMentions(Array.from({ length: 15 }, (_, i) => '<@' + String(100000000000000000n + BigInt(i)) + '>').join(' ')).length, 10, 'no máximo 10');
  const text = bodyOf(300) + ' fim <@' + u1 + '> e <@' + u2 + '>\n' + FOOT;
  const w = makeWorld();
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text, ...noWait });
  assert.equal(res.mode, 'attachment');
  const p = w.timeline[0].payload;
  assert.ok(p.content.includes('Citados no arquivo: <@' + u1 + '> <@' + u2 + '>'), 'os citados entram como texto na mensagem');
  assert.ok(p.content.length <= DISCORD_LIMIT && p.content.endsWith(FOOT), 'cabe no limite e o rodapé continua por último');
  assert.equal(p.allowedMentions, SAFE_ALLOWED_MENTIONS, 'só usuários podem ser notificados');
  assert.ok(p.files[0].attachment.toString('utf8').includes('<@' + u1 + '>'), 'o arquivo mantém o texto completo, com as menções como estão');
  // sem menção: nenhuma linha extra
  const w2 = makeWorld();
  await sendLongReply({ kind: 'mention', interaction: w2.message, replyMessage: w2.replyMessage, text: bodyOf(300) + '\n' + FOOT, ...noWait });
  assert.ok(!w2.timeline[0].payload.content.includes('Citados no arquivo'));
});
await test('PRAZO de entrega: parte travada não segura a fila (vai para anexo/aviso e a função retorna)', async () => {
  const w = makeWorld({ delay: (n, name) => (name === 'send' ? 600 : 0) });
  const logger = makeLogger();
  const t0 = Date.now();
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text: bodyOf(80), deadlineMs: 120, fallbackMs: 4000, logger, sleep: async () => {}, retryDelayMs: 0 });
  assert.ok(Date.now() - t0 < 4000, 'demorou demais');
  assert.equal(res.degraded, true);
  assert.ok(res.ok);
});
await test('muitos links: a parte sai com SuppressEmbeds (sem previews)', async () => {
  const w = makeWorld();
  const links = Array.from({ length: 130 }, (_, i) => `- https://exemplo.com/p/${i}`).join('\n');
  assert.equal(countUrls(links), 130);
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text: links, ...noWait });
  assert.ok(res.parts >= 2);
  for (const t of w.timeline) assert.ok(t.payload.flags & MessageFlags.SuppressEmbeds, 'deveria suprimir os previews');
});
await test('@everyone/@here são neutralizados em TODAS as partes e o log de erro não vaza o conteúdo', async () => {
  const w = makeWorld({ fail: { send: [discordError(403)] } });
  const logger = makeLogger();
  const text = `${'aviso @everyone e @here SEGREDO_XYZ. '.repeat(120)}`;
  await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text, logger, ...noWait });
  for (const t of w.timeline) {
    assert.ok(!/@(everyone|here)\b/.test(t.payload.content), 'menção em massa passou');
    assert.equal(t.payload.allowedMentions, SAFE_ALLOWED_MENTIONS);
  }
  const all = [...logger.logs.info, ...logger.logs.warn, ...logger.logs.error].join('\n');
  assert.ok(!all.includes('SEGREDO_XYZ'), 'o log recebeu o conteúdo da resposta');
});
await test('slash sem editReply possível (não deferido): usa interaction.reply; texto curto passa direto como parte única', async () => {
  const w = makeWorld();
  w.slash.deferred = false;
  const res = await sendLongReply({ kind: 'slash', interaction: w.slash, text: 'resposta curta', ...noWait });
  assert.equal(res.mode, 'single');
  assert.deepEqual(w.timeline.map((t) => t.name), ['reply']);
  assert.equal(w.timeline[0].payload.fetchReply, true);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('C. createUnifiedReply (fábrica do unifiedReply da fila)');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('texto curto segue o caminho de sempre: 1ª chamada responde (reply), as seguintes editam; devolve a mensagem', async () => {
  const w = makeWorld();
  let rm = null;
  const reply = createUnifiedReply({ interaction: w.message, type: 'mention', userId: 'u1', getReplyMessage: () => rm, setReplyMessage: (m) => { rm = m; } });
  const m1 = await reply('🧠 **Processando...**');
  assert.equal(w.timeline[0].name, 'reply');
  assert.equal(w.timeline[0].payload.fetchReply, true);
  assert.equal(w.timeline[0].payload.failIfNotExists, false);
  assert.equal(w.timeline[0].payload.allowedMentions, SAFE_ALLOWED_MENTIONS);
  assert.equal(rm, m1);
  rm.edit = (p) => makeWorld().replyMessage.edit(p); // edição bem-sucedida de uma mensagem falsa
  const embeds = [{ title: 'e' }];
  const m2 = await reply(null, [], [], embeds);
  assert.equal(m2, rm);
  assert.equal(reply.lastDelivery.mode, 'single');
  assert.equal(reply.lastDelivery.ok, true);
  const s = makeWorld();
  const replySlash = createUnifiedReply({ interaction: s.slash, type: 'slash', userId: 'u1' });
  const m3 = await replySlash('oi');
  assert.equal(s.timeline[0].name, 'editReply');
  assert.ok(m3);
});
await test('falha do envio: devolve null, chama onError e marca lastDelivery.ok=false', async () => {
  // 403/50013 (sem permissão): reenviar o mesmo corpo falharia igual, então não há plano B (o 5xx/10008 tem o seu, em test-longreply-limits.js)
  const w = makeWorld({ fail: { reply: [discordError(403, 50013)] } });
  const errors = [];
  const reply = createUnifiedReply({ interaction: w.message, type: 'mention', userId: 'u1', onError: (e) => errors.push(e) });
  assert.equal(await reply('oi'), null);
  assert.equal(errors.length, 1);
  assert.equal(reply.lastDelivery.ok, false);
  assert.equal(w.ops('send').length, 0, 'erro sem solução no reenvio não gera mensagem nova');
});
await test('resposta longa: divide, atualiza a mensagem de "Processando...", devolve a ÚLTIMA parte e deixa lastDelivery', async () => {
  const w = makeWorld();
  let rm = w.replyMessage;
  const reply = createUnifiedReply({ interaction: w.message, type: 'mention', userId: 'u1', getReplyMessage: () => rm, setReplyMessage: (m) => { rm = m; }, deps: noWait });
  const comps = [{ type: 1 }];
  const out = await reply(`${bodyOf(80)}\n${FOOT}`, [], comps, []);
  assert.equal(out.id, `send-${w.timeline.at(-1).n}`);
  assert.equal(w.timeline[0].name, 'edit');
  assert.equal(w.timeline.at(-1).payload.components, comps);
  assert.equal(reply.lastDelivery.mode, 'split');
  assert.equal(reply.lastDelivery.sentParts, reply.lastDelivery.parts);
});
await test('o divisor roda DEPOIS de resolveMentions: "@nome" vira <@id> (mais longo) e nenhuma parte estoura 2000', async () => {
  const w = makeWorld();
  const expand = async (t) => t.replace(/@ab\b/g, '<@123456789012345678>');
  const text = ('palavra '.repeat(235) + '@ab ').repeat(2).slice(0, 4000);
  assert.ok(text.length < 4000 + 1 && (text.match(/@ab\b/g) ?? []).length >= 1);
  const reply = createUnifiedReply({ interaction: w.message, type: 'mention', userId: 'u1', resolveMentions: expand, getReplyMessage: () => w.replyMessage, deps: noWait });
  await reply(text);
  for (const t of w.timeline) assert.ok(t.payload.content.length <= DISCORD_LIMIT);
  const all = w.timeline.map((t) => t.payload.content).join('\n');
  assert.ok(!/@ab\b/.test(all) && all.includes('<@123456789012345678>'));
  for (const t of w.timeline) {
    for (const m of t.payload.content.matchAll(/<@(\d*)(>?)/g)) assert.ok(m[1].length === 18 && m[2] === '>', `menção partida: ${m[0]}`);
  }
});
await test('VOZ e RÁDIO nunca passam pelo divisor: uma mensagem só, com o prefixo <@id> e o rodapé', async () => {
  const w = makeWorld();
  const voice = { ...w.message, id: 'voice_123', isVoice: true };
  const reply = createUnifiedReply({ interaction: voice, type: 'mention', userId: 'u1', getReplyMessage: () => w.replyMessage });
  await reply(`${'frase falada. '.repeat(400)}\n${FOOT}`);
  assert.equal(w.timeline.length, 1);
  const p = w.timeline[0].payload;
  assert.ok(p.content.startsWith('<@u1> ') && p.content.length <= DISCORD_LIMIT && p.content.endsWith(FOOT));
  const radio = createUnifiedReply({ interaction: w.message, type: 'mention', userId: 'u1', radioMode: true, getReplyMessage: () => w.replyMessage });
  await radio('x'.repeat(3000));
  assert.equal(w.timeline.length, 2);
  assert.ok(w.timeline[1].payload.content.length <= DISCORD_LIMIT);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('D. Utilitários puros');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('variáveis de ambiente: YUI_REPLY_MAX_PARTS (padrão 4, 1..10) e YUI_REPLY_MAX_TOKENS (64..8192)', () => {
  assert.equal(parseMaxParts({}), 4);
  assert.equal(parseMaxParts({ YUI_REPLY_MAX_PARTS: '6' }), 6);
  for (const bad of ['0', '11', 'x', '', '-2']) assert.equal(parseMaxParts({ YUI_REPLY_MAX_PARTS: bad }), 4);
  assert.equal(parseReplyMaxTokens({}), null);
  assert.equal(parseReplyMaxTokens({ YUI_REPLY_MAX_TOKENS: '3000' }), 3000);
  for (const bad of ['10', '99999', 'abc', '']) assert.equal(parseReplyMaxTokens({ YUI_REPLY_MAX_TOKENS: bad }), null);
});
await test('isTruncatedFinish reconhece length/MAX_TOKENS e ignora stop/null', () => {
  for (const r of ['length', 'LENGTH', 'MAX_TOKENS', 'max_tokens']) assert.equal(isTruncatedFinish(r), true);
  for (const r of ['stop', 'tool_calls', null, undefined, '']) assert.equal(isTruncatedFinish(r), false);
  assert.equal(looksLikeToolJson('{"tool":"x"}'), true);
  assert.equal(looksLikeToolJson('Texto normal'), false);
});
await test('mergeContinuation: tira a sobreposição da emenda, não duplica e escolhe o separador certo', () => {
  assert.equal(mergeContinuation('Isso foi cortado no meio do raciocínio', 'no meio do raciocínio e continua aqui.'), 'Isso foi cortado no meio do raciocínio e continua aqui.');
  assert.equal(mergeContinuation('Palavra parcial Parti', 'Particularmente isso importa.'), 'Palavra parcial Particularmente isso importa.');
  assert.equal(mergeContinuation('Primeira frase.', 'Segunda frase.'), 'Primeira frase. Segunda frase.');
  assert.equal(mergeContinuation('1. um\n2. dois', '3. três'), '1. um\n2. dois\n3. três');
  assert.equal(mergeContinuation('Fim da frase', ', e segue.'), 'Fim da frase, e segue.');
  assert.equal(mergeContinuation('abc', ''), 'abc');
  assert.equal(mergeContinuation('', 'abc'), 'abc');
  // sobreposição curtinha demais (< 5) não conta
  assert.equal(mergeContinuation('Vi o gato e a', 'a casa'), 'Vi o gato e a a casa');
});
await test('FILTRO DE PROMESSAS: "anotei", "te aviso", "vou te mandar" ganham o aviso fixo; negações, texto normal e memória gravada não', () => {
  const yes = ['Anotei sua lista, pode deixar!', 'Beleza, te aviso quando sair.', 'Vou te mandar mais tarde.', 'Pode deixar que eu te envio depois', 'ok, vou te avisar', 'Guardei a lista aqui', 'Me manda um ponto pra eu continuar a lista', 'Te mando mais tarde, pode deixar', 'Te lembro quando chegar a hora'];
  for (const t of yes) assert.equal(promisesFutureAction(t), true, t);
  const no = [
    'Não vou te avisar, sinto muito.', 'Nunca te mando nada fora daqui.', 'O Mod(1.20) roda bem no servidor.', 'Aqui está a lista completa.',
    'A missão marcada no mapa fica em Paleto Bay.', 'Se quiser, me pergunta de novo.',
    'Te aviso que isso é arriscado.', 'Te aviso: não faça isso.', 'Te mando um abraço!', 'Te passo a receita agora mesmo.',
  ];
  for (const t of no) assert.equal(promisesFutureAction(t), false, t);
  // entrega IMEDIATA na própria resposta (introdução de lista, link, gíria) NÃO é promessa
  const immediate = [
    'vou te mandar o link: https://exemplo.com/a', 'Vou enviar a lista abaixo:', 'vou te passar o resumo:', 'vou mandar a real:', 'vou chamar de bobo',
    'vou lembrar que o patch saiu', 'vou salvar o arquivo', 'Beleza, vou te mandar a lista abaixo.\n1. a\n2. b', 'vou te mandar tudo aqui mesmo',
    'Vou te mandar a lista abaixo:\n1. depois do café\n2. quando chover', 'vou te avisar que isso é arriscado', 'vou te lembrar que isso não vale',
    'Vou te passar o link https://exemplo.com/depois.html agora', 'vou encaminhar a dúvida na resposta mesmo',
  ];
  for (const t of immediate) assert.equal(promisesFutureAction(t), false, t);
  // continuam promessas: ação inequívoca, ou verbo de entrega com adiamento na mesma frase
  const deferred = [
    'vou te mandar depois', 'vou enviar amanhã', 'Vou te lembrar amanhã', 'Vou te lembrar disso', 'Depois eu vou te mandar o link', 'vou programar para quando sair',
    'vou salvar isso para depois', 'vou chamar você quando terminar', 'vou te passar o resultado assim que sair', 'vou te avisar', 'vou anotar isso',
    'vou guardar isso', 'vou agendar um lembrete', 'vou te enviar o link https://exemplo.com/x em breve', 'Vou registrar isso',
  ];
  for (const t of deferred) assert.equal(promisesFutureAction(t), true, t);
  const out = applyPromiseNotice(`Anotei tudo!\n${FOOT}`);
  assert.equal(out, `Anotei tudo!\n\n${PROMISE_NOTICE}\n${FOOT}`);
  assert.equal(PROMISE_NOTICE, '(Não guardei nada nem consigo avisar depois.)');
  assert.equal(applyPromiseNotice('Anotei tudo!', { savedSomething: true }), 'Anotei tudo!', 'o código gravou algo: a promessa é verdadeira');
  assert.equal(applyPromiseNotice(`Anotei!\n\n${PROMISE_NOTICE}`), `Anotei!\n\n${PROMISE_NOTICE}`, 'não duplica o aviso');
  assert.equal(applyPromiseNotice('Texto sem promessa.'), 'Texto sem promessa.');
});
await test('antiEchoExempt: mensagem longa (> 200) e pedido explícito de lista ficam isentos', () => {
  assert.equal(antiEchoExempt('x'.repeat(201)), true);
  assert.equal(antiEchoExempt('liste os modos de jogo do GTA'), true);
  assert.equal(antiEchoExempt('me faz uma lista de carros'), true);
  assert.equal(antiEchoExempt('qual a capital da frança hoje'), false);
  assert.equal(antiEchoExempt(undefined), false);
});
await test('historyCopy: cópia aparada, sem rodapé e com a marca de partes', () => {
  assert.equal(historyCopy(`curta\n${FOOT}`), 'curta');
  const long = historyCopy(listLines(200).join('\n'), { parts: 5 });
  assert.ok(long.length < 1400 && long.endsWith('[resposta entregue em 5 mensagens]') && long.includes('[…]'), long.slice(-80));
  assert.ok(!LONE_SURROGATE.test(long));
});
await test('contexto do Discord: a mensagem respondida e a última do mesmo autor mantêm até 4000; as demais, 500 (com marcador de corte)', () => {
  const lista = Array.from({ length: 40 }, (_, i) => `${i + 1}. item numero ${i + 1} da lista colada`).join('\n');
  assert.ok(lista.length > 1000 && lista.length < 3000);
  const msgs = [
    { id: 'a', author: { id: 'x' } }, { id: 'b', author: { id: 'u1' } }, { id: 'c', author: { id: 'bot' } },
    { id: 'd', author: { id: 'u1' } }, { id: 'e', author: { id: 'x' } },
  ];
  const ids = longContextIds(msgs, { repliedId: 'a', authorId: 'u1' });
  assert.deepEqual([...ids].sort(), ['a', 'd']);
  assert.equal(clipContextText(lista, LONG_CONTEXT_LIMIT), lista, 'a lista de ~1500 caracteres precisa ficar inteira');
  const cutShort = clipContextText(lista, SHORT_CONTEXT_LIMIT);
  assert.equal(cutShort, `${lista.slice(0, 500)} [... cortada: ${lista.length} caracteres no original]`);
  const cutLong = clipContextText('x'.repeat(5000), LONG_CONTEXT_LIMIT);
  assert.equal(cutLong, `${'x'.repeat(4000)} [... cortada: 5000 caracteres no original]`);
  assert.equal(clipContextText('x'.repeat(4000), LONG_CONTEXT_LIMIT), 'x'.repeat(4000), 'no limite exato nada é cortado');
  assert.equal(LONG_CONTEXT_LIMIT, 4000);
  assert.equal(SHORT_CONTEXT_LIMIT, 500);
  assert.equal(longContextIds([], { authorId: 'u1' }).size, 0);
});
await test('formatDeliveryLog: uma linha com os metadados e SEM conteúdo', () => {
  const line = formatDeliveryLog({ chars: 3500, parts: 2, mode: 'split', channelKind: 'servidor', durationMs: 4200, deliveryMs: 800, provider: 'gemini', model: 'Gemini\n"x"', finishReason: 'length', continuations: 1 });
  assert.ok(!line.includes('\n'));
  for (const piece of ['caracteres=3500', 'partes=2/2', 'modo=dividida', 'canal=servidor', 'duracao=4200ms', 'provedor=gemini', 'finish=length', 'continuacoes=1']) assert.ok(line.includes(piece), piece);
  assert.match(formatDeliveryLog({ mode: 'attachment', channelKind: 'DM' }), /modo=anexo canal=DM/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('E. llmHandler de verdade (provedores falsos): continuação por limite de tokens, fila e filtros');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const { default: config } = await import('../src/config/index.js');
config.saveHistory = false; // NUNCA escrever no historico.txt real
const llm = await import('../src/handlers/llmHandler.js');
const { generateResponse, stripThinking } = llm;
const core = await import('../src/core/index.js');
await core.initMemory();
const adapter = await import('../src/core/discordAdapter.js');
const anaCtx = adapter.contextFromDiscord({ userId: '222', guildId: 'g1', channelId: 'chan-q6' });

const isLocal = (c) => c.url === config.localLlmUrl;
function sse(text, finish = 'stop', model = 'modelo-falso') {
  const chunks = [];
  const n = Math.max(1, Math.ceil(text.length / 3));
  for (let i = 0; i < text.length; i += n) chunks.push(`data: ${JSON.stringify({ model, choices: [{ delta: { content: text.slice(i, i + n) }, finish_reason: null }] })}\n\n`);
  chunks.push(`data: ${JSON.stringify({ model, choices: [{ delta: {}, finish_reason: finish }] })}\n\n`);
  chunks.push('data: [DONE]\n\n');
  return Readable.from(chunks);
}
let localScript = []; // [{ text, finish }] consumido a cada chamada ao provedor local
let localCalls = [];
postHook = (url, body) => {
  if (url !== config.localLlmUrl) return undefined;
  localCalls.push(body);
  const step = localScript.length ? localScript.shift() : { text: 'Resposta padrão do teste.', finish: 'stop' };
  return { data: sse(step.text, step.finish) };
};
const resetLocal = (script = []) => { localScript = script.slice(); localCalls = []; };
const userMsgs = (body) => (body?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content);

await test('resposta CORTADA (finish_reason length) pede continuação ao mesmo provedor com o rascunho e emenda sem duplicar', async () => {
  const A = 'A lista tem muitos itens e a resposta foi cortada no meio do raciocínio';
  const B = 'no meio do raciocínio e agora termina aqui.';
  resetLocal([{ text: A, finish: 'length' }, { text: B, finish: 'stop' }]);
  let meta = null;
  const out = await generateResponse('pergunta longa', 'chan-c1', { allowSearch: false, disableTools: false, onMeta: (m) => { meta = m; } });
  assert.equal(out, 'A lista tem muitos itens e a resposta foi cortada no meio do raciocínio e agora termina aqui.');
  assert.equal(localCalls.length, 2);
  const second = localCalls[1].messages;
  assert.equal(second.at(-1).role, 'user');
  assert.equal(second.at(-1).content, CONTINUE_INSTRUCTION);
  assert.equal(second.at(-2).role, 'assistant');
  assert.equal(second.at(-2).content, A, 'o rascunho precisa ir como turno do assistente');
  assert.ok(second.some((m) => m.role === 'user' && m.content === 'pergunta longa'), 'a pergunta original precisa ir junto');
  assert.ok(localCalls[0].messages[0].content.includes('FERRAMENTAS DISPONÍVEIS'));
  assert.ok(!second[0].content.includes('FERRAMENTAS DISPONÍVEIS'), 'a continuação não leva o bloco de ferramentas');
  assert.deepEqual([meta.provider, meta.continuations, meta.truncated, meta.finishReason], ['local', 1, false, 'stop']);
});
await test('no máximo 2 continuações; se ainda cortada, termina com o aviso honesto', async () => {
  resetLocal([1, 2, 3, 4].map((i) => ({ text: `parte numero ${i} do texto que nunca acaba `, finish: 'length' })));
  let meta = null;
  const out = await generateResponse('pergunta', 'chan-c2', { allowSearch: false, disableTools: true, onMeta: (m) => { meta = m; } });
  assert.equal(localCalls.length, 3, '1 chamada + 2 continuações');
  assert.ok(out.endsWith(`\n\n${TRUNCATION_NOTICE}`));
  assert.equal(TRUNCATION_NOTICE, '(resposta cortada pelo limite do modelo; peça para continuar)');
  assert.ok(out.includes('parte numero 1') && out.includes('parte numero 3') && !out.includes('parte numero 4'));
  assert.deepEqual([meta.continuations, meta.truncated, meta.finishReason], [2, true, 'length']);
});
await test('resposta completa (finish_reason stop) NÃO continua e não leva aviso', async () => {
  resetLocal([{ text: 'Resposta inteira.', finish: 'stop' }]);
  let meta = null;
  const out = await generateResponse('oi', 'chan-c3', { allowSearch: false, disableTools: true, onMeta: (m) => { meta = m; } });
  assert.equal(out, 'Resposta inteira.');
  assert.equal(localCalls.length, 1);
  assert.deepEqual([meta.continuations, meta.truncated, meta.finishReason], [0, false, 'stop']);
});
await test('teto de 8000 caracteres: rascunho já grande não pede continuação; falha da continuação mantém o rascunho com o aviso', async () => {
  resetLocal([{ text: 'palavra '.repeat(1100), finish: 'length' }]);
  const out = await generateResponse('pergunta', 'chan-c4', { allowSearch: false, disableTools: true });
  assert.equal(localCalls.length, 1);
  assert.ok(out.endsWith(TRUNCATION_NOTICE));
  // a continuação falha (erro do provedor): o rascunho segue com o aviso
  let n = 0;
  const old = postHook;
  postHook = (url, body) => { if (url === config.localLlmUrl) { n++; if (n === 2) throw new Error('queda no meio (teste)'); } return old(url, body); };
  resetLocal([{ text: 'texto parcial do começo', finish: 'length' }]);
  const out2 = await generateResponse('pergunta', 'chan-c4b', { allowSearch: false, disableTools: true });
  postHook = old;
  assert.ok(out2.startsWith('texto parcial do começo') && out2.endsWith(TRUNCATION_NOTICE), out2);
});
await test('provedor que não informa o corte (Pollinations) nunca continua; JSON de ferramenta cortado também não', async () => {
  const old = postHook;
  let pol = 0;
  try {
    // o local falha (offline) e só a Pollinations responde: ela não informa o corte, então nunca há continuação
    postHook = (url) => (/pollinations/i.test(url) ? (pol++, { data: 'Resposta da Pollinations.' }) : undefined);
    const out = await generateResponse('oi', 'chan-c5', { allowSearch: false, disableTools: true });
    assert.equal(out, 'Resposta da Pollinations.');
    assert.equal(pol, 1);
  } finally {
    postHook = old;
  }
  resetLocal([{ text: '{"thought":"x","tool":"search_web","args":{"query":"abc', finish: 'length' }]);
  const out2 = await generateResponse('pesquise', 'chan-c5b', { allowSearch: false, disableTools: false });
  assert.equal(localCalls.length, 1, 'JSON de ferramenta cortado não é continuado');
  assert.ok(!out2.includes(TRUNCATION_NOTICE));
});
// ── modo de FERRAMENTAS (LM_STUDIO_API_KEY definida, como em produção): generate_reply via tool_call ──
function sseToolCall(name, argsText, finish = 'tool_calls', model = 'modelo-falso') {
  const chunks = [];
  chunks.push(`data: ${JSON.stringify({ model, choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] })}\n\n`);
  const n = Math.max(1, Math.ceil(argsText.length / 4));
  for (let i = 0; i < argsText.length; i += n) chunks.push(`data: ${JSON.stringify({ model, choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argsText.slice(i, i + n) } }] }, finish_reason: null }] })}\n\n`);
  chunks.push(`data: ${JSON.stringify({ model, choices: [{ delta: {}, finish_reason: finish }] })}\n\n`);
  chunks.push('data: [DONE]\n\n');
  return Readable.from(chunks);
}
await test('recoverReplyContent: JSON válido, cortado no meio do texto, no meio de um escape, após o texto e sem content', () => {
  const full = JSON.stringify({ content: 'Olá, "mundo"\nlinha 2 😀' });
  assert.deepEqual(lr.recoverReplyContent(full), { content: 'Olá, "mundo"\nlinha 2 😀', parsed: true, complete: true });
  assert.deepEqual(lr.recoverReplyContent({ content: 'já objeto' }), { content: 'já objeto', parsed: true, complete: true });
  const mid = lr.recoverReplyContent('{"content":"Primeiro item\\nSegundo it');
  assert.deepEqual(mid, { content: 'Primeiro item\nSegundo it', parsed: false, complete: false });
  assert.equal(lr.recoverReplyContent('{"content":"corte no escape \\').content, 'corte no escape ');
  assert.equal(lr.recoverReplyContent('{"content":"acento \\u00e').content, 'acento ');
  assert.equal(lr.recoverReplyContent('{"content":"emoji \\ud83d').content, 'emoji ');
  assert.equal(lr.recoverReplyContent('{"content":"aspas \\"dentro\\" ok').content, 'aspas "dentro" ok');
  const after = lr.recoverReplyContent('{"content":"texto inteiro","extra":"x');
  assert.deepEqual([after.content, after.parsed, after.complete], ['texto inteiro', false, true]);
  assert.deepEqual(lr.recoverReplyContent('{"outra":"coisa"}'), { content: '', parsed: true, complete: true });
  assert.deepEqual(lr.recoverReplyContent('lixo sem json'), { content: '', parsed: false, complete: false });
  assert.deepEqual(lr.recoverReplyContent(undefined), { content: '', parsed: false, complete: false });
});
await test('MODO DE FERRAMENTAS (LM_STUDIO_API_KEY definida): tool_call generate_reply CORTADO por limite de tokens continua e termina sem o JSON', async () => {
  const oldKey = config.lmStudioApiKey;
  config.lmStudioApiKey = 'chave-falsa-so-para-o-teste';
  const old = postHook;
  try {
    const cutArgs = '{"content":"Lista dos itens:\\n1. primeiro item da lista\\n2. segundo item da li';
    const seen = [];
    let n = 0;
    postHook = (url, body) => {
      if (url !== config.localLlmUrl) return undefined;
      seen.push(body);
      n++;
      if (n === 1) return { data: sseToolCall('generate_reply', cutArgs, 'length') };
      return { data: sse('segundo item da lista\n3. terceiro item.', 'stop') };
    };
    let meta = null;
    const out = await generateResponse('liste os itens', 'chan-tool1', { allowSearch: false, disableTools: false, onMeta: (m) => { meta = m; } });
    assert.ok(!out.includes('Action triggered') && !out.includes('"tool"') && !out.startsWith('{'), `não pode devolver o JSON da ferramenta: ${out}`);
    assert.equal(out, 'Lista dos itens:\n1. primeiro item da lista\n2. segundo item da lista\n3. terceiro item.');
    assert.equal(seen.length, 2, 'pediu a continuação');
    assert.ok(Array.isArray(seen[0].tools) && seen[0].tools.length > 0, 'a 1ª chamada leva as ferramentas');
    assert.ok(!seen[1].tools, 'a continuação não leva ferramentas');
    assert.equal(seen[1].messages.at(-2).role, 'assistant');
    assert.ok(seen[1].messages.at(-2).content.endsWith('2. segundo item da li'), 'o rascunho parcial recuperado vai como turno do assistente');
    assert.deepEqual([meta.continuations, meta.truncated], [1, false]);

    // sempre cortada: termina com o aviso honesto (nunca com o JSON)
    n = 0;
    seen.length = 0;
    postHook = (url, body) => {
      if (url !== config.localLlmUrl) return undefined;
      seen.push(body);
      n++;
      return { data: n === 1 ? sseToolCall('generate_reply', '{"content":"parte um sem fim ', 'length') : sse(`mais parte ${n} sem fim `, 'length') };
    };
    const out2 = await generateResponse('liste', 'chan-tool2', { allowSearch: false, disableTools: false });
    assert.ok(out2.startsWith('parte um sem fim') && out2.endsWith(TRUNCATION_NOTICE), out2);
    assert.equal(seen.length, 3, '1 chamada + 2 continuações');

    // resposta completa em tool_call: devolve o texto, sem continuar e sem aviso
    seen.length = 0;
    postHook = (url, body) => { if (url !== config.localLlmUrl) return undefined; seen.push(body); return { data: sseToolCall('generate_reply', JSON.stringify({ content: 'Resposta inteira via ferramenta.' }), 'tool_calls') }; };
    const out3 = await generateResponse('oi', 'chan-tool3', { allowSearch: false, disableTools: false });
    assert.equal(out3, 'Resposta inteira via ferramenta.');
    assert.equal(seen.length, 1);

    // texto completo e só as chaves do JSON cortadas: a resposta está inteira (sem continuação, sem aviso)
    seen.length = 0;
    postHook = (url, body) => { if (url !== config.localLlmUrl) return undefined; seen.push(body); return { data: sseToolCall('generate_reply', '{"content":"Texto completo","thought":"abc', 'length') }; };
    const out4 = await generateResponse('oi', 'chan-tool4', { allowSearch: false, disableTools: false });
    assert.equal(out4, 'Texto completo');
    assert.equal(seen.length, 1);

    // outra ferramenta continua saindo como JSON de ferramenta (o fluxo normal executa)
    postHook = (url) => (url === config.localLlmUrl ? { data: sseToolCall('search_web', JSON.stringify({ query: 'abc' })) } : undefined);
    const out5 = await generateResponse('pesquise abc', 'chan-tool5', { allowSearch: false, disableTools: false });
    assert.equal(JSON.parse(out5.match(/\{[\s\S]*\}/)[0]).tool, 'search_web');
  } finally {
    config.lmStudioApiKey = oldKey;
    postHook = old;
  }
});
await test('Gemini com tool_call generate_reply cortado (finish_reason length): recupera o texto parcial e continua', async () => {
  const old = postHook;
  process.env.GEMINI_API_KEY = 'AIzaFAKEKEYFAKEKEYFAKEKEY123456';
  try {
    const seen = [];
    postHook = (url, body) => {
      if (url !== config.geminiUrl) return undefined;
      seen.push(body);
      if (seen.length === 1) return { data: { choices: [{ message: { content: null, tool_calls: [{ function: { name: 'generate_reply', arguments: '{"content":"começo do texto da ferra' } }] }, finish_reason: 'length' }] } };
      return { data: { choices: [{ message: { content: 'texto da ferramenta e o fim.' }, finish_reason: 'stop' }] } };
    };
    const out = await generateResponse('pergunta', 'chan-gtool', { allowSearch: false, disableTools: false });
    assert.equal(seen.length, 2);
    assert.ok(out.includes('começo do texto da ferra') && out.includes('e o fim.') && !out.includes('"tool"') && !out.includes(TRUNCATION_NOTICE), out);
  } finally {
    delete process.env.GEMINI_API_KEY;
    postHook = old;
  }
});
await test('Gemini (endpoint OpenAI-compatível), Groq e Hugging Face: lê choices[0].finish_reason e continua', async () => {
  const old = postHook;
  const table = [
    ['gemini', () => config.geminiUrl, { GEMINI_API_KEY: 'AIzaFAKEKEYFAKEKEYFAKEKEY123456' }],
    ['groq', () => config.groqApiUrl, { GROQ_API_KEY: 'gsk_chave_falsa_so_para_o_teste_1234567890' }],
    ['hf', () => config.hfApiUrl, {}],
  ];
  try {
    for (const [name, urlOf, env] of table) {
      Object.assign(process.env, env);
      const seen = [];
      postHook = (url, body) => {
        if (url !== urlOf()) return undefined;
        seen.push(body);
        const first = seen.length === 1;
        return { data: { choices: [{ message: { content: first ? 'começo do texto do provedor' : 'texto do provedor e o fim.' }, finish_reason: first ? 'length' : 'stop' }] } };
      };
      let out;
      try {
        out = await generateResponse('pergunta', `chan-${name}`, { allowSearch: false, disableTools: true });
      } finally {
        for (const k of Object.keys(env)) delete process.env[k];
      }
      assert.equal(seen.length, 2, `${name}: deveria ter pedido a continuação`);
      // a emenda tira a sobreposição ("texto do provedor") que o modelo repetiu
      assert.equal(out, 'começo do texto do provedor e o fim.', name);
      assert.equal(seen[1].messages.at(-2).content, 'começo do texto do provedor');
    }
  } finally {
    postHook = old;
  }
});
await test('Gateway em processo: o finish_reason do roteador chega à cadeia e dispara a continuação (e o x_gateway avisa só quando cortou)', async () => {
  const gw = await import('../src/gateway/index.js');
  const { createRouter } = await import('../src/gateway/router.js');
  const mk = (finish) => ({ status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'oi' }, finish_reason: finish }] }), headers: { get: () => null }, ok: true });
  const router = createRouter({ providers: [{ id: 'p', label: 'P', priority: 1, endpoint: 'https://p.test/v1/chat/completions', keys: ['chave-falsa-0000001'], headers: {}, models: [{ id: 'm', tier: 'smart' }] }], fetchImpl: async () => mk('length') });
  const cut = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(cut.x_gateway.truncated, true);
  const router2 = createRouter({ providers: [{ id: 'p', label: 'P', priority: 1, endpoint: 'https://p.test/v1/chat/completions', keys: ['chave-falsa-0000001'], headers: {}, models: [{ id: 'm', tier: 'smart' }] }], fetchImpl: async () => mk('stop') });
  const ok = await router2.chat({ model: 'auto', messages: [{ role: 'user', content: 'x' }] });
  assert.ok(!('truncated' in ok.x_gateway) && !('finish_reason' in ok.x_gateway), 'sem o campo extra quando não cortou');
  // cadeia real: LM Studio falha, o gateway (Groq falso via fetch) responde cortado e depois completa
  const savedHook = postHook;
  postHook = null; // o LM Studio (local) fica fora do ar: quem responde é o gateway
  process.env.YUI_GATEWAY_IN_CHAIN = 'true';
  process.env.GROQ_API_KEY = 'gsk_chave_falsa_so_para_o_teste_1234567890';
  process.env.YUI_GATEWAY_DISABLE = 'pollinations';
  gw.resetGateway();
  const bodies = [];
  fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const first = bodies.length === 1;
    return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: first ? 'início pelo gateway' : 'fim pelo gateway.' }, finish_reason: first ? 'length' : 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const out = await generateResponse('pergunta', 'chan-gw', { allowSearch: false, disableTools: true });
    assert.equal(out, 'início pelo gateway fim pelo gateway.');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1].messages.at(-2).content, 'início pelo gateway');
  } finally {
    postHook = savedHook;
    process.env.YUI_GATEWAY_IN_CHAIN = 'false';
    delete process.env.GROQ_API_KEY;
    delete process.env.YUI_GATEWAY_DISABLE;
    gw.resetGateway();
    fetchImpl = async () => { throw new Error('offline (teste)'); };
  }
});
await test('YUI_REPLY_MAX_TOKENS: override opcional do max_tokens (Horde limitado a 512); sem a variável nada muda', async () => {
  const settings = llm.getProviderSettings();
  const snapshot = JSON.parse(JSON.stringify(settings));
  assert.equal(llm.applyReplyMaxTokensEnv({}), false);
  assert.deepEqual(JSON.parse(JSON.stringify(settings)), snapshot);
  assert.equal(llm.applyReplyMaxTokensEnv({ YUI_REPLY_MAX_TOKENS: 'abc' }), false);
  try {
    assert.equal(llm.applyReplyMaxTokensEnv({ YUI_REPLY_MAX_TOKENS: '3000' }), true);
    for (const [name, s] of Object.entries(settings)) assert.equal(s.max_tokens, name === 'horde' ? 512 : 3000, name);
    resetLocal([{ text: 'ok', finish: 'stop' }]);
    await generateResponse('oi', 'chan-mt', { allowSearch: false, disableTools: true });
    assert.equal(localCalls[0].max_tokens, 3000);
  } finally {
    for (const [name, s] of Object.entries(snapshot)) Object.assign(settings[name], s);
  }
  assert.equal(snapshot.local.max_tokens, 1024, 'os padrões atuais não mudaram');
});
await test('o prompt de sistema traz a regra de listas longas e de não prometer; persona (.md e persona.js) também', async () => {
  resetLocal([{ text: 'ok', finish: 'stop' }]);
  await generateResponse('oi', 'chan-sys', { allowSearch: false, disableTools: true });
  const sys = localCalls[0].messages[0].content;
  assert.ok(sys.includes('Parte N de M') && /COMPLETO/.test(sys) && /não envia DM, não agenda avisos/.test(sys), 'regra ausente no prompt de sistema');
  const md = read('persona/yui-publica.md');
  assert.ok(/COMPLETO/.test(md) && md.includes('Parte N de M') && /não manda DM/.test(md));
  const persona = await import('../src/core/persona.js');
  const { buildContext } = await import('../src/core/permissions.js');
  const owner = persona.buildPersonaPrompt(buildContext({ platform: 'discord', userId: '111', isDM: true }));
  const member = persona.buildPersonaPrompt(buildContext({ platform: 'api', userId: '222', isDM: true }));
  for (const p of [owner, member]) assert.ok(/Parte N de M/.test(p) && /não envia DM/.test(p) && /COMPLETO/.test(p));
  assert.ok(read('src/core/persona.js').includes('Parte N de M'));
});
await test('stripThinking: "Mod(1.20)" e "Ovos(12 unidades)" ficam; chamadas de ferramenta conhecidas ainda são removidas', () => {
  assert.equal(stripThinking('Mod(1.20)'), 'Mod(1.20)');
  assert.equal(stripThinking('Instale o Mod(1.20) e depois compre Ovos(12 unidades) no mercado.'), 'Instale o Mod(1.20) e depois compre Ovos(12 unidades) no mercado.');
  assert.equal(stripThinking('Preço(R$ 10) e Total(R$ 20)'), 'Preço(R$ 10) e Total(R$ 20)');
  assert.equal(stripThinking('search_web(query="gta")'), '');
  assert.equal(stripThinking('Claro! search_web(query="gta") resto'), 'Claro!  resto');
  assert.equal(stripThinking('tool_code\nprint(default_api.coisa_desconhecida(x=1))'), '');
  assert.equal(stripThinking('radio_next_track()'), '');
});

// ── processQueue de verdade ─────────────────────────────────────────────────────────────────────
function fakeSlashFull({ userId = '222', channelId, guildId = 'g1', ephemeral = false, failEdit = false } = {}) {
  const i = {
    user: { id: userId, tag: `user${userId}#0001` }, channelId, guildId,
    guild: guildId ? { id: guildId, name: 'Servidor Teste' } : null,
    channel: { id: channelId, name: 'geral', send: async (p) => { i.sends.push(p); return { id: `s${i.sends.length}`, channel: i.channel }; } },
    deferred: true, replied: false, ephemeral, createdTimestamp: Date.now(),
    replies: [], followUps: [], sends: [],
    async deferReply() {},
    // 403/50013: erro sem plano B (um 5xx/10008 reenviaria o texto como mensagem nova; isso é testado em test-longreply-limits.js)
    async editReply(p) { if (failEdit && !String(p.content).includes('Processando')) throw discordError(403, 50013, 'falha forçada'); this.replies.push(p); return { id: 'm1', channel: this.channel }; },
    async followUp(p) { this.followUps.push(p); return { id: `f${this.followUps.length}`, channel: this.channel }; },
    async reply(p) { this.replies.push(p); return { id: 'm1', channel: this.channel }; },
  };
  return i;
}
async function runQueue(prompt, interaction, options, done) {
  await llm.addToQueue(prompt, interaction, 'slash', options);
  const ok = await waitFor(done, 30000);
  await sleep(120);
  assert.ok(ok, `a fila não terminou (respostas: ${JSON.stringify(interaction.replies.map((r) => String(r.content ?? '').slice(0, 40)))})`);
}
const historyOf = async (channelId) => {
  resetLocal([{ text: 'ok', finish: 'stop' }]);
  await generateResponse('próxima', channelId, { allowSearch: false, disableTools: true });
  return (localCalls[0]?.messages ?? []).slice(1, -1);
};
const allContents = (i) => [...i.replies.filter((r) => !String(r.content ?? '').includes('Processando')), ...i.followUps].map((r) => r.content);

await test('FILA: resposta de ~3500 caracteres chega INTEIRA (editReply + followUps, cada uma <= 2000), sem corte nem "Processando..." preso', async () => {
  const list = ['Aqui vai a lista:', '', ...listLines(74)].join('\n');
  assert.ok(list.length > 3000);
  resetLocal([{ text: list, finish: 'stop' }]);
  const i = fakeSlashFull({ channelId: 'chan-q1' });
  await runQueue('lista de mods', i, { allowSearch: false, disableTools: true, searchPrompt: 'lista de mods' }, () => i.followUps.length >= 1 && /parte (\d+)\/\1$/.test(i.followUps.at(-1).content ?? ''));
  const contents = allContents(i);
  assert.ok(contents.every((c) => c.length <= DISCORD_LIMIT));
  assert.ok(!contents.some((c) => c.includes('Processando')));
  const nums = [...contents.map(stripMarker).join('\n').matchAll(/^(\d+)\. \[Mod número/gm)].map((m) => Number(m[1]));
  assert.deepEqual(nums, Array.from({ length: 74 }, (_, k) => k + 1), 'faltou item ou saiu fora de ordem');
  assert.equal(i.sends.length, 0, 'slash público usa followUp, não channel.send');
});
await test('FILA: o histórico do canal só recebe a resposta DEPOIS da entrega, em cópia aparada (nunca o texto inteiro)', async () => {
  const big = listLines(120).join('\n'); // ~11k caracteres: 6 partes > 4 => introdução + anexo
  assert.ok(big.length > 7600);
  resetLocal([{ text: big, finish: 'stop' }]);
  const i = fakeSlashFull({ channelId: 'chan-q2' });
  await runQueue('lista enorme', i, { allowSearch: false, disableTools: true, searchPrompt: 'lista enorme' }, () => i.replies.some((r) => r.files?.length));
  const att = i.replies.find((r) => r.files?.length);
  assert.equal(att.files[0].attachment.toString('utf8').includes('120. [Mod número 120]'), true, 'o anexo precisa ter a lista completa');
  assert.ok(att.content.length <= DISCORD_LIMIT);
  const hist = await historyOf('chan-q2');
  const assistant = hist.find((m) => m.role === 'assistant');
  assert.ok(assistant, 'a resposta entregue deveria estar no histórico');
  assert.ok(assistant.content.length < 1500, `histórico com ${assistant.content.length} caracteres`);
  assert.ok(!assistant.content.includes('120. [Mod número 120]'));
});
await test('FILA: se o envio FALHA, o histórico guarda "erro da ia" (e não a resposta que ninguém recebeu)', async () => {
  resetLocal([{ text: 'Resposta que não chega.', finish: 'stop' }]);
  const i = fakeSlashFull({ channelId: 'chan-q3', failEdit: true });
  await llm.addToQueue('uma pergunta qualquer', i, 'slash', { allowSearch: false, disableTools: true, searchPrompt: 'uma pergunta qualquer' });
  await waitFor(() => localCalls.length >= 1, 10000);
  await sleep(500);
  const hist = await historyOf('chan-q3');
  const contents = hist.filter((m) => m.role === 'assistant').map((m) => m.content);
  assert.deepEqual(contents, ['erro da ia']);
});
await test('FILA: "Mod(1.20)" no fim da resposta continua sendo texto (não vira ferramenta nem "Erro de Processamento")', async () => {
  resetLocal([{ text: 'Para o servidor use o Mod(1.20)', finish: 'stop' }]);
  const i = fakeSlashFull({ channelId: 'chan-q4' });
  await runQueue('qual mod?', i, { allowSearch: false, disableTools: false, searchPrompt: 'qual mod?' }, () => i.replies.some((r) => /Mod\(1\.20\)/.test(r.content ?? '')));
  assert.ok(!i.replies.some((r) => /Erro de Processamento/.test(r.content ?? '')));
});
await test('FILA: promessa de ação futura leva o aviso fixo; se o código gravou a memória, a promessa vale e não leva', async () => {
  resetLocal([{ text: 'Anotei a sua lista, depois te aviso!', finish: 'stop' }]);
  const i = fakeSlashFull({ channelId: 'chan-q5' });
  await runQueue('anota essa lista pra mim', i, { allowSearch: false, disableTools: true, searchPrompt: 'anota essa lista pra mim' }, () => i.replies.some((r) => /Anotei/.test(r.content ?? '')));
  assert.ok(i.replies.some((r) => (r.content ?? '').includes(PROMISE_NOTICE)), 'faltou o aviso fixo');
  core.memory.forgetAll(anaCtx);
  resetLocal([{ text: 'Anotei! Vou lembrar disso.', finish: 'stop' }]);
  const j = fakeSlashFull({ channelId: 'chan-q6' });
  await runQueue('lembra que eu gosto de Sultan RS', j, { allowSearch: false, disableTools: true, searchPrompt: 'lembra que eu gosto de Sultan RS' }, () => j.replies.some((r) => /Anotei/.test(r.content ?? '')));
  assert.ok(!j.replies.some((r) => (r.content ?? '').includes(PROMISE_NOTICE)), 'a memória foi gravada de verdade: sem aviso');
  core.memory.forgetAll(anaCtx);
});
await test('FILA: ANTI-ECO não descarta resposta a mensagem longa nem a pedido de lista; continua valendo para eco curto', async () => {
  const longUser = `Quero organizar esta lista de compras que eu colei aqui: ${'ovos, leite, pão, queijo, presunto, café, açúcar, '.repeat(6)}`;
  assert.ok(longUser.length > 200);
  const echo = (u) => `${u.slice(0, 60)} ... aqui está a lista organizada.`;
  resetLocal([{ text: echo(longUser), finish: 'stop' }]);
  const a = fakeSlashFull({ channelId: 'chan-q7' });
  await runQueue(longUser, a, { allowSearch: false, disableTools: true, searchPrompt: longUser }, () => a.replies.some((r) => /lista organizada/.test(r.content ?? '')));
  assert.equal(localCalls.length, 1, 'ANTI-ECO regenerou a resposta de uma mensagem longa');
  const listReq = 'liste os modos de jogo do GTA Online';
  resetLocal([{ text: echo(listReq), finish: 'stop' }]);
  const b = fakeSlashFull({ channelId: 'chan-q8' });
  await runQueue(listReq, b, { allowSearch: false, disableTools: true, searchPrompt: listReq }, () => b.replies.some((r) => /lista organizada/.test(r.content ?? '')));
  assert.equal(localCalls.length, 1, 'ANTI-ECO regenerou a resposta de um pedido de lista');
  const shortUser = 'qual a capital da frança hoje';
  resetLocal([{ text: `${shortUser} é Paris, claro.`, finish: 'stop' }, { text: 'É Paris.', finish: 'stop' }]);
  const c = fakeSlashFull({ channelId: 'chan-q9' });
  await runQueue(shortUser, c, { allowSearch: false, disableTools: true, searchPrompt: shortUser }, () => c.replies.some((r) => /É Paris\./.test(r.content ?? '')));
  assert.equal(localCalls.length, 2, 'o eco curto deveria continuar sendo regenerado');
});
await test('FILA (menção): a mensagem "Processando..." é EDITADA com a parte 1 e as demais saem por channel.send em resposta à anterior', async () => {
  await sleep(1200); // deixa a fila ociosa (o processQueue só libera 1 s depois do item anterior)
  const list = ['Lista:', ...listLines(74)].join('\n');
  resetLocal([{ text: list, finish: 'stop' }]);
  const w = makeWorld({ delay: () => 5 });
  await llm.addToQueue('lista de mods', w.message, 'mention', { allowSearch: false, disableTools: true, searchPrompt: 'lista de mods', guildId: 'g1' });
  const lastIsFinal = () => { const s = w.ops('send').at(-1); return Boolean(s) && /parte (\d+)\/\1$/.test(s.payload.content ?? ''); };
  assert.ok(await waitFor(lastIsFinal, 30000), 'as partes não chegaram');
  await sleep(100);
  const names = w.timeline.map((t) => t.name);
  assert.deepEqual(names.slice(0, 2), ['reply', 'edit'], '1º o "Processando...", depois a parte 1 EDITANDO essa mensagem');
  assert.ok(names.slice(2).every((n) => n === 'send') && names.length >= 4);
  assert.match(w.timeline[0].payload.content, /Processando/);
  assert.match(w.timeline[1].payload.content, /^Lista:[\s\S]*-# parte 1\/\d+$/);
  w.ops('send').forEach((t) => {
    const prev = w.timeline[w.timeline.indexOf(t) - 1];
    assert.equal(t.payload.reply.messageReference.id, `${prev.name}-${prev.n}`, 'cada parte responde à anterior');
    assert.ok(t.payload.flags & MessageFlags.SuppressNotifications);
    assert.equal(t.payload.allowedMentions, SAFE_ALLOWED_MENTIONS);
  });
  assert.equal(w.maxInFlight, 1, 'houve envio em paralelo');
  const nums = [...w.timeline.slice(1).map((t) => stripMarker(t.payload.content)).join('\n').matchAll(/^(\d+)\. \[Mod número/gm)].map((m) => Number(m[1]));
  assert.deepEqual(nums, Array.from({ length: 74 }, (_, k) => k + 1));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('F. Requisitos nas fontes');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const llmSrc = read('src/handlers/llmHandler.js');
await test('sem os cortes silenciosos de 3900 (llmHandler) e de 1900 (/yui); o envio usa o divisor', () => {
  assert.ok(!/3900 - footer/.test(llmSrc) && !/\[TRUNCATE\]/.test(llmSrc), 'o corte de 3900 ainda existe');
  const ask = read('src/discord/commands/ask.js');
  assert.ok(!/slice\(0,\s*1900\)/.test(ask), 'o corte de 1900 ainda existe');
  assert.ok(ask.includes('sendLongReply(') && /allowedMentions:\s*SAFE_ALLOWED_MENTIONS/.test(ask));
  assert.ok(llmSrc.includes('createUnifiedReply(') && !/const unifiedReply = async/.test(llmSrc));
});
await test('histórico: a resposta só entra depois da entrega (addToHistory do assistente fica DEPOIS do unifiedReply final)', () => {
  const i = llmSrc.indexOf('await unifiedReply(processedResponse);');
  const j = llmSrc.indexOf("addToHistory(channelId, 'assistant', delivery.ok ? historyCopy(");
  assert.ok(i > 0 && j > i, 'o histórico precisa vir depois da entrega');
  assert.ok(!/addToHistory\(channelId, 'assistant', cleanResponseForHistory\)/.test(llmSrc));
});
await test('messageCreate usa o corte de contexto novo nos DOIS pontos (respondida/última do autor até 4000; demais 500)', () => {
  const src = read('src/events/messageCreate.js');
  assert.equal(count(src, 'clipContextText('), 2);
  assert.ok(!/content\.length > 500/.test(src));
  assert.ok(src.includes('longContextIds('));
});
await test('as variáveis novas estão documentadas no código (YUI_REPLY_MAX_PARTS e YUI_REPLY_MAX_TOKENS)', () => {
  assert.ok(read('src/discord/longReply.js').includes('YUI_REPLY_MAX_PARTS'));
  assert.ok(llmSrc.includes('YUI_REPLY_MAX_TOKENS'));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('G. Entrega final (itens 4 e 19 do plano da pesquisa): nova tentativa, plano B e aviso de partes perdidas');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const { STALE_REPLY_TEXT, DELIVERY_FAILED_TEXT } = lr;
/** createUnifiedReply de menção sobre o mundo falso, com o "Processando..." (replyMessage) já existente. */
const mentionReply = (w, extra = {}) => {
  const state = { rm: w.replyMessage, errors: [], logger: makeLogger() };
  const reply = createUnifiedReply({
    interaction: w.message, type: 'mention', userId: 'u1',
    getReplyMessage: () => state.rm, setReplyMessage: (m) => { state.rm = m; },
    onError: (e) => state.errors.push(e), logger: state.logger, deps: noWait, ...extra,
  });
  return { reply, state };
};

await test('Q30: a edição final falha com 404 (Unknown Message): o MESMO texto sai por channel.send, sem repetir a edição nem apagar o que já sumiu', async () => {
  const w = makeWorld({ canDelete: true, fail: { edit: [discordError(404, 10008, 'Unknown Message')] } });
  const { reply, state } = mentionReply(w);
  const out = await reply('Resposta final.');
  assert.ok(out);
  assert.deepEqual(w.timeline.map((t) => t.name), ['edit', 'send']);
  assert.equal(w.ops('send')[0].payload.content, 'Resposta final.');
  assert.equal(w.ops('send')[0].payload.reply.messageReference, w.message);
  assert.equal(state.rm, out, 'as próximas edições vão para a mensagem que existe');
  const d = reply.lastDelivery;
  assert.deepEqual([d.ok, d.mode, d.parts, d.sentParts, d.degraded, d.retried], [true, 'single', 1, 1, true, undefined]);
  assert.equal(state.errors.length, 1);
});
await test('Q30: a edição final falha UMA vez com 503: a nova tentativa edita a MESMA mensagem (nada de mensagem duplicada)', async () => {
  const w = makeWorld({ canDelete: true, fail: { edit: [discordError(503)] } });
  const { reply, state } = mentionReply(w);
  const out = await reply('Resposta final.');
  assert.equal(out, state.rm);
  assert.deepEqual(w.timeline.map((t) => t.name), ['edit', 'edit']);
  assert.equal(w.timeline[0].payload.content, 'Resposta final.');
  assert.equal(w.timeline[1].payload.content, 'Resposta final.');
  assert.deepEqual([reply.lastDelivery.ok, reply.lastDelivery.retried, reply.lastDelivery.degraded], [true, 1, undefined]);
  assert.equal(state.errors.length, 0, 'onError só quando a entrega falha de vez');
  assert.ok(state.logger.logs.warn.some((l) => /status=503/.test(l) && /repetindo uma vez/.test(l)));
  assert.ok(![...state.logger.logs.warn, ...state.logger.logs.error].some((l) => l.includes('Resposta final')), 'o log não recebe o conteúdo');
});
await test('Q30: 503 nas duas tentativas: o texto vai como mensagem nova e a mensagem de progresso antiga é APAGADA (nunca fica como estado final)', async () => {
  const w = makeWorld({ canDelete: true, fail: { edit: [discordError(503), discordError(502)] } });
  const { reply, state } = mentionReply(w);
  const out = await reply('Resposta final.');
  assert.ok(out);
  assert.deepEqual(w.timeline.map((t) => t.name), ['edit', 'edit', 'send', 'delete']);
  assert.equal(state.rm, out);
  assert.equal(state.errors.length, 1);
  assert.equal(state.errors[0].status, 502, 'onError recebe o erro final');
  assert.deepEqual([reply.lastDelivery.ok, reply.lastDelivery.degraded, reply.lastDelivery.retried], [true, true, 1]);
});
await test('Q30: alvo que sumiu sem código no corpo (404 puro, 10015): a edição final cai no plano B sem repetir e sem tentar apagar', async () => {
  for (const err of [discordError(404), discordError(404, 10015, 'Unknown Webhook')]) {
    const w = makeWorld({ canDelete: true, fail: { edit: [err] } });
    const { reply, state } = mentionReply(w);
    assert.ok(await reply('Resposta final.'), `${err.status}/${err.code}`);
    assert.deepEqual(w.timeline.map((t) => t.name), ['edit', 'send'], `${err.status}/${err.code}`);
    assert.equal(reply.lastDelivery.degraded, true);
    assert.equal(state.errors.length, 1);
  }
  assert.equal(lr.isRecoverableEditError(discordError(404)), false, 'o plano B restrito de isRecoverableEditError não mudou');
});
await test('Q30: se não der para apagar a mensagem de progresso antiga, ela vira uma linha neutra (a resposta está abaixo)', async () => {
  const w = makeWorld({ canDelete: true, fail: { edit: [discordError(503), discordError(503)], delete: [discordError(500)] } });
  const { reply } = mentionReply(w);
  assert.ok(await reply('Resposta final.'));
  assert.deepEqual(w.timeline.map((t) => t.name), ['edit', 'edit', 'send', 'delete', 'edit']);
  const last = w.timeline.at(-1).payload;
  assert.equal(last.content, STALE_REPLY_TEXT);
  assert.deepEqual([last.files, last.components, last.embeds], [[], [], []]);
});
await test('uma edição que PENDURA não prende a fila: o prazo a abandona e a nova tentativa entrega; se a abandonada ainda completar na folga, nada se repete', async () => {
  const w = makeWorld();
  let calls = 0;
  const hanging = { ...w.replyMessage, edit: (p) => { calls++; return calls === 1 ? new Promise(() => {}) : w.replyMessage.edit(p); } };
  const t0 = Date.now();
  const reply = createUnifiedReply({ interaction: w.message, type: 'mention', userId: 'u1', getReplyMessage: () => hanging, limits: { editTimeoutMs: 40 }, deps: { ...noWait, lateGraceMs: 10 }, logger: makeLogger() });
  assert.ok(await reply('Resposta final.'));
  assert.equal(calls, 2);
  assert.ok(Date.now() - t0 < 2000, 'a fila ficou presa');
  assert.equal(reply.lastDelivery.retried, 1);
  // lenta, mas completa dentro da folga: a edição JÁ saiu e repetir seria redundante
  const w2 = makeWorld();
  let calls2 = 0;
  const slow = { ...w2.replyMessage, edit: (p) => { calls2++; return sleep(120).then(() => w2.replyMessage.edit(p)); } };
  const reply2 = createUnifiedReply({ interaction: w2.message, type: 'mention', userId: 'u1', getReplyMessage: () => slow, limits: { editTimeoutMs: 30 }, deps: { retryDelayMs: 0, lateGraceMs: 2000 }, logger: makeLogger() });
  assert.ok(await reply2('Resposta final.'));
  assert.equal(calls2, 1, 'repetiu uma edição que já tinha saído');
  assert.equal(w2.ops('edit').length, 1);
  assert.equal(reply2.lastDelivery.retried, undefined);
});
await test('a edição que pendura nas duas tentativas cai no plano B (mensagem nova) e a antiga é apagada', async () => {
  const w = makeWorld({ canDelete: true });
  const dead = { ...w.replyMessage, edit: () => new Promise(() => {}) };
  let rm = dead;
  const reply = createUnifiedReply({ interaction: w.message, type: 'mention', userId: 'u1', getReplyMessage: () => rm, setReplyMessage: (m) => { rm = m; }, limits: { editTimeoutMs: 30 }, deps: { ...noWait, lateGraceMs: 10 }, logger: makeLogger() });
  const out = await reply('Resposta final.');
  assert.ok(out);
  assert.deepEqual(w.timeline.map((t) => t.name), ['send', 'delete']);
  assert.equal(reply.lastDelivery.degraded, true);
});
await test('edição com ARQUIVO não é repetida (um upload não se repete nem tem prazo curto): vai direto ao plano B', async () => {
  const w = makeWorld({ canDelete: true, fail: { edit: [discordError(503)] } });
  const { reply } = mentionReply(w);
  const files = [new AttachmentBuilder(Buffer.from('x'), { name: 'a.txt' })];
  assert.ok(await reply('Aqui está o arquivo.', files));
  assert.deepEqual(w.timeline.map((t) => t.name), ['edit', 'send', 'delete']);
  assert.equal(w.ops('send')[0].payload.files, files);
});
await test('erro permanente (50035, 50013): sem nova tentativa e sem plano B; o "Processando..." vira o aviso de falha e lastDelivery diz que NÃO entregou', async () => {
  for (const err of [discordError(400, 50035), discordError(403, 50013)]) {
    const w = makeWorld({ fail: { edit: [err] } });
    const { reply, state } = mentionReply(w);
    assert.equal(await reply('Resposta que o Discord recusa'), null);
    assert.deepEqual(w.timeline.map((t) => t.name), ['edit', 'edit'], `${err.status}/${err.code}`);
    const notice = w.timeline[1].payload;
    assert.equal(notice.content, DELIVERY_FAILED_TEXT);
    assert.deepEqual([notice.files, notice.components, notice.embeds], [[], [], []]);
    assert.deepEqual([reply.lastDelivery.ok, reply.lastDelivery.noticed], [false, true]);
    assert.equal(state.errors.length, 1);
  }
});
await test('mensagem de PROGRESSO ("Processando...") não é repetida nem vira aviso; mensagem que já sumiu (10008) tampouco', async () => {
  const w = makeWorld({ fail: { edit: () => discordError(503) } });
  const { reply } = mentionReply(w);
  assert.equal(await reply('🧠 **Processando...**'), null);
  assert.deepEqual(w.timeline.map((t) => t.name), ['edit']);
  const w2 = makeWorld({ fail: { edit: () => discordError(404, 10008) } });
  const { reply: r2 } = mentionReply(w2, { radioMode: true });
  assert.equal(await r2('rádio nunca repete'), null);
  assert.deepEqual(w2.timeline.map((t) => t.name), ['edit']);
});
await test('slash público: 503 uma vez = nova tentativa no editReply; 503 duas vezes = followUp e o "pensando..." original é apagado (deleteReply)', async () => {
  const a = makeWorld({ canDelete: true, fail: { editReply: [discordError(503)] } });
  const ra = createUnifiedReply({ interaction: a.slash, type: 'slash', userId: 'u1', deps: noWait, logger: makeLogger() });
  assert.ok(await ra('Resposta A'));
  assert.deepEqual(a.timeline.map((t) => t.name), ['editReply', 'editReply']);
  const b = makeWorld({ canDelete: true, fail: { editReply: [discordError(503), discordError(503)] } });
  const rb = createUnifiedReply({ interaction: b.slash, type: 'slash', userId: 'u1', deps: noWait, logger: makeLogger() });
  assert.ok(await rb('Resposta B'));
  assert.deepEqual(b.timeline.map((t) => t.name), ['editReply', 'editReply', 'followUp', 'deleteReply']);
  assert.equal(rb.lastDelivery.degraded, true);
  // efêmera: nada de followUp nem de apagar (o conteúdo é privado), só a nova tentativa
  const c = makeWorld({ canDelete: true, ephemeral: true, fail: { editReply: [discordError(503), discordError(503)] } });
  const rc = createUnifiedReply({ interaction: c.slash, type: 'slash', userId: 'u1', deps: noWait, logger: makeLogger() });
  assert.equal(await rc('Segredo'), null);
  assert.ok(c.timeline.every((t) => t.name === 'editReply'));
});
await test('plano B de uma resposta LONGA: a parte 1 sai como mensagem nova, a de "Processando..." é apagada e quem guarda a mensagem passa para a nova', async () => {
  const w = makeWorld({ canDelete: true, fail: { edit: [discordError(503), discordError(503)] } });
  const { reply, state } = mentionReply(w);
  const out = await reply(`${bodyOf(80)}\n${FOOT}`);
  assert.ok(out);
  const names = w.timeline.map((t) => t.name);
  assert.deepEqual(names.slice(0, 4), ['edit', 'edit', 'send', 'delete']);
  assert.ok(names.slice(4).every((n) => n === 'send'));
  assert.equal(reply.lastDelivery.firstReplaced, true);
  assert.equal(state.rm.id, `send-${w.timeline[2].n}`, 'as próximas edições vão para a mensagem nova');
  const direct = makeWorld({ canDelete: true, fail: { edit: [discordError(404, 10008)] } });
  const res = await sendLongReply({ kind: 'mention', interaction: direct.message, replyMessage: direct.replyMessage, text: bodyOf(80), logger: makeLogger(), ...noWait });
  assert.equal(res.firstReplaced, true);
  assert.equal(direct.ops('delete').length, 0, 'mensagem apagada (10008): nada a apagar');
});

await test('Q31: channel.send das partes 2+ falha sempre (H3): o aviso é EDITADO na parte 1, a entrega é parcial (ok false) e nada vaza no log', async () => {
  const w = makeWorld({ fail: { send: () => discordError(403, 50013) } });
  const logger = makeLogger();
  const text = `${bodyOf(80)}\n${FOOT}`;
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text, logger, ...noWait });
  assert.deepEqual([res.ok, res.partial, res.degraded, res.mode, res.sentParts], [false, true, true, 'split', 1]);
  assert.ok(res.parts >= 3);
  const edits = w.ops('edit');
  assert.equal(edits.length, 2, 'a parte 1 e depois o aviso');
  const first = edits[0].payload.content;
  const notice = edits[1].payload.content;
  assert.ok(notice.startsWith(stripMarker(first)), 'o texto da parte 1 continua inteiro');
  assert.match(notice, new RegExp(`-# parte 1/${res.parts} · ⚠️ Não consegui enviar as partes 2 a ${res.parts}\.`));
  assert.ok(notice.length <= DISCORD_LIMIT);
  assert.equal(edits[1].payload.allowedMentions, SAFE_ALLOWED_MENTIONS);
  assert.ok(![...logger.logs.info, ...logger.logs.warn, ...logger.logs.error].some((l) => l.includes('Mod número')), 'o log recebeu o conteúdo');
});
await test('Q31: pelo createUnifiedReply (o caminho do llmHandler) a entrega parcial devolve null, lastDelivery.ok=false/partial=true e o log diz "parcial=sim"', async () => {
  const w = makeWorld({ fail: { send: () => discordError(403, 50013) } });
  const { reply } = mentionReply(w);
  assert.equal(await reply(`${bodyOf(80)}\n${FOOT}`), null);
  const d = reply.lastDelivery;
  assert.deepEqual([d.ok, d.partial, d.sentParts < d.parts], [false, true, true]);
  const line = formatDeliveryLog(d);
  assert.match(line, /entrega FALHOU/);
  assert.match(line, / parcial=sim/);
  assert.ok(!/ parcial=sim/.test(formatDeliveryLog({ ...d, partial: false })));
  assert.match(formatDeliveryLog({ ok: true, retried: 1 }), / repeticoes=1/);
});
await test('Q31: falha na parte 3 de N: o aviso vai na última parte ENTREGUE (a 2) e as partes seguintes não são tentadas', async () => {
  const w = makeWorld({ fail: { send: [null, discordError(403), discordError(403), discordError(403)] } });
  const text = `${bodyOf(150)}\n${FOOT}`;
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text, maxParts: 10, logger: makeLogger(), ...noWait });
  assert.deepEqual([res.ok, res.partial, res.sentParts], [false, true, 2]);
  const edits = w.ops('edit');
  assert.equal(edits.length, 2, 'a parte 1 e o aviso na parte 2');
  assert.match(edits[1].payload.content, /-# parte 2\/\d+ · ⚠️ Não consegui enviar as partes 3 a \d+\./);
  assert.equal(w.ops('send').length, 4, 'parte 2 (ok), parte 3 (falhou), anexo (falhou) e aviso à parte (falhou)');
});
await test('Q31: se só o aviso à parte chegou, a entrega segue ok (a parte 1 foi entregue) mas fica marcada como parcial, sem editar nada', async () => {
  const w = makeWorld({ fail: { send: [discordError(403), discordError(403), null] } });
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text: bodyOf(80), logger: makeLogger(), ...noWait });
  assert.deepEqual([res.ok, res.partial], [true, true]);
  assert.equal(w.ops('edit').length, 1);
  // o anexo com o restante chegou: a entrega é COMPLETA (degradada, não parcial)
  const w2 = makeWorld({ fail: { send: [discordError(403, 50013)] } });
  const r2 = await sendLongReply({ kind: 'mention', interaction: w2.message, replyMessage: w2.replyMessage, text: bodyOf(80), logger: makeLogger(), ...noWait });
  assert.deepEqual([r2.ok, r2.degraded, r2.partial], [true, true, undefined]);
});
await test('Q31: se até a edição do aviso falhar, não lança: ok false, partial true e o erro vai ao log (só metadados)', async () => {
  const w = makeWorld({ fail: { send: () => discordError(403), edit: [null, discordError(403)] } });
  const logger = makeLogger();
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text: bodyOf(80), logger, ...noWait });
  assert.deepEqual([res.ok, res.partial, res.sentParts], [false, true, 1]);
  assert.ok(logger.logs.error.some((l) => /aviso de partes faltando/.test(l) && /status=403/.test(l)));
});
await test('Q31: slash público com followUp e channel.send quebrados: o aviso é escrito pelo editReply da parte 1', async () => {
  const w = makeWorld({ fail: { followUp: () => discordError(403), send: () => discordError(403) } });
  const res = await sendLongReply({ kind: 'slash', interaction: w.slash, text: bodyOf(80), logger: makeLogger(), ...noWait });
  assert.deepEqual([res.ok, res.partial, res.sentParts], [false, true, 1]);
  const edits = w.ops('editReply');
  assert.equal(edits.length, 2);
  assert.match(edits[1].payload.content, /⚠️ Não consegui enviar as partes 2 a \d+\./);
});
await test('Q31: com só 2 partes e a 2ª perdida o aviso fala no singular; se a edição devolve um objeto sem edit(), o aviso usa a mensagem de "Processando..."', async () => {
  const text = bodyOf(40);
  assert.equal(splitDetailed(text, {}).parts.length, 2, 'o texto do teste precisa ter exatamente 2 partes');
  const w = makeWorld({ fail: { send: () => discordError(403) } });
  const edits = [];
  w.replyMessage.edit = async (p) => { edits.push(p); return {}; };
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text, logger: makeLogger(), ...noWait });
  assert.deepEqual([res.ok, res.partial, res.parts, res.sentParts], [false, true, 2, 1]);
  assert.equal(edits.length, 2);
  assert.match(edits[1].content, /-# parte 1\/2 · ⚠️ Não consegui enviar a parte 2\./);
  assert.ok(!/partes 2/.test(edits[1].content));
});

// ── Resultado ───────────────────────────────────────────────────────────────────────────────────
console.log(`\n${passed} teste(s) ok, ${failures.length} falha(s).`);
if (failures.length) console.log(`Falharam: ${failures.join(' | ')}`);
process.chdir(repoRoot);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* pode estar em uso (logs) */ }
process.exit(failures.length ? 1 : 0);
