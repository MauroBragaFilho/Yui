// Testes dos limites e dos planos B das respostas longas (rodada final, pacote 2 de src/discord/longReply.js):
//   TG-06 plano B do texto curto (C7: escopo restrito) · TG-07 sem a permissão "Anexar arquivos" · TG-24 partes no modo anexo
//   TG-25 entrega lenta sem duplicar · TG-26 texto só de espaço · TG-27 "info string" da cerca de código · TG-28 corte de contexto.
// SEM Discord real, SEM rede, SEM banco: só dublês de canal, mensagem e interação. Importar longReply.js não tem efeitos colaterais.
// Execução: npm run test:longreplylimits   (node tests/test-longreply-limits.js)
import assert from 'assert';
import { MessageFlags, AttachmentBuilder } from 'discord.js';
import {
  splitDetailed, splitReply, splitFooter, sendLongReply, createUnifiedReply, isRecoverableEditError, isPermanentDiscordError,
  isRetryableEditError, isTargetGoneError, createProgressReporter, progressSubtext,
  clipContextText, historyCopy, formatDeliveryLog, parseAttachExt, parseMaxParts,
  DISCORD_LIMIT, EMPTY_REPLY_TEXT, LONG_CONTEXT_LIMIT, SHORT_CONTEXT_LIMIT,
  DELIVERY_FAILED_TEXT, STALE_REPLY_TEXT, PROGRESS_BASE_TEXT, PROGRESS_MAX_EDITS, PROGRESS_MIN_GAP_MS,
} from '../src/discord/longReply.js';
import { SAFE_ALLOWED_MENTIONS } from '../src/discord/mentions.js';

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

// ── Dublês ──────────────────────────────────────────────────────────────────────────────────────
const discordError = (status, code = 0, message = 'erro do Discord') => Object.assign(new Error(message), { status, code });
function makeLogger() {
  const logs = { info: [], warn: [], error: [] };
  return { logs, info: (m) => logs.info.push(String(m)), warn: (m) => logs.warn.push(String(m)), error: (m) => logs.error.push(String(m)), debug() {} };
}
/**
 * Mundo falso: canal, mensagem "Processando...", mensagem do usuário e interação slash.
 * `fail[op]` = lista de erros por chamada, ou função (nº da chamada, payload) => erro|null. Toda chamada fica na `timeline`
 * (com `failed` quando lançou, `t0`/`t1` de início e fim); `delay` atrasa a resposta de cada operação. `canDelete` dá `delete` à
 * mensagem de "Processando..." e `deleteReply` à interação (a limpeza da mensagem de progresso antiga só age se o método existir).
 */
function makeWorld({ delay = () => 0, fail = {}, ephemeral = false, tokenAgeMs = 0, canDelete = false } = {}) {
  const timeline = [];
  let seq = 0;
  const counters = {};
  const op = async (name, payload) => {
    const n = ++seq;
    counters[name] = (counters[name] ?? 0) + 1;
    const entry = { n, name, payload, call: counters[name], failed: false, t0: Date.now(), t1: 0 };
    timeline.push(entry);
    await sleep(delay(n, name, payload));
    entry.t1 = Date.now();
    const f = fail[name];
    const err = typeof f === 'function' ? f(counters[name], payload) : Array.isArray(f) ? f[counters[name] - 1] : null;
    if (err) { entry.failed = true; throw err; }
    return { id: `${name}-${n}`, content: payload.content, channel, edit: (pp) => op('edit', pp), ...(canDelete ? { delete: () => op('delete', {}) } : {}), __entry: entry };
  };
  const channel = { id: 'chan1', send: (p) => op('send', p) };
  const replyMessage = { id: 'proc1', channel, edit: (p) => op('edit', p), ...(canDelete ? { delete: () => op('delete', {}) } : {}) };
  const message = { id: 'orig1', channel, channelId: 'chan1', guildId: 'g1', guild: { id: 'g1' }, reply: (p) => op('reply', p), author: { id: 'u1', tag: 'u#1' } };
  const slash = {
    id: 'int1', channel, channelId: 'chan1', guildId: 'g1', guild: { id: 'g1' }, deferred: true, replied: false, ephemeral,
    createdTimestamp: Date.now() - tokenAgeMs,
    editReply: (p) => op('editReply', p), followUp: (p) => op('followUp', p), reply: (p) => op('reply', p),
    ...(canDelete ? { deleteReply: () => op('deleteReply', {}) } : {}),
    user: { id: 'u1', tag: 'u#1' },
  };
  return { timeline, channel, replyMessage, message, slash, ops: (name) => timeline.filter((t) => t.name === name), delivered: () => timeline.filter((t) => !t.failed) };
}
const noWait = { sleep: async () => {}, retryDelayMs: 0 };
const FOOT = '-# Gemini | 🔎 Search | ⏱️ 3.2s';
const listLines = (n) => Array.from({ length: n }, (_, i) => `${i + 1}. [Mod número ${i + 1}](https://www.exemplo.com/mods/${i + 1}-nome-longo) - descrição do item ${i + 1}`);
const bodyOf = (n = 74) => ['Aqui está a lista completa:', '', ...listLines(n)].join('\n');
const markerLine = /\n-# parte \d+\/\d+$/;
const stripMarker = (c) => c.replace(markerLine, '');
const itemNumbers = (text) => [...text.matchAll(/^(\d+)\. \[Mod número/gm)].map((m) => Number(m[1]));
const hasFiles = (payload) => Array.isArray(payload?.files) && payload.files.length > 0;
const attachmentTexts = (w) => w.timeline.flatMap((t) => (t.payload?.files ?? []).map((f) => f.attachment.toString('utf8')));
const countIn = (haystack, needle) => haystack.split(needle).length - 1;

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('A. TG-06 (com o escopo restrito C7): plano B do texto curto');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('isRecoverableEditError: só 10008, 10062, 50027 e 5xx; o resto falharia igual no reenvio', () => {
  for (const e of [discordError(404, 10008), discordError(404, 10062), discordError(401, 50027), discordError(500), discordError(502, 0), discordError(503), { httpStatus: 504 }, { code: 10008 }]) {
    assert.equal(isRecoverableEditError(e), true, JSON.stringify([e.status, e.code]));
  }
  for (const e of [discordError(400, 50035), discordError(403, 50013), discordError(413, 40005), discordError(400), discordError(404), discordError(429), new Error('rede'), null, undefined, {}]) {
    assert.equal(isRecoverableEditError(e), false, String(e?.status) + '/' + String(e?.code));
  }
});
await test('menção: o "Processando..." foi apagado (10008) -> o MESMO conteúdo sai por channel.send, em resposta a quem perguntou, com arquivo/botão/embed', async () => {
  const w = makeWorld({ fail: { edit: [discordError(404, 10008, 'Unknown Message')] } });
  let rm = w.replyMessage;
  const errors = [];
  const logger = makeLogger();
  const reply = createUnifiedReply({ interaction: w.message, type: 'mention', userId: 'u1', getReplyMessage: () => rm, setReplyMessage: (m) => { rm = m; }, onError: (e) => errors.push(e), logger });
  const files = [new AttachmentBuilder(Buffer.from('x'), { name: 'a.txt' })];
  const comps = [{ type: 1 }];
  const embeds = [{ title: 'e' }];
  const out = await reply('Resposta pronta.', files, comps, embeds);
  assert.ok(out, 'deveria devolver a mensagem nova');
  assert.deepEqual(w.timeline.map((t) => t.name), ['edit', 'send']);
  const sent = w.ops('send')[0].payload;
  assert.equal(sent.content, 'Resposta pronta.');
  assert.deepEqual([sent.files, sent.components, sent.embeds], [files, comps, embeds]);
  assert.equal(sent.allowedMentions, SAFE_ALLOWED_MENTIONS);
  assert.equal(sent.reply.messageReference, w.message);
  assert.equal(sent.reply.failIfNotExists, false);
  assert.equal(out.id, `send-${w.ops('send')[0].n}`);
  assert.equal(rm, out, 'as próximas edições devem ir para a mensagem que existe');
  assert.equal(errors.length, 1, 'onError continua sendo chamado com o erro original');
  assert.equal(reply.lastDelivery.ok, true);
  assert.equal(reply.lastDelivery.degraded, true);
  assert.equal(reply.lastDelivery.mode, 'single');
  assert.ok(logger.logs.warn.some((l) => /codigo=10008/.test(l)), 'registra o motivo (só metadados)');
  assert.ok(![...logger.logs.warn, ...logger.logs.error].some((l) => l.includes('Resposta pronta')), 'o log não recebe o conteúdo');
});
await test('menção: erro 5xx na PRIMEIRA resposta (sem "Processando...") também cai para channel.send', async () => {
  const w = makeWorld({ fail: { reply: [discordError(503)] } });
  const reply = createUnifiedReply({ interaction: w.message, type: 'mention', userId: 'u1' });
  const out = await reply('Olá!');
  assert.ok(out);
  assert.deepEqual(w.timeline.map((t) => t.name), ['reply', 'send']);
  assert.equal(w.ops('send')[0].payload.content, 'Olá!');
});
await test('slash PÚBLICO: editReply falhou (50027) -> followUp; se o followUp também falhar -> channel.send; se tudo falhar -> null', async () => {
  const a = makeWorld({ fail: { editReply: [discordError(401, 50027, 'Invalid Webhook Token')] } });
  const ra = createUnifiedReply({ interaction: a.slash, type: 'slash', userId: 'u1' });
  assert.ok(await ra('Resposta A'));
  assert.deepEqual(a.timeline.map((t) => t.name), ['editReply', 'followUp']);
  assert.equal(a.ops('followUp')[0].payload.content, 'Resposta A');
  assert.equal(a.ops('send').length, 0);
  assert.equal(ra.lastDelivery.degraded, true);

  const b = makeWorld({ fail: { editReply: [discordError(404, 10062)], followUp: [discordError(500)] } });
  const rb = createUnifiedReply({ interaction: b.slash, type: 'slash', userId: 'u1' });
  const outB = await rb('Resposta B');
  assert.ok(outB);
  assert.deepEqual(b.timeline.map((t) => t.name), ['editReply', 'followUp', 'send']);
  assert.equal(b.ops('send')[0].payload.reply, undefined, 'em slash o canal não responde a mensagem nenhuma');
  assert.equal(rb.lastDelivery.ok, true);

  const errors = [];
  const c = makeWorld({ fail: { editReply: () => discordError(500), followUp: () => discordError(500), send: () => discordError(500) } });
  const rc = createUnifiedReply({ interaction: c.slash, type: 'slash', userId: 'u1', onError: (e) => errors.push(e), logger: makeLogger() });
  assert.equal(await rc('Resposta C'), null);
  assert.equal(rc.lastDelivery.ok, false);
  assert.equal(errors.length, 1);
  // item 4 do plano da pesquisa: o 5xx da edição ganha UMA nova tentativa (editReply 2x) e, como nada foi entregue, a última
  // cartada tenta trocar o "Processando..." por um aviso (3ª editReply); o plano B (followUp, depois channel.send) segue o mesmo.
  assert.deepEqual(c.timeline.map((t) => t.name), ['editReply', 'editReply', 'followUp', 'send', 'editReply']);
  assert.equal(c.ops('editReply')[2].payload.content, DELIVERY_FAILED_TEXT);
});
await test('slash público com o token vencido (> 14 min): pula o followUp e usa o canal', async () => {
  const w = makeWorld({ tokenAgeMs: 20 * 60 * 1000, fail: { editReply: [discordError(401, 50027)] } });
  const reply = createUnifiedReply({ interaction: w.slash, type: 'slash', userId: 'u1' });
  assert.ok(await reply('Ainda chega'));
  assert.deepEqual(w.timeline.map((t) => t.name), ['editReply', 'send']);
});
await test('resposta EFÊMERA: NUNCA channel.send nem followUp (o conteúdo é privado)', async () => {
  for (const err of [discordError(500), discordError(404, 10008), discordError(401, 50027), discordError(404, 10062)]) {
    const w = makeWorld({ ephemeral: true, fail: { editReply: () => err } });
    const reply = createUnifiedReply({ interaction: w.slash, type: 'slash', userId: 'u1', logger: makeLogger() });
    assert.equal(await reply('Segredo só seu'), null);
    // a efêmera só pode usar editReply (nunca followUp, channel.send nem reply). O 5xx ganha a nova tentativa e o aviso de falha
    // (3 chamadas); mensagem/interação que já sumiram (10008, 10062, 50027) não repetem nem avisam (1 chamada).
    assert.ok(w.timeline.every((t) => t.name === 'editReply'), `efêmera vazou: ${w.timeline.map((t) => t.name).join(',')}`);
    assert.equal(w.timeline.length, err.status === 500 ? 3 : 1, `${err.status}/${err.code}`);
    assert.equal(reply.lastDelivery.ok, false);
  }
});
await test('VOZ e RÁDIO: o plano B não existe (a fala já tem o seu fluxo)', async () => {
  const w = makeWorld({ fail: { edit: () => discordError(404, 10008) } });
  const voice = { ...w.message, id: 'voice_123', isVoice: true };
  const rv = createUnifiedReply({ interaction: voice, type: 'mention', userId: 'u1', getReplyMessage: () => w.replyMessage, logger: makeLogger() });
  assert.equal(await rv('resposta falada'), null);
  const radio = createUnifiedReply({ interaction: w.message, type: 'mention', userId: 'u1', radioMode: true, getReplyMessage: () => w.replyMessage, logger: makeLogger() });
  assert.equal(await radio('resposta do rádio'), null);
  assert.equal(w.ops('send').length, 0);
  const w2 = makeWorld({ fail: { editReply: () => discordError(500) } });
  const radioSlash = createUnifiedReply({ interaction: { ...w2.slash, isRadioMode: true }, type: 'slash', userId: 'u1', logger: makeLogger() });
  assert.equal(await radioSlash('x'), null);
  assert.equal(w2.ops('followUp').length + w2.ops('send').length, 0);
});
await test('mensagens de PROGRESSO não viram mensagem nova: "Processando...", sem texto (só embed), vazio e null', async () => {
  const cases = [
    ['🧠 **Processando...**', [], [], []],
    ['-# 🧠 **Processando...**\n-# 🧠 (gemini) Processando...', [], [], []],
    [null, [], [], [{ title: 'Executando Ação' }]],
    ['', [], [{ type: 1 }], [{ title: 'painel' }]],
    [undefined, [], [], [{ title: 'x' }]],
  ];
  for (const [content, files, comps, embeds] of cases) {
    const w = makeWorld({ fail: { edit: () => discordError(500), reply: () => discordError(500) } });
    const reply = createUnifiedReply({ interaction: w.message, type: 'mention', userId: 'u1', getReplyMessage: () => w.replyMessage, logger: makeLogger() });
    assert.equal(await reply(content, files, comps, embeds), null, `conteúdo ${JSON.stringify(content)}`);
    assert.equal(w.ops('send').length, 0, `plano B indevido para ${JSON.stringify(content)}`);
  }
});
await test('erros em que reenviar falharia igual NÃO acionam o plano B (50035, 50013, 40005, 400 e erro de rede)', async () => {
  for (const err of [discordError(400, 50035), discordError(403, 50013), discordError(413, 40005), discordError(400), new Error('socket hang up')]) {
    const w = makeWorld({ fail: { edit: () => err } });
    const reply = createUnifiedReply({ interaction: w.message, type: 'mention', userId: 'u1', getReplyMessage: () => w.replyMessage, logger: makeLogger() });
    assert.equal(await reply('texto'), null);
    assert.equal(w.ops('send').length, 0, `plano B indevido para ${err.status}/${err.code}`);
  }
});
await test('menção: se o channel.send do plano B também falha, devolve null e deixa lastDelivery.ok=false', async () => {
  const w = makeWorld({ fail: { edit: () => discordError(500), send: () => discordError(500) } });
  const reply = createUnifiedReply({ interaction: w.message, type: 'mention', userId: 'u1', getReplyMessage: () => w.replyMessage, logger: makeLogger() });
  assert.equal(await reply('texto'), null);
  assert.equal(reply.lastDelivery.ok, false);
  assert.equal(w.ops('send').length, 1, 'uma tentativa só, sem laço');
});
await test('o texto LONGO continua indo pelo divisor (o plano B do texto curto não o altera)', async () => {
  const w = makeWorld();
  const reply = createUnifiedReply({ interaction: w.message, type: 'mention', userId: 'u1', getReplyMessage: () => w.replyMessage, deps: noWait });
  await reply(bodyOf(80));
  assert.equal(reply.lastDelivery.mode, 'split');
  assert.ok(!reply.lastDelivery.degraded);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('B. TG-07: sem a permissão "Anexar arquivos" (ou anexo recusado) o texto não fica só na introdução');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const noAttach = (code, status) => (_n, payload) => (hasFiles(payload) ? discordError(status, code, 'Missing Permissions') : null);
const LONG_FOOT = '-# ' + 'x'.repeat(300); // rodapé grande: o aviso não cabe embutido e vai numa mensagem à parte
const longText = (footer = FOOT) => `${bodyOf(100)}\n${footer}`;
await test('sem "Anexar arquivos": entrega as primeiras 4 partes e um aviso do que faltou (todas <= 2000; a junção é prefixo do original)', async () => {
  const text = longText();
  const d = splitDetailed(splitFooter(text).body, { footer: FOOT });
  assert.ok(d.parts.length > 4, `precisa de mais de 4 partes: ${d.parts.length}`);
  const w = makeWorld({ fail: { edit: noAttach(50013, 403), send: noAttach(50013, 403) } });
  const logger = makeLogger();
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text, logger, ...noWait });
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'split');
  assert.equal(res.degraded, true);
  assert.equal(res.parts, 4);
  assert.equal(res.sentParts, 4);
  const ok = w.delivered();
  assert.deepEqual(ok.map((t) => t.name).slice(0, 4), ['edit', 'send', 'send', 'send'], 'as 4 partes iniciais');
  assert.ok(ok.length === 4 || ok.length === 5, 'o aviso vem embutido na 4ª parte ou numa mensagem à parte');
  const payloads = ok.map((t) => t.payload);
  for (const p of payloads) {
    assert.ok(p.content.length <= DISCORD_LIMIT, `mensagem com ${p.content.length} caracteres`);
    assert.ok(!hasFiles(p), 'nenhuma mensagem entregue leva anexo');
    assert.equal(p.allowedMentions, SAFE_ALLOWED_MENTIONS);
  }
  // o texto entregue é o INÍCIO do original, em ordem e sem buracos
  const delivered = payloads.slice(0, 4).map((p) => stripMarker(p.content.split('\n-# 📎')[0])).join('\n');
  const nums = itemNumbers(delivered);
  assert.ok(nums.length >= 30, `poucos itens entregues: ${nums.length}`);
  assert.deepEqual(nums, Array.from({ length: nums.length }, (_, i) => i + 1));
  const rawJoined = d.parts.slice(0, 4).map((p) => p.raw).join('');
  assert.ok(d.body.startsWith(rawJoined));
  assert.ok(rawJoined.length > 6000 && rawJoined.length < 8000, `entregou ${rawJoined.length} caracteres`);
  // o aviso: permissão, partes que faltaram e quantos caracteres
  const notice = payloads.at(-1).content;
  assert.match(notice, /Anexar arquivos/);
  assert.match(notice, new RegExp(`partes 5 a ${d.parts.length}`));
  const lost = Number(notice.match(/Faltaram ([\d.]+) caracteres/)[1].replace(/\./g, ''));
  assert.equal(lost, d.body.length - d.parts[3].end, 'a contagem do que faltou deve bater com o plano');
  assert.ok(notice.endsWith(FOOT), 'o rodapé do modelo acompanha o aviso');
  // o anexo foi tentado UMA vez (edição + o novo envio da parte 1) e nunca mais
  assert.equal(w.timeline.filter((t) => hasFiles(t.payload)).length, 2, 'o anexo não pode ser tentado de novo em cada parte');
  assert.ok(logger.logs.error.some((l) => /anexo/.test(l) && /codigo=50013/.test(l)));
});
await test('erro genérico no anexo (5xx persistente): mesmo caminho, aviso sem citar a permissão', async () => {
  const w = makeWorld({ fail: { edit: (_n, p) => (hasFiles(p) ? discordError(500) : null), send: (_n, p) => (hasFiles(p) ? discordError(500) : null) } });
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text: longText(), logger: makeLogger(), ...noWait });
  assert.ok(res.ok && res.mode === 'split' && res.parts === 4);
  const notice = w.delivered().at(-1).payload.content;
  assert.match(notice, /não consegui anexar o texto completo/);
  assert.doesNotMatch(notice, /Anexar arquivos/);
});
await test('acima de 20000 caracteres também: 4 partes iniciais + aviso; cada uma <= 2000', async () => {
  const huge = 'palavra '.repeat(3200); // 25600 caracteres
  const w = makeWorld({ fail: { reply: noAttach(50013, 403), send: noAttach(50013, 403), editReply: noAttach(50013, 403), followUp: noAttach(50013, 403) } });
  const res = await sendLongReply({ kind: 'slash', interaction: w.slash, text: huge, maxParts: 4, logger: makeLogger(), ...noWait });
  assert.ok(res.ok && res.parts === 4 && res.sentParts === 4);
  const ok = w.delivered();
  for (const t of ok) assert.ok(t.payload.content.length <= DISCORD_LIMIT);
  assert.equal(ok.filter((t) => t.name === 'send').length, 0, 'slash público usa followUp, não channel.send');
  assert.match(ok.at(-1).payload.content, /Anexar arquivos/);
  const d = splitDetailed(huge.trim(), {});
  const lost = Number(ok.at(-1).payload.content.match(/Faltaram ([\d.]+) caracteres/)[1].replace(/\./g, ''));
  assert.equal(lost, d.body.length - d.parts[3].end);
});
await test('aviso EMBUTIDO na última parte quando cabe (partes curtas); senão numa mensagem à parte', async () => {
  const text = `${bodyOf(60)}\n${FOOT}`;
  const small = makeWorld({ fail: { edit: noAttach(50013, 403), send: noAttach(50013, 403) } });
  const r1 = await sendLongReply({ kind: 'mention', interaction: small.message, replyMessage: small.replyMessage, text, budget: 600, logger: makeLogger(), ...noWait });
  assert.ok(r1.ok && r1.parts === 4);
  assert.deepEqual(small.delivered().map((t) => t.name), ['edit', 'send', 'send', 'send'], 'o aviso deveria estar dentro da 4ª parte');
  const last = small.delivered().at(-1).payload.content;
  assert.ok(last.length <= DISCORD_LIMIT && /Anexar arquivos/.test(last) && /\n-# parte 4\/\d+\n-# 📎 Faltaram/.test(last));
  // partes cheias (1900): o aviso não cabe junto e vai sozinho, depois da 4ª parte
  const full = makeWorld({ fail: { edit: noAttach(50013, 403), send: noAttach(50013, 403) } });
  const r2 = await sendLongReply({ kind: 'mention', interaction: full.message, replyMessage: full.replyMessage, text: longText(LONG_FOOT), logger: makeLogger(), ...noWait });
  assert.ok(r2.ok);
  const names = full.delivered().map((t) => t.name);
  assert.equal(names.length, 5);
  assert.ok(!/Faltaram/.test(full.delivered()[3].payload.content), 'o aviso não deveria estar na 4ª parte');
  assert.match(full.delivered()[4].payload.content, /^-# 📎 Faltaram/);
  assert.equal(full.delivered()[4].payload.flags & MessageFlags.SuppressNotifications, MessageFlags.SuppressNotifications, 'o aviso é silencioso');
});
await test('botões e embeds vão na última PARTE do texto (nunca no aviso solto); o arquivo extra do chamador não é reenviado', async () => {
  const w = makeWorld({ fail: { edit: noAttach(50013, 403), send: noAttach(50013, 403) } });
  const comps = [{ type: 1 }];
  const embeds = [{ title: 'e' }];
  const files = [new AttachmentBuilder(Buffer.from('x'), { name: 'a.txt' })];
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text: longText(LONG_FOOT), components: comps, embeds, files, logger: makeLogger(), ...noWait });
  assert.ok(res.ok);
  const ok = w.delivered();
  const part4 = ok[3].payload;
  assert.deepEqual([part4.components, part4.embeds], [comps, embeds]);
  assert.ok(!hasFiles(part4));
  for (const t of [ok[1], ok[2], ok[4]]) assert.ok(!t.payload.components && !t.payload.embeds, 'só a última parte leva botões/embeds (nem o aviso solto)');
  assert.equal(res.message.id, `send-${ok[3].n}`, 'a mensagem devolvida é a última parte (a que leva os botões)');
});
await test('se as partes também falharem: nenhum novo anexo, só o aviso curto; sem lançar', async () => {
  const w = makeWorld({ fail: { edit: () => discordError(403, 50013), send: () => discordError(403, 50013) } });
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text: longText(), logger: makeLogger(), ...noWait });
  assert.equal(res.ok, false);
  assert.equal(res.mode, 'failed');
  assert.equal(res.sentParts, 0);
  assert.equal(w.timeline.filter((t) => hasFiles(t.payload)).length, 2, 'só as 2 tentativas iniciais levaram anexo');
});
await test('slash EFÊMERA sem permissão de anexar: as partes saem por followUp efêmero e NUNCA por channel.send', async () => {
  const w = makeWorld({ ephemeral: true, fail: { editReply: noAttach(50013, 403), followUp: noAttach(50013, 403) } });
  const res = await sendLongReply({ kind: 'slash', interaction: w.slash, text: longText(), logger: makeLogger(), ...noWait });
  assert.ok(res.ok && res.sentParts === 4);
  assert.equal(w.ops('send').length, 0);
  for (const t of w.ops('followUp')) assert.equal(t.payload.flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
});
await test('o caminho normal NÃO muda: anexo enviado com sucesso continua sendo UMA mensagem com resposta-yui.md e a linha "Citados no arquivo"', async () => {
  const u1 = '123456789012345678';
  const text = `${bodyOf(150)} fim <@${u1}>\n${FOOT}`;
  const w = makeWorld();
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text, ...noWait });
  assert.ok(res.ok && res.mode === 'attachment' && !res.degraded);
  assert.equal(w.timeline.length, 1);
  const p = w.timeline[0].payload;
  assert.equal(p.files[0].name, 'resposta-yui.md');
  assert.ok(p.content.includes(`Citados no arquivo: <@${u1}>`));
  assert.equal(parseAttachExt({ YUI_REPLY_ATTACH_EXT: 'txt' }), 'txt');
  assert.equal(parseAttachExt({}), 'md');
  assert.equal(parseMaxParts({}), 4);
});
await test('o plano usa plan.body: com espaços no começo do texto o anexo do restante começa EXATAMENTE na parte k', async () => {
  const text = `\n\n   ${bodyOf(80)}\n${FOOT}`;
  const body = splitFooter(text).body;
  const d = splitDetailed(body, { footer: FOOT });
  const w = makeWorld({ fail: { send: [discordError(403, 50013)] } });
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text, logger: makeLogger(), ...noWait });
  assert.equal(res.degraded, true);
  const att = attachmentTexts(w)[0];
  assert.equal(att, `${d.body.slice(d.parts[1].start)}\n${FOOT}`);
  assert.ok(att.startsWith(d.parts[1].raw.slice(0, 40)));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('C. TG-24: "partes" no modo anexo');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('anexo entregue = 1 mensagem: parts=1 (o histórico não diz "N mensagens" e o log mostra partes=1/1)', async () => {
  const text = `${bodyOf(150)}\n${FOOT}`;
  assert.ok(splitReply(text).parts.length > 4);
  const w = makeWorld();
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text, ...noWait });
  assert.equal(res.mode, 'attachment');
  assert.equal(res.parts, 1);
  assert.equal(res.sentParts, 1);
  assert.ok(!/resposta entregue em/.test(historyCopy(text, { parts: res.parts })), historyCopy(text, { parts: res.parts }).slice(-60));
  assert.match(formatDeliveryLog(res), /partes=1\/1 modo=anexo/);
  // e pelo createUnifiedReply (o caminho do llmHandler)
  const w2 = makeWorld();
  const reply = createUnifiedReply({ interaction: w2.message, type: 'mention', userId: 'u1', getReplyMessage: () => w2.replyMessage, deps: noWait });
  await reply(text);
  assert.equal(reply.lastDelivery.mode, 'attachment');
  assert.equal(reply.lastDelivery.parts, 1);
});
await test('modo dividido continua com parts = total de partes', async () => {
  const w = makeWorld();
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text: bodyOf(60), ...noWait });
  assert.equal(res.mode, 'split');
  assert.ok(res.parts >= 2 && res.parts === res.sentParts);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('D. TG-25: entrega lenta não duplica a parte nem prende a fila');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('parte lenta que ainda completa dentro da folga NÃO é reenviada (sem duplicata); sem folga, aparece duas vezes', async () => {
  const text = bodyOf(80);
  const d = splitDetailed(splitFooter(text).body, {});
  const marker2 = d.parts[1].raw.trim().split('\n')[0]; // 1ª linha da parte 2
  const run = async (lateGraceMs) => {
    const w = makeWorld({ delay: (_n, name) => (name === 'send' ? 400 : 0) });
    const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text, deadlineMs: 60, fallbackMs: 6000, lateGraceMs, retryDelayMs: 0, logger: makeLogger() });
    await sleep(650); // deixa a requisição abandonada terminar
    const delivered = w.delivered();
    const seen = delivered.map((t) => t.payload.content ?? '').join('\n') + '\n' + attachmentTexts(w).join('\n');
    return { res, seen, w };
  };
  const withGrace = await run(2500);
  assert.equal(countIn(withGrace.seen, marker2), 1, 'a parte 2 chegou e foi reenviada dentro do anexo');
  assert.ok(withGrace.res.ok);
  const noGrace = await run(0);
  assert.equal(countIn(noGrace.seen, marker2), 2, 'sem a folga o comportamento antigo duplica (confirma que o teste enxerga o problema)');
});
await test('se a requisição abandonada FALHA na folga, o plano B continua (anexo com o restante) e a fila não trava', async () => {
  const text = bodyOf(80);
  const w = makeWorld({ delay: (_n, name) => (name === 'send' ? 120 : 0), fail: { send: [discordError(403, 50013)] } });
  const t0 = Date.now();
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text, deadlineMs: 50, fallbackMs: 4000, lateGraceMs: 1500, retryDelayMs: 0, logger: makeLogger() });
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(res.degraded, true);
  assert.ok(attachmentTexts(w).length >= 1, 'o restante precisa ir como anexo');
});
await test('requisição que NÃO completa na folga: espera só a folga e segue para o plano B', async () => {
  const text = bodyOf(80);
  const w = makeWorld({ delay: (_n, name) => (name === 'send' ? 700 : 0) });
  const t0 = Date.now();
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text, deadlineMs: 60, fallbackMs: 4000, lateGraceMs: 120, retryDelayMs: 0, logger: makeLogger() });
  const elapsed = Date.now() - t0;
  assert.equal(res.degraded, true);
  assert.ok(elapsed >= 150 && elapsed < 3500, `demorou ${elapsed}ms`);
  await sleep(750);
});
await test('isPermanentDiscordError continua igual (o timeout do prazo não é tratado como permanente)', () => {
  assert.equal(isPermanentDiscordError(discordError(404)), true);
  assert.equal(isPermanentDiscordError(Object.assign(new Error('x'), { code: 'DELIVERY_TIMEOUT' })), false);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('E. TG-26: texto só de espaço nunca vira mensagem vazia');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('createUnifiedReply: espaço puro sem arquivo/embed/botão envia o texto mínimo; com embed/botão/arquivo nada muda', async () => {
  for (const blank of ['   ', '\n\n', ' \t \n ']) {
    const w = makeWorld();
    const reply = createUnifiedReply({ interaction: w.message, type: 'mention', userId: 'u1' });
    await reply(blank);
    assert.equal(w.timeline[0].payload.content, EMPTY_REPLY_TEXT);
  }
  const w = makeWorld();
  const embeds = [{ title: 'só embed' }];
  const reply = createUnifiedReply({ interaction: w.message, type: 'mention', userId: 'u1' });
  await reply('   ', [], [], embeds);
  assert.equal(w.timeline[0].payload.content, '   ', 'com embed o texto fica como veio');
  const w2 = makeWorld();
  const reply2 = createUnifiedReply({ interaction: w2.message, type: 'mention', userId: 'u1' });
  await reply2('', [], [{ type: 1 }], []);
  assert.equal(w2.timeline[0].payload.content, '');
  const w3 = makeWorld();
  const reply3 = createUnifiedReply({ interaction: w3.message, type: 'mention', userId: 'u1' });
  await reply3(null, [], [], [{ title: 'x' }]);
  assert.equal(w3.timeline[0].payload.content, null, 'null com embed (progresso) nunca é trocado');
});
await test('espaço puro MUITO longo (3000 caracteres) também não gera mensagem vazia; voz leva o prefixo <@id>', async () => {
  const w = makeWorld();
  const reply = createUnifiedReply({ interaction: w.message, type: 'mention', userId: 'u1', getReplyMessage: () => w.replyMessage, deps: noWait });
  await reply(' '.repeat(3000));
  assert.equal(w.timeline.length, 1);
  assert.equal(w.timeline[0].payload.content, EMPTY_REPLY_TEXT);
  const v = makeWorld();
  const voice = { ...v.message, id: 'voice_1', isVoice: true };
  const rv = createUnifiedReply({ interaction: voice, type: 'mention', userId: 'u1', getReplyMessage: () => v.replyMessage });
  await rv('   ');
  assert.equal(v.timeline[0].payload.content, `<@u1> ${EMPTY_REPLY_TEXT}`);
});
await test('sendLongReply: espaço puro sem extras vira o texto mínimo; com embeds segue o curso normal', async () => {
  const w = makeWorld();
  const res = await sendLongReply({ kind: 'mention', interaction: w.message, replyMessage: w.replyMessage, text: '  \n  ', ...noWait });
  assert.ok(res.ok && res.mode === 'single');
  assert.equal(w.timeline[0].payload.content, EMPTY_REPLY_TEXT);
  const e = makeWorld();
  await sendLongReply({ kind: 'mention', interaction: e.message, replyMessage: e.replyMessage, text: '  ', embeds: [{ title: 'x' }], ...noWait });
  assert.equal(e.timeline[0].payload.content, '');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('F. TG-27: "info string" da cerca de código');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const F3 = '```';
const fenceDoc = (info, codeLines = 300) => `${'Introdução. '.repeat(120)}\n${F3}${info}\n${'linha de codigo;\n'.repeat(codeLines)}${F3}\nfim.`;
await test('info string de ~1950 caracteres sem espaço não estoura as partes (antes: ~32 partes e cortes duros)', () => {
  for (const len of [1, 100, 1500, 1900, 1950, 1990]) {
    const d = splitDetailed(fenceDoc('x'.repeat(len)), { footer: FOOT });
    assert.ok(d.parts.every((p) => p.content.length <= DISCORD_LIMIT), `info ${len}`);
    assert.ok(d.parts.length <= 6, `info ${len}: ${d.parts.length} partes`);
    assert.equal(d.parts.map((p) => p.raw).join(''), d.body, `info ${len}: a junção não reconstrói o texto`);
    for (const p of d.parts) assert.ok(p.prefix.length <= 24, `prefixo de ${p.prefix.length} caracteres`);
  }
});
await test('o prefixo de reabertura guarda só a linguagem (letras, números e _+#.-; no máximo 20)', () => {
  const reopen = (info) => {
    const d = splitDetailed(fenceDoc(info, 400), { footer: FOOT });
    const p = d.parts.find((x) => x.prefix.startsWith(F3));
    assert.ok(p, `nenhuma parte reabriu o bloco (${info})`);
    return p.prefix;
  };
  assert.equal(reopen('python title="x"'), `${F3}python\n`);
  assert.equal(reopen('c++'), `${F3}c++\n`);
  assert.equal(reopen('js{1,3}<b>'), `${F3}js13b\n`);
  assert.equal(reopen('linguagem-com-nome-bem-comprido'), `${F3}linguagem-com-nome-b\n`, 'no máximo 20 caracteres');
  assert.equal(reopen(''), `${F3}\n`);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('G. TG-28: contexto do Discord cortado com marcador');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('limites: respondida/última do autor até 4000, demais 500', () => {
  assert.equal(LONG_CONTEXT_LIMIT, 4000);
  assert.equal(SHORT_CONTEXT_LIMIT, 500);
});
await test('clipContextText: texto dentro do limite não muda; acima disso fica o início e o marcador com o tamanho ORIGINAL', () => {
  assert.equal(clipContextText('curto'), 'curto');
  assert.equal(clipContextText('x'.repeat(500)), 'x'.repeat(500));
  assert.equal(clipContextText(null), '');
  const cut = clipContextText('y'.repeat(1234));
  assert.equal(cut, `${'y'.repeat(500)} [... cortada: 1234 caracteres no original]`);
  assert.equal(clipContextText('z'.repeat(4001), LONG_CONTEXT_LIMIT), `${'z'.repeat(4000)} [... cortada: 4001 caracteres no original]`);
  assert.ok(!cut.endsWith('...'), 'o "..." solto foi trocado pelo marcador');
});
await test('clipContextText nunca parte um emoji (par substituto, ZWJ, bandeira) ao meio', () => {
  const family = '👨‍👩‍👧'; // 8 unidades UTF-16, 1 grafema
  const flag = '🇧🇷';
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  // oráculo independente: segmenta a string INTEIRA e pega o maior grafema completo que cabe em 500
  const seg = new Intl.Segmenter('pt-BR', { granularity: 'grapheme' });
  const oracle = (s, limit) => { let end = 0; for (const { index, segment } of seg.segment(s)) { if (index + segment.length > limit) break; end = index + segment.length; } return end; };
  for (const emoji of [family, flag, '😀']) {
    for (let pad = 485; pad <= 499; pad++) {
      const s = 'a'.repeat(pad) + emoji + 'b'.repeat(50);
      const out = clipContextText(s);
      const head = out.slice(0, out.indexOf(' [... cortada'));
      assert.ok(!LONE.test(head), `par substituto solto (pad ${pad})`);
      assert.equal(head, s.slice(0, oracle(s, 500)), `corte fora da fronteira de grafema (pad ${pad}): ${JSON.stringify(head.slice(-12))}`);
      assert.ok(head.length <= 500);
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('H. Progresso do agente de pesquisa: progressSubtext, createProgressReporter e unifiedReply.progress');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('progressSubtext: uma linha "-# ...", sem URL, menção, @everyone nem "-# " repetido; no máximo 120 caracteres; sem partir emoji', () => {
  assert.equal(progressSubtext('-# 🔎 Pesquisando: «preço do ps5»'), '-# 🔎 Pesquisando: «preço do ps5»');
  assert.equal(progressSubtext('Lendo 2 páginas'), '-# Lendo 2 páginas');
  assert.equal(progressSubtext('-# -# repetido'), '-# repetido');
  assert.equal(progressSubtext('linha 1\nlinha 2\r\nlinha 3'), '-# linha 1 linha 2 linha 3');
  const dirty = progressSubtext('veja https://evil.test/x <@123456789012345678> <@&223456789012345678> <#323456789012345678> @everyone @here @fulano');
  assert.ok(!/https?:|<@|<#/.test(dirty), dirty);
  assert.ok(!/@(everyone|here)\b/.test(dirty) && !/@fulano/.test(dirty), dirty);
  for (const empty of ['', '   ', null, undefined, '-# ', 'https://so-link.test']) assert.equal(progressSubtext(empty), '', String(empty));
  const long = progressSubtext('x'.repeat(500));
  assert.ok(long.length <= 3 + 120 && long.endsWith('…'), String(long.length));
  const family = '👨‍👩‍👧';
  for (let pad = 100; pad <= 125; pad++) {
    const out = progressSubtext(`${'a'.repeat(pad)}${family}${'b'.repeat(30)}`);
    assert.equal(out.includes('👨'), out.includes(family), `emoji partido (pad ${pad})`);
  }
});
await test('createProgressReporter: no máximo 3 edições, 1,2 s entre elas, a última reservada a "last", em ordem e com o texto-base', async () => {
  assert.equal(PROGRESS_MAX_EDITS, 3);
  assert.equal(PROGRESS_MIN_GAP_MS, 1200);
  let t = 0;
  const seen = [];
  const p = createProgressReporter(async (text, meta) => { seen.push([text, meta.index, meta.line]); }, { now: () => t });
  assert.equal(p.show('-# 🔎 Pesquisando: «a»'), true);
  t = 1000;
  assert.equal(p.show('-# 🔎 Tentando de outro jeito'), false, 'antes de 1,2 s: descartada');
  t = 1300;
  assert.equal(p.show('-# 🔎 Tentando de outro jeito'), true);
  t = 2600;
  assert.equal(p.show('-# 📖 Lendo 2 páginas'), false, 'o 3º slot é reservado à linha final');
  assert.equal(p.show('-# ✍️ Escrevendo a resposta', { last: true }), true);
  t = 4000;
  assert.equal(p.show('-# mais uma', { last: true }), false, 'nunca mais de 3');
  assert.equal(await p.drain(), true);
  assert.deepEqual(seen.map((s) => s[1]), [1, 2, 3]);
  assert.equal(seen[0][0], `${PROGRESS_BASE_TEXT}\n-# 🔎 Pesquisando: «a»`);
  assert.equal(seen[2][2], '-# ✍️ Escrevendo a resposta');
  assert.equal(p.edits, 3);
  assert.equal(p.lines.length, 3);
  // o intervalo mínimo e o teto não podem ser afrouxados por configuração
  let t2 = 0;
  const loose = createProgressReporter(async () => {}, { now: () => t2, maxEdits: 50, minGapMs: 0 });
  assert.equal(loose.show('-# a'), true);
  t2 = 100;
  assert.equal(loose.show('-# b'), false, 'minGapMs=0 não vale: o mínimo é 1,2 s');
  t2 = 1300; assert.equal(loose.show('-# b'), true);
  t2 = 2600; assert.equal(loose.show('-# c'), false);
  assert.equal(loose.show('-# c', { last: true }), true);
  t2 = 4000; assert.equal(loose.show('-# d', { last: true }), false, 'maxEdits=50 não passa de 3');
});
await test('createProgressReporter: "Escrevendo a resposta" usa o último slot sozinha (sem { last }) e show pode ser passado solto como onProgress', async () => {
  let t = 0;
  const seen = [];
  const { show, drain } = createProgressReporter(async (text) => { seen.push(text); }, { now: () => t });
  assert.equal(show('-# 🔎 Pesquisando: «a»'), true);
  t = 1500;
  assert.equal(show('-# 📖 Lendo 2 páginas'), true);
  t = 3000;
  assert.equal(show('-# 🔎 Tentando de outro jeito'), false, 'o 3º slot é do "Escrevendo"');
  assert.equal(show('-# ✍️ Escrevendo a resposta'), true);
  await drain();
  assert.equal(seen.length, 3);
  assert.ok(seen[2].endsWith('Escrevendo a resposta'));
  assert.doesNotThrow(() => ['x', 'y'].forEach(show), 'argumentos extras de quem chama (índice, lista) são ignorados');
});
await test('createProgressReporter: linha repetida é descartada; a edição nunca lança; erro permanente (mensagem apagada) encerra o progresso; passageiro não', async () => {
  let t = 0;
  const logger = makeLogger();
  const p = createProgressReporter(async () => { throw discordError(404, 10008, 'Unknown Message'); }, { now: () => t, logger });
  assert.equal(p.show('-# segredo-da-consulta'), true);
  assert.equal(p.show('-# segredo-da-consulta'), false, 'repetida');
  assert.equal(await p.drain(), true);
  t = 5000;
  assert.equal(p.show('-# b'), false, 'a mensagem sumiu: não adianta continuar');
  assert.equal(logger.logs.warn.length, 1);
  assert.ok(!/segredo-da-consulta/.test(logger.logs.warn[0]), 'o log não leva o texto da linha');
  assert.match(logger.logs.warn[0], /codigo=10008/);
  const q = createProgressReporter(async () => { throw discordError(503); }, { now: () => t });
  assert.equal(q.show('-# a'), true);
  await q.drain();
  t = 9000;
  assert.equal(q.show('-# b'), true, 'erro passageiro: o progresso continua');
  assert.equal(createProgressReporter(null).show('-# x'), false);
  assert.equal(createProgressReporter(async () => {}, { maxEdits: 0 }).show('-# x'), false);
});
await test('createProgressReporter: edição pendurada tem prazo; settle() fecha, descarta o que não começou e espera só a que está em andamento', async () => {
  let t = 0;
  const started = [];
  const finished = [];
  const p = createProgressReporter(async (_text, meta) => { started.push(meta.index); await sleep(80); finished.push(meta.index); }, { now: () => t });
  p.show('-# um');
  t = 2000;
  p.show('-# dois'); // entra na fila e ainda não começou quando o settle chegar
  await sleep(10);
  assert.equal(await p.settle(1000), true);
  assert.deepEqual(started, [1], 'a 2ª não começou e foi descartada');
  assert.deepEqual(finished, [1], 'a que estava em andamento terminou ANTES de o settle voltar');
  t = 9000;
  assert.equal(p.show('-# tres'), false, 'depois do settle nada entra');
  assert.equal(p.closed, true);
  const hung = createProgressReporter(() => new Promise(() => {}), { now: () => t, timeoutMs: 30 });
  hung.show('-# preso');
  const t0 = Date.now();
  assert.equal(await hung.drain(1000), true, 'o prazo da edição libera a fila');
  assert.ok(Date.now() - t0 < 600);
  const hung2 = createProgressReporter(() => new Promise(() => {}), { now: () => t, timeoutMs: 5000 });
  hung2.show('-# preso');
  await sleep(10); // a edição já está em andamento (uma edição que ainda não começou seria descartada pelo settle)
  const t1 = Date.now();
  assert.equal(await hung2.settle(60), false, 'settle devolve false se a edição não terminou a tempo, mas não prende');
  assert.ok(Date.now() - t1 < 500);
});
/** createUnifiedReply de menção com o "Processando..." criado de verdade pela primeira chamada. */
async function progressWorld(opts = {}, extra = {}) {
  const w = makeWorld(opts);
  const state = { rm: null, errors: [], clock: 0 };
  const reply = createUnifiedReply({
    interaction: w.message, type: 'mention', userId: 'u1',
    getReplyMessage: () => state.rm, setReplyMessage: (m) => { state.rm = m; },
    onError: (e) => state.errors.push(e), logger: makeLogger(), deps: { ...noWait, now: () => state.clock }, ...extra,
  });
  await reply(PROGRESS_BASE_TEXT);
  return { w, state, reply };
}
await test('unifiedReply.progress: edita o "Processando..." com a linha de subtexto (sem embed antigo nem menção), sem mexer em lastDelivery nem em onError', async () => {
  const { w, state, reply } = await progressWorld({ fail: { edit: (_n, p) => (String(p.content).includes('quebra') ? discordError(500) : null) } });
  const before = reply.lastDelivery;
  assert.equal(before.ok, true);
  assert.equal(reply.progress.show('-# 🔎 Pesquisando: «preço do ps5»'), true);
  await reply.progress.drain();
  const e = w.ops('edit')[0].payload;
  assert.equal(e.content, `${PROGRESS_BASE_TEXT}\n-# 🔎 Pesquisando: «preço do ps5»`);
  assert.deepEqual([e.files, e.components, e.embeds], [[], [], []]);
  assert.deepEqual(e.allowedMentions, { parse: [] });
  assert.equal(reply.lastDelivery, before, 'o progresso não altera lastDelivery');
  // a edição de progresso falha: ninguém é avisado (onError é só da entrega) e nada vira mensagem nova
  state.clock = 5000;
  assert.equal(reply.progress.show('-# 🔎 a consulta quebra'), true);
  await reply.progress.drain();
  assert.equal(state.errors.length, 0);
  assert.equal(reply.lastDelivery, before);
  assert.equal(w.ops('send').length, 0);
});
await test('a resposta final ESPERA a edição de progresso em andamento e fecha o progresso: nenhuma linha velha chega depois', async () => {
  const slowProgress = (_n, name, payload) => (name === 'edit' && /-# /.test(String(payload?.content)) ? 120 : 0);
  const { w, state, reply } = await progressWorld({ delay: slowProgress });
  reply.progress.show('-# 🔎 Pesquisando: «x»');
  await sleep(10); // a edição de 120 ms está em andamento quando a resposta final chega
  const done = await reply('Resposta final da pesquisa.');
  assert.equal(done, state.rm);
  const edits = w.ops('edit');
  assert.equal(edits.length, 2);
  assert.ok(/-# /.test(edits[0].payload.content));
  assert.equal(edits[1].payload.content, 'Resposta final da pesquisa.');
  assert.ok(edits[1].t0 >= edits[0].t1, 'a final só começou depois que a de progresso terminou');
  assert.equal(reply.progress.closed, true);
  state.clock = 9000;
  assert.equal(reply.progress.show('-# tarde demais', { last: true }), false);
  assert.equal(reply.lastDelivery.ok, true);
});
await test('linha de progresso e resposta final logo em seguida: a edição que ainda não começou é descartada (não gasta chamada nem atrasa)', async () => {
  const { w, reply } = await progressWorld();
  assert.equal(reply.progress.show('-# 🔎 Pesquisando: «x»'), true);
  assert.ok(await reply('Resposta final.'));
  const edits = w.ops('edit');
  assert.equal(edits.length, 1, 'só a resposta final editou a mensagem');
  assert.equal(edits[0].payload.content, 'Resposta final.');
});
await test('um embed (sem texto) ou outra mensagem de "Processando..." NÃO fecham o progresso; a resposta de verdade, sim', async () => {
  const { state, reply } = await progressWorld();
  reply.progress.show('-# 🔎 um');
  await reply(null, [], [], [{ title: 'Executando Ação' }]);
  assert.equal(reply.progress.closed, false);
  state.clock = 3000;
  assert.equal(reply.progress.show('-# 🔎 dois'), true);
  await reply('-# 🧠 **Processando...**\n-# 🧠 (gemini) Processando...');
  assert.equal(reply.progress.closed, false);
  await reply('Pronto.');
  assert.equal(reply.progress.closed, true);
});
await test('progresso PENDURADO não segura a resposta final além de ~1,5 s', async () => {
  const stuck = (_n, name, payload) => (name === 'edit' && /-# /.test(String(payload?.content)) ? 5000 : 0);
  const { w, reply } = await progressWorld({ delay: stuck });
  reply.progress.show('-# 🔎 Pesquisando');
  await sleep(10); // em andamento (e pendurada)
  const t0 = Date.now();
  assert.ok(await reply('Resposta final.'));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 1300 && elapsed < 3500, `demorou ${elapsed}ms`);
  assert.equal(w.ops('edit').at(-1).payload.content, 'Resposta final.');
});
await test('progresso + falha da edição final: o subtexto de progresso NUNCA fica como estado final (nova tentativa, mensagem nova e a antiga é apagada)', async () => {
  const { w, state, reply } = await progressWorld({ canDelete: true, fail: { edit: (_n, p) => (p.content === 'Resposta final.' ? discordError(503) : null) } });
  reply.progress.show('-# 🔎 Pesquisando: «x»');
  await reply.progress.drain(); // a linha de progresso chegou ao canal
  const out = await reply('Resposta final.');
  assert.ok(out);
  assert.deepEqual(w.timeline.map((t) => t.name), ['reply', 'edit', 'edit', 'edit', 'send', 'delete']);
  assert.equal(w.ops('send')[0].payload.content, 'Resposta final.');
  assert.equal(state.rm, out);
  assert.equal(state.errors.length, 1);
});
await test('progresso: voz e rádio são inertes; slash edita o editReply; sem resposta ainda não cria mensagem; limits.progressMaxEdits vale', async () => {
  const v = makeWorld();
  const voice = { ...v.message, id: 'voice_1', isVoice: true };
  const rv = createUnifiedReply({ interaction: voice, type: 'mention', userId: 'u1', getReplyMessage: () => v.replyMessage });
  assert.equal(rv.progress.show('-# 🔎 x'), false);
  const rr = createUnifiedReply({ interaction: v.message, type: 'mention', userId: 'u1', radioMode: true, getReplyMessage: () => v.replyMessage });
  assert.equal(rr.progress.show('-# 🔎 x'), false);
  assert.equal(v.timeline.length, 0);

  const s = makeWorld();
  const rs = createUnifiedReply({ interaction: s.slash, type: 'slash', userId: 'u1', deps: noWait });
  rs.progress.show('-# 🔎 x');
  await rs.progress.drain();
  assert.deepEqual(s.timeline.map((t) => t.name), ['editReply']);
  assert.equal(s.timeline[0].payload.content, `${PROGRESS_BASE_TEXT}\n-# 🔎 x`);

  const s2 = makeWorld();
  s2.slash.deferred = false;
  const rs2 = createUnifiedReply({ interaction: s2.slash, type: 'slash', userId: 'u1', deps: noWait });
  rs2.progress.show('-# 🔎 x');
  await rs2.progress.drain();
  const m = makeWorld();
  const rm3 = createUnifiedReply({ interaction: m.message, type: 'mention', userId: 'u1', getReplyMessage: () => null, setReplyMessage: () => {}, deps: noWait });
  rm3.progress.show('-# 🔎 x');
  await rm3.progress.drain();
  assert.equal(s2.timeline.length + m.timeline.length, 0, 'sem "Processando..." o progresso não cria mensagem');

  const one = makeWorld();
  const r1 = createUnifiedReply({ interaction: one.slash, type: 'slash', userId: 'u1', limits: { progressMaxEdits: 1 }, deps: noWait });
  assert.equal(r1.progress.show('-# 🔎 a'), true);
  assert.equal(r1.progress.show('-# 🔎 b', { last: true }), false);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('I. Classificação dos erros da entrega final');
// ═════════════════════════════════════════════════════════════════════════════════════════════════
await test('isRetryableEditError: passageiro (5xx, 408, 425, 429, rede, prazo) repete; mensagem apagada e qualquer outro 4xx não', () => {
  for (const e of [discordError(500), discordError(502), discordError(503), discordError(429), discordError(408), discordError(425), new Error('socket hang up'), { code: 'DELIVERY_TIMEOUT' }, { httpStatus: 504 }]) {
    assert.equal(isRetryableEditError(e), true, JSON.stringify([e.status, e.code, e.message]));
  }
  for (const e of [discordError(404, 10008), discordError(404, 10062), discordError(401, 50027), discordError(400, 50035), discordError(403, 50013), discordError(413, 40005), discordError(404), null, undefined]) {
    assert.equal(isRetryableEditError(e), false, JSON.stringify([e?.status, e?.code]));
  }
});
await test('isTargetGoneError: 10008, 10015, 10062, 50027 e qualquer 404 = o alvo sumiu; 5xx, 50035 e 403 não', () => {
  for (const e of [discordError(404, 10008), discordError(404, 10015), discordError(404, 10062), discordError(401, 50027), discordError(404), { code: 10008 }]) {
    assert.equal(isTargetGoneError(e), true, JSON.stringify([e.status, e.code]));
  }
  for (const e of [discordError(500), discordError(400, 50035), discordError(403, 50013), new Error('rede'), null, undefined, {}]) {
    assert.equal(isTargetGoneError(e), false, JSON.stringify([e?.status, e?.code]));
  }
});
await test('isRecoverableEditError continua exatamente o plano B restrito da rodada anterior (nada novo entra)', () => {
  for (const e of [discordError(404, 10008), discordError(404, 10062), discordError(401, 50027), discordError(500), discordError(503)]) assert.equal(isRecoverableEditError(e), true);
  for (const e of [discordError(404), discordError(429), discordError(400, 50035), discordError(403, 50013), discordError(413, 40005), new Error('rede'), { code: 10015 }]) assert.equal(isRecoverableEditError(e), false);
});
await test('as constantes de aviso não parecem progresso (não contêm "Processando...") e o aviso de falha cabe numa linha', () => {
  for (const text of [DELIVERY_FAILED_TEXT, STALE_REPLY_TEXT]) {
    assert.ok(!text.includes('Processando...') && text.length < 120 && !text.includes('\n'), text);
  }
  assert.ok(PROGRESS_BASE_TEXT.includes('Processando...'), 'o texto-base É reconhecido como progresso pelo unifiedReply');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} teste(s) ok, ${failures.length} falha(s).`);
if (failures.length) console.log(`Falharam: ${failures.join(' | ')}`);
process.exit(failures.length ? 1 : 0);
