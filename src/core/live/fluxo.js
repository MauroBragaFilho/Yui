// LEITURA DO CHAT EM FLUXO (liveChatMessages.streamList, gRPC): o leitor PRINCIPAL da live (a consulta REST de adaptadores/youtube/api.js fica de reserva).
//
// Como o YouTube entrega: UMA conexão aberta que empurra as mensagens quando elas chegam (a mediana medida foi 1,4 s). O servidor fecha cada conexão em cerca de 10 s, com fim NORMAL; reabrir com o
// último nextPageToken continua sem perder nada. A cota cobra 5 unidades por CONEXÃO aberta, não por mensagem: por isso quem decide abrir é o adaptador (via `podeAbrir`, a cota) e a pausa entre
// conexões vem da duração da live (ritmoDaLive, servico.js).
//
// Este leitor tem a MESMA forma de `lerMensagens` do cliente REST, mais dois campos na resposta: `novaConexao` (true só quando esta chamada abriu uma conexão: é o que o adaptador conta na cota) e
// `intervaloMs` (em quanto tempo chamar de novo). Tudo é INJETÁVEL (token, carregamento do gRPC, endereço, credenciais, relógio e timers): os testes usam um servidor gRPC falso em 127.0.0.1 (insecure).
// O módulo do gRPC só é carregado na primeira leitura; se não carregar, o fluxo fica indisponível (FLUXO_INDISPONIVEL) e o serviço cai para a consulta. O token nunca vai para log nem para erro.
import path from 'node:path';
import { ErroYoutube } from '../../adaptadores/youtube/api.js';

export const ARQUIVO_PROTO = path.join(import.meta.dirname, 'stream_list.proto');
export const ENDERECO_PADRAO = 'dns:///youtube.googleapis.com:443';
export const ESPERA_DADO_MS = 1000; // com a conexão aberta e nada no buffer: espera até isto por dado ou fechamento
export const ESPERA_ABERTURA_MS = 1500; // depois de abrir uma conexão: espera até isto pela primeira resposta
export const INTERVALO_BUFFER_MS = 1000;
export const INTERVALO_SEM_COTA_MS = 30_000; // sem cota para abrir outra conexão: olha de novo daqui a pouco (o adaptador decide parar quando esgota)
export const BACKOFF_MAX_MS = 60_000;
export const FALHAS_SEGUIDAS_MAX = 3;
export const CONEXAO_CURTA_MS = 2000; // conexão que dura menos que isto (ou termina sem nenhum dado) é suspeita...
export const REABERTURA_MIN_MS = 5000; // ...e a seguinte só abre depois deste intervalo (no máximo 12 conexões por minuto)
const BUFFER_MAX = 1000;
const PEDIDO_PARTES = ['id', 'snippet', 'authorDetails'];
const SEM_DADO_MAX_MS = 45_000; // conexão aberta há tanto tempo sem NENHUMA resposta (o servidor fecha em ~10 s): trata como UNAVAILABLE

/** Carrega o gRPC e o .proto (só na primeira leitura). @returns {Promise<{ grpc: any, Servico: any }>} */
export async function carregarGrpcPadrao() {
  const [g, l] = await Promise.all([import('@grpc/grpc-js'), import('@grpc/proto-loader')]);
  const grpc = g.default ?? g;
  const loader = l.default ?? l;
  const def = loader.loadSync(ARQUIVO_PROTO, { keepCase: false, longs: String, enums: String, defaults: false, oneofs: true });
  const Servico = grpc.loadPackageDefinition(def).youtube.api.v3.V3DataLiveChatMessageService;
  if (typeof Servico !== 'function') throw new Error('serviço StreamList não encontrado no .proto');
  return { grpc, Servico };
}

const camel = (s) => String(s).toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/** Põe a mensagem do fluxo no formato da consulta REST (o tipo vem como TEXT_MESSAGE_EVENT e a REST usa textMessageEvent). */
function converterItem(item) {
  if (!item || typeof item !== 'object') return item;
  const snippet = item.snippet && typeof item.snippet === 'object'
    ? { ...item.snippet, ...(typeof item.snippet.type === 'string' ? { type: camel(item.snippet.type) } : {}) }
    : item.snippet;
  return { ...item, snippet };
}

/**
 * @param {{
 *   obterToken: () => Promise<string>,
 *   carregarGrpc?: () => Promise<{ grpc: any, Servico: any }>,
 *   endereco?: string,
 *   credenciais?: any | ((grpc: any) => any),
 *   agora?: () => number,
 *   agendar?: (fn: Function, ms: number) => any,
 *   cancelar?: (t: any) => void,
 *   pausaMs?: number | (() => number),
 *   log?: (codigo: string) => void,
 * }} o
 */
export function criarLeitorEmFluxo({
  obterToken, carregarGrpc = carregarGrpcPadrao, endereco = ENDERECO_PADRAO, credenciais = null, agora = Date.now,
  agendar = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, cancelar = clearTimeout, pausaMs = 0, log = () => {},
} = {}) {
  let modulo = null; // { grpc, Servico }
  let cliente = null;
  let chamada = null;
  let aberta = false;
  let fechado = false;
  let buffer = { itens: [], token: null };
  let liveChatId = null;
  let erroPendente = null; // ErroYoutube a lançar quando o buffer esvaziar
  let proximaAberturaEm = 0; // ms (relógio de `agora`): antes disso não abre outra conexão
  let falhasSeguidas = 0;
  let backoffMs = 0;
  let conexoes = 0;
  let ultimaAtividadeEm = 0;
  let encerrarChamada = null; // (codigo, nome) => encerra a chamada atual como se o servidor tivesse fechado assim
  let limitesSeguidos = 0; // RESOURCE_EXHAUSTED seguidos
  let abertaEm = 0;
  let dadosNaConexao = false;
  let aguardandoHistorico = false; // a 1ª resposta de uma conexão aberta SEM token é o histórico do chat
  let primeiraFeita = false; // a 1ª leitura deste leitor já voltou: depois dela, a 1ª resposta de QUALQUER conexão sem token é histórico e é sempre descartada
  const acordadores = new Set();
  const timers = new Set();

  const pausa = () => Math.max(0, Number(typeof pausaMs === 'function' ? pausaMs() : pausaMs) || 0);
  const acordar = () => { for (const f of [...acordadores]) f(); };
  const esperar = (ms) => new Promise((resolve) => {
    let t = null;
    const fim = () => { if (t !== null) { cancelar(t); timers.delete(t); } acordadores.delete(fim); resolve(); };
    t = agendar(fim, ms);
    timers.add(t);
    acordadores.add(fim);
  });

  async function garantirCliente() {
    if (cliente) return;
    let novo;
    try {
      modulo = modulo ?? await carregarGrpc();
      const cred = typeof credenciais === 'function' ? credenciais(modulo.grpc) : (credenciais ?? modulo.grpc.credentials.createSsl());
      novo = new modulo.Servico(endereco, cred);
    } catch {
      throw new ErroYoutube('FLUXO_INDISPONIVEL', { reason: 'grpc-nao-carregou' });
    }
    if (fechado || cliente) { try { novo.close?.(); } catch { /* */ } return; } // fecharam durante o carregamento: o canal criado não fica aberto
    cliente = novo;
  }

  function tratarFim(codigoGrpc, nomeDoCodigo) {
    const t = agora();
    aberta = false;
    chamada = null;
    if (nomeDoCodigo === 'OK' || codigoGrpc === undefined) {
      proximaAberturaEm = Math.max(proximaAberturaEm, t + pausa());
      if (!dadosNaConexao || t - abertaEm < CONEXAO_CURTA_MS) {
        // fechou na hora ou sem dado nenhum: com pausa 0 isto viraria um laço de conexões (5 unidades cada). Espera mínima e, sem nenhum dado, conta como falha passageira.
        proximaAberturaEm = Math.max(proximaAberturaEm, t + REABERTURA_MIN_MS);
        if (!dadosNaConexao) {
          falhasSeguidas += 1;
          log('fluxo:fechou-sem-dado');
          if (falhasSeguidas >= FALHAS_SEGUIDAS_MAX) erroPendente = new ErroYoutube('FLUXO_INDISPONIVEL', { reason: 'fechou-sem-dado' });
        }
      }
    } else if (nomeDoCodigo === 'PERMISSION_DENIED') {
      erroPendente = new ErroYoutube('SEM_PERMISSAO', { reason: 'grpc', permanente: true });
    } else if (nomeDoCodigo === 'UNAUTHENTICATED') {
      erroPendente = new ErroYoutube('NAO_AUTENTICADO', { reason: 'grpc', permanente: true });
    } else if (nomeDoCodigo === 'NOT_FOUND') {
      erroPendente = new ErroYoutube('LIVE_ACABOU', { reason: 'grpc' });
    } else if (nomeDoCodigo === 'RESOURCE_EXHAUSTED') {
      limitesSeguidos += 1;
      if (limitesSeguidos >= FALHAS_SEGUIDAS_MAX) erroPendente = new ErroYoutube('FLUXO_INDISPONIVEL', { reason: 'limite-de-uso' }); // a reserva recebe a recusa de cota da REST e para como sempre
      backoffMs = Math.min(BACKOFF_MAX_MS, Math.max(2000, backoffMs * 2)); // pediu rápido demais: espera dobrada, sem parar
      proximaAberturaEm = t + backoffMs;
      log('fluxo:limite');
    } else if (nomeDoCodigo === 'UNIMPLEMENTED') {
      erroPendente = new ErroYoutube('FLUXO_INDISPONIVEL', { reason: 'unimplemented' });
    } else if (nomeDoCodigo === 'INVALID_ARGUMENT') {
      erroPendente = new ErroYoutube('FLUXO_INDISPONIVEL', { reason: 'argumento' }); // a reserva recomeça sem token
    } else {
      // UNAVAILABLE, INTERNAL, DEADLINE_EXCEEDED (e qualquer outro desconhecido): passageiro até FALHAS_SEGUIDAS_MAX seguidas
      falhasSeguidas += 1;
      log(`fluxo:falha:${String(nomeDoCodigo).slice(0, 30)}`);
      if (falhasSeguidas >= FALHAS_SEGUIDAS_MAX) erroPendente = new ErroYoutube('FLUXO_INDISPONIVEL', { reason: `falhas-seguidas:${String(nomeDoCodigo).slice(0, 30)}` });
      else proximaAberturaEm = Math.max(proximaAberturaEm, t + 1000 * falhasSeguidas);
    }
    acordar();
  }

  async function abrir(chat, pageToken) {
    await garantirCliente();
    if (fechado || !cliente) return false;
    let token;
    try { token = await obterToken(); } catch (e) { if (e instanceof ErroYoutube) throw e; token = null; } // falha passageira da renovação não vira erro permanente (igual à consulta)
    if (fechado || !cliente) return false;
    if (typeof token !== 'string' || !token) throw new ErroYoutube('NAO_AUTENTICADO', { permanente: true });
    const { grpc } = modulo;
    const meta = new grpc.Metadata();
    meta.set('authorization', `Bearer ${token}`);
    const pedido = { liveChatId: chat, part: PEDIDO_PARTES, ...(pageToken ? { pageToken } : {}) };
    aguardandoHistorico = !pageToken;
    conexoes += 1;
    aberta = true;
    dadosNaConexao = false;
    abertaEm = agora();
    ultimaAtividadeEm = abertaEm;
    const minha = cliente.StreamList(pedido, meta);
    chamada = minha;
    let terminou = false;
    const fim = (cod, nome) => { if (terminou || chamada !== minha) return; terminou = true; tratarFim(cod, nome); };
    encerrarChamada = (cod, nome) => { fim(cod, nome); try { minha.cancel(); } catch { /* já fechada */ } };
    minha.on('data', (resp) => {
      if (terminou || chamada !== minha || fechado) return;
      falhasSeguidas = 0;
      backoffMs = 0;
      limitesSeguidos = 0;
      dadosNaConexao = true;
      ultimaAtividadeEm = agora();
      if (typeof resp?.nextPageToken === 'string' && resp.nextPageToken) buffer.token = resp.nextPageToken;
      let ignorar = false;
      if (aguardandoHistorico) { aguardandoHistorico = false; ignorar = primeiraFeita; }
      for (const it of Array.isArray(resp?.items) ? resp.items : []) {
        const tipo = it?.snippet?.type;
        if (tipo === 'CHAT_ENDED_EVENT') { erroPendente = erroPendente ?? new ErroYoutube('LIVE_ACABOU', { reason: 'chat-ended' }); continue; }
        if (ignorar) continue;
        buffer.itens.push(converterItem(it));
        if (buffer.itens.length > BUFFER_MAX) buffer.itens.shift();
      }
      if (resp?.offlineAt) erroPendente = erroPendente ?? new ErroYoutube('LIVE_ACABOU', { reason: 'offline' });
      acordar();
    });
    minha.on('error', (e) => {
      const nome = grpc.status?.[e?.code] ?? String(e?.code ?? 'UNKNOWN');
      if (nome === 'CANCELLED') { fim(undefined, 'OK'); return; }
      fim(e?.code, nome);
    });
    minha.on('end', () => fim(undefined, 'OK'));
    return true;
  }

  const devolver = (novaConexao, intervaloMs) => {
    const mensagens = buffer.itens;
    buffer = { itens: [], token: buffer.token };
    return { mensagens, proximaPagina: buffer.token, intervaloMs, novaConexao };
  };
  const vazio = (intervaloMs, novaConexao = false) => devolver(novaConexao, intervaloMs);
  const lancarSePendente = () => { if (erroPendente) { const e = erroPendente; erroPendente = null; throw e; } };

  return {
    /**
     * @param {{ liveChatId: string, pageToken?: string|null, podeAbrir?: boolean }} p
     * @returns {Promise<{ mensagens: object[], proximaPagina: string|null, intervaloMs: number, novaConexao: boolean }>}
     */
    async lerMensagens({ liveChatId: chat, pageToken = null, podeAbrir = true } = {}) {
      if (fechado) return vazio(INTERVALO_SEM_COTA_MS);
      if (liveChatId !== chat) { liveChatId = chat; if (!buffer.token && pageToken) buffer.token = pageToken; }
      if (buffer.itens.length) return devolver(false, INTERVALO_BUFFER_MS);
      lancarSePendente();

      if (aberta) {
        if (agora() - ultimaAtividadeEm > SEM_DADO_MAX_MS) { encerrarChamada?.(14, 'UNAVAILABLE'); lancarSePendente(); return vazio(Math.max(500, proximaAberturaEm - agora())); }
        await esperar(ESPERA_DADO_MS);
        if (fechado) return vazio(INTERVALO_SEM_COTA_MS);
        if (buffer.itens.length) return devolver(false, INTERVALO_BUFFER_MS);
        lancarSePendente();
        return vazio(aberta ? INTERVALO_BUFFER_MS : Math.max(500, proximaAberturaEm - agora()));
      }

      const falta = proximaAberturaEm - agora();
      if (falta > 0) return vazio(Math.max(500, falta));
      if (podeAbrir === false) return vazio(INTERVALO_SEM_COTA_MS);

      const abriu = await abrir(chat, buffer.token ?? pageToken);
      if (!abriu || fechado) return vazio(INTERVALO_SEM_COTA_MS);
      try {
        if (!buffer.itens.length && aberta && !erroPendente) await esperar(ESPERA_ABERTURA_MS);
      } finally {
        primeiraFeita = true; // a partir daqui, a 1ª resposta de uma conexão sem token (histórico) nunca vira mensagem nova
      }
      if (fechado) return vazio(INTERVALO_SEM_COTA_MS);
      if (buffer.itens.length) return devolver(true, INTERVALO_BUFFER_MS);
      // o servidor recusou ou a live acabou logo na abertura: a conexão foi aberta (e cobrada), e o erro leva essa marca para a cota não ser subcontada
      try { lancarSePendente(); } catch (e) { if (e && typeof e === 'object') e.novaConexao = true; throw e; }
      return vazio(aberta ? INTERVALO_BUFFER_MS : Math.max(500, proximaAberturaEm - agora()), true);
    },

    /** Cancela a chamada, fecha o canal e limpa os timers. Pode ser chamada mais de uma vez. */
    fechar() {
      fechado = true;
      const c = chamada;
      chamada = null;
      aberta = false;
      try { c?.cancel?.(); } catch { /* já fechada */ }
      try { cliente?.close?.(); } catch { /* já fechado */ }
      cliente = null;
      for (const t of [...timers]) { try { cancelar(t); } catch { /* */ } }
      timers.clear();
      acordar();
      acordadores.clear();
    },

    /** Para o diagnóstico (só números e estado, nenhum texto do chat). */
    modo() {
      return { tipo: 'fluxo', fechado, conexaoAberta: aberta, conexoesAbertas: conexoes, naFila: buffer.itens.length, falhasSeguidas, backoffMs, carregado: Boolean(modulo) };
    },
  };
}
