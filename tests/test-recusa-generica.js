// A RECUSA GENÉRICA do modelo ("Desculpa, não posso ajudar com isso" a uma pergunta sobre o Cayo Perico do GTA Online): detecção e UMA nova tentativa com o contexto de que é um jogo.
//  A. a detecção (função pura): só a resposta CURTA que é só a recusa; resposta que explica algo, resposta normal e vazio não são recusa;
//  B. o assunto de GTA fica num módulo próprio e o /yui continua usando a mesma função;
//  C. no passo do cérebro: chave desligada (padrão) = a MESMA chamada de IA de sempre (uma só); ligada = refaz UMA vez, só com assunto de GTA, só na chamada principal,
//     e a nova resposta só vale se NÃO for outra recusa; nunca mais de uma nova tentativa.
// SEM rede, SEM Discord, SEM bancos reais (pasta temporária). Execução: npm run test:recusageral   (node tests/test-recusa-generica.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-recusa-'));
const OWNER = '111111111111111111';
const DMCH = '777777777777777777';
Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'), YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false', LOG_LEVEL: 'error',
  YUI_CONTEXT_ENABLED: 'false', YUI_PRIVATE_SEARCH: 'off',
});
for (const k of ['YUI_TRUSTED_IDS', 'YUI_CEREBRO_EXTERNO', 'YUI_SKILLS', 'YUI_IA_PERFIS', 'YUI_IA_PERFIS_ARQUIVO', 'YUI_IA_REFAZER_RECUSA']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
process.chdir(tmp);

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const { pareceRecusaGenerica, pedidoReforcado } = await imp('src/core/ai/recusa.js');
const { isGtaTopic } = await imp('src/core/ai/temaGta.js');
const conversa = await imp('src/cerebro/conversa.js');

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); } catch (err) { failures.push(name); console.log(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 6).join('\n        ')}`); }
};
const section = (t) => console.log(`\n${t}`);

const META = { role: 'bot' };
const logLines = [];
const logger = { debug() {}, info: (m) => logLines.push(`info: ${m}`), warn: (m) => logLines.push(`warn: ${m}`), error: (m) => logLines.push(`error: ${m}`) };
function ia(respostas) {
  const calls = [];
  return { calls, listBackends: () => [{ name: 'falsa', active: true }], async chat(a) { calls.push(a); const r = respostas[Math.min(calls.length - 1, respostas.length - 1)]; return typeof r === 'function' ? r(a) : r; } };
}
let idSeq = 800000000000000000n;
const nextId = () => String(++idSeq);
function turnParams({ text, options = {}, call = {} } = {}) {
  return {
    turn: { id: nextId(), at: Date.now() - 1000 },
    ctx: { platform: 'discord', userId: OWNER, guildId: null, channelId: DMCH, isDM: true, isBlocked: false },
    call: { entry: 'fila', type: 'mention', mentionsBot: true, hasBotName: false, repliesToBot: false, thirdParty: false, voice: false, voiceInteraction: false, voiceItem: false, chatter: false, ...call },
    ownText: text, memoryQuery: text, channel: { toolsActive: [], toolsDisabled: [] }, step: 1, prompt: `user: "${text}"`, options: { main: true, persona: true, memory: true, ...options },
  };
}
function cerebro(env, respostas) {
  const ai = ia(respostas);
  const brain = conversa.createChatBrain({ ai, logger, env: { ...env }, persona: () => 'PERSONA-DE-TESTE', memoryBlock: () => '', tools: () => [], context: { enabled: () => false } });
  return { ai, brain };
}
const RECUSA = 'Desculpa, não posso ajudar com isso';
const BOA = 'Bora! No Cayo Perico o ideal é começar pelo reconhecimento da ilha e escolher a entrada pelo submarino.';
const PERGUNTA_GTA = 'Yui, qual o melhor jeito de começar o Cayo Perico?';

section('A. A detecção');
await test('só a resposta curta que é SÓ a recusa conta (português e inglês)', () => {
  for (const r of [RECUSA, 'Desculpe, mas não posso ajudar com isso.', 'Sinto muito, não consigo responder isso.', 'Não posso ajudar com isso.', 'Lamento, mas não posso ajudar.', "I'm sorry, but I can't help with that.", 'I cannot help with that request.', 'Não posso fornecer essa informação.']) {
    assert.equal(pareceRecusaGenerica(r), true, r);
  }
});
await test('resposta que explica, resposta normal, texto vazio e coisas parecidas NÃO são recusa genérica', () => {
  for (const r of [
    BOA, '', '   ', null, undefined, 'Claro! Posso ajudar com isso sim.', 'Não posso garantir o horário, mas o reset do GTA costuma sair às 6h da manhã no Brasil e é bom conferir no chat do servidor.',
    'Não posso ajudar com isso, mas posso te explicar como funciona o Cayo Perico: primeiro você faz o reconhecimento da ilha, depois escolhe a entrada e o equipamento certos para o golpe.',
    'Eu poderia ajudar, mas preciso saber qual dificuldade você joga.',
  ]) assert.equal(pareceRecusaGenerica(r), false, String(r));
});
await test('o pedido reforçado traz a pergunta e o contexto de jogo (golpe, assalto e heist são missões)', () => {
  const p = pedidoReforcado(PERGUNTA_GTA);
  assert.ok(p.includes(PERGUNTA_GTA));
  assert.ok(/jogo GTA Online/.test(p) && /MISS(Õ|O)ES do jogo/.test(p) && /heist/.test(p));
});

section('B. O assunto de GTA');
await test('isGtaTopic reconhece o Cayo Perico e golpes; assunto de outro jogo não; o /yui reexporta a MESMA função', async () => {
  assert.equal(isGtaTopic(PERGUNTA_GTA), true);
  assert.equal(isGtaTopic('como faço o golpe do cassino?'), true);
  assert.equal(isGtaTopic('qual a melhor build no Elden Ring?'), false);
  assert.equal(isGtaTopic(''), false);
  assert.equal(isGtaTopic(null), false);
  const ask = await imp('src/discord/commands/ask.js');
  assert.equal(ask.isGtaTopic, isGtaTopic);
});

section('C. No passo do cérebro');
await test('chave desligada (ausente, false, vazia, valor estranho): UMA chamada só e a recusa passa como está', async () => {
  for (const valor of [undefined, 'false', '', '0', 'off', 'talvez']) {
    const { ai, brain } = cerebro(valor === undefined ? {} : { YUI_IA_REFAZER_RECUSA: valor }, [RECUSA, BOA]);
    const r = await brain.turn(turnParams({ text: PERGUNTA_GTA }), META);
    assert.equal(ai.calls.length, 1, `YUI_IA_REFAZER_RECUSA=${valor}`);
    assert.equal(r.text, RECUSA);
  }
});
await test('ligada: recusa genérica a uma pergunta de GTA é refeita UMA vez, com o contexto do jogo, e a nova resposta vale', async () => {
  const { ai, brain } = cerebro({ YUI_IA_REFAZER_RECUSA: 'true' }, [RECUSA, BOA]);
  const r = await brain.turn(turnParams({ text: PERGUNTA_GTA }), META);
  assert.equal(ai.calls.length, 2);
  assert.equal(r.text, BOA);
  assert.ok(ai.calls[1].prompt.includes('[CONTEXTO]') && ai.calls[1].prompt.includes(PERGUNTA_GTA), 'a nova tentativa leva o contexto de jogo e a pergunta');
  assert.ok(!ai.calls[0].prompt.includes('[CONTEXTO] A pergunta é sobre o jogo'), 'a primeira chamada ficou como era');
  assert.ok(logLines.some((l) => /recusa gen/.test(l)), 'registra o refazer (sem o texto da conversa)');
  assert.ok(!logLines.some((l) => l.includes('Cayo Perico')), 'o log não leva a conversa');
});
await test('ligada: se a nova resposta também for recusa, NÃO tenta de novo (no máximo uma) e fica a primeira', async () => {
  const { ai, brain } = cerebro({ YUI_IA_REFAZER_RECUSA: 'true' }, [RECUSA, 'Sinto muito, não posso ajudar com isso.', BOA]);
  const r = await brain.turn(turnParams({ text: PERGUNTA_GTA }), META);
  assert.equal(ai.calls.length, 2, 'só uma nova tentativa');
  assert.equal(r.text, RECUSA);
});
await test('ligada: pergunta que NÃO é de GTA, resposta normal e chamada que não é a principal não refazem nada', async () => {
  const fora = cerebro({ YUI_IA_REFAZER_RECUSA: 'true' }, [RECUSA, BOA]);
  assert.equal((await fora.brain.turn(turnParams({ text: 'como faço um bolo de cenoura?' }), META)).text, RECUSA);
  assert.equal(fora.ai.calls.length, 1, 'fora de jogo: recusa respeitada');
  const normal = cerebro({ YUI_IA_REFAZER_RECUSA: 'true' }, [BOA]);
  assert.equal((await normal.brain.turn(turnParams({ text: PERGUNTA_GTA }), META)).text, BOA);
  assert.equal(normal.ai.calls.length, 1);
  const secundaria = cerebro({ YUI_IA_REFAZER_RECUSA: 'true' }, [RECUSA, BOA]);
  await secundaria.brain.turn(turnParams({ text: PERGUNTA_GTA, options: { main: false } }), META);
  assert.equal(secundaria.ai.calls.length, 1, 'passo que não é o principal não refaz');
});
await test('ligada: uma falha na nova tentativa não derruba a resposta (fica a primeira)', async () => {
  const { ai, brain } = cerebro({ YUI_IA_REFAZER_RECUSA: 'true' }, [RECUSA, () => { throw new Error('rede caiu'); }]);
  const r = await brain.turn(turnParams({ text: PERGUNTA_GTA }), META);
  assert.equal(ai.calls.length, 2);
  assert.equal(r.text, RECUSA);
  assert.equal(r.failed, false);
});

console.log(`\n${passed} testes OK${failures.length ? `; ${failures.length} FALHARAM: ${failures.join(' | ')}` : ''}`);
try { process.chdir(repoRoot); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* */ }
process.exit(failures.length ? 1 : 0);
