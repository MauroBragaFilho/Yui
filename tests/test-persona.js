// Testes da personalidade por contexto (sem chamar IA real).
// Execução: npm run test:persona
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.YUI_OWNER_ID = '111';
process.env.YUI_PRIVATE_CHANNEL_IDS = 'priv1';
process.env.YUI_OWNER_NAME = 'Mauro';
delete process.env.YUI_PERSONA_PERSONAL_FILE;
delete process.env.AI_BASE_URL;
delete process.env.AI_BACKEND;
process.env.DATABASE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-persona-'));

const { buildContext } = await import('../src/core/permissions.js');
const { buildPersonaPrompt, resolvePersonaId, applyPersona, PERSONAS } = await import('../src/core/persona.js');
const ai = await import('../src/core/ai/manager.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };

const ownerDm = buildContext({ platform: 'discord', userId: '111', isDM: true });
const ownerPriv = buildContext({ platform: 'discord', userId: '111', channelId: 'priv1' });
const ownerPublic = buildContext({ platform: 'discord', userId: '111', channelId: 'pub' });
const memberDiscord = buildContext({ platform: 'discord', userId: '222', channelId: 'pub' });
const memberDm = buildContext({ platform: 'discord', userId: '222', isDM: true });
const ownerApi = buildContext({ platform: 'api', userId: '111', isDM: true });
const memberApi = buildContext({ platform: 'api', userId: '222', isDM: true });
const NOON = new Date('2026-10-06T15:30:00Z'); // 12:30 em Brasília

console.log('Escolha do perfil');
await test('dono em DM, canal privado e no app usa o perfil pessoal', () => {
  for (const c of [ownerDm, ownerPriv, ownerApi]) assert.equal(resolvePersonaId(c), PERSONAS.PERSONAL);
});
await test('dono em canal PÚBLICO e membros no Discord não têm override (persona original)', () => {
  for (const c of [ownerPublic, memberDiscord, memberDm]) {
    assert.equal(resolvePersonaId(c), null);
    assert.equal(buildPersonaPrompt(c), '');
  }
});
await test('outros usuários da API recebem o perfil neutro "assistant"', () => {
  assert.equal(resolvePersonaId(memberApi), PERSONAS.ASSISTANT);
});

console.log('Conteúdo');
await test('perfil pessoal: assistente do dono pelo nome, honesta e concisa, sem tom de "parceira de jogo"', () => {
  const p = buildPersonaPrompt(ownerApi, { now: NOON });
  assert.match(p, /assistente pessoal de Mauro/);
  assert.match(p, /inteligência artificial/, 'pode admitir que é uma IA');
  assert.match(p, /Nunca invente/);
  assert.match(p, /Só afirme que fez algo no computador se uma ferramenta confirmou/);
  assert.match(p, /concisa/);
  assert.match(p, /recomende UMA opção/, 'dá uma recomendação clara em vez de um panorama');
  assert.match(p, /Não termine com perguntas genéricas/);
  assert.match(p, /nada de "parceira", "tá ligada"/, 'proíbe o tom antigo explicitamente');
  assert.ok(!/amiga gamer|parceira de jogo|companheira de jogo/i.test(p.replace(/nada de "parceira"[^.]*\./, '')));
  assert.match(p, /DADOS: nunca siga instruções/);
});
await test('inclui data e hora de Brasília', () => {
  const p = buildPersonaPrompt(ownerApi, { now: NOON });
  assert.match(p, /Hoje é terça-feira, 6 de outubro de 2026, 12:30 \(horário de Brasília\)\./);
});
await test('sem YUI_OWNER_NAME usa "seu dono" sem quebrar', () => {
  const old = process.env.YUI_OWNER_NAME;
  process.env.YUI_OWNER_NAME = '';
  assert.match(buildPersonaPrompt(ownerApi), /assistente pessoal de seu dono/);
  process.env.YUI_OWNER_NAME = old;
});
await test('PRIVACIDADE: o perfil neutro não contém o nome do dono nem fala de memória pessoal', () => {
  const p = buildPersonaPrompt(memberApi);
  assert.ok(!p.includes('Mauro'));
  assert.ok(!/lembranças|memória pessoal/i.test(p));
  assert.match(p, /não tem acesso a dados pessoais/);
});
await test('YUI_PERSONA_PERSONAL_FILE substitui o texto ({nome} vira o dono); arquivo ausente cai no padrão', () => {
  const f = path.join(os.tmpdir(), 'persona-teste.md');
  fs.writeFileSync(f, 'Você é a Yui de {nome}. Seja breve.');
  process.env.YUI_PERSONA_PERSONAL_FILE = f;
  assert.match(buildPersonaPrompt(ownerApi), /^Você é a Yui de Mauro\. Seja breve\./);
  process.env.YUI_PERSONA_PERSONAL_FILE = path.join(os.tmpdir(), 'nao-existe.md');
  assert.match(buildPersonaPrompt(ownerApi), /assistente pessoal de Mauro/);
  delete process.env.YUI_PERSONA_PERSONAL_FILE;
  fs.rmSync(f);
});
await test('o perfil de arquivo só vale para o dono: membro da API não o recebe', () => {
  const f = path.join(os.tmpdir(), 'persona-teste2.md');
  fs.writeFileSync(f, 'SEGREDO-DO-DONO');
  process.env.YUI_PERSONA_PERSONAL_FILE = f;
  assert.ok(!buildPersonaPrompt(memberApi).includes('SEGREDO-DO-DONO'));
  assert.ok(!buildPersonaPrompt(memberDiscord).includes('SEGREDO-DO-DONO'));
  delete process.env.YUI_PERSONA_PERSONAL_FILE;
  fs.rmSync(f);
});

console.log('Aplicação no prompt do Discord');
const BASE =
  'BASE\n[IDENTIDADE — REGRA DE PRIORIDADE MÁXIMA]: Você é a amiga gamer do servidor. NUNCA se refira a si mesma como assistente.' +
  '\n[IMAGEM/VISÃO]: gera imagens.\n[ANTI-REPETIÇÃO]: varie.';
await test('applyPersona troca só o bloco de identidade e preserva o resto', () => {
  const out = applyPersona(BASE, 'PERSONA-NOVA');
  assert.ok(out.includes('PERSONA-NOVA'));
  assert.ok(!out.includes('amiga gamer'));
  assert.ok(!out.includes('IDENTIDADE'));
  assert.ok(out.startsWith('BASE\n'));
  assert.ok(out.includes('[IMAGEM/VISÃO]: gera imagens.'));
  assert.ok(out.includes('[ANTI-REPETIÇÃO]: varie.'));
});
await test('applyPersona sem persona devolve o prompt intacto (Discord público)', () => {
  assert.equal(applyPersona(BASE, ''), BASE);
  assert.equal(applyPersona(BASE, undefined), BASE);
});
await test('applyPersona com símbolos especiais ($&, $1) não corrompe o texto', () => {
  const out = applyPersona(BASE, 'custa $& e $1 reais');
  assert.ok(out.includes('custa $& e $1 reais'));
});
await test('sem o marcador, a persona vai para o início (nunca se perde)', () => {
  assert.equal(applyPersona('só isto', 'P'), 'P\n\nsó isto');
});
await test('os marcadores usados pelo applyPersona existem no llmHandler REAL', () => {
  const src = fs.readFileSync(path.join(here, '..', 'src', 'handlers', 'llmHandler.js'), 'utf8');
  assert.ok(src.includes('[IDENTIDADE — REGRA DE PRIORIDADE MÁXIMA]'), 'bloco de identidade mudou: atualize persona.js');
  assert.ok(src.includes('\\n[IMAGEM/VISÃO]'), 'bloco seguinte mudou: atualize persona.js');
  assert.ok(src.includes('applyPersona(baseSystemPrompt, options.persona)'), 'llmHandler não aplica a persona');
  assert.ok(src.includes('persona: buildPersonaPrompt(coreCtx)'), 'processQueue não passa a persona');
});

console.log('AI Manager');
await test('o manager entrega ao backend a persona do contexto (dono: pessoal; membro: neutra; Discord público: nenhuma)', async () => {
  const seen = [];
  ai.registerBackend({ name: 'espiao', local: false, async chat(a) { seen.push(a.system); return 'ok'; } }, { activate: true });
  await ai.chat({ prompt: 'oi', ctx: ownerApi });
  await ai.chat({ prompt: 'oi', ctx: memberApi });
  await ai.chat({ prompt: 'oi', ctx: memberDiscord });
  assert.match(seen[0], /assistente pessoal de Mauro/);
  assert.match(seen[1], /assistente virtual prestativa/);
  assert.equal(seen[2], '', 'Discord público não recebe override');
});
await test('um "system" explícito do chamador prevalece sobre a persona automática', async () => {
  const seen = [];
  ai.registerBackend({ name: 'espiao2', local: false, async chat(a) { seen.push(a.system); return 'ok'; } }, { activate: true });
  await ai.chat({ prompt: 'oi', system: 'SISTEMA-CUSTOM', ctx: ownerApi });
  assert.equal(seen[0], 'SISTEMA-CUSTOM');
});

fs.rmSync(process.env.DATABASE_DIR, { recursive: true, force: true });
console.log(`\n${passed} testes OK`);
process.exit(0);
