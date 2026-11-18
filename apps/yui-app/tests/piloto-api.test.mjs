// Testes do piloto do app contra a Yui API REAL (servidor de verdade, sem IA nem Discord): o diagnóstico completo (só o dono, só leitura, só o que o servidor já filtra)
// e o "Reiniciar a Yui" (o que o servidor responde nos dois modos). Execução: npm test   (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-app-piloto-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_OWNER_ID = '111';
process.env.YUI_MEMORY_ENABLED = 'false';
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_LOG_DIR = path.join(tmp, 'logs');
process.env.YUI_AI_SETTINGS_FILE = path.join(tmp, 'secrets', 'ai-providers.json');
for (const k of ['GROQ_API_KEY', 'GROQ_API_KEYS', 'YUI_GATEWAY_DISABLE', 'YUI_GATEWAY_CUSTOM', 'YUI_IA_PERFIS', 'YUI_IA_PERFIS_ARQUIVO', 'AI_BASE_URL', 'AI_BACKEND']) delete process.env[k];
fs.mkdirSync(process.env.YUI_LOG_DIR, { recursive: true });

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const { createApiServer, parseTokens, parseCorsOrigins } = await import(`file://${root}/src/core/api/server.js`);
const { createAdmin } = await import(`file://${root}/src/core/api/admin.js`);
const { closeAllDatabases } = await import(`file://${root}/src/database/db.js`);
const { createClient, ApiError } = await import('../src/api/client.ts');
const { visaoDoDiagnostico, podeVerDiagnostico } = await import('../src/diagnosticoLogic.ts');
const { confirmacaoDeReinicio } = await import('../src/restartLogic.ts');

const OWNER = 'owner-token-0123456789';
const MEMBER = 'member-token-0123456789';
const SEGREDO = 'tok-SEGREDO-DO-DIAGNOSTICO-9f3a';
const fontes = {
  // o que o cérebro e o Core entregam, ENVENENADO com um segredo em campos que o servidor NÃO promete: o servidor filtra (lista de permitidos) e o app só mostra o que veio
  cerebro: () => ({ uptimeSegundos: 4000, backend: 'gateway', ponteDoBot: false, canal: { conexoes: 1, texto: SEGREDO }, conversa: { turnos: 3 }, pesquisa: { pedidas: 1 }, travasPerdidas: 0, token: SEGREDO }),
  perfisIa: () => ({
    configurado: true, origem: 'arquivo', errosDeConfiguracao: [],
    perfis: [{ nome: 'conversa', habilitado: true, privacidade: 'geral', combo: 'auto', provedorDaYui: 'omniroute', provedorCadastrado: true, maxTokens: 1024, limiteEfetivo: 1024, capacidadeConhecida: null, chamadas: 4, ok: 3, erros: 0, fallbacks: 1, fechadas: 0, recusadasPorPrivacidade: 0, prompt: SEGREDO }],
    totais: { chamadas: 4, ok: 3, erros: 0, fallbacks: 1, fechadas: 0, recusadasPorPrivacidade: 0 },
    ultimas: [{ quando: new Date().toISOString(), ponto: 'conversa', perfil: 'conversa', combo: 'auto', provedor: 'groq', estrategia: 'priority', fallback: false, limiteTokens: 1024, latenciaMs: 300, resultado: 'ok', decisao: 'confirmada', motivo: null, cabecalho: SEGREDO }],
    rotaPrivada: { estado: 'nao-validada', motivo: 'tempo-esgotado', motivos: [], formatoDefinido: true, sondas: 5, sondasOk: 0, violacoes: 0, ultimaSondaHaSegundos: 90, falhasSeguidas: 5, sondaSozinhaPausada: false, falhasRecentes: [{ haSegundos: 90, motivo: 'tempo-esgotado' }, { haSegundos: 400, motivo: 'rede' }] },
  }),
  motor: () => ({ pedido: 'nativo', recusado: false, motivo: null }),
};
const pedidos = [];
let resposta = { aceito: true, motivo: 'aceito' };
const server = createApiServer({
  tokens: parseTokens(`${OWNER}=111,${MEMBER}=222`), corsOrigins: parseCorsOrigins(''),
  admin: createAdmin({ deps: { modoDiagnostico: 'cerebro-separado', diagnostico: fontes }, exit: () => { throw new Error('o exit nunca pode ser usado quando o supervisor cuida do reinício'); }, reinicio: async (p) => { pedidos.push(p); return resposta; } }),
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.closeAllConnections?.(); server.close(); closeAllDatabases(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('diagnóstico: o dono lê pelo cliente do app, o membro recebe 403 e o app nem o pede (não é dono)', async () => {
  const owner = createClient({ baseUrl: url, token: OWNER });
  const d = await owner.admin.diagnostico();
  assert.equal(d.versao, 1);
  assert.equal(d.modo, 'cerebro-separado');
  assert.ok(['ok', 'atencao', 'problema'].includes(d.estado));
  assert.ok(d.perfisDeIa && d.motorAgente, 'o que a etapa 9 acrescentou');
  assert.equal(d.perfisDeIa.rotaPrivada.estado, 'nao-validada');
  assert.equal(d.perfisDeIa.rotaPrivada.falhasSeguidas, 5);
  assert.equal(d.perfisDeIa.rotaPrivada.falhasRecentes.length, 2);
  const member = createClient({ baseUrl: url, token: MEMBER });
  await assert.rejects(member.admin.diagnostico(), (e) => e instanceof ApiError && e.status === 403 && /Acesso negado/.test(e.message));
  const me = await member.me();
  assert.equal(podeVerDiagnostico(me.role), false, 'a tela do membro não pede o diagnóstico');
  assert.equal(podeVerDiagnostico((await owner.me()).role), true);
  await assert.rejects(createClient({ baseUrl: url, token: 'token-errado-0123456789' }).admin.diagnostico(), (e) => e.status === 401);
});

test('diagnóstico de verdade -> cartões da tela: tudo que o servidor entrega aparece e o segredo plantado nunca (nem no payload nem na tela)', async () => {
  const d = await createClient({ baseUrl: url, token: OWNER }).admin.diagnostico();
  assert.ok(!JSON.stringify(d).includes(SEGREDO), 'o servidor já filtra por lista de permitidos');
  const v = visaoDoDiagnostico(d);
  assert.ok(!JSON.stringify(v).includes(SEGREDO));
  const chaves = v.cartoes.map((c) => c.chave);
  for (const k of ['geral', 'processos', 'ia', 'limites', 'cotas', 'perfis', 'rota-privada', 'motor', 'erros']) assert.ok(chaves.includes(k), `falta o cartão ${k}: ${chaves.join(', ')}`);
  const rota = v.cartoes.find((c) => c.chave === 'rota-privada');
  assert.deepEqual(rota.selo, { texto: 'Não validada', tom: 'atencao' });
  assert.equal(rota.linhas.find((l) => l.rotulo === 'Falhas seguidas da verificação').valor, '5');
  assert.deepEqual(rota.itens.map((i) => i.titulo.replace(/^há \d+ \w+ · /, '')), ['tempo esgotado', 'falha de rede']);
  const perfis = v.cartoes.find((c) => c.chave === 'perfis');
  assert.ok(perfis.itens.some((i) => /Provedor que respondeu: groq · Estratégia: priority · Caminho de sempre usado: não · Limite: 1\.024 tokens · Demorou: 300 ms/.test(i.detalhe ?? '')));
  assert.match(v.cartoes.find((c) => c.chave === 'processos').titulo, /Cérebro e bot/);
  // a rota privada "não validada" pede atenção no estado geral (o servidor decide; o app só mostra)
  assert.equal(d.estado, 'atencao');
  assert.ok(v.cartoes[0].itens.some((i) => /perfil privado da IA está declarado/.test(i.titulo)));
});

test('reiniciar (dois processos): o cliente recebe a verdade do servidor (cérebro e bot) e o `exit` nunca é usado; a confirmação do app diz o mesmo', async () => {
  const owner = createClient({ baseUrl: url, token: OWNER });
  pedidos.length = 0;
  resposta = { aceito: true, motivo: 'aceito' };
  const r = await owner.admin.restart();
  assert.equal(r.ok, true);
  assert.equal(r.escopo, 'cerebro-e-bot');
  assert.match(r.message, /cérebro e o bot do Discord/);
  assert.deepEqual(pedidos, [{ motivo: 'pedido-do-dono' }]);
  const texto = confirmacaoDeReinicio({ cerebro: { botConectado: true } }).mensagem;
  assert.match(texto, /DOIS/);
  // o membro nunca reinicia
  await assert.rejects(createClient({ baseUrl: url, token: MEMBER }).admin.restart(), (e) => e instanceof ApiError && e.status === 403);
  assert.equal(pedidos.length, 1);
});

test('reiniciar recusado pelo supervisor: o app lê que NADA foi reiniciado e o motivo (503 sem supervisor, 409 já em curso, 504 sem resposta)', async () => {
  const owner = createClient({ baseUrl: url, token: OWNER });
  for (const [motivo, status, texto] of [['sem-supervisor', 503, /Nada foi reiniciado/], ['ja-em-curso', 409, /já existe um reinício em andamento/i], ['sem-resposta', 504, /não respondeu/i]]) {
    resposta = { aceito: false, motivo };
    await assert.rejects(owner.admin.restart(), (e) => e instanceof ApiError && e.status === status && texto.test(e.message), motivo);
  }
  resposta = { aceito: true, motivo: 'aceito' };
});
