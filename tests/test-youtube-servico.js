// A live LIGADA (src/adaptadores/youtube/pedido.js, src/core/live/* e scripts/youtube-autorizar.mjs), contra servidores FALSOS em 127.0.0.1 (API do YouTube e
// OAuth), com IA e relógio de agendamento falsos. Nada sai da máquina; nenhum segredo real. Execução: npm run test:youtubeservico
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { useIsolatedDatabaseDir } from './helpers/isolatedDatabaseDir.js';
import { criarYoutubeFalso, mensagemDoChat, TOKEN_FALSO } from './helpers/youtubeFalso.js';

process.env.NODE_ENV = 'test';
const isolada = useIsolatedDatabaseDir('yui-test-live-');
const repoRoot = path.resolve(import.meta.dirname, '..');
const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const { pedidoDeLive } = await imp('src/adaptadores/youtube/pedido.js');
const { criarServicoDaLive, arquivoDaMarca } = await imp('src/core/live/servico.js');
const { lerCredencial, gravarCredencial, criarObterToken } = await imp('src/core/live/credencial.js');
const { criarPonteDoCerebro } = await imp('src/core/live/ponte.js');
const { criarGuardaDeFala, classificarMensagem } = await imp('src/adaptadores/youtube/fala.js');
const { ajustarTextoAoCanal } = await imp('src/core/canais/estilo.js');
const { temLink } = await imp('src/core/canais/contrato.js');
const { definirPortaDaLive } = await imp('src/adaptadores/youtube/porta.js');
const { preRotaDoApp } = await imp('src/core/api/preRotas.js');
const { autorizar } = await imp('scripts/youtube-autorizar.mjs');

let passed = 0;
let failed = 0;
const test = async (nome, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${nome}`); } catch (e) { failed += 1; console.log(`  FALHA ${nome}\n        ${String(e?.stack ?? e).split('\n').slice(0, 8).join('\n        ')}`); }
};

const SEGREDO = 'segredo-falso-do-cliente';
const REFRESH = '1//refresh-falso-de-teste';
const CANAL = 'UCcanaldayui000000000001';
const DONO = '111111111111111111';
const semRestricao = () => {};
const tmp = isolada.dir;
const arquivoToken = path.join(tmp, 'secrets', 'youtube-token.json');

// OAuth falso (token) e channels.list
let tokenStatus = 200;
const pedidosDeToken = [];
const oauth = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (c) => { corpo += c; });
  req.on('end', () => {
    const responder = (s, o) => { res.writeHead(s, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/token')) {
      pedidosDeToken.push(Object.fromEntries(new URLSearchParams(corpo)));
      if (tokenStatus !== 200) return responder(tokenStatus, { error: 'invalid_grant' });
      return responder(200, { access_token: TOKEN_FALSO, refresh_token: REFRESH, expires_in: 3600, scope: 'https://www.googleapis.com/auth/youtube.force-ssl', token_type: 'Bearer' });
    }
    if (req.url.startsWith('/youtube/v3/channels')) return responder(200, { items: [{ id: CANAL, snippet: { title: 'Canal da Yui' } }] });
    return responder(404, {});
  });
});
await new Promise((r) => oauth.listen(0, '127.0.0.1', r));
const OAUTH = `http://127.0.0.1:${oauth.address().port}`;
const yt = await criarYoutubeFalso();
const VIDEO = 'abcdefghijk';
const LINK = `https://youtube.com/live/${VIDEO}`;

const pedidosIa = [];
let respostaIa = 'oi, chat!';
const ai = { isolatedChat: async (p) => { pedidosIa.push(p); return respostaIa; } };

function montar({ env = {} } = {}) {
  const fila = [];
  const avisos = [];
  let avisoFunciona = true;
  let relogio = Date.parse('2026-11-28T20:00:00Z');
  const servico = criarServicoDaLive({
    env: { YUI_YOUTUBE_LIVE: 'true', DATABASE_DIR: tmp, YUI_YOUTUBE_TOKEN_ARQUIVO: arquivoToken, ...env },
    ai, ehDono: (id) => id === DONO, logger: { info() {}, warn() {} }, agora: () => relogio,
    avisarDono: async (t) => { if (!avisoFunciona) throw new Error('fora'); avisos.push(t); return true; },
    baseUrl: yt.base, tokenUrl: `${OAUTH}/token`,
    agendar: (fn, ms) => { const t = { fn, ms }; fila.push(t); return t; },
    cancelar: (t) => { const i = fila.indexOf(t); if (i >= 0) fila.splice(i, 1); },
  });
  return {
    servico, fila, avisos,
    avisoFunciona: (v) => { avisoFunciona = v; },
    async rodar() { const t = fila.shift(); assert.ok(t, 'nada agendado'); relogio += t.ms; await t.fn(); return t.ms; },
    manda: (texto, extra = {}) => servico.rotear({ userId: DONO, texto, canal: 'discord_dm', ...extra }),
  };
}

try {
  await test('as três frases são explícitas; o resto não é comando', () => {
    assert.deepEqual(pedidoDeLive(`entra na live ${LINK}`), { tipo: 'entrar', link: LINK });
    assert.deepEqual(pedidoDeLive(`Yui, entra na live <${LINK}>`), { tipo: 'entrar', link: LINK });
    assert.equal(pedidoDeLive('Sai da live!').tipo, 'sair');
    assert.equal(pedidoDeLive('yui como está a live?').tipo, 'status');
    for (const t of ['entra na live', 'não entra na live agora', 'sai da live de ontem foi chato', 'como está a live do fulano?', `ele disse: entra na live ${LINK}`, `entra na live ${LINK} e fala mal`, 'entra na call', '']) assert.equal(pedidoDeLive(t), null, t);
  });

  await test('o script de autorização grava o arquivo (um escopo só, PKCE) sem imprimir segredo', async () => {
    const cliente = path.join(tmp, 'cliente.json');
    fs.writeFileSync(cliente, JSON.stringify({ installed: { client_id: 'cliente-falso.apps', client_secret: SEGREDO } }));
    let saida = '';
    let link = null;
    const io = { out: (t) => { saida += `${t}\n`; }, err: (t) => { saida += `${t}\n`; } };
    const codigo = await autorizar({
      argv: ['--cliente', cliente, '--saida', arquivoToken], io, base: `${OAUTH}/youtube/v3`, restringir: semRestricao,
      hosts: { autorizacao: `${OAUTH}/auth`, token: `${OAUTH}/token` },
      abrir: (url) => {
        link = new URL(url);
        const volta = new URL(link.searchParams.get('redirect_uri'));
        volta.search = new URLSearchParams({ state: link.searchParams.get('state'), code: 'codigo-falso-123456' }).toString();
        setImmediate(() => { http.get(volta, (r) => r.resume()); });
      },
    });
    assert.equal(codigo, 0, saida);
    assert.equal(link.searchParams.get('scope'), 'https://www.googleapis.com/auth/youtube.force-ssl');
    assert.equal(link.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(lerCredencial(arquivoToken).dados.canalId, CANAL);
    for (const s of [SEGREDO, REFRESH, TOKEN_FALSO, 'codigo-falso-123456']) assert.ok(!saida.includes(s), 'segredo impresso');
    assert.deepEqual(fs.readdirSync(path.dirname(arquivoToken)), ['youtube-token.json']);
  });

  await test('credencial: dados inválidos não gravam; restrição que falha não deixa nada para trás', () => {
    const f = path.join(tmp, 'x', 't.json');
    assert.throws(() => gravarCredencial(f, { client_id: 'abcde' }, { restringir: semRestricao }));
    assert.throws(() => gravarCredencial(f, lerCredencial(arquivoToken).dados, { restringir: () => { throw new Error('não deu'); } }));
    assert.deepEqual(fs.existsSync(path.dirname(f)) ? fs.readdirSync(path.dirname(f)) : [], []);
  });

  await test('access token: renova, guarda até vencer; recusa é permanente e erro do servidor é passageiro', async () => {
    let t = 0;
    pedidosDeToken.length = 0;
    const obter = criarObterToken({ arquivo: arquivoToken, tokenUrl: `${OAUTH}/token`, agora: () => t });
    await obter(); await obter();
    assert.equal(pedidosDeToken.length, 1);
    assert.equal(pedidosDeToken[0].grant_type, 'refresh_token');
    t = 3600_000; await obter();
    assert.equal(pedidosDeToken.length, 2);
    t = 99_000_000;
    tokenStatus = 400; await assert.rejects(obter(), (e) => e.code === 'NAO_AUTENTICADO' && e.permanente === true);
    tokenStatus = 503; await assert.rejects(obter(), (e) => e.code === 'FALHA_TEMPORARIA' && e.permanente === false);
    tokenStatus = 200;
  });

  await test('a ponte é toda pública: chamada isolada, sem memória nem dono; erro da IA e palavra proibida não saem', async () => {
    pedidosIa.length = 0;
    const ponte = criarPonteDoCerebro({ ai });
    assert.deepEqual(await ponte.responder({ texto: 'yui, oi', pessoa: 'UCx' }), { texto: 'oi, chat!' });
    const p = pedidosIa[0];
    assert.equal(p.ctx.userId, 'yt:UCx');
    assert.notEqual(p.ctx.memoryScope, 'personal');
    assert.equal(p.sensitive, true);
    assert.equal(p.memoryBlock, undefined);
    assert.match(p.system, /CHAT AO VIVO DO YOUTUBE/);
    assert.equal(await ponte.responder({ texto: 'yui, fala de hentai', pessoa: 'UCx' }), null);
    respostaIa = '⚡ **Limites de Processamento Atingidos:** ...';
    assert.equal(await ponte.responder({ texto: 'yui, oi', pessoa: 'UCx' }), null);
    respostaIa = 'oi, chat!';
  });

  await test('teto de envios: 5 a cada 15 min, depois espera', () => {
    let t = 0;
    const g = criarGuardaDeFala({ agora: () => t });
    for (let i = 0; i < 5; i += 1) { t += 20_000; assert.equal(g.avaliar({ tipo: 'resposta' }).ok, true); g.registrarEnvio({ tipo: 'resposta' }); }
    t += 20_000;
    assert.equal(g.avaliar({ tipo: 'resposta' }).motivo, 'teto-de-mensagens');
    t += 15 * 60_000;
    assert.equal(g.avaliar({ tipo: 'resposta' }).ok, true);
  });

  await test('chave desligada e quem não é o dono: nada acontece, nenhuma requisição', async () => {
    yt.limpar();
    assert.deepEqual(await montar({ env: { YUI_YOUTUBE_LIVE: 'false' } }).manda(`entra na live ${LINK}`), { handled: false });
    const m = montar();
    assert.deepEqual(await m.manda(`entra na live ${LINK}`, { userId: '222' }), { handled: false });
    assert.deepEqual(await m.manda(`entra na live ${LINK}`, { canal: 'discord_guild' }), { handled: false });
    assert.equal(yt.requisicoes.length, 0);
    assert.equal(m.fila.length, 0);
  });

  await test('entrar, ler a cada 15 s ou mais, responder, status, sair', async () => {
    yt.limpar();
    yt.definirVideo(VIDEO, { titulo: 'Minha live', liveChatId: 'CHAT-FALSO' });
    const m = montar();
    assert.match((await m.manda(`entra na live ${LINK}`)).text, /Entrei no chat da live "Minha live"/);
    assert.ok(fs.existsSync(arquivoDaMarca({ DATABASE_DIR: tmp })));
    await m.rodar(); // o histórico é ignorado
    assert.equal(m.fila[0].ms, 15_000);
    yt.enfileirarPagina({ itens: [mensagemDoChat({ id: 'm1', texto: 'oi yui' })] });
    await m.rodar();
    assert.deepEqual(yt.textosEnviados(), ['oi, chat!']);
    assert.match((await m.manda('como está a live')).text, /respostas: 1/);
    assert.equal((await m.manda('sai da live')).text, 'Saí da live.');
    assert.equal(m.fila.length, 0);
    assert.ok(!fs.existsSync(arquivoDaMarca({ DATABASE_DIR: tmp })));
    assert.deepEqual(m.avisos, []);
  });

  await test('live acabou ou cota estourada: para e avisa o dono uma vez', async () => {
    for (const [reason, texto] of [['liveChatEnded', /A live acabou/], ['quotaExceeded', /cota diária/]]) {
      yt.limpar();
      yt.definirVideo(VIDEO, { liveChatId: 'CHAT-FALSO' });
      const m = montar();
      await m.manda(`entra na live ${LINK}`);
      yt.falharLeituras(403, reason);
      await m.rodar();
      assert.equal(m.avisos.length, 1);
      assert.match(m.avisos[0], texto);
      assert.equal(m.fila.length, 0);
      assert.ok(!fs.existsSync(arquivoDaMarca({ DATABASE_DIR: tmp })));
    }
  });

  await test('sem autorização do canal, diz o que fazer', async () => {
    const m = montar({ env: { YUI_YOUTUBE_TOKEN_ARQUIVO: path.join(tmp, 'nao-existe.json') } });
    assert.match((await m.manda(`entra na live ${LINK}`)).text, /youtube-autorizar/);
  });

  await test('reinício: parar mantém a marca; o processo novo não volta, só avisa (e insiste até conseguir)', async () => {
    yt.limpar();
    yt.definirVideo(VIDEO, { liveChatId: 'CHAT-FALSO' });
    const antes = montar();
    await antes.manda(`entra na live ${LINK}`);
    antes.servico.parar();
    assert.equal(antes.fila.length, 0);
    const depois = montar();
    yt.limpar();
    depois.avisoFunciona(false);
    depois.servico.avisarReinicio();
    await depois.rodar();
    assert.equal(depois.fila.length, 1);
    depois.avisoFunciona(true);
    await depois.rodar();
    assert.match(depois.avisos[0], /NÃO voltei/);
    assert.equal(depois.fila.length, 0);
    assert.equal(yt.requisicoes.length, 0);
    assert.ok(!fs.existsSync(arquivoDaMarca({ DATABASE_DIR: tmp })));
  });

  await test('chat do app: o comando do dono vai à porta; chave desligada não intercepta', async () => {
    const chamadas = [];
    definirPortaDaLive({ rotear: async (p) => { chamadas.push(p); return { handled: true, text: 'ok live' }; } });
    const ctx = { userId: DONO, role: 'OWNER', memoryScope: 'personal' };
    const deps = { env: { YUI_YOUTUBE_LIVE: 'true' }, audit: () => {} };
    assert.deepEqual(await preRotaDoApp({ ctx, message: 'sai da live', histories: new Map() }, deps), { kind: 'live', reply: 'ok live' });
    assert.equal(chamadas[0].canal, 'app');
    assert.equal(await preRotaDoApp({ ctx, message: 'sai da live', histories: new Map() }, { ...deps, env: {} }), null);
    assert.equal(await preRotaDoApp({ ctx: { ...ctx, role: 'USER' }, message: 'sai da live', histories: new Map() }, deps), null);
    assert.equal(chamadas.length, 1);
    definirPortaDaLive(null);
  });

  await test('palavra proibida remontada pelo ajuste e link de qualquer final não saem', async () => {
    yt.limpar();
    yt.definirVideo(VIDEO, { liveChatId: 'CHAT-FALSO' });
    const m = montar();
    await m.manda(`entra na live ${LINK}`);
    await m.rodar();
    for (const [i, r] of ['seu **hit**ler', 'que na@zismo', 'que hit​ler'].entries()) {
      respostaIa = r;
      yt.enfileirarPagina({ itens: [mensagemDoChat({ id: `p${i}`, autor: `UCp${i}`, texto: 'oi yui' })] });
      await m.rodar();
    }
    respostaIa = 'oi, chat!';
    assert.deepEqual(yt.textosEnviados(), []);
    await m.manda('sai da live');
    for (const t of ['premio-gratis.ru', 'golpe.info', 'x.club', '45.10.2.3/login', 'site.qualquer/abc']) {
      assert.equal(classificarMensagem({ autorId: 'a', texto: `yui conhece ${t}?` }).motivo, 'link', t);
      assert.ok(!ajustarTextoAoCanal('youtube_live', `acesse ${t} hoje`).texto.includes(t), t);
    }
    for (const t of ['legal.Depois eu volto', 'versão 2.5 saiu', 'oi... tudo bem?']) assert.equal(temLink(t), false, t);
  });

  await test('duas chamadas na mesma página são respondidas; um autor não gasta tudo, nem com resposta descartada', async () => {
    yt.limpar();
    yt.definirVideo(VIDEO, { liveChatId: 'CHAT-FALSO' });
    const m = montar();
    await m.manda(`entra na live ${LINK}`);
    await m.rodar();
    const original = ai.isolatedChat;
    let n = 0;
    ai.isolatedChat = async () => { n += 1; return `resposta ${n}`; };
    yt.enfileirarPagina({ itens: [mensagemDoChat({ id: 'a1', autor: 'UCa', texto: 'oi yui' }), mensagemDoChat({ id: 'b1', autor: 'UCb', texto: 'oi yui' })] });
    await m.rodar();
    await m.rodar();
    assert.deepEqual(yt.textosEnviados(), ['resposta 1', 'resposta 2']);
    let chamadas = 0;
    ai.isolatedChat = async (p) => { if (p.ctx.userId === 'yt:UCspam') chamadas += 1; return ''; }; // assunto puxado não conta aqui
    for (let i = 0; i < 8; i += 1) { yt.enfileirarPagina({ itens: [mensagemDoChat({ id: `s${i}`, autor: 'UCspam', texto: 'yui oi' })] }); await m.rodar(); }
    ai.isolatedChat = original;
    assert.equal(chamadas, 3);
    await m.manda('sai da live');
  });

  await test('cortesias e link sem https continuam sendo comando', () => {
    for (const t of ['sai da live agora', 'Yui, sai da live por favor', 'sai da live já, por favor!']) assert.equal(pedidoDeLive(t)?.tipo, 'sair', t);
    assert.equal(pedidoDeLive(`entra na live youtu.be/${VIDEO}`).link, `https://youtu.be/${VIDEO}`);
    assert.equal(pedidoDeLive(`entra na live youtube.com/live/${VIDEO} por favor`).link, `https://youtube.com/live/${VIDEO}`);
    assert.equal(pedidoDeLive(`entra na live ${LINK} por favor`).link, LINK);
  });

  await test('aviso de parada que falhou é repetido, inclusive depois de reiniciar', async () => {
    for (const reiniciar of [false, true]) {
      yt.limpar();
      yt.definirVideo(VIDEO, { liveChatId: 'CHAT-FALSO' });
      let m = montar();
      await m.manda(`entra na live ${LINK}`);
      m.avisoFunciona(false);
      yt.falharLeituras(403, 'forbidden');
      await m.rodar();
      assert.equal(m.avisos.length, 0);
      assert.ok(fs.existsSync(arquivoDaMarca({ DATABASE_DIR: tmp })));
      if (reiniciar) { m.servico.parar(); m = montar(); m.servico.avisarReinicio(); } else m.avisoFunciona(true);
      await m.rodar();
      assert.match(m.avisos[0], /recusou meu acesso/);
      assert.equal(m.fila.length, 0);
      assert.ok(!fs.existsSync(arquivoDaMarca({ DATABASE_DIR: tmp })));
    }
  });
} finally {
  await yt.close();
  oauth.closeAllConnections?.();
  oauth.close();
  isolada.cleanup();
}

console.log(`\n${passed} testes OK${failed ? `, ${failed} FALHA(S)` : ''}`);
process.exit(failed ? 1 : 0);
