// A leitura do chat da live EM FLUXO (src/core/live/fluxo.js, gRPC) com a consulta REST de reserva, contra um servidor gRPC FALSO em 127.0.0.1 (sem TLS), a API REST falsa de
// tests/helpers/youtubeFalso.js e um OAuth falso. Nada sai da máquina; nenhum segredo real. Execução: npm run test:youtubefluxo
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { useIsolatedDatabaseDir } from './helpers/isolatedDatabaseDir.js';
import { criarYoutubeFalso, mensagemDoChat, TOKEN_FALSO } from './helpers/youtubeFalso.js';

process.env.NODE_ENV = 'test';
const isolada = useIsolatedDatabaseDir('yui-test-fluxo-');
const repoRoot = path.resolve(import.meta.dirname, '..');
const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const { criarLeitorEmFluxo, carregarGrpcPadrao, ARQUIVO_PROTO } = await imp('src/core/live/fluxo.js');
const { criarServicoDaLive, ritmoDaLive, ritmoDoFluxo, leituraEscolhida, SAUDACOES_DA_LIVE } = await imp('src/core/live/servico.js');
const { gravarCredencial } = await imp('src/core/live/credencial.js');
const { criarAdaptadorYoutube } = await imp('src/adaptadores/youtube/adaptador.js');
const { ErroYoutube } = await imp('src/adaptadores/youtube/api.js');

let passed = 0;
let failed = 0;
const test = async (nome, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${nome}`); } catch (e) { failed += 1; console.log(`  FALHA ${nome}\n        ${String(e?.stack ?? e).split('\n').slice(0, 8).join('\n        ')}`); }
};
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const ate = async (cond, ms = 2000) => { const fim = Date.now() + ms; while (Date.now() < fim) { if (cond()) return true; await dormir(20); } return cond(); };

const CANAL = 'UCcanaldayui000000000001';
const DONO = '111111111111111111';
const VIDEO = 'abcdefghijk';
const LINK = `https://youtube.com/live/${VIDEO}`;
const CHAT = 'CHAT-FALSO';
const tmp = isolada.dir;
const arquivoToken = path.join(tmp, 'secrets', 'youtube-token.json');
gravarCredencial(arquivoToken, { client_id: 'cliente-falso.apps', client_secret: 'segredo-falso', refresh_token: '1//refresh-falso', canalId: CANAL }, { restringir: () => {} });

// ── OAuth falso (só o token) e API REST falsa ─────────────────────────────────────────────────────────────────────────────────────────────
const oauth = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify({ access_token: TOKEN_FALSO, expires_in: 3600, token_type: 'Bearer' })); });
});
await new Promise((r) => oauth.listen(0, '127.0.0.1', r));
const OAUTH = `http://127.0.0.1:${oauth.address().port}`;
const yt = await criarYoutubeFalso();

// ── Servidor gRPC falso do StreamList ─────────────────────────────────────────────────────────────────────────────────────────────────────
const grpc = (await import('@grpc/grpc-js')).default ?? (await import('@grpc/grpc-js'));
const { grpc: grpcDoLeitor, Servico } = await carregarGrpcPadrao();
const servidor = await (async () => {
  const pedidos = []; // { liveChatId, pageToken, autorizado }
  const ativas = new Set();
  let n = 0;
  const estado = { roteiro: null };
  const srv = new grpcDoLeitor.Server();
  srv.addService(Servico.service, {
    StreamList(call) {
      n += 1;
      const auth = call.metadata.get('authorization')[0];
      pedidos.push({ liveChatId: call.request.liveChatId, pageToken: call.request.pageToken ?? null, autorizado: auth === `Bearer ${TOKEN_FALSO}` });
      ativas.add(call);
      const tirar = () => ativas.delete(call);
      call.on('cancelled', tirar);
      call.on('close', tirar);
      estado.roteiro?.(call, n);
    },
  });
  const porta = await new Promise((resolve, reject) => srv.bindAsync('127.0.0.1:0', grpcDoLeitor.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));
  return {
    endereco: `127.0.0.1:${porta}`,
    pedidos,
    ativas,
    set roteiro(fn) { estado.roteiro = fn; },
    reiniciar() { estado.roteiro = null; pedidos.length = 0; n = 0; for (const c of [...ativas]) { try { c.end(); } catch { /* */ } } ativas.clear(); },
    /** Escreve uma resposta em todas as conexões abertas. */
    enviar(itens, token = null, extra = {}) { for (const c of ativas) c.write({ ...(token ? { nextPageToken: token } : {}), items: itens, ...extra }); },
    fim() { for (const c of [...ativas]) { try { c.end(); } catch { /* */ } ativas.delete(c); } },
    parar() { srv.forceShutdown(); },
  };
})();
void grpc;

const msg = (id, texto, { autor = 'UCautor00000000000000001', tipo = 'TEXT_MESSAGE_EVENT' } = {}) => ({
  id, snippet: { type: tipo, publishedAt: new Date().toISOString(), displayMessage: texto, ...(tipo === 'TEXT_MESSAGE_EVENT' ? { textMessageDetails: { messageText: texto } } : {}) },
  authorDetails: { channelId: autor, displayName: 'Alguem' },
});
const escrever = (call, itens, token) => call.write({ ...(token ? { nextPageToken: token } : {}), items: itens });
const erroGrpc = (call, code, details = 'erro de teste') => call.emit('error', { code, details });
const credInsegura = (g) => g.credentials.createInsecure();
const novoLeitor = (extra = {}) => criarLeitorEmFluxo({ obterToken: async () => TOKEN_FALSO, carregarGrpc: carregarGrpcPadrao, endereco: servidor.endereco, credenciais: credInsegura, ...extra });
const relogio = (inicio = 1_000_000) => { const r = { t: inicio, agora: () => r.t, avanca: (ms) => { r.t += ms; } }; return r; };
const rejeita = async (p, code) => { try { await p; } catch (e) { assert.ok(e instanceof ErroYoutube, `não é ErroYoutube: ${e}`); assert.equal(e.code, code); return e; } assert.fail(`esperava ${code}`); };
const abertas = () => servidor.ativas.size;

try {
  await test('o .proto vem junto do código e o ritmo do fluxo segue a tabela da duração', () => {
    assert.ok(ARQUIVO_PROTO.endsWith('stream_list.proto'));
    assert.deepEqual(ritmoDoFluxo(undefined), { pausaMs: 0, cabemHoras: 4 });
    assert.deepEqual(ritmoDoFluxo(4), { pausaMs: 0, cabemHoras: 4 });
    assert.deepEqual(ritmoDoFluxo(5), { pausaMs: 10_000, cabemHoras: 6 });
    assert.deepEqual(ritmoDoFluxo(6), { pausaMs: 10_000, cabemHoras: 6 });
    assert.deepEqual(ritmoDoFluxo(7), { pausaMs: 15_000, cabemHoras: 8 });
    assert.deepEqual(ritmoDoFluxo(8), { pausaMs: 15_000, cabemHoras: 8 });
    assert.deepEqual(ritmoDoFluxo(9), { pausaMs: 25_000, cabemHoras: 9 });
    assert.deepEqual(ritmoDoFluxo(20), { pausaMs: 25_000, cabemHoras: 9 });
    // a reserva REST continua com 15/20/30 s; as contas da tabela cabem nas 9.000 unidades usáveis (conexão de ~10 s, mensagens no teto de 400/h)
    assert.deepEqual([ritmoDaLive(1).segundos, ritmoDaLive(6).segundos, ritmoDaLive(8).segundos], [15, 20, 30]);
    for (const [h, pausa] of [[4, 0], [6, 10], [8, 15], [9, 25]]) assert.ok(h * ((3600 / (10 + pausa)) * 5 + 400) <= 9000, `${h} h`);
    assert.equal(leituraEscolhida({}), 'fluxo');
    assert.equal(leituraEscolhida({ YUI_YOUTUBE_LEITURA: ' Consulta ' }), 'consulta');
    assert.equal(leituraEscolhida({ YUI_YOUTUBE_LEITURA: 'qualquer' }), 'fluxo');
  });

  await test('leitor: o histórico vem na abertura; a mensagem nova chega na hora, no formato da consulta, com o token do canal', async () => {
    servidor.reiniciar();
    servidor.roteiro = (call) => escrever(call, [msg('h1', 'velha')], 't1');
    const leitor = novoLeitor();
    const p1 = await leitor.lerMensagens({ liveChatId: CHAT, podeAbrir: true });
    assert.equal(p1.novaConexao, true);
    assert.equal(p1.mensagens.length, 1);
    assert.equal(p1.mensagens[0].snippet.type, 'textMessageEvent');
    assert.equal(p1.mensagens[0].snippet.textMessageDetails.messageText, 'velha');
    assert.equal(p1.proximaPagina, 't1');
    assert.equal(servidor.pedidos[0].autorizado, true);
    assert.equal(servidor.pedidos[0].liveChatId, CHAT);
    const t0 = Date.now();
    setTimeout(() => servidor.enviar([msg('m2', 'oi yui')], 't2'), 150);
    const p2 = await leitor.lerMensagens({ liveChatId: CHAT, pageToken: p1.proximaPagina });
    assert.ok(Date.now() - t0 < 1000, `demorou ${Date.now() - t0} ms`);
    assert.equal(p2.novaConexao, false);
    assert.deepEqual(p2.mensagens.map((m) => m.id), ['m2']);
    assert.equal(p2.proximaPagina, 't2');
    const t1 = Date.now();
    const p3 = await leitor.lerMensagens({ liveChatId: CHAT, pageToken: p2.proximaPagina });
    assert.deepEqual([p3.mensagens.length, p3.novaConexao, p3.intervaloMs], [0, false, 1000]);
    assert.ok(Date.now() - t1 <= 1400);
    assert.equal(servidor.pedidos.length, 1, 'uma conexão só');
    leitor.fechar();
    assert.ok(await ate(() => abertas() === 0), 'a conexão precisa fechar');
  });

  await test('leitor: buffer com itens devolve na hora; fim normal respeita a pausa, depois reabre com o último token', async () => {
    servidor.reiniciar();
    servidor.roteiro = (call, n) => { escrever(call, [msg(`h${n}`, 'velha')], `t${n}`); setTimeout(() => call.end(), 100); };
    const rel = relogio();
    const leitor = novoLeitor({ agora: rel.agora, pausaMs: 10_000 });
    const p1 = await leitor.lerMensagens({ liveChatId: CHAT });
    assert.equal(p1.novaConexao, true);
    await ate(() => leitor.modo().conexaoAberta === false);
    const p2 = await leitor.lerMensagens({ liveChatId: CHAT, pageToken: p1.proximaPagina });
    assert.equal(p2.novaConexao, false);
    assert.ok(p2.intervaloMs >= 500 && p2.intervaloMs <= 10_000, String(p2.intervaloMs));
    assert.equal(servidor.pedidos.length, 1, 'a pausa não foi cumprida: não reabre');
    rel.avanca(4000);
    const p3 = await leitor.lerMensagens({ liveChatId: CHAT, pageToken: p1.proximaPagina });
    assert.equal(p3.novaConexao, false);
    assert.equal(servidor.pedidos.length, 1);
    assert.ok(p3.intervaloMs <= 6000 + 1);
    rel.avanca(6000);
    const p4 = await leitor.lerMensagens({ liveChatId: CHAT, pageToken: p1.proximaPagina });
    assert.equal(p4.novaConexao, true);
    assert.equal(servidor.pedidos.length, 2);
    assert.equal(servidor.pedidos[1].pageToken, 't1', 'reabre do último token');
    // sem cota para abrir: não abre, e diz para olhar de novo daqui a 30 s
    await ate(() => leitor.modo().conexaoAberta === false);
    rel.avanca(60_000);
    const p5 = await leitor.lerMensagens({ liveChatId: CHAT, podeAbrir: false });
    assert.deepEqual([p5.mensagens.length, p5.novaConexao, p5.intervaloMs], [0, false, 30_000]);
    assert.equal(servidor.pedidos.length, 2);
    leitor.fechar();
  });

  await test('leitor: erros do gRPC viram os mesmos códigos da consulta (acesso negado, não autenticado, live acabou)', async () => {
    for (const [code, esperado, permanente] of [[grpcDoLeitor.status.PERMISSION_DENIED, 'SEM_PERMISSAO', true], [grpcDoLeitor.status.UNAUTHENTICATED, 'NAO_AUTENTICADO', true], [grpcDoLeitor.status.NOT_FOUND, 'LIVE_ACABOU', false]]) {
      servidor.reiniciar();
      servidor.roteiro = (call) => erroGrpc(call, code);
      const leitor = novoLeitor();
      const e = await rejeita(leitor.lerMensagens({ liveChatId: CHAT }), esperado);
      assert.equal(e.permanente, permanente);
      assert.ok(!String(e.message + e.reason).includes(TOKEN_FALSO));
      leitor.fechar();
    }
  });

  await test('leitor: fim da live (CHAT_ENDED_EVENT ou offlineAt) entrega o que veio e depois avisa LIVE_ACABOU', async () => {
    for (const via of ['evento', 'offline']) {
      servidor.reiniciar();
      servidor.roteiro = (call) => {
        if (via === 'evento') escrever(call, [msg('a1', 'tchau yui'), msg('fim', '', { tipo: 'CHAT_ENDED_EVENT' })], 't1');
        else call.write({ nextPageToken: 't1', items: [msg('a1', 'tchau yui')], offlineAt: new Date().toISOString() });
      };
      const leitor = novoLeitor();
      const p = await leitor.lerMensagens({ liveChatId: CHAT });
      assert.deepEqual(p.mensagens.map((m) => m.id), ['a1']);
      await rejeita(leitor.lerMensagens({ liveChatId: CHAT }), 'LIVE_ACABOU');
      leitor.fechar();
    }
  });

  await test('leitor: RESOURCE_EXHAUSTED espera em dobro (até 60 s) e não para; UNAVAILABLE 3 vezes seguidas e UNIMPLEMENTED viram FLUXO_INDISPONIVEL', async () => {
    servidor.reiniciar();
    servidor.roteiro = (call) => erroGrpc(call, grpcDoLeitor.status.RESOURCE_EXHAUSTED);
    const rel = relogio();
    let leitor = novoLeitor({ agora: rel.agora });
    const esperas = [];
    for (let i = 0; i < 2; i += 1) {
      const p = await leitor.lerMensagens({ liveChatId: CHAT });
      assert.equal(p.mensagens.length, 0);
      esperas.push(leitor.modo().backoffMs);
      rel.avanca(70_000);
    }
    assert.deepEqual(esperas, [2000, 4000]);
    // a 3ª seguida não insiste mais (nunca parar era o defeito): o fluxo fica indisponível e a reserva REST recebe a recusa de cota; a conexão aberta foi cobrada
    const e3 = await rejeita(leitor.lerMensagens({ liveChatId: CHAT }), 'FLUXO_INDISPONIVEL');
    assert.equal(e3.reason, 'limite-de-uso');
    assert.equal(e3.novaConexao, true);
    leitor.fechar();

    servidor.reiniciar();
    servidor.roteiro = (call) => erroGrpc(call, grpcDoLeitor.status.UNAVAILABLE);
    const rel2 = relogio();
    leitor = novoLeitor({ agora: rel2.agora });
    await leitor.lerMensagens({ liveChatId: CHAT }); rel2.avanca(10_000);
    await leitor.lerMensagens({ liveChatId: CHAT }); rel2.avanca(10_000);
    await rejeita(leitor.lerMensagens({ liveChatId: CHAT }), 'FLUXO_INDISPONIVEL');
    leitor.fechar();

    servidor.reiniciar();
    servidor.roteiro = (call) => erroGrpc(call, grpcDoLeitor.status.UNIMPLEMENTED);
    leitor = novoLeitor();
    await rejeita(leitor.lerMensagens({ liveChatId: CHAT }), 'FLUXO_INDISPONIVEL');
    leitor.fechar();

    // o módulo do gRPC não carrega: indisponível, sem derrubar nada
    leitor = novoLeitor({ carregarGrpc: async () => { throw new Error('sem o módulo'); } });
    await rejeita(leitor.lerMensagens({ liveChatId: CHAT }), 'FLUXO_INDISPONIVEL');
    leitor.fechar();
  });

  await test('leitor: um dado antes da hora basta; uma conexão muda por tempo demais é dada como caída', async () => {
    servidor.reiniciar();
    servidor.roteiro = () => {}; // abre e não manda nada
    const rel = relogio();
    const leitor = novoLeitor({ agora: rel.agora });
    const p = await leitor.lerMensagens({ liveChatId: CHAT });
    assert.deepEqual([p.mensagens.length, p.novaConexao], [0, true]);
    rel.avanca(60_000);
    const p2 = await leitor.lerMensagens({ liveChatId: CHAT });
    assert.equal(p2.mensagens.length, 0);
    assert.equal(leitor.modo().falhasSeguidas, 1);
    leitor.fechar();
  });

  await test('regressão 1: se a 1ª conexão cai sem resposta, o histórico da 2ª (sem token) é descartado, nunca vira mensagem nova', async () => {
    servidor.reiniciar();
    servidor.roteiro = (call, n) => { if (n === 1) { call.end(); return; } escrever(call, [msg('h1', 'conversa antiga')], 't1'); };
    const rel = relogio();
    const leitor = novoLeitor({ agora: rel.agora });
    const p1 = await leitor.lerMensagens({ liveChatId: CHAT });
    assert.deepEqual([p1.mensagens.length, p1.novaConexao], [0, true]);
    rel.avanca(6000);
    const p2 = await leitor.lerMensagens({ liveChatId: CHAT });
    assert.equal(servidor.pedidos.length, 2);
    assert.equal(servidor.pedidos[1].pageToken, null, 'a 2ª abriu sem token');
    assert.equal(p2.mensagens.length, 0, 'o histórico não pode virar mensagem nova');
    assert.equal(p2.proximaPagina, 't1', 'mas o token dele vale');
    servidor.enviar([msg('n1', 'oi yui')], 't2');
    const p3 = await leitor.lerMensagens({ liveChatId: CHAT, pageToken: p2.proximaPagina });
    assert.deepEqual(p3.mensagens.map((m) => m.id), ['n1']);
    leitor.fechar();
  });

  await test('regressão 2: servidor que fecha na hora não vira laço de conexões: no máximo 12 por minuto e acaba indisponível', async () => {
    servidor.reiniciar();
    servidor.roteiro = (call) => call.end();
    const rel = relogio();
    const leitor = novoLeitor({ agora: rel.agora, pausaMs: 0 });
    let erro = null;
    for (let s = 0; s < 60 && !erro; s += 1) {
      try { await leitor.lerMensagens({ liveChatId: CHAT }); } catch (e) { erro = e; }
      rel.avanca(1000);
    }
    assert.ok(servidor.pedidos.length <= 12, `abriu ${servidor.pedidos.length} conexões`);
    assert.ok(erro instanceof ErroYoutube && erro.code === 'FLUXO_INDISPONIVEL', String(erro));
    assert.equal(erro.novaConexao, true);
    leitor.fechar();
    // conexão com dado que fecha na hora também espera o intervalo mínimo (sem laço)
    servidor.reiniciar();
    servidor.roteiro = (call, n) => { escrever(call, [msg(`x${n}`, 'oi')], `t${n}`); call.end(); };
    const rel2 = relogio();
    const l2 = novoLeitor({ agora: rel2.agora, pausaMs: 0 });
    for (let s = 0; s < 60; s += 1) { await l2.lerMensagens({ liveChatId: CHAT }); rel2.avanca(1000); }
    assert.ok(servidor.pedidos.length <= 12, `abriu ${servidor.pedidos.length} conexões`);
    l2.fechar();
  });

  await test('regressão 4 e 7: INVALID_ARGUMENT vira fluxo indisponível; fechar durante o carregamento não deixa conexão nem canal', async () => {
    servidor.reiniciar();
    servidor.roteiro = (call) => erroGrpc(call, grpcDoLeitor.status.INVALID_ARGUMENT);
    let leitor = novoLeitor();
    const e = await rejeita(leitor.lerMensagens({ liveChatId: CHAT }), 'FLUXO_INDISPONIVEL');
    assert.equal(e.reason, 'argumento');
    leitor.fechar();

    servidor.reiniciar();
    let canais = 0;
    leitor = novoLeitor({ carregarGrpc: async () => { await dormir(150); const m = await carregarGrpcPadrao(); const Orig = m.Servico; return { grpc: m.grpc, Servico: function Servico(...a) { canais += 1; return new Orig(...a); } }; } });
    const p = leitor.lerMensagens({ liveChatId: CHAT });
    await dormir(20);
    leitor.fechar();
    const r = await p;
    assert.deepEqual([r.mensagens.length, r.novaConexao], [0, false]);
    assert.equal(servidor.pedidos.length, 0, 'nenhuma conexão aberta depois de fechar');
    assert.ok(canais <= 1);
  });

  // ── O adaptador sobre o leitor ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  function montarAdaptador() {
    servidor.reiniciar();
    const enviadas = [];
    const perguntas = [];
    const leitor = novoLeitor();
    const cliente = {
      buscarLive: async () => ({ eLive: true, terminou: false, liveChatId: CHAT, titulo: 'Live de teste' }),
      lerMensagens: (a) => leitor.lerMensagens(a),
      enviarMensagem: async ({ texto }) => { enviadas.push(texto); return { id: 'x' }; },
    };
    const ad = criarAdaptadorYoutube({ ligado: true, cliente, cerebro: { responder: async (p) => { perguntas.push(p.texto); return { texto: 'oi, chat!' }; } }, config: { canalDaYui: CANAL } });
    return { ad, leitor, enviadas, perguntas };
  }

  await test('adaptador: mensagem nova é respondida em menos de 2 s; o passo seguinte é em 1 s (sem o mínimo de 15 s)', async () => {
    const { ad, leitor, enviadas, perguntas } = montarAdaptador();
    servidor.roteiro = (call) => escrever(call, [msg('h1', 'conversa velha yui')], 't1');
    assert.equal((await ad.entrar({ link: LINK, canal: 'app', papel: 'dono' })).ok, true);
    const r1 = await ad.passo();
    assert.equal(r1.ativo, true);
    assert.deepEqual(perguntas, [], 'o histórico não vira resposta');
    const t0 = Date.now();
    servidor.enviar([msg('m1', 'oi yui, tudo bem?')], 't2');
    const r2 = await ad.passo();
    assert.ok(Date.now() - t0 < 2000, `demorou ${Date.now() - t0} ms`);
    assert.deepEqual(perguntas, ['oi yui, tudo bem?']);
    assert.deepEqual(enviadas, ['oi, chat!']);
    assert.equal(r2.proximoEmMs, 1000);
    leitor.fechar();
    ad.desligar();
  });

  await test('adaptador: a cota conta só a conexão aberta (5 unidades), não a leitura; reconectar com o token não repete resposta', async () => {
    const { ad, leitor, perguntas } = montarAdaptador();
    servidor.roteiro = (call, n) => {
      if (n === 1) { escrever(call, [msg('h1', 'velha')], 't1'); return; }
      // a 2ª conexão repete a mensagem m1 na primeira resposta (como o servidor pode fazer) e traz m2
      escrever(call, [msg('m1', 'oi yui, tudo bem?'), msg('m2', 'yui, e a live?')], 't3');
    };
    await ad.entrar({ link: LINK, canal: 'app', papel: 'dono' });
    await ad.passo(); // abre a conexão 1 (histórico ignorado)
    servidor.enviar([msg('m1', 'oi yui, tudo bem?')], 't2');
    await ad.passo();
    for (let i = 0; i < 2; i += 1) await ad.passo(); // leituras sem conexão nova: não gastam
    assert.equal(ad.retrato().cota.porOperacao['liveChatMessages.list'], 5 * servidor.pedidos.length);
    assert.equal(servidor.pedidos.length, 1);
    servidor.fim(); // o servidor fecha a conexão (fim normal)
    await ate(() => leitor.modo().conexaoAberta === false);
    await ad.passo(); // reabre com o último token e recebe m1 repetida + m2
    assert.equal(servidor.pedidos.length, 2);
    assert.equal(servidor.pedidos[1].pageToken, 't2');
    assert.equal(ad.retrato().cota.porOperacao['liveChatMessages.list'], 10);
    assert.equal(perguntas.filter((t) => t === 'oi yui, tudo bem?').length, 1, 'a mensagem repetida não vira segunda resposta');
    assert.equal(ad.retrato().contadores.lidas, 2, 'm1 e m2, cada uma uma vez');
    leitor.fechar();
    ad.desligar();
  });

  await test('regressão 6: a conexão aberta que termina em erro logo de cara é contada na cota (não subconta)', async () => {
    const { ad, leitor } = montarAdaptador();
    servidor.roteiro = (call) => erroGrpc(call, grpcDoLeitor.status.PERMISSION_DENIED);
    await ad.entrar({ link: LINK, canal: 'app', papel: 'dono' });
    await ad.passo();
    assert.equal(ad.estado, 'interrompida');
    assert.equal(servidor.pedidos.length, 1);
    assert.equal(ad.retrato().cota.porOperacao['liveChatMessages.list'], 5);
    leitor.fechar();
  });

  // ── O serviço: fluxo principal, reserva na consulta, paradas, chave e fechamento ────────────────────────────────────────────────────────
  const logs = [];
  function montar({ env = {}, fluxo = {} } = {}) {
    servidor.reiniciar();
    yt.limpar();
    yt.definirVideo(VIDEO, { titulo: 'Minha live', liveChatId: CHAT });
    logs.length = 0;
    const fila = [];
    const avisos = [];
    const respostasIa = [];
    let relogioFalso = Date.parse('2026-11-28T20:00:00Z');
    const servico = criarServicoDaLive({
      env: { YUI_YOUTUBE_LIVE: 'true', DATABASE_DIR: tmp, YUI_YOUTUBE_TOKEN_ARQUIVO: arquivoToken, ...env },
      ai: { isolatedChat: async (p) => { respostasIa.push(p); return 'oi, chat!'; } }, ehDono: (id) => id === DONO,
      logger: { info: (t) => logs.push(t), warn: (t) => logs.push(t) }, agora: () => relogioFalso,
      avisarDono: async (t) => { avisos.push(t); return true; },
      baseUrl: yt.base, tokenUrl: `${OAUTH}/token`,
      fluxo: { endereco: servidor.endereco, credenciais: credInsegura, carregarGrpc: carregarGrpcPadrao, ...fluxo },
      agendar: (fn, ms) => { const t = { fn, ms }; fila.push(t); return t; },
      cancelar: (t) => { const i = fila.indexOf(t); if (i >= 0) fila.splice(i, 1); },
    });
    return {
      servico, fila, avisos, respostasIa,
      avanca: (ms) => { relogioFalso += ms; }, // o relógio da Yui (os 5 s mínimos entre duas mensagens dela)
      async rodar() { const t = fila.shift(); assert.ok(t, 'nada agendado'); relogioFalso += t.ms; await t.fn(); return t.ms; },
      manda: (texto) => servico.rotear({ userId: DONO, texto, canal: 'discord_dm' }),
    };
  }
  const respostas = () => yt.textosEnviados().filter((t) => !SAUDACOES_DA_LIVE.includes(t));

  await test('serviço: fluxo é o padrão; lê em ~1 s, responde na hora, "como está a live" diz o modo e a cota conta só as conexões', async () => {
    const m = montar();
    servidor.roteiro = (call) => escrever(call, [msg('h1', 'velha')], 't1');
    const entrada = (await m.manda(`entra na live ${LINK}`)).text;
    assert.match(entrada, /Leio o chat em fluxo/);
    assert.match(entrada, /cerca de 4 h/);
    await m.rodar(); // abre a conexão; o histórico é ignorado
    assert.ok(m.fila[0].ms <= 1000, `o laço devia voltar em até 1 s, voltou em ${m.fila[0].ms} ms`);
    m.avanca(6000);
    const t0 = Date.now();
    servidor.enviar([msg('m1', 'oi yui')], 't2');
    await m.rodar();
    assert.ok(Date.now() - t0 < 2000);
    assert.deepEqual(respostas(), ['oi, chat!']);
    const stf = (await m.manda('como está a live')).text;
    assert.match(stf, /Lendo em fluxo\./);
    assert.doesNotMatch(stf, /  /, 'sem espaço duplo');
    assert.equal(servidor.pedidos.length, 1);
    const porOp = m.servico.painel().cota;
    assert.equal(porOp.usado, 1 + 20 + 5 + 20, 'videos.list + saudação + 1 conexão + 1 resposta');
    await m.manda('sai da live');
  });

  await test('serviço: a duração escolhe a mensagem de entrada (horas que cabem) e o aviso de estouro', async () => {
    for (const [horas, cabe, avisa] of [[6, 6, false], [8, 8, false], [9, 9, false], [12, 9, true]]) {
      const m = montar();
      servidor.roteiro = () => {};
      const t = (await m.manda(`entra na live ${LINK} por ${horas} horas`)).text;
      assert.match(t, new RegExp(`em fluxo \\(quase em tempo real\\), o que dá para cerca de ${cabe} h`));
      assert.equal(/podem estourar/.test(t), avisa);
      assert.match(t, /Se o fluxo falhar, passo para a consulta \((15|20|30) s\)|a cada (15|20|30) s/);
      await m.manda('sai da live');
    }
  });

  await test('serviço: UNIMPLEMENTED no gRPC passa para a consulta sem sair do chat; o status diz "o fluxo falhou" e o ritmo volta a 15 s+', async () => {
    const m = montar();
    servidor.roteiro = (call) => erroGrpc(call, grpcDoLeitor.status.UNIMPLEMENTED);
    await m.manda(`entra na live ${LINK}`);
    yt.enfileirarPagina({ itens: [mensagemDoChat({ id: 'velha1', texto: 'yui velha', em: '2026-11-28T19:00:00Z' })] }); // anterior à entrada: o corte da troca a descarta
    await m.rodar();
    assert.ok(logs.some((l) => /\[Live\] reserva:unimplemented/.test(l)), logs.join('|'));
    assert.match((await m.manda('como está a live')).text, /Estou na live.*Lendo por consulta \(o fluxo falhou\)\./);
    assert.equal(m.fila[0].ms, 15_000);
    assert.equal(m.respostasIa.length, 0, 'o que o fluxo já tinha entregado ou veio antes da entrada não vira resposta');
    yt.enfileirarPagina({ itens: [mensagemDoChat({ id: 'nova1', texto: 'oi yui', em: '2026-11-28T20:05:00Z' })] });
    await m.rodar();
    assert.deepEqual(respostas(), ['oi, chat!']);
    assert.equal(m.servico.estado(), 'ouvindo');
    assert.equal(servidor.pedidos.length, 1, 'o fluxo não é tentado de novo nesta live');
    assert.equal(m.avisos.length, 0);
    await m.manda('sai da live');
  });

  await test('serviço: o módulo do gRPC que não carrega também cai para a consulta, e na live seguinte o fluxo é tentado de novo', async () => {
    let carrega = false;
    const m = montar({ fluxo: { carregarGrpc: async () => { if (!carrega) throw new Error('sem o módulo'); return carregarGrpcPadrao(); } } });
    await m.manda(`entra na live ${LINK}`);
    await m.rodar();
    assert.match((await m.manda('como está a live')).text, /o fluxo falhou/);
    assert.equal(m.fila[0].ms, 15_000);
    await m.manda('sai da live');
    carrega = true;
    servidor.roteiro = (call) => escrever(call, [msg('h1', 'velha')], 't1');
    await m.manda(`entra na live ${LINK}`);
    await m.rodar();
    assert.match((await m.manda('como está a live')).text, /Lendo em fluxo\./);
    await m.manda('sai da live');
  });

  await test('serviço: acesso negado (PERMISSION_DENIED) e fim da live param e avisam como na consulta, sem cair para a reserva', async () => {
    let m = montar();
    servidor.roteiro = (call) => erroGrpc(call, grpcDoLeitor.status.PERMISSION_DENIED);
    await m.manda(`entra na live ${LINK}`);
    await m.rodar();
    assert.equal(m.avisos.length, 1);
    assert.match(m.avisos[0], /recusou meu acesso ao chat/);
    assert.equal(m.fila.length, 0);
    assert.ok(!logs.some((l) => /reserva:/.test(l)));

    m = montar();
    servidor.roteiro = (call) => erroGrpc(call, grpcDoLeitor.status.UNAUTHENTICATED);
    await m.manda(`entra na live ${LINK}`);
    await m.rodar();
    assert.match(m.avisos[0], /erro que não passa sozinho/);

    m = montar();
    servidor.roteiro = (call) => escrever(call, [msg('h1', 'velha')], 't1');
    await m.manda(`entra na live ${LINK}`);
    await m.rodar();
    servidor.enviar([msg('fim', '', { tipo: 'CHAT_ENDED_EVENT' })], 't2');
    await m.rodar(); // pega o evento
    if (m.fila.length) await m.rodar(); // (se a rodada anterior ainda não viu o fim)
    assert.equal(m.avisos.length, 1);
    assert.match(m.avisos[0], /A live acabou/);
    assert.equal(m.fila.length, 0);
    assert.ok(await ate(() => abertas() === 0), 'não pode sobrar conexão aberta depois de a live acabar');
  });

  await test('serviço: YUI_YOUTUBE_LEITURA=consulta usa só a consulta (nenhuma conexão gRPC), com o ritmo de sempre', async () => {
    const m = montar({ env: { YUI_YOUTUBE_LEITURA: 'consulta' } });
    servidor.roteiro = (call) => escrever(call, [msg('h1', 'velha')], 't1');
    const t = (await m.manda(`entra na live ${LINK}`)).text;
    assert.match(t, /Leio o chat a cada 15 s, o que dá para cerca de 5 h/);
    await m.rodar();
    assert.equal(m.fila[0].ms, 15_000);
    yt.enfileirarPagina({ itens: [mensagemDoChat({ id: 'a1', texto: 'oi yui' })] });
    await m.rodar();
    assert.deepEqual(respostas(), ['oi, chat!']);
    const st = (await m.manda('como está a live')).text;
    assert.doesNotMatch(st, /Lendo/, 'o status da consulta forçada é o de antes (só a queda para a reserva aparece)');
    assert.doesNotMatch(st, /  /, 'sem espaço duplo');
    assert.equal(servidor.pedidos.length, 0);
    await m.manda('sai da live');
  });

  await test('serviço: sair e parar fecham a conexão (nada fica aberto)', async () => {
    let m = montar();
    servidor.roteiro = (call) => escrever(call, [msg('h1', 'velha')], 't1');
    await m.manda(`entra na live ${LINK}`);
    await m.rodar();
    assert.equal(abertas(), 1);
    assert.equal((await m.manda('sai da live')).text, 'Saí da live.');
    assert.ok(await ate(() => abertas() === 0), 'sair precisa fechar a conexão');
    assert.equal(m.fila.length, 0);

    m = montar();
    servidor.roteiro = (call) => escrever(call, [msg('h1', 'velha')], 't1');
    await m.manda(`entra na live ${LINK}`);
    await m.rodar();
    assert.equal(abertas(), 1);
    m.servico.parar();
    assert.ok(await ate(() => abertas() === 0), 'desligar precisa fechar a conexão');
    assert.equal(m.fila.length, 0);
  });
  await test('regressão 2 no serviço: servidor que fecha na hora acaba na reserva (consulta), sem laço, e a cota conta cada conexão', async () => {
    const rel = relogio(Date.parse('2026-11-28T20:00:00Z'));
    const m = montar({ fluxo: { agora: rel.agora } });
    servidor.roteiro = (call) => call.end();
    await m.manda(`entra na live ${LINK}`);
    for (let i = 0; i < 6 && !/falhou/.test((await m.manda('como está a live')).text); i += 1) { await m.rodar(); rel.avanca(6000); }
    assert.match((await m.manda('como está a live')).text, /Lendo por consulta \(o fluxo falhou\)\./);
    assert.equal(servidor.pedidos.length, 3);
    assert.ok(logs.some((l) => /reserva:fechou-sem-dado/.test(l)));
    assert.equal(m.servico.painel().cota.usado, 1 + 20 + 5 * 3 + 5, '1 videos.list, a saudação, 3 conexões e a 1ª leitura da reserva');
    await m.manda('sai da live');
  });

  await test('regressão 5: se a 1ª leitura da reserva falha, a tentativa seguinte ainda vai sem token e ainda descarta o histórico', async () => {
    const m = montar({ fluxo: { carregarGrpc: async () => { throw new Error('sem o módulo'); } } });
    await m.manda(`entra na live ${LINK}`);
    yt.falharLeituras(500, 'backendError');
    await m.rodar(); // a troca acontece, mas a leitura da consulta falha
    yt.falharLeituras(null);
    yt.enfileirarPagina({ itens: [mensagemDoChat({ id: 'velha1', texto: 'oi yui velha', em: '2026-11-28T19:00:00Z' })], proxima: 'PAG-REST' });
    await m.rodar();
    assert.equal(m.respostasIa.length, 0, 'o histórico anterior à entrada não vira resposta');
    const leituras = yt.requisicoes.filter((r) => r.metodo === 'GET' && r.caminho.endsWith('/liveChat/messages'));
    assert.ok(leituras.length >= 2);
    assert.ok(leituras.every((r) => !r.consulta.pageToken), 'nenhuma leitura da reserva leva o token do gRPC');
    await m.manda('sai da live');
  });

  await test('regressão 7 no serviço: o erro tardio do leitor de uma live que já saiu não muda o modo da live nova', async () => {
    let chamadas = 0;
    let soltar;
    const portao = new Promise((r) => { soltar = r; });
    const m = montar({ fluxo: { carregarGrpc: async () => { chamadas += 1; if (chamadas === 1) { await portao; throw new Error('tarde'); } return carregarGrpcPadrao(); } } });
    servidor.roteiro = (call) => escrever(call, [msg('h1', 'velha')], 't1');
    await m.manda(`entra na live ${LINK}`);
    const antiga = m.rodar(); // fica esperando o carregamento do gRPC
    await dormir(30);
    await m.manda('sai da live');
    await m.manda(`entra na live ${LINK}`);
    soltar();
    await antiga;
    assert.match((await m.manda('como está a live')).text, /Lendo em fluxo\./);
    assert.equal(logs.filter((l) => /reserva:/.test(l)).length, 0);
    await m.manda('sai da live');
  });
} finally {
  servidor.reiniciar();
  servidor.parar();
  await yt.close();
  oauth.closeAllConnections?.();
  await new Promise((r) => oauth.close(r));
  isolada.cleanup();
}

console.log(`\n${passed} testes OK${failed ? `, ${failed} FALHA(S)` : ''}`);
process.exitCode = failed ? 1 : 0;
// O processo precisa terminar sozinho (sem handles abertos): se ainda estiver vivo daqui a pouco, algo ficou aberto.
setTimeout(() => { console.log('FALHA: o processo não terminou sozinho (conexão, timer ou servidor ficou aberto)'); process.exit(3); }, 4000).unref();
