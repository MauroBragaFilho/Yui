// Live dos amigos, etapa 1 (vínculos), no PROCESSO ÚNICO: docs/PLANO_TECNICO_LIVE_AMIGOS_ETAPA1.md (versão 3, aprovada pela Liz em 27/11/2026), §11.
// Cobre os testes 1 a 34 e 42 a 56 do plano (os de cérebro e bot separados ficam em test-live-amigos-canal.js). Nada toca o Discord nem o YouTube de verdade.
// Execução: npm run test:liveamigos
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useIsolatedDatabaseDir, assertNotRealDatabaseDir } from './helpers/isolatedDatabaseDir.js';

const isolated = useIsolatedDatabaseDir('yui-live-amigos-');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-live-amigos-cwd-'));
process.chdir(work);
const OWNER = '111111111111111111';
const AMIGO = '222222222222222222';
const AMIGO2 = '333333333333333333';
const OUTRO = '444444444444444444';
const CANAL = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const CANAL2 = 'UCbbbbbbbbbbbbbbbbbbbbbb';
process.env.YUI_OWNER_ID = OWNER;
process.env.YUI_AUDIT_FILE = path.join(work, 'logs', 'audit.jsonl');
delete process.env.YUI_POLICY_MODE;
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { config } = await import('../src/config/index.js');
assertNotRealDatabaseDir(path.resolve(config.database.dir));
const { criarServicoLiveAmigos, TEXTOS, novoCodigo } = await import('../src/core/liveAmigos/servico.js');
const { criarStoreLiveAmigos, NOME_VINCULOS, NOME_DIARIO } = await import('../src/core/liveAmigos/store.js');
const { conferirLiveAmigos } = await import('../src/core/liveAmigos/camada.js');
const { reconhecerFrase } = await import('../src/core/liveAmigos/frases.js');
const { definirServicoLiveAmigos, apagarVinculoDe } = await import('../src/core/liveAmigos/porta.js');
const { createPolicyEngine } = await import('../src/core/security/policyEngine.js');
const { audit, verifyAudit } = await import('../src/core/audit.js');
const { portaA, handleLiveAmigosButton, acoesDoDiscord, montarMensagem, FALHA_FIXA } = await import('../src/discord/liveAmigosDiscord.js');
const ret = await import('../src/core/auditRetencao.js');
const backup = await import('../src/core/memory/backup.js');

let passed = 0;
let finished = false;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const ehDono = (id) => String(id) === OWNER;
const linhasDaAuditoria = () => (fs.existsSync(process.env.YUI_AUDIT_FILE) ? fs.readFileSync(process.env.YUI_AUDIT_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const eventos = (nome) => linhasDaAuditoria().filter((e) => e.event === nome);

let relogio = Date.parse('2026-12-01T12:00:00Z');
const agora = () => relogio;
let contador = 0;

/** Um serviço novo sobre uma pasta própria (ou a mesma, para simular a reinicialização). */
function montar({ pasta = null, modo = 'observe', ligado = true, falhar = () => {}, avisarOk = () => true, limparOk = () => ({ feito: true }), gravar = undefined } = {}) {
  const dir = pasta ?? fs.mkdtempSync(path.join(isolated.dir, `caso-${++contador}-`));
  const env = { ...process.env, DATABASE_DIR: dir, YUI_LIVE_AMIGOS: ligado ? 'true' : 'false' };
  const avisos = [];
  const limpezas = [];
  const store = criarStoreLiveAmigos({ env, ...(gravar ? { gravar } : {}) });
  const engine = createPolicyEngine({ env: { YUI_POLICY_MODE: modo }, auditFn: audit, readOnly: () => false });
  const s = criarServicoLiveAmigos({
    env, store, engine, ehDono, agora, logger: quiet, falhar,
    avisar: async (a) => { avisos.push(a); return avisarOk(a); },
    limparDm: async (l) => { limpezas.push(l); return limparOk(l); },
  });
  return { s, dir, env, store, avisos, limpezas };
}
const confirmar = async (s, userId, r) => s.botao({ userId, customId: r.botoes[0].customId });
const cancelar = async (s, userId, r) => s.botao({ userId, customId: r.botoes[1].customId });
async function autorizar(m, discordId = AMIGO, canal = CANAL) {
  const r = await m.s.comando({ userId: OWNER, texto: `autoriza amigo da live ${discordId} canal ${canal}` });
  assert.ok(r.botoes, `pediu confirmação: ${r.texto}`);
  const f = await confirmar(m.s, OWNER, r);
  assert.match(f.texto, /Pronto: amigo autorizado/);
  return f.codigo;
}

try {
  console.log('Frases e camada obrigatória');
  await test('frases: IDs só no formato imutável; @handle e link de vídeo recusados (formato inválido)', () => {
    assert.deepEqual(reconhecerFrase(`autoriza amigo da live <@${AMIGO}> https://www.youtube.com/channel/${CANAL}`), { acao: 'autorizar', discordId: AMIGO, canalId: CANAL, formatoInvalido: false });
    assert.equal(reconhecerFrase('autoriza amigo da live @fulano canal https://youtu.be/abc').formatoInvalido, true);
    assert.equal(reconhecerFrase(`autoriza amigo da live ${AMIGO} canal https://www.youtube.com/watch?v=abc`).formatoInvalido, true);
    assert.equal(reconhecerFrase('apagar meus dados da live').acao, 'apagar_meus_dados');
    assert.equal(reconhecerFrase('oi yui, tudo bem?'), null);
  });
  await test('camada: o interruptor vale conforme a ação (nega autorizar; nunca listar, revogar nem apagar)', () => {
    const v = [{ codigo: 'amigo-aaaaaaaaaaaaaaaa', discordId: AMIGO, canalId: CANAL, estado: 'ativo' }];
    assert.equal(conferirLiveAmigos('autorizar', { ehDono: true, alvo: { discordId: AMIGO2, canalId: CANAL2 }, vinculos: v, interruptor: false }).motivo, 'desligado');
    assert.equal(conferirLiveAmigos('listar', { ehDono: true, vinculos: v, interruptor: false }).ok, true);
    assert.equal(conferirLiveAmigos('revogar', { ehDono: true, alvo: { codigo: v[0].codigo }, vinculos: v, interruptor: false }).ok, true);
    assert.equal(conferirLiveAmigos('apagar_meus_dados', { userId: AMIGO, vinculos: v, interruptor: false }).ok, true);
    assert.equal(conferirLiveAmigos('qualquer', {}).motivo, 'acao-desconhecida');
  });

  console.log('Fluxos (testes 1 a 18)');
  await test('1. o Braga autoriza: vínculo criado, código de 16 caracteres, auditoria "concluido", confirmação sem IDs depois', async () => {
    const m = montar();
    const r = await m.s.comando({ userId: OWNER, texto: `autoriza amigo da live ${AMIGO} canal ${CANAL}` });
    assert.match(r.texto, /Não prova que o canal é dessa pessoa/);
    assert.equal(r.limpeza.acao, 'editar');
    await m.s.mensagemEnviada({ ref: r.ref, messageId: '900000000000000001', channelId: '900000000000000002', limpeza: r.limpeza });
    assert.equal(m.store.lerDiario().limpezas.length, 1, 'a edição pendente entra no diário');
    const f = await confirmar(m.s, OWNER, r);
    assert.match(f.codigo, /^amigo-[a-z2-9]{16}$/);
    assert.ok(!f.texto.includes(AMIGO) && !f.texto.includes(CANAL), 'o resultado não tem IDs');
    assert.equal(m.store.lerDiario().limpezas.length, 0, 'o clique editou a mensagem: a limpeza sai do diário');
    const v = m.store.lerVinculos();
    assert.equal(v.length, 1);
    assert.deepEqual([v[0].discordId, v[0].canalId, v[0].estado], [AMIGO, CANAL, 'ativo']);
    assert.ok(eventos('live_amigos.autorizar').some((e) => e.vinculo === f.codigo && e.resultado === 'concluido' && e.userId === null));
  });
  await test('2. outra pessoa tenta autorizar: negado (nao-e-o-dono), nada gravado', async () => {
    const m = montar();
    const r = await m.s.comando({ userId: OUTRO, texto: `autoriza amigo da live ${AMIGO} canal ${CANAL}` });
    assert.equal(r.botoes, undefined);
    assert.ok(!fs.existsSync(path.join(m.dir, NOME_VINCULOS)));
    assert.ok(eventos('live_amigos.negado').some((e) => e.motivo === 'nao-e-o-dono' && e.ator === 'outro'));
  });
  await test('3 e 4. o Braga lista com o interruptor ligado e desligado (lista some em 10 min)', async () => {
    const m = montar();
    await autorizar(m);
    const r = await m.s.comando({ userId: OWNER, texto: 'lista os amigos da live' });
    assert.match(r.texto, /Amigos da live \(1\)/);
    assert.deepEqual(r.limpeza, { acao: 'apagar', emMs: 600000 });
    m.env.YUI_LIVE_AMIGOS = 'false';
    const r2 = await m.s.comando({ userId: OWNER, texto: 'lista os amigos da live' });
    assert.match(r2.texto, /Amigos da live \(1\)/);
  });
  await test('5. autorizar com o interruptor desligado: negado (desligado)', async () => {
    const m = montar({ ligado: false });
    const r = await m.s.comando({ userId: OWNER, texto: `autoriza amigo da live ${AMIGO} canal ${CANAL}` });
    assert.match(r.texto, /desligada/);
    assert.ok(eventos('live_amigos.negado').some((e) => e.motivo === 'desligado'));
  });
  await test('6. revogar com o interruptor desligado: permitido, vínculo apagado, amigo avisado com o texto fixo', async () => {
    const m = montar();
    const codigo = await autorizar(m);
    m.env.YUI_LIVE_AMIGOS = 'false';
    const r = await m.s.comando({ userId: OWNER, texto: `revoga o amigo ${codigo}` });
    const f = await confirmar(m.s, OWNER, r);
    assert.match(f.texto, /revogado/);
    assert.equal(m.store.lerVinculos().length, 0);
    assert.deepEqual(m.avisos.map((a) => [a.userId, a.texto]), [[AMIGO, TEXTOS.avisoAmigoRevogado]]);
    assert.equal(m.store.lerDiario().encerramentos.length, 0, 'encerramento fechado; o discordId saiu do diário');
  });
  await test('7. o amigo apaga os dados com o interruptor desligado: apagado; o Braga avisado só com o código', async () => {
    const m = montar();
    const codigo = await autorizar(m);
    m.env.YUI_LIVE_AMIGOS = 'false';
    const r = await m.s.comando({ userId: AMIGO, texto: 'apagar meus dados da live' });
    const f = await confirmar(m.s, AMIGO, r);
    assert.equal(f.texto, TEXTOS.feitoApagar);
    assert.equal(m.store.lerVinculos().length, 0);
    assert.equal(m.avisos.length, 1);
    assert.equal(m.avisos[0].dono, true);
    assert.ok(m.avisos[0].texto.includes(codigo) && !m.avisos[0].texto.includes(AMIGO));
  });
  await test('8 e 9. o amigo tenta listar, revogar, agir sobre outro vínculo ou mudar o canal: negado', async () => {
    const m = montar();
    const c1 = await autorizar(m, AMIGO, CANAL);
    await autorizar(m, AMIGO2, CANAL2);
    for (const texto of ['lista os amigos da live', `revoga o amigo ${c1}`, `autoriza amigo da live ${AMIGO} canal ${CANAL2}`]) {
      const r = await m.s.comando({ userId: AMIGO2, texto });
      assert.equal(r.botoes, undefined, texto);
    }
    assert.equal(m.store.lerVinculos().length, 2, 'nada mudou');
    assert.equal(conferirLiveAmigos('apagar_meus_dados', { userId: AMIGO2, alvo: { codigo: c1 }, vinculos: m.store.lerVinculos() }).motivo, 'vinculo-de-outro');
  });
  await test('10. pessoa sem vínculo pede "apagar meus dados": a mesma frase neutra, nada apagado, "sem-vinculo"', async () => {
    const m = montar();
    await autorizar(m);
    const r = await m.s.comando({ userId: OUTRO, texto: 'apagar meus dados da live' });
    const f = await confirmar(m.s, OUTRO, r);
    assert.equal(f.texto, TEXTOS.feitoApagar);
    assert.equal(m.store.lerVinculos().length, 1);
    assert.ok(eventos('live_amigos.apagar_meus_dados').some((e) => e.motivo === 'sem-vinculo' && e.resultado === 'negado'));
  });
  await test('11, 12 e 53. o motor só aperta: observe e off nunca liberam o que a camada nega; enforce com a matriz negando nega', async () => {
    for (const modo of ['observe', 'off', 'enforce']) {
      const m = montar({ modo, ligado: false });
      const r = await m.s.comando({ userId: OWNER, texto: `autoriza amigo da live ${AMIGO} canal ${CANAL}` });
      assert.equal(r.botoes, undefined, `${modo}: a camada nega e continua negado`);
    }
    // enforce: camada permite (o dono), a matriz nega (MEMBER não pode listar) -> negado. Simulado com um "dono" que a matriz vê como membro.
    const m = montar({ modo: 'enforce' });
    const engineQueNega = createPolicyEngine({ env: { YUI_POLICY_MODE: 'enforce', POLICY_LIVE_AMIGOS_AUTONOMY: 'DENY' }, auditFn: audit, readOnly: () => false });
    const s2 = criarServicoLiveAmigos({ env: m.env, store: m.store, engine: engineQueNega, ehDono, agora, logger: quiet });
    const r = await s2.comando({ userId: OWNER, texto: 'lista os amigos da live' });
    assert.ok(!/Amigos da live/.test(r.texto), 'a matriz apertada pelo dono nega mesmo com a camada permitindo');
  });
  await test('somente leitura em enforce: autorizar é negado (modifies); revogar, apagar e listar continuam; em observe o "ask" ainda exige o botão', async () => {
    const m = montar();
    const codigo = await autorizar(m);
    const ro = createPolicyEngine({ env: { YUI_POLICY_MODE: 'enforce' }, auditFn: audit, readOnly: () => true });
    const s = criarServicoLiveAmigos({ env: m.env, store: m.store, engine: ro, ehDono, agora, logger: quiet, avisar: async () => true });
    assert.equal((await s.comando({ userId: OWNER, texto: `autoriza amigo da live ${AMIGO2} canal ${CANAL2}` })).botoes, undefined, 'autorizar negado em somente leitura');
    assert.match((await s.comando({ userId: OWNER, texto: 'lista os amigos da live' })).texto, /Amigos da live \(1\)/);
    const r = await s.comando({ userId: OWNER, texto: `revoga o amigo ${codigo}` });
    assert.match((await confirmar(s, OWNER, r)).texto, /revogado/, 'revogar continua em somente leitura');
    // observe: a decisão "ask" não executa nada sozinha; o vínculo só nasce no clique de Confirmar.
    const pedido = await m.s.comando({ userId: OWNER, texto: `autoriza amigo da live ${AMIGO2} canal ${CANAL2}` });
    assert.ok(pedido.botoes);
    assert.equal(m.store.lerVinculos().length, 0, 'sem o clique, nada gravado');
  });
  await test('13. duas revogações simultâneas do mesmo vínculo: uma conclui, a outra não faz nada; arquivo consistente', async () => {
    const m = montar();
    const codigo = await autorizar(m);
    const r1 = await m.s.comando({ userId: OWNER, texto: `revoga o amigo ${codigo}` });
    const r2 = await m.s.comando({ userId: OWNER, texto: `revoga o amigo ${codigo}` });
    const [f1, f2] = await Promise.all([confirmar(m.s, OWNER, r1), confirmar(m.s, OWNER, r2)]);
    assert.match(f1.texto, /revogado/);
    assert.equal(f2.texto, TEXTOS.venceu, 'a primeira cancelou a confirmação da segunda');
    assert.equal(m.store.lerVinculos().length, 0);
    assert.equal(eventos('live_amigos.encerramento').filter((e) => e.vinculo === codigo).length, 1);
  });
  await test('14. revogação com uma confirmação aberta da mesma pessoa: a confirmação deixa de valer', async () => {
    const m = montar();
    const codigo = await autorizar(m);
    const pedidoDoAmigo = await m.s.comando({ userId: AMIGO, texto: 'apagar meus dados da live' });
    const r = await m.s.comando({ userId: OWNER, texto: `revoga o amigo ${codigo}` });
    await confirmar(m.s, OWNER, r);
    assert.equal((await confirmar(m.s, AMIGO, pedidoDoAmigo)).texto, TEXTOS.venceu);
  });
  await test('15 e 51. botão clicado duas vezes vale uma vez; clique de outra pessoa é recusado e não muda nada', async () => {
    const m = montar();
    const r = await m.s.comando({ userId: OWNER, texto: `autoriza amigo da live ${AMIGO} canal ${CANAL}` });
    const alheio = await confirmar(m.s, OUTRO, r);
    assert.equal(alheio.naoEditar, true);
    assert.equal(m.store.lerVinculos().length, 0);
    await confirmar(m.s, OWNER, r);
    assert.equal((await confirmar(m.s, OWNER, r)).texto, TEXTOS.venceu);
    assert.equal(m.store.lerVinculos().length, 1);
  });
  await test('16. confirmação vencida (5 min) é recusada; cancelar não faz nada', async () => {
    const m = montar();
    const r = await m.s.comando({ userId: OWNER, texto: `autoriza amigo da live ${AMIGO} canal ${CANAL}` });
    relogio += 5 * 60_000 + 1;
    assert.equal((await confirmar(m.s, OWNER, r)).texto, TEXTOS.venceu);
    const r2 = await m.s.comando({ userId: OWNER, texto: `autoriza amigo da live ${AMIGO} canal ${CANAL}` });
    assert.equal((await cancelar(m.s, OWNER, r2)).texto, TEXTOS.cancelado);
    assert.equal(m.store.lerVinculos().length, 0);
  });
  await test('17 e 18. formato inválido e pessoa ou canal já vinculados são negados', async () => {
    const m = montar();
    await autorizar(m);
    assert.match((await m.s.comando({ userId: OWNER, texto: 'autoriza amigo da live @fulano canal https://youtu.be/x' })).texto, /Não entendi/);
    assert.match((await m.s.comando({ userId: OWNER, texto: `autoriza amigo da live ${AMIGO} canal ${CANAL2}` })).texto, /já tem um vínculo/);
    assert.match((await m.s.comando({ userId: OWNER, texto: `autoriza amigo da live ${AMIGO2} canal ${CANAL}` })).texto, /já tem um vínculo/);
  });

  console.log('Encerramento recuperável (testes 19 a 25)');
  await test('19. falha ao gravar no passo 2 (diário) ou 3 (encerrando): nada apagado, falha informada', async () => {
    let quebrar = null;
    const gravar = (file, data) => { if (quebrar && file.endsWith(quebrar)) throw Object.assign(new Error('disco'), { code: 'ENOSPC' }); fs.writeFileSync(file, JSON.stringify(data)); };
    for (const alvo of [NOME_DIARIO, NOME_VINCULOS]) {
      const m = montar({ gravar });
      quebrar = null;
      const codigo = await autorizar(m);
      const r = await m.s.comando({ userId: OWNER, texto: `revoga o amigo ${codigo}` });
      quebrar = alvo;
      assert.equal((await confirmar(m.s, OWNER, r)).texto, TEXTOS.falhaGravar, alvo);
      quebrar = null;
      assert.equal(m.store.lerVinculos().length, 1, `${alvo}: nada apagado`);
    }
    assert.ok(eventos('live_amigos.encerramento').some((e) => e.resultado === 'falhou'));
  });
  async function quedaEm(passo) {
    const m = montar({ falhar: (p) => { if (p === passo) throw new Error(`queda simulada: ${passo}`); } });
    const codigo = await autorizar(m);
    const r = await m.s.comando({ userId: OWNER, texto: `revoga o amigo ${codigo}` });
    await assert.rejects(confirmar(m.s, OWNER, r));
    const depois = montar({ pasta: m.dir });
    return { m, depois, codigo };
  }
  await test('20. queda depois do passo 3 (encerrando): a retomada apaga, audita e avisa', async () => {
    const { depois, codigo } = await quedaEm('encerrando');
    assert.equal(depois.store.lerVinculos()[0].estado, 'encerrando');
    await depois.s.retomar();
    assert.equal(depois.store.lerVinculos().length, 0);
    assert.ok(eventos('live_amigos.encerramento').some((e) => e.vinculo === codigo && e.retomada === true));
    assert.equal(depois.avisos.length, 1);
    assert.equal(depois.store.lerDiario().encerramentos.length, 0);
  });
  await test('21. queda depois de apagar (sem auditoria): a retomada audita UMA vez, com retomada: true', async () => {
    const { depois, codigo } = await quedaEm('apagado-anotado');
    assert.equal(depois.store.lerVinculos().length, 0);
    await depois.s.retomar();
    const regs = eventos('live_amigos.encerramento').filter((e) => e.vinculo === codigo && e.resultado === 'concluido');
    assert.equal(regs.length, 1);
    assert.equal(regs[0].retomada, true);
  });
  await test('22. queda depois de auditar (sem aviso): a retomada avisa; a auditoria não é duplicada', async () => {
    const { depois, codigo } = await quedaEm('auditou');
    await depois.s.retomar();
    assert.equal(eventos('live_amigos.encerramento').filter((e) => e.vinculo === codigo && e.resultado === 'concluido').length, 1);
    assert.equal(depois.avisos.length, 1);
  });
  await test('23 e 49. queda depois de mandar a DM e antes de anotar: o aviso pode sair de novo (aceito), com a mesma chave; nada mais se repete', async () => {
    const { m, depois, codigo } = await quedaEm('avisou');
    assert.equal(m.avisos.length, 1);
    await depois.s.retomar();
    assert.equal(depois.avisos.length, 1, 'saiu de novo na retomada');
    assert.equal(depois.avisos[0].chave, m.avisos[0].chave, 'mesma chave de idempotência');
    assert.equal(eventos('live_amigos.encerramento').filter((e) => e.vinculo === codigo && e.resultado === 'concluido').length, 1);
    assert.equal(depois.store.lerVinculos().length, 0);
  });
  await test('24. queda depois do último aviso anotado e antes de fechar: fecha sem repetir nada', async () => {
    const { depois } = await quedaEm('aviso-anotado');
    await depois.s.retomar();
    assert.equal(depois.avisos.length, 0);
    assert.equal(depois.store.lerDiario().encerramentos.length, 0);
  });
  await test('25. aviso que falha sempre: a entrada fica no diário e o Braga é avisado uma vez', async () => {
    const m = montar({ avisarOk: (a) => a.dono === true });
    const codigo = await autorizar(m);
    const r = await m.s.comando({ userId: OWNER, texto: `revoga o amigo ${codigo}` });
    await confirmar(m.s, OWNER, r);
    for (let i = 0; i < 4; i++) await m.s.retomar();
    const d = m.store.lerDiario();
    assert.equal(d.encerramentos.length, 1, 'continua no diário');
    assert.equal(m.avisos.filter((a) => a.dono === true && /ainda não terminou/.test(a.texto)).length, 1);
    assert.equal(m.store.lerVinculos().length, 0, 'os dados já foram apagados');
  });

  console.log('Integridade, esquecer e Porta A (testes 26 a 34)');
  await test('26. arquivo ilegível: nenhum vínculo vale, Braga avisado, nenhuma cópia .corrompido; recomeço só com confirmação', async () => {
    const m = montar();
    fs.writeFileSync(path.join(m.dir, NOME_VINCULOS), '{ quebrado');
    const r = await m.s.comando({ userId: OWNER, texto: 'lista os amigos da live' });
    assert.match(r.texto, /indisponíveis/);
    assert.ok(m.avisos.some((a) => a.dono && a.texto === TEXTOS.ilegivel));
    assert.ok(!fs.readdirSync(m.dir).some((n) => n.includes('corrompido')));
    const rc = await m.s.comando({ userId: OWNER, texto: 'recomeça os vínculos da live' });
    await confirmar(m.s, OWNER, rc);
    assert.ok(!fs.existsSync(path.join(m.dir, NOME_VINCULOS)));
    assert.match((await m.s.comando({ userId: OWNER, texto: 'lista os amigos da live' })).texto, /Nenhum amigo/);
  });
  await test('27. "esquecer tudo" de quem tem vínculo: apagado pela mesma rotina (gancho dos esquecer)', async () => {
    const m = montar();
    const codigo = await autorizar(m);
    definirServicoLiveAmigos(m.s);
    apagarVinculoDe(AMIGO);
    await m.s.retomar(); // espera a fila
    definirServicoLiveAmigos(null);
    assert.equal(m.store.lerVinculos().length, 0);
    assert.ok(eventos('live_amigos.encerramento').some((e) => e.vinculo === codigo && e.tipo === 'esquecer'));
    const fontes = ['src/core/memory/store.js', 'src/core/context/contextStore.js'].map((f) => fs.readFileSync(path.join(RAIZ, f), 'utf8'));
    for (const f of fontes) assert.match(f, /apagarVinculoDe\((ctx\.)?userId\)/);
  });
  await test('28 e 29. Porta A: antes do descarte de DM de terceiros e do banimento; frase tratada não segue para a IA', async () => {
    const fonte = fs.readFileSync(path.join(RAIZ, 'src/events/messageCreate.js'), 'utf8');
    const iPorta = fonte.indexOf('await portaA(message');
    assert.ok(iPorta > 0 && iPorta < fonte.indexOf('if (isForeignDirectMessage(message)) return;') && iPorta < fonte.indexOf('checkBan(message.author.id'), 'a Porta A vem antes');
    assert.match(fonte, /if \(!message\.guildId && await portaA\(message, client, \{ logger \}\)\) return;/);
    const enviados = [];
    const porta = { comando: async () => ({ texto: 'ok' }), mensagemEnviada: async () => true };
    const msg = (autor, content) => ({ guildId: null, author: { id: autor, bot: false }, content, attachments: { size: 0 }, reference: null, id: '1', channel: { send: async (p) => { enviados.push(p); return { id: '2', channelId: '3' }; } } });
    assert.equal(await portaA(msg(OUTRO, 'apagar meus dados da live'), null, { porta, ehDono }), true, 'de terceiro, só o apagar');
    assert.equal(await portaA(msg(OUTRO, 'lista os amigos da live'), null, { porta, ehDono }), false, 'frase do dono vinda de outro: segue o fluxo normal');
    assert.equal(await portaA(msg(OWNER, 'bom dia yui'), null, { porta, ehDono }), false, 'conversa comum segue');
    const quebrada = { comando: async () => { throw new Error('canal caiu'); } };
    assert.equal(await portaA(msg(OWNER, 'lista os amigos da live'), null, { porta: quebrada, ehDono }), true);
    assert.equal(enviados.at(-1).content, FALHA_FIXA);
  });
  await test('30. limite da Porta A: o quarto pedido em 15 min é recusado; o dono não tem limite', async () => {
    const m = montar();
    for (let i = 0; i < 3; i++) assert.ok((await m.s.comando({ userId: OUTRO, texto: 'apagar meus dados da live' })).botoes);
    assert.match((await m.s.comando({ userId: OUTRO, texto: 'apagar meus dados da live' })).texto, /Muitos pedidos/);
    for (let i = 0; i < 6; i++) assert.match((await m.s.comando({ userId: OWNER, texto: 'lista os amigos da live' })).texto, /Nenhum amigo/);
  });
  await test('31. listagem apagada depois de 10 min, inclusive depois de uma reinicialização no meio', async () => {
    const m = montar();
    await autorizar(m);
    const r = await m.s.comando({ userId: OWNER, texto: 'lista os amigos da live' });
    await m.s.mensagemEnviada({ ref: r.ref, messageId: '900000000000000011', channelId: '900000000000000012', limpeza: r.limpeza });
    const depois = montar({ pasta: m.dir });
    await depois.s.rodarLimpezas();
    assert.equal(depois.limpezas.length, 0, 'ainda não venceu');
    relogio += 10 * 60_000 + 1;
    await depois.s.rodarLimpezas();
    assert.deepEqual(depois.limpezas.map((l) => [l.acao, l.messageId]), [['apagar', '900000000000000011']]);
    assert.equal(depois.store.lerDiario().limpezas.length, 0);
  });
  await test('32 e 52. limpeza que falha três vezes: sai do diário com os IDs, "falhou" na auditoria, Braga avisado, sem conteúdo', async () => {
    const m = montar({ limparOk: () => ({ feito: false, motivo: 'erro 50013' }) });
    const r = await m.s.comando({ userId: OWNER, texto: `autoriza amigo da live ${AMIGO} canal ${CANAL}` });
    await m.s.mensagemEnviada({ ref: r.ref, messageId: '900000000000000021', channelId: '900000000000000022', limpeza: r.limpeza });
    for (let i = 0; i < 3; i++) { relogio += 6 * 60_000; await m.s.rodarLimpezas(); }
    assert.equal(m.store.lerDiario().limpezas.length, 0);
    const falhas = eventos('live_amigos.limpeza_dm').filter((e) => e.resultado === 'falhou');
    assert.ok(falhas.length >= 1);
    assert.ok(m.avisos.some((a) => a.dono && a.texto === TEXTOS.limpezaFalhou));
  });
  await test('33. gravação interrompida entre o temporário e o rename: o arquivo anterior continua legível; o órfão some', async () => {
    const m = montar();
    await autorizar(m);
    const orfao = path.join(m.dir, `${NOME_VINCULOS}.99999.tmp`);
    fs.writeFileSync(orfao, '{"meio":');
    const depois = montar({ pasta: m.dir });
    assert.equal(depois.store.lerVinculos().length, 1);
    assert.ok(!fs.existsSync(orfao));
  });
  await test('34. backups: os vínculos e o diário não estão em nenhuma lista, e um backup criado aqui não os contém', async () => {
    const nomes = [NOME_VINCULOS, NOME_DIARIO];
    for (const lista of [backup.MEMORY_DATABASES, backup.EXTRA_DATABASES, backup.DATA_FILES]) for (const n of nomes) assert.ok(!lista.includes(n));
    const m = montar();
    await autorizar(m);
    const destino = path.join(work, 'backups');
    try { await backup.createMemoryBackup({ dbDir: m.dir, backupDir: destino, key: crypto.randomBytes(32) }); } catch { /* sem bancos: nada a copiar */ }
    const todos = fs.existsSync(destino) ? fs.readdirSync(destino, { recursive: true }).map(String) : [];
    assert.ok(!todos.some((n) => nomes.some((x) => n.includes(x.replace('.json', '')))), 'nenhum arquivo do vínculo no backup');
  });
  await test('mensagem do Discord: botões montados aqui (só liveamg_), nomes buscados na hora, sem menções', async () => {
    const cliente = { users: { fetch: async () => ({ username: 'ana', globalName: 'Ana' }) } };
    const msg = await montarMensagem({ texto: `x @@NOME:${AMIGO}@@ y`, botoes: [{ customId: 'liveamg_ok_0123456789abcdef', label: 'Confirmar', estilo: 'perigo' }, { customId: 'outro_x', label: 'mal' }] }, cliente);
    assert.equal(msg.content, 'x Ana (@ana) y');
    assert.equal(msg.components[0].components.length, 1);
    assert.deepEqual(msg.allowedMentions, { parse: [] });
  });
  await test('40. avisar pelo Discord: para quem não é o dono, só o texto fixo da revogação', async () => {
    const enviados = [];
    const cliente = { isReady: () => true, users: { fetch: async (id) => ({ send: async (p) => { enviados.push([id, p.content]); } }) } };
    const a = acoesDoDiscord(() => cliente, { ehDono, dono: () => OWNER });
    assert.equal(await a.avisar({ userId: AMIGO, texto: TEXTOS.avisoAmigoRevogado, chave: 'k' }), true);
    await assert.rejects(a.avisar({ userId: AMIGO, texto: 'qualquer outra coisa', chave: 'k2' }), /aviso recusado/);
    assert.equal(await a.avisar({ dono: true, texto: 'livre para o dono', chave: 'k3' }), true);
    assert.deepEqual(enviados.map((e) => e[0]), [AMIGO, OWNER]);
  });
  await test('botão: só na DM; o clique encaminha e a mensagem vira o resultado, sem botões', async () => {
    const chamadas = [];
    const it = (guildId) => ({ guildId, user: { id: OWNER }, id: '5', customId: 'liveamg_ok_0123456789abcdef', reply: async (p) => chamadas.push(['reply', p]), deferUpdate: async () => {}, editReply: async (p) => chamadas.push(['edit', p]), followUp: async (p) => chamadas.push(['follow', p]) });
    await handleLiveAmigosButton(it('123'), { porta: { botao: async () => ({ texto: 'ok' }) } });
    assert.equal(chamadas.at(-1)[0], 'reply');
    await handleLiveAmigosButton(it(null), { porta: { botao: async () => ({ texto: 'Pronto' }) } });
    assert.deepEqual([chamadas.at(-1)[0], chamadas.at(-1)[1].content, chamadas.at(-1)[1].components], ['edit', 'Pronto', []]);
  });
  await test('41 (parte do bot). o bot não grava auditoria da live dos amigos e o prefixo fica fora do discordGuard', () => {
    const discord = fs.readFileSync(path.join(RAIZ, 'src/discord/liveAmigosDiscord.js'), 'utf8');
    assert.ok(!/\baudit\(/.test(discord), 'liveAmigosDiscord.js não chama audit()');
    assert.ok(!fs.readFileSync(path.join(RAIZ, 'src/core/security/discordGuard.js'), 'utf8').includes('liveamg_'));
  });

  console.log('Retenção da auditoria (testes 44 a 48 e 54 a 56)');
  const dirRet = fs.mkdtempSync(path.join(work, 'ret-'));
  let serie = 0;
  const linha = (seq, ts, tag) => JSON.stringify({ seq, prev_hash: '0', ts, event: 'x', hash: `h${seq}-${tag}` });
  const escrever = (f, datas) => { const tag = ++serie; fs.writeFileSync(f, `${datas.map((d, i) => linha(i + 1, d, tag)).join('\n')}\n`); };
  const AGORA = Date.parse('2026-12-01T00:00:00Z');
  const diasAtras = (n) => new Date(AGORA - n * 86_400_000).toISOString();
  await test('44 e 48. arquivo atual com a primeira linha de mais de 30 dias gira, mesmo sem gravação nova', () => {
    const f = path.join(dirRet, 'a.jsonl');
    escrever(f, [diasAtras(31), diasAtras(1)]);
    const r = ret.aplicarRetencao({ file: f, env: {}, agora: AGORA });
    assert.equal(r.girou, true);
    assert.ok(fs.existsSync(`${f}.1`) && !fs.existsSync(f));
  });
  await test('45, 46 e 47. girado com a PRIMEIRA linha além do prazo é apagado (mesmo com a última dentro), com âncora sem dado pessoal', () => {
    const f = path.join(dirRet, 'b.jsonl');
    escrever(f, [diasAtras(2)]);
    escrever(`${f}.1`, [diasAtras(40)]);
    escrever(`${f}.2`, [diasAtras(61), diasAtras(35)]);
    const r = ret.aplicarRetencao({ file: f, env: { YUI_AUDIT_RETENCAO_DIAS: '60' }, agora: AGORA });
    assert.equal(r.apagados, 1);
    assert.ok(!fs.existsSync(`${f}.2`) && fs.existsSync(`${f}.1`));
    const anc = fs.readFileSync(ret.arquivoDasAncoras(f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(anc.length, 1);
    assert.deepEqual([anc[0].arquivo, anc[0].primeiraSeq, anc[0].ultimaSeq, anc[0].ultimoHash.split('-')[0], anc[0].motivo], ['b.jsonl.2', 1, 2, 'h2', 'prazo']);
    assert.ok(Array.isArray(anc[0].verificacaoRestantes));
    assert.ok(!/\d{17,20}/.test(JSON.stringify(anc)), 'âncora sem IDs');
  });
  await test('46. depois de uma exclusão, o verifyAudit dos que restam (cadeia de verdade) continua ok', () => {
    const f = path.join(dirRet, 'real.jsonl');
    const antes = process.env.YUI_AUDIT_FILE;
    process.env.YUI_AUDIT_FILE = f;
    try {
      for (let i = 0; i < 3; i++) audit('teste.retencao', {}, { i });
      fs.renameSync(f, `${f}.1`);
      for (let i = 0; i < 2; i++) audit('teste.retencao', {}, { i });
      fs.renameSync(f, `${f}.2`);
      audit('teste.retencao', {}, { i: 9 });
    } finally { process.env.YUI_AUDIT_FILE = antes; }
    assert.equal(ret.apagarComAncora(`${f}.2`, 'prazo', { base: f }), true);
    assert.equal(verifyAudit(f).ok, true);
    assert.equal(verifyAudit(`${f}.1`).ok, true);
  });
  await test('54. falha ao gravar a âncora: o arquivo NÃO é apagado; a rodada seguinte tenta de novo', () => {
    const f = path.join(dirRet, 'c.jsonl');
    escrever(`${f}.1`, [diasAtras(90)]);
    assert.equal(ret.apagarComAncora(`${f}.1`, 'prazo', { base: f, gravar: () => { throw new Error('disco cheio'); } }), false);
    assert.ok(fs.existsSync(`${f}.1`));
    assert.equal(ret.apagarComAncora(`${f}.1`, 'prazo', { base: f }), true);
    assert.ok(!fs.existsSync(`${f}.1`));
  });
  await test('55. duas chamadas da rotina ao mesmo tempo: só uma roda', () => {
    const f = path.join(dirRet, 'd.jsonl');
    escrever(f, [diasAtras(1)]);
    ret.__travaDaRetencao.add(f);
    try { assert.equal(ret.aplicarRetencao({ file: f, env: {}, agora: AGORA }).ignorado, true); } finally { ret.__travaDaRetencao.delete(f); }
    assert.equal(ret.aplicarRetencao({ file: f, env: {}, agora: AGORA }).ignorado, undefined);
  });
  await test('56. exclusão que falha depois da âncora: a rodada seguinte apaga sem gravar outra âncora', () => {
    const f = path.join(dirRet, 'e.jsonl');
    escrever(`${f}.1`, [diasAtras(90)]);
    assert.equal(ret.apagarComAncora(`${f}.1`, 'prazo', { base: f, apagar: () => { throw new Error('EBUSY'); } }), false);
    assert.equal(ret.apagarComAncora(`${f}.1`, 'prazo', { base: f }), true);
    assert.equal(fs.readFileSync(ret.arquivoDasAncoras(f), 'utf8').trim().split('\n').length, 1, 'uma âncora só');
  });
  await test('prévia da retenção: diz o que faria (girar, apagar pelo prazo e pela quantidade) sem mudar nenhum arquivo', () => {
    const f = path.join(dirRet, 'p.jsonl');
    escrever(f, [diasAtras(31)]);
    escrever(`${f}.1`, [diasAtras(45)]);
    escrever(`${f}.2`, [diasAtras(70)]);
    escrever(`${f}.4`, [diasAtras(50)]);
    const antes = fs.readdirSync(dirRet).sort().join('|');
    const p = ret.previaDaRetencao({ file: f, env: {}, agora: AGORA });
    assert.equal(p.girariaPorIdade, true);
    assert.deepEqual(p.apagariaPorQuantidade, ['p.jsonl.4']);
    assert.deepEqual(p.apagariaPorPrazo, ['p.jsonl.2']);
    assert.equal(p.ancorasQueSeriamCriadas, 2);
    assert.equal(p.arquivos.length, 4);
    assert.equal(fs.readdirSync(dirRet).sort().join('|'), antes, 'nada mudou');
  });
  await test('giro por tamanho: o excedente sai com âncora (limite 4); sem âncora, não gira', () => {
    const f = path.join(dirRet, 'g.jsonl');
    for (let i = 1; i <= 4; i++) escrever(`${f}.${i}`, [diasAtras(i)]);
    escrever(f, [diasAtras(0)]);
    assert.equal(ret.girarAuditoria(f, {}), true);
    assert.ok(fs.existsSync(`${f}.4`) && !fs.existsSync(`${f}.5`) && fs.existsSync(`${f}.1`));
    assert.equal(fs.readFileSync(ret.arquivoDasAncoras(f), 'utf8').trim().split('\n').length, 1);
    escrever(f, [diasAtras(0)]);
    assert.equal(ret.girarAuditoria(f, {}, { gravar: () => { throw new Error('x'); } }), false, 'sem âncora, não gira');
    assert.ok(fs.existsSync(f));
  });

  console.log('As duas suítes (testes 42 e 43)');
  await test('42. auditoria, âncoras, logs e diários sem IDs de teste, nomes ou links; nenhum userId gravado', () => {
    const ids = [AMIGO, AMIGO2, OUTRO, OWNER, CANAL, CANAL2];
    const arquivos = [];
    const varrer = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) varrer(p); else arquivos.push(p); } };
    varrer(path.join(work, 'logs'));
    const auditoria = fs.readFileSync(process.env.YUI_AUDIT_FILE, 'utf8');
    for (const id of ids) assert.ok(!auditoria.includes(id), `a auditoria tem ${id}`);
    for (const f of arquivos) { const t = fs.readFileSync(f, 'utf8'); for (const id of ids) assert.ok(!t.includes(id), `${path.basename(f)} tem um ID`); }
    assert.ok(!auditoria.includes('youtube.com'));
    for (const e of linhasDaAuditoria().filter((x) => String(x.event).startsWith('live_amigos.') || x.event === 'policy.evaluate')) assert.equal(e.userId, null);
    // diários: depois de fechados, nenhum discordId
    for (const d of fs.readdirSync(isolated.dir)) {
      const diario = path.join(isolated.dir, d, NOME_DIARIO);
      if (!fs.existsSync(diario)) continue;
      const j = JSON.parse(fs.readFileSync(diario, 'utf8'));
      for (const e of j.encerramentos) for (const a of e.avisos ?? []) assert.ok(a.discordId === undefined || a.discordId === AMIGO, 'só o aviso pendente do caso 25 guarda o discordId');
    }
    assert.equal(verifyAudit(process.env.YUI_AUDIT_FILE).ok, true);
  });
  await test('43. nenhuma chamada ao YouTube: o código da etapa 1 não importa o adaptador nem o cliente do YouTube', () => {
    for (const f of ['src/core/liveAmigos/servico.js', 'src/core/liveAmigos/store.js', 'src/core/liveAmigos/camada.js', 'src/core/liveAmigos/frases.js', 'src/core/liveAmigos/porta.js', 'src/discord/liveAmigosDiscord.js', 'src/cerebro/liveAmigos.js']) {
      const t = fs.readFileSync(path.join(RAIZ, f), 'utf8');
      assert.ok(!/adaptadores\/youtube|googleapis|youtube\.com\/youtubei|(^|[^.\w])fetch\(/m.test(t), `${f} não fala com o YouTube (só o Discord, pelo cliente dele)`);
    }
    assert.match(novoCodigo(), /^amigo-[a-z2-9]{16}$/);
  });

  console.log(`\n${passed} testes OK`);
  finished = true;
} finally {
  try { (await import('../src/utils/logger.js')).logger.close(); } catch { /* */ }
  process.chdir(os.tmpdir());
  await new Promise((r) => setTimeout(r, 150));
  try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* */ }
  isolated.cleanup();
}
process.exit(finished ? 0 : 1);
