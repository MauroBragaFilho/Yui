// Live dos amigos, etapa 1, com o CÉREBRO E O BOT SEPARADOS: o canal de verdade (WebSocket local) roda neste processo, como em test-memoria-admin.js.
// Cobre os testes 35 a 41 e 50 do plano (docs/PLANO_TECNICO_LIVE_AMIGOS_ETAPA1.md §11.2 e §11.5). O Discord é falso; nada sai para a rede.
// Execução: npm run test:liveamigoscanal
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useIsolatedDatabaseDir, assertNotRealDatabaseDir } from './helpers/isolatedDatabaseDir.js';
import { rodarSobBloqueio, EXCECOES_DO_CANAL } from './helpers/bloqueioExternoTeste.js';

rodarSobBloqueio(import.meta.url, { teste: 'test:liveamigoscanal', liberar: { ...EXCECOES_DO_CANAL } });

const isolated = useIsolatedDatabaseDir('yui-live-amigos-canal-');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-live-amigos-canal-cwd-'));
process.chdir(work);
const OWNER = '111111111111111111';
const AMIGO = '222222222222222222';
const OUTRO = '444444444444444444';
const CANAL = 'UCaaaaaaaaaaaaaaaaaaaaaa';
process.env.YUI_OWNER_ID = OWNER;
process.env.YUI_LIVE_AMIGOS = 'true';
process.env.YUI_AUDIT_FILE = path.join(work, 'logs', 'audit.jsonl');
delete process.env.YUI_POLICY_MODE;

const { config } = await import('../src/config/index.js');
assertNotRealDatabaseDir(path.resolve(config.database.dir));
const { startChannelServer } = await import('../src/core/channel/server.js');
const { connectChannel } = await import('../src/core/channel/client.js');
const { registrarLiveAmigos } = await import('../src/cerebro/liveAmigos.js');
const { startBotChannel } = await import('../src/discord/canalCerebro.js');
const { portaLiveAmigos, definirPortaLiveAmigos } = await import('../src/core/liveAmigos/porta.js');
const { criarStoreLiveAmigos } = await import('../src/core/liveAmigos/store.js');
const { TEXTOS } = await import('../src/core/liveAmigos/servico.js');
const { portaA, FALHA_FIXA } = await import('../src/discord/liveAmigosDiscord.js');
const { verifyAudit } = await import('../src/core/audit.js');

let passed = 0;
let finished = false;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

// O Discord falso do bot: DMs e mensagens anotadas, nada sai.
const dms = [];
const nonces = [];
const editadas = [];
let queda = null;
const clienteFalso = {
  isReady: () => true,
  user: { id: '900000000000000099' },
  users: {
    fetch: async (id) => ({
      id, username: `u${id.slice(0, 3)}`,
      send: async (p) => {
        // Quedas simuladas da conexão do bot (testes 37 e 49): o handler do próprio bot derruba a conexão.
        if (queda === 'antes-de-enviar' && id === AMIGO) { queda = null; bot.close(); throw new Error('conexão caiu'); }
        dms.push([id, p.content]);
        nonces.push(p.nonce ?? null);
        if (queda === 'depois-de-enviar' && id === AMIGO) { queda = null; bot.close(); throw new Error('conexão caiu depois do envio'); }
        return { id: 'm' };
      },
    }),
  },
  channels: { fetch: async () => ({ guildId: null, messages: { fetch: async (mid) => ({ author: { id: '900000000000000099' }, edit: async (p) => editadas.push([mid, p.content]), delete: async () => editadas.push([mid, 'apagada']) }) } }) },
};
const mensagem = (autor, content, id) => {
  const enviados = [];
  return { enviados, guildId: null, author: { id: autor, bot: false }, content, attachments: { size: 0 }, reference: null, id, channelId: '900000000000000050', channel: { send: async (p) => { enviados.push(p); return { id: `r${id}`, channelId: '900000000000000050' }; } } };
};
const clicar = (userId, customId, id) => portaLiveAmigos().botao({ userId, customId, idem: id });

const secretFile = path.join(work, 'secrets', 'canal.json');
const server = await startChannelServer({ port: 0, secretFile, logger: quiet });
const { servico, parar } = registrarLiveAmigos({ channel: server, logger: quiet, agendar: false });
let bot = null;
const ligarBot = () => startBotChannel({ getClient: () => clienteFalso, logger: quiet, idemFile: null, connect: (o) => connectChannel({ ...o, secretFile, logger: quiet, minBackoffMs: 50, maxBackoffMs: 200 }) });
const store = criarStoreLiveAmigos();

try {
  bot = ligarBot();
  await bot.ready(10_000);

  console.log('Cérebro e bot separados (testes 35 a 41 e 50)');
  let codigo = null;
  await test('35. autorizar pelo canal: da frase na Porta A ao clique; o vínculo nasce no cérebro', async () => {
    assert.ok(portaLiveAmigos(), 'o bot montou a porta do canal');
    const m = mensagem(OWNER, `autoriza amigo da live ${AMIGO} canal ${CANAL}`, '1001');
    assert.equal(await portaA(m, clienteFalso), true);
    const botoes = m.enviados[0].components[0].components.map((c) => c.data.custom_id);
    assert.match(m.enviados[0].content, /Não prova que o canal é dessa pessoa/);
    const r = await clicar(OWNER, botoes[0], 'c1');
    assert.match(r.texto, /Pronto: amigo autorizado/);
    codigo = r.codigo;
    assert.equal(store.lerVinculos().length, 1);
  });
  await test('38. a repetição com o mesmo idem devolve a mesma resposta e a operação acontece uma vez só', async () => {
    const m = mensagem(OWNER, 'lista os amigos da live', '1002');
    const a = await portaLiveAmigos().comando({ userId: OWNER, texto: m.content, idem: 'mesmo' });
    const b = await portaLiveAmigos().comando({ userId: OWNER, texto: m.content, idem: 'mesmo' });
    assert.deepEqual(a, b);
    const r1 = await portaLiveAmigos().comando({ userId: OWNER, texto: `revoga o amigo ${codigo}`, idem: 'rev' });
    const conf = r1.botoes[1].customId; // cancelar, para manter o vínculo
    const x = await clicar(OWNER, conf, 'dup');
    const y = await clicar(OWNER, conf, 'dup');
    assert.deepEqual(x, y);
    assert.equal(store.lerVinculos().length, 1);
  });
  await test('37. o canal cai: o bot responde com a frase fixa; ao voltar, nada duplicou', async () => {
    await bot.close();
    const m = mensagem(OWNER, 'lista os amigos da live', '1003');
    assert.equal(await portaA(m, clienteFalso, { porta: portaLiveAmigos() }), true);
    assert.equal(m.enviados.at(-1).content, FALHA_FIXA);
    bot = ligarBot();
    await bot.ready(10_000);
    assert.equal(store.lerVinculos().length, 1);
    assert.equal(servico.estado().bloqueados, 0);
  });
  await test('36. revogar e "apagar meus dados" pelo canal: a rotina roda no cérebro; o aviso sai pelo liveamigos.avisar', async () => {
    const r = await portaLiveAmigos().comando({ userId: OWNER, texto: `revoga o amigo ${codigo}`, idem: 'rev2' });
    const f = await clicar(OWNER, r.botoes[0].customId, 'c2');
    assert.match(f.texto, /revogado/);
    assert.equal(store.lerVinculos().length, 0);
    assert.deepEqual(dms.at(-1), [AMIGO, TEXTOS.avisoAmigoRevogado]);
    // de novo, agora o próprio amigo apaga
    const nova = await portaLiveAmigos().comando({ userId: OWNER, texto: `autoriza amigo da live ${AMIGO} canal ${CANAL}`, idem: 'aut2' });
    await clicar(OWNER, nova.botoes[0].customId, 'c3');
    const m = mensagem(AMIGO, 'apagar meus dados da live', '1004');
    assert.equal(await portaA(m, clienteFalso), true);
    const a = await clicar(AMIGO, m.enviados[0].components[0].components[0].data.custom_id, 'c4');
    assert.equal(a.texto, TEXTOS.feitoApagar);
    assert.equal(store.lerVinculos().length, 0);
    assert.ok(dms.at(-1)[0] === OWNER && /apagou o próprio vínculo/.test(dms.at(-1)[1]) && !dms.at(-1)[1].includes(AMIGO));
  });
  // Quedas DE VERDADE da conexão do bot no meio da operação (parecer da Liz de 28/11/2026): o próprio handler do bot derruba a conexão.
  async function revogarComQueda(momento) {
    const nova = await portaLiveAmigos().comando({ userId: OWNER, texto: `autoriza amigo da live ${AMIGO} canal ${CANAL}`, idem: `aut-${momento}` });
    const f = await clicar(OWNER, nova.botoes[0].customId, `c-${momento}`);
    const r = await portaLiveAmigos().comando({ userId: OWNER, texto: `revoga o amigo ${f.codigo}`, idem: `rev-${momento}` });
    queda = momento;
    const antes = dms.length;
    // O clique do bot pode voltar ou perder a resposta (a conexão cai durante a operação): os dois casos são válidos.
    await clicar(OWNER, r.botoes[0].customId, `cq-${momento}`).catch(() => null);
    for (let i = 0; i < 50 && servico.estado().bloqueados === 0; i++) await new Promise((res) => setTimeout(res, 20));
    return { codigo: f.codigo, antes };
  }
  await test('37. queda da conexão do bot DURANTE a revogação: os dados já saíram; o aviso fica no diário e sai na retomada, depois de o bot voltar', async () => {
    const { codigo, antes } = await revogarComQueda('antes-de-enviar');
    assert.equal(store.lerVinculos().length, 0, 'o vínculo já foi apagado no cérebro');
    const d = store.lerDiario();
    assert.equal(d.encerramentos.length, 1);
    assert.equal(d.encerramentos[0].passo, 'auditado');
    assert.equal(dms.length, antes, 'a DM não saiu');
    bot = ligarBot();
    await bot.ready(10_000);
    await servico.retomar();
    assert.deepEqual(dms.at(-1), [AMIGO, TEXTOS.avisoAmigoRevogado]);
    assert.equal(store.lerDiario().encerramentos.length, 0);
    const regs = fs.readFileSync(process.env.YUI_AUDIT_FILE, 'utf8').split('\n').filter((l) => l.includes('"live_amigos.encerramento"') && l.includes(codigo));
    assert.equal(regs.length, 1, 'uma conclusão só na auditoria');
  });
  await test('49. o bot cai DEPOIS de mandar a DM e antes de o diário anotar: na volta o aviso sai de novo (aceito), com a mesma chave, e nada mais se repete', async () => {
    const { codigo, antes } = await revogarComQueda('depois-de-enviar');
    assert.equal(dms.length, antes + 1, 'a DM saiu uma vez');
    assert.equal(store.lerDiario().encerramentos.length, 1, 'mas o diário não anotou');
    bot = ligarBot();
    await bot.ready(10_000);
    await servico.retomar();
    assert.equal(dms.length, antes + 2, 'saiu de novo na retomada');
    assert.equal(nonces.at(-1), nonces.at(-2), 'a mesma nonce (o Discord de verdade devolve a mensagem que já existe, por alguns minutos)');
    assert.equal(store.lerDiario().encerramentos.length, 0);
    assert.equal(store.lerVinculos().length, 0);
    const regs = fs.readFileSync(process.env.YUI_AUDIT_FILE, 'utf8').split('\n').filter((l) => l.includes('"live_amigos.encerramento"') && l.includes(codigo));
    assert.equal(regs.length, 1);
  });
  await test('39. o store aberto no papel de bot é recusado', () => {
    assert.throws(() => criarStoreLiveAmigos({ env: { ...process.env, YUI_DB_OWNER_ROLE: 'bot' } }), (e) => e.code === 'PAPEL_ERRADO');
  });
  await test('40. liveamigos.avisar para quem não é o dono, fora do texto fixo: recusado pelo bot', async () => {
    await assert.rejects(server.request('bot', 'liveamigos.avisar', { userId: OUTRO, texto: 'qualquer coisa', chave: 'z' }), (e) => e.code === 'FORBIDDEN');
    assert.ok(!dms.some((d) => d[0] === OUTRO));
  });
  await test('50. liveamigos.comando e liveamigos.botao chamados por uma conexão que não é do papel bot: recusados antes do serviço', async () => {
    const app = connectChannel({ role: 'app', secretFile, logger: quiet, minBackoffMs: 50, maxBackoffMs: 200 });
    try {
      await app.ready(10_000);
      for (const metodo of ['liveamigos.comando', 'liveamigos.botao', 'liveamigos.mensagem']) {
        await assert.rejects(app.request(metodo, { userId: OWNER, texto: 'lista os amigos da live', customId: 'liveamg_ok_0123456789abcdef' }), (e) => e.code === 'METHOD_NOT_ALLOWED', metodo);
      }
    } finally { await app.close(); }
  });
  await test('limpeza pelo canal: o cérebro pede, o bot edita só mensagens da própria Yui e devolve só o resultado', async () => {
    const r = await server.request('bot', 'liveamigos.limparDm', { messageId: '900000000000000070', channelId: '900000000000000050', acao: 'editar', texto: TEXTOS.venceu });
    assert.deepEqual(r, { feito: true });
    assert.deepEqual(editadas.at(-1), ['900000000000000070', TEXTOS.venceu]);
  });
  await test('41. a auditoria (escrita só pelo cérebro) não tem userId nem IDs; a corrente está íntegra', () => {
    const linhas = fs.readFileSync(process.env.YUI_AUDIT_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const nossas = linhas.filter((e) => String(e.event).startsWith('live_amigos.') || (e.event === 'policy.evaluate' && String(e.action).startsWith('live_amigos.')));
    assert.ok(nossas.length >= 5);
    for (const e of nossas) assert.equal(e.userId, null);
    const texto = JSON.stringify(linhas);
    for (const id of [OWNER, AMIGO, OUTRO, CANAL]) assert.ok(!texto.includes(id), `a auditoria tem ${id}`);
    assert.equal(verifyAudit(process.env.YUI_AUDIT_FILE).ok, true);
  });

  console.log(`\n${passed} testes OK`);
  finished = true;
} finally {
  try { parar(); } catch { /* */ }
  definirPortaLiveAmigos(null);
  try { await bot?.close(); } catch { /* */ }
  try { await server.close(); } catch { /* */ }
  try { (await import('../src/database/db.js')).closeAllDatabases(); } catch { /* */ }
  try { (await import('../src/utils/logger.js')).logger.close(); } catch { /* */ }
  process.chdir(os.tmpdir());
  await new Promise((r) => setTimeout(r, 200));
  try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* */ }
  isolated.cleanup();
}
process.exit(finished ? 0 : 1);
