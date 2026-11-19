// O SERVIDOR FALSO DA API DO YOUTUBE dos testes do adaptador de live (docs/CANAIS_NOVOS.md): um servidor HTTP em 127.0.0.1, aberto pelo PRÓPRIO teste, que imita só o que o adaptador
// usa (videos.list, liveChatMessages.list e liveChatMessages.insert). Nada sai da máquina e a API de verdade nunca é tocada. Os ids, os textos e os tokens daqui são inventados pelo teste.
//
// O que ele guarda (sem o token: só se a autorização veio certa): cada requisição { metodo, caminho, consulta, corpo, autorizado }.
// O que ele faz de errado, de propósito, quando o teste manda: erros HTTP com a razão do Google (403 liveChatEnded, 403 quotaExceeded, 401, 429, 500...), redirecionamento, página vazia,
// corpo que não é JSON e lentidão.
import http from 'node:http';

export const TOKEN_FALSO = 'ya29.TOKEN-FALSO-DE-TESTE-0123456789abcdef';

/** Uma mensagem do chat no formato da API (liveChatMessage). */
export function mensagemDoChat({ id, autor = 'UCautor00000000000000001', nome = 'Alguem', texto, em = '2026-11-19T12:00:00Z', dono = false, tipo = 'textMessageEvent' }) {
  return {
    kind: 'youtube#liveChatMessage',
    id,
    snippet: { type: tipo, liveChatId: 'CHAT-FALSO', authorChannelId: autor, publishedAt: em, hasDisplayContent: true, displayMessage: texto, textMessageDetails: { messageText: texto } },
    authorDetails: { channelId: autor, displayName: nome, isChatOwner: dono, isChatModerator: false, isChatSponsor: false, isVerified: false },
  };
}

const erroDoGoogle = (status, reason, message = 'erro de teste') => ({ error: { code: status, message, errors: [{ domain: 'youtube.liveChat', reason, message }], status: reason } });

/**
 * @returns {Promise<{ base: string, port: number, requisicoes: object[], definirVideo: Function, enfileirarPagina: Function, falharProximoEnvio: Function, falharLeituras: Function, responderCom: Function, limpar: Function, close: Function }>}
 */
export async function criarYoutubeFalso({ token = TOKEN_FALSO } = {}) {
  const requisicoes = [];
  const videos = new Map(); // id -> { titulo, liveChatId, terminou, eLive }
  const paginas = []; // páginas do chat (uma por leitura): { itens, intervaloMs, proxima } ou { erro: { status, reason } }
  const falhasDeEnvio = []; // { status, reason }: cada uma vale para UM envio
  let leituraComErro = null; // { status, reason } para TODAS as leituras
  let forcado = null; // { status, tipo, corpo, atrasoMs, local }: resposta forçada para TODAS as requisições
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let corpo = null;
      try { corpo = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { corpo = '(não é JSON)'; }
      const autorizado = req.headers.authorization === `Bearer ${token}`;
      requisicoes.push({ metodo: req.method, caminho: url.pathname, consulta: Object.fromEntries(url.searchParams), corpo, autorizado, temTokenNaUrl: req.url.includes(token) });
      const responder = (status, objeto) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof objeto === 'string' ? objeto : JSON.stringify(objeto)); };
      const executar = () => {
        if (forcado?.local) { res.writeHead(forcado.status, { location: forcado.local }); res.end(); return; }
        if (forcado?.corpo !== undefined) { responder(forcado.status ?? 200, forcado.corpo); return; }
        if (!autorizado) { responder(401, erroDoGoogle(401, 'authError', 'sem autorização')); return; }
        if (req.method === 'GET' && url.pathname.endsWith('/videos')) {
          const v = videos.get(url.searchParams.get('id'));
          if (!v) { responder(200, { kind: 'youtube#videoListResponse', items: [] }); return; }
          const liveStreamingDetails = v.eLive === false ? undefined : { actualStartTime: '2026-11-19T11:00:00Z', ...(v.terminou ? { actualEndTime: '2026-11-19T12:30:00Z' } : v.liveChatId ? { activeLiveChatId: v.liveChatId } : {}) };
          responder(200, { kind: 'youtube#videoListResponse', items: [{ id: url.searchParams.get('id'), snippet: { title: v.titulo ?? 'Live de teste' }, ...(liveStreamingDetails ? { liveStreamingDetails } : {}) }] });
          return;
        }
        if (req.method === 'GET' && url.pathname.endsWith('/liveChat/messages')) {
          if (leituraComErro) { responder(leituraComErro.status, erroDoGoogle(leituraComErro.status, leituraComErro.reason)); return; }
          const p = paginas.shift();
          if (p?.erro) { responder(p.erro.status, erroDoGoogle(p.erro.status, p.erro.reason)); return; }
          responder(200, { kind: 'youtube#liveChatMessageListResponse', pollingIntervalMillis: p?.intervaloMs ?? 5000, nextPageToken: p?.proxima ?? `PAGINA-${requisicoes.length}`, items: p?.itens ?? [] });
          return;
        }
        if (req.method === 'POST' && url.pathname.endsWith('/liveChat/messages')) {
          const falha = falhasDeEnvio.shift();
          if (falha) { responder(falha.status, erroDoGoogle(falha.status, falha.reason)); return; }
          responder(200, { kind: 'youtube#liveChatMessage', id: `ENVIADA-${requisicoes.length}` });
          return;
        }
        responder(404, erroDoGoogle(404, 'notFound'));
      };
      if (forcado?.atrasoMs) setTimeout(executar, forcado.atrasoMs); else executar();
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    base: `http://127.0.0.1:${port}/youtube/v3`,
    port,
    requisicoes,
    /** Cadastra um vídeo: { titulo, liveChatId (null = sem chat ativo), terminou, eLive (false = vídeo comum) }. */
    definirVideo(id, cfg) { videos.set(id, cfg); },
    /** A próxima leitura do chat devolve esta página: { itens, intervaloMs, proxima } ou { erro: { status, reason } }. */
    enfileirarPagina(p) { paginas.push(p); },
    /** O PRÓXIMO envio falha com este erro. */
    falharProximoEnvio(status, reason) { falhasDeEnvio.push({ status, reason }); },
    /** TODAS as leituras do chat falham com este erro (null desliga). */
    falharLeituras(status, reason) { leituraComErro = status ? { status, reason } : null; },
    /** Força uma resposta para TODAS as requisições (null desliga): { status, corpo } | { status, local } | { atrasoMs, ... }. */
    responderCom(f) { forcado = f; },
    enviadas() { return requisicoes.filter((r) => r.metodo === 'POST'); },
    textosEnviados() { return requisicoes.filter((r) => r.metodo === 'POST').map((r) => r.corpo?.snippet?.textMessageDetails?.messageText); },
    limpar() { requisicoes.length = 0; paginas.length = 0; falhasDeEnvio.length = 0; leituraComErro = null; forcado = null; videos.clear(); },
    close() { for (const s of sockets) s.destroy(); return new Promise((resolve) => server.close(resolve)); },
  };
}
