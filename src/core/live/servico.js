// O SERVIÇO da live: roda no cérebro (ou no processo único), uma live por vez. Faz o laço de passo() no ritmo que o adaptador pede, atende os comandos do dono,
// avisa quando para e, depois de um reinício, NÃO volta sozinho: só avisa. A única coisa gravada em disco é a marca "estava numa live" (<DATABASE_DIR>/youtube-live.json).
import fs from 'node:fs';
import path from 'node:path';
import { criarAdaptadorYoutube, youtubeLigado } from '../../adaptadores/youtube/adaptador.js';
import { criarClienteYoutube, BASE_PADRAO, ErroYoutube } from '../../adaptadores/youtube/api.js';
import { criarLeitorEmFluxo } from './fluxo.js';
import { arquivoDaCredencial, lerCredencial, criarObterToken } from './credencial.js';
import { criarPonteDoCerebro, temPalavraProibida } from './ponte.js';
import { pedidoDeLive } from '../../adaptadores/youtube/pedido.js';
import { hostsDoGoogle } from '../../integrations/google/endpoints.js';

/** Os padrões que cabem numa live de 4 horas (docs/GUIA_YOUTUBE_LIVE.md): leitura a cada 15 s = 4.800 unidades; até 5 mensagens a cada 15 min = 1.600 nas 4 horas. */
export const PADROES_DA_LIVE = Object.freeze({ intervaloMinimoLeituraMs: 15_000 });
/**
 * Ritmo de leitura pela duração que o dono informar: 15 s cabem cerca de 5 h da cota diária falando no limite, 20 s cerca de 7 h, 30 s cerca de 9 h.
 */
export function ritmoDaLive(horas) {
  const fluxo = ritmoDoFluxo(horas);
  if (!(horas > 5)) return { segundos: 15, cabemHoras: 5, fluxo };
  return horas <= 7 ? { segundos: 20, cabemHoras: 7, fluxo } : { segundos: 30, cabemHoras: 9, fluxo };
}
/**
 * Ritmo do FLUXO (leitura principal) pela duração. Cada conexão dura cerca de 10 s e custa 5 unidades; a pausa entre conexões é o que faz o dia durar. Contas com 9.000 unidades usáveis
 * e as mensagens no teto de 20 por hora (400 por hora):
 *  sem horas ou até 4 h: pausa 0     -> 360 conexões/h x 5 + 400 = 2.200/h  -> 4 h = 8.800
 *  de 5 a 6 h:           pausa 10 s  -> 180 conexões/h x 5 + 400 = 1.300/h  -> 6 h = 7.800
 *  de 7 a 8 h:           pausa 15 s  -> 144 conexões/h x 5 + 400 = 1.120/h  -> 8 h = 8.960
 *  9 h ou mais:          pausa 25 s  -> ~103 conexões/h x 5 + 400 = ~915/h  -> 9 h = ~8.235
 * (a reserva REST, ritmoDaLive().segundos, mantém 15/20/30 s)
 */
export function ritmoDoFluxo(horas) {
  if (!(horas > 4)) return { pausaMs: 0, cabemHoras: 4 };
  if (horas <= 6) return { pausaMs: 10_000, cabemHoras: 6 };
  if (horas <= 8) return { pausaMs: 15_000, cabemHoras: 8 };
  return { pausaMs: 25_000, cabemHoras: 9 };
}
/** A chave YUI_YOUTUBE_LEITURA: "fluxo" (padrão) ou "consulta" (força a consulta REST). Lida a cada entrada na live (vale sem reiniciar). */
export const leituraEscolhida = (env = process.env) => (String(env?.YUI_YOUTUBE_LEITURA ?? 'fluxo').trim().toLowerCase() === 'consulta' ? 'consulta' : 'fluxo');
const LEITURA_NO_STATUS = Object.freeze({ fluxo: 'Lendo em fluxo.', reserva: 'Lendo por consulta (o fluxo falhou).' });
const AVISO_TENTATIVAS = 720; // 12 horas, uma por minuto: a queda de internet que derruba a live também derruba a DM
const AVISO_ESPERA_MS = 60_000;

export const arquivoDaMarca = (env = process.env) => path.join(env.DATABASE_DIR || path.join(process.cwd(), 'database'), 'youtube-live.json');

const TEXTOS = Object.freeze({
  'link-invalido': 'Esse link não parece de uma live do YouTube.',
  'host-nao-permitido': 'Só aceito link do youtube.com ou youtu.be.',
  'sem-video': 'Não achei o vídeo nesse link. Mande o link da live (youtube.com/watch?v=... ou /live/...).',
  'ja-esta-numa-live': 'Já estou numa live. Mande "sai da live" antes.',
  'video-nao-encontrado': 'Não achei esse vídeo (ele é privado?). Use uma live pública ou não listada.',
  'nao-e-live': 'Esse vídeo não é uma transmissão ao vivo.',
  'live-acabou': 'Essa live já acabou.',
  'sem-chat': 'Não achei o chat: a live ainda não começou ou o chat está desligado.',
  'cota-esgotada': 'A cota diária da API do YouTube acabou. Ela volta à meia-noite do horário do Pacífico.',
  'nao-autenticado': 'O YouTube recusou a autorização. Rode scripts/youtube-autorizar.mjs de novo.',
  'sem-credencial': 'Falta a autorização do canal. Rode scripts/youtube-autorizar.mjs (veja docs/GUIA_YOUTUBE_LIVE.md).',
  'sem-permissao': 'O YouTube negou o acesso (permissão, API desligada no projeto ou conta bloqueada).',
  'falha-temporaria': 'Não consegui falar com o YouTube agora. Tente de novo daqui a pouco.',
});
const MOTIVO_DA_PARADA = Object.freeze({
  removida: 'o YouTube recusou meu acesso ao chat (removida, silenciada, banida ou sem permissão)',
  cota_esgotada: 'a cota diária da API do YouTube acabou',
  erro_permanente: 'deu um erro que não passa sozinho',
});

/** Fala de chegada no chat (pedido do dono): frases fixas, uma sorteada a cada entrada. */
export const SAUDACOES_DA_LIVE = Object.freeze(['Cheguei, galera!', 'Cheguei, galera! Bora de live?', 'Oi, galera, cheguei!']);

/**
 * Os códigos FIXOS do "último erro" que o painel mostra (GET /v1/admin/live): os da entrada (TEXTOS), os das paradas (MOTIVO_DA_PARADA), os do adaptador e
 * os do laço. Qualquer outro vira "outro": nenhum texto de erro, do YouTube ou do chat sai daqui.
 */
export const CODIGOS_DE_ERRO_DA_LIVE = Object.freeze([
  ...Object.keys(TEXTOS), ...Object.keys(MOTIVO_DA_PARADA),
  'leituras-falharam', 'nao-escreve', 'desligado', 'cancelada', 'sem-canal-da-yui', 'chat-desligado', 'base-invalida', 'nao-esta-numa-live', 'outro',
]);
const codigoDeErro = (c) => (CODIGOS_DE_ERRO_DA_LIVE.includes(c) ? c : 'outro');

/**
 * @param {{ env?: object, ai?: object, avisarDono: (texto: string) => Promise<unknown>, ehDono: (id: string) => boolean, logger?: object, agora?: () => number,
 *   baseUrl?: string, tokenUrl?: string, fetchImpl?: typeof fetch, config?: object, agendar?: Function, cancelar?: Function,
 *   fluxo?: { endereco?: string, credenciais?: any, carregarGrpc?: Function, agendar?: Function, cancelar?: Function, agora?: Function } }} o
 * `fluxo` (opções do leitor em fluxo, para os testes): sem ele, o fluxo só vale com o endereço padrão da API do Google (com um `baseUrl` de teste a leitura é sempre a consulta, e nada sai da máquina).
 */
export function criarServicoDaLive({
  env = process.env, ai, avisarDono, ehDono, logger = console, agora = Date.now, baseUrl = BASE_PADRAO, tokenUrl = null, fetchImpl = globalThis.fetch, config = {}, fluxo: fluxoCfg = null,
  agendar = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, cancelar = clearTimeout,
} = {}) {
  const marca = arquivoDaMarca(env);
  const arquivo = arquivoDaCredencial(env);
  let adaptador = null;
  let composto = null; // o cliente composto (fluxo com reserva na consulta)
  let canalDoAdaptador = null;
  let titulo = '';
  let timer = null;
  let timerDoAviso = null;
  let geracao = 0; // muda a cada entrar/sair/parar: um laço antigo nunca continua
  let entrando = false;
  // Para o painel (só leitura): quando entrou na live atual, os contadores do adaptador naquela hora (os números do painel são DESTA live) e o último erro
  // como código fixo com a hora. Nada disso leva texto do chat, nome de quem escreveu nem texto de erro.
  let desdeEm = null;
  let baseDosContadores = null;
  let ultimoErro = null;
  const anotarErro = (codigo) => { ultimoErro = { codigo: codigoDeErro(codigo), em: agora() }; };

  const avisar = async (texto) => {
    try { return (await avisarDono(texto)) !== false; } catch { logger.warn?.('[Live] não consegui avisar o dono.'); return false; }
  };
  const apagarMarca = () => { try { fs.rmSync(marca, { force: true }); } catch { /* */ } };
  const gravarMarca = (aviso) => {
    try { fs.mkdirSync(path.dirname(marca), { recursive: true }); fs.writeFileSync(marca, JSON.stringify({ em: new Date(agora()).toISOString(), ...(aviso ? { aviso } : {}) })); } catch { logger.warn?.('[Live] não consegui gravar a marca da live.'); }
  };
  const pararLaco = () => { geracao += 1; if (timer) cancelar(timer); if (timerDoAviso) cancelar(timerDoAviso); timer = null; timerDoAviso = null; composto?.fechar(); };

  /** A marca (com o texto do aviso) só é apagada quando o dono recebe: até lá tenta de novo, e a próxima subida também. */
  async function entregarAviso(texto, minha, tentativa = 1) {
    if (minha !== geracao) return;
    if (await avisar(texto)) { if (minha === geracao) apagarMarca(); return; }
    if (tentativa < AVISO_TENTATIVAS && minha === geracao) timerDoAviso = agendar(() => entregarAviso(texto, minha, tentativa + 1), AVISO_ESPERA_MS);
  }
  const notificar = (texto) => { gravarMarca(texto); return entregarAviso(texto, geracao); };

  /**
   * O cliente que o adaptador usa: buscar a live e escrever vão pela API de sempre (REST); LER vai pelo fluxo (gRPC) e, se ele falhar de um jeito que não passa
   * (FLUXO_INDISPONIVEL), troca para a consulta REST até o fim DESSA live, sem sair do chat. `iniciar` vale por live: cria o leitor novo e escolhe o modo.
   */
  function criarClienteComposto({ rest, obterToken }) {
    let leitor = null;
    let modo = 'consulta'; // 'fluxo' | 'consulta' | 'reserva' (o fluxo falhou)
    let desde = 0;
    let ultimaPublicacao = 0; // a mensagem mais nova que o fluxo entregou (ms)
    let conexaoExtra = false; // a conexão que falhou e levou à troca foi aberta: a cota conta uma vez a mais
    let trocou = false; // a 1ª leitura da consulta, logo depois da troca, começa do zero e descarta o que o fluxo já tinha entregado
    const publicada = (m) => { const t = Date.parse(m?.snippet?.publishedAt ?? ''); return Number.isFinite(t) ? t : null; };
    return {
      buscarLive: (v) => rest.buscarLive(v),
      enviarMensagem: (a) => rest.enviarMensagem(a),
      async lerMensagens(args) {
        const l = leitor;
        if (l) {
          try {
            const p = await l.lerMensagens(args);
            if (leitor === l) for (const m of p.mensagens) ultimaPublicacao = Math.max(ultimaPublicacao, publicada(m) ?? 0);
            return p;
          } catch (e) {
            if (!(e instanceof ErroYoutube) || e.code !== 'FLUXO_INDISPONIVEL') throw e;
            if (leitor !== l) return { mensagens: [], proximaPagina: null, intervaloMs: 1000, novaConexao: false }; // a live acabou ou mudou durante a espera: não mexe no estado da outra
            logger.warn?.(`[Live] reserva:${String(e.reason ?? e.code).slice(0, 40)}`);
            l.fechar();
            leitor = null;
            modo = 'reserva';
            trocou = true;
            conexaoExtra = e.novaConexao === true;
          }
        }
        if (!trocou) return rest.lerMensagens(args);
        // só depois de a 1ª leitura da reserva dar certo é que a troca está feita (se falhar, a próxima tentativa continua sem o token do gRPC e com o filtro do histórico)
        const p = await rest.lerMensagens({ ...args, pageToken: null });
        trocou = false;
        const corte = Math.max(ultimaPublicacao, desde);
        const extra = conexaoExtra;
        conexaoExtra = false;
        return { ...p, ...(extra ? { conexaoExtra: true } : {}), mensagens: p.mensagens.filter((m) => (publicada(m) ?? Infinity) > corte) };
      },
      /** Nova live: fecha o leitor da anterior e prepara o desta. @param {{ fluxo: boolean, pausaMs?: number }} o */
      iniciar({ fluxo: usarFluxo, pausaMs }) {
        leitor?.fechar();
        leitor = null;
        trocou = false;
        ultimaPublicacao = 0;
        desde = agora();
        modo = usarFluxo ? 'fluxo' : 'consulta';
        if (usarFluxo) {
          leitor = criarLeitorEmFluxo({ obterToken, pausaMs, log: (c) => logger.info?.(`[Live] ${c}`), ...(fluxoCfg ?? {}) });
        }
      },
      fechar() { leitor?.fechar(); leitor = null; },
      modo: () => modo,
    };
  }

  function criar(canalId) {
    if (adaptador && canalDoAdaptador === canalId) return adaptador; // o contador de cota do dia fica com o adaptador
    canalDoAdaptador = canalId;
    const ligado = youtubeLigado(env);
    const obterToken = criarObterToken({ arquivo, tokenUrl: tokenUrl ?? hostsDoGoogle().token, fetchImpl, agora });
    composto = criarClienteComposto({ rest: criarClienteYoutube({ ligado, obterToken, baseUrl, fetchImpl }), obterToken });
    adaptador = criarAdaptadorYoutube({
      ligado,
      cliente: composto,
      cerebro: criarPonteDoCerebro({ ...(ai ? { ai } : {}), agora }),
      agora,
      avisarDono: ({ evento }) => { anotarErro(evento); return notificar(`Saí da live: ${MOTIVO_DA_PARADA[evento] ?? 'algo deu errado'}.`); },
      proibido: temPalavraProibida,
      log: (codigo) => logger.info?.(`[Live] ${codigo}`),
      config: { ...PADROES_DA_LIVE, ...config, canalDaYui: canalId },
    });
    return adaptador;
  }

  function laco(minha, ms, quebras = 0) {
    timer = agendar(async () => {
      if (minha !== geracao) return;
      let r;
      try {
        r = await adaptador.passo();
      } catch (e) {
        logger.warn?.(`[Live] a rodada falhou (${String(e?.code ?? e?.name ?? 'erro').slice(0, 40)}).`);
        if (minha !== geracao) return;
        if (quebras < 4) { laco(minha, 30_000, quebras + 1); return; }
        anotarErro('leituras-falharam');
        desdeEm = null;
        composto?.fechar();
        adaptador.sair({ canal: 'app', papel: 'dono' });
        await notificar('Saí da live: as leituras do chat falharam várias vezes seguidas.');
        return;
      }
      if (minha !== geracao) return;
      if (r.proximoEmMs !== null) { laco(minha, r.proximoEmMs); return; }
      composto?.fechar(); // a live acabou ou o adaptador parou: nada de conexão aberta
      if (adaptador.estado === 'encerrada') await notificar('A live acabou e eu saí do chat.'); // as outras paradas o adaptador já avisou
    }, ms);
  }

  async function entrar(link, canal, horas) {
    if (entrando) return 'Já estou tentando entrar. Um instante.';
    const lida = lerCredencial(arquivo);
    if (!lida.ok) { anotarErro('sem-credencial'); return TEXTOS['sem-credencial']; }
    entrando = true;
    try {
      const ad = criar(lida.dados.canalId);
      const ritmo = ritmoDaLive(horas);
      const usarFluxo = leituraEscolhida(env) === 'fluxo' && (fluxoCfg !== null || baseUrl === BASE_PADRAO);
      const r = await ad.entrar({ link, canal, papel: 'dono', intervaloLeituraMs: ritmo.segundos * 1000 });
      if (!r.ok) { anotarErro(r.codigo); return TEXTOS[r.codigo] ?? 'Não consegui entrar na live.'; }
      pararLaco();
      composto.iniciar({ fluxo: usarFluxo, pausaMs: ritmo.fluxo.pausaMs });
      titulo = r.titulo;
      desdeEm = agora();
      const c = ad.retrato().contadores;
      baseDosContadores = { lidas: c.lidas, respondidas: c.respondidas, espontaneas: c.espontaneas };
      gravarMarca();
      await ad.saudar(SAUDACOES_DA_LIVE[Math.floor(Math.random() * SAUDACOES_DA_LIVE.length)]);
      if (ad.estado !== 'ouvindo') { anotarErro('nao-escreve'); desdeEm = null; composto.fechar(); return 'Entrei no chat, mas o YouTube não me deixou escrever e eu saí. Confira se a conta pode falar nesse chat.'; }
      laco(geracao, 0);
      const abertura = `Entrei no chat da live${titulo ? ` "${titulo}"` : ''}. Respondo quando me chamarem pelo nome.`;
      if (!usarFluxo) return `${abertura} Leio o chat a cada ${ritmo.segundos} s, o que dá para cerca de ${ritmo.cabemHoras} h${horas > ritmo.cabemHoras ? `; as ${horas} h que você disse podem estourar a cota antes do fim` : ''}. Para parar: "sai da live".`;
      return `${abertura} Leio o chat em fluxo (quase em tempo real), o que dá para cerca de ${ritmo.fluxo.cabemHoras} h${horas > ritmo.fluxo.cabemHoras ? `; as ${horas} h que você disse podem estourar a cota antes do fim` : ''}. Se o fluxo falhar, passo para a consulta (a cada ${ritmo.segundos} s). Para parar: "sai da live".`;
    } finally {
      entrando = false;
    }
  }

  function sair(canal) {
    const r = adaptador?.sair({ canal, papel: 'dono' });
    if (!r?.ok) return 'Não estou em nenhuma live.';
    pararLaco();
    apagarMarca();
    desdeEm = null;
    return 'Saí da live.';
  }

  /**
   * O retrato para o painel (GET /v1/admin/live; só leitura, só o dono): estado, qual live (id e título), desde quando, mensagens lidas e respondidas DESTA live,
   * a cota do dia e o último erro como código fixo. NUNCA o texto de uma mensagem do chat nem o nome de quem escreveu (o adaptador nem guarda isso no retrato).
   */
  function painel() {
    const r = adaptador ? adaptador.retrato() : null;
    const ativo = Boolean(r?.ativo);
    const c = r?.contadores ?? {};
    const desta = (k) => Math.max(0, (Number(c[k]) || 0) - (Number(baseDosContadores?.[k]) || 0));
    return {
      ligado: youtubeLigado(env),
      estado: r?.estado ?? null,
      ativo,
      videoId: ativo ? r.videoId : null,
      titulo: ativo ? titulo : null,
      desde: ativo && desdeEm ? new Date(desdeEm).toISOString() : null,
      mensagens: baseDosContadores ? { lidas: desta('lidas'), respondidas: desta('respondidas'), espontaneas: desta('espontaneas') } : null,
      cota: r?.cota ? { dia: r.cota.dia, usado: r.cota.usado, limiteDiario: r.cota.limiteDiario, reserva: r.cota.reserva, restante: r.cota.restante, nivel: r.cota.nivel } : null,
      ultimoErro: ultimoErro ? { codigo: ultimoErro.codigo, em: new Date(ultimoErro.em).toISOString() } : null,
    };
  }

  function status() {
    if (!adaptador) return 'Não estou em nenhuma live (desde que liguei).';
    const r = adaptador.retrato();
    const onde = r.estado === 'ouvindo' ? `Estou na live${titulo ? ` "${titulo}"` : ''}.`
      : r.estado === 'interrompida' ? 'Parei por um problema e não estou em live.'
        : r.estado === 'procurando' ? 'Estou procurando o chat.' : 'Não estou em nenhuma live.';
    const espera = r.guarda?.esperaDoTetoMs > 0 ? ` Atingi o teto de mensagens; volto a responder em cerca de ${Math.ceil(r.guarda.esperaDoTetoMs / 60_000)} min.` : '';
    return `${onde}${espera} Mensagens lidas: ${r.contadores.lidas}; respostas: ${r.contadores.respondidas}; assuntos puxados: ${r.contadores.espontaneas}.${r.ativo && LEITURA_NO_STATUS[composto?.modo()] ? ` ${LEITURA_NO_STATUS[composto.modo()]}` : ''} Cota de hoje contada por mim: ${r.cota.usado} de ${r.cota.limiteDiario} unidades.`;
  }

  function avisarReinicio() {
    if (!youtubeLigado(env) || !fs.existsSync(marca)) return;
    let pendente = null;
    try { pendente = JSON.parse(fs.readFileSync(marca, 'utf8')).aviso; } catch { /* marca sem texto */ }
    const texto = typeof pendente === 'string' && pendente ? pendente : 'Reiniciei enquanto estava numa live e NÃO voltei para ela. Se ainda quiser, mande "entra na live <link>" de novo.';
    const minha = geracao;
    timerDoAviso = agendar(() => entregarAviso(texto, minha), 15_000);
  }

  return {
    /** Comando do dono. Quem chama já garantiu que é texto digitado em conversa privada; aqui o dono, o canal e a frase são conferidos de novo. */
    async rotear({ userId, texto, canal = 'discord_dm' } = {}) {
      const p = youtubeLigado(env) && ehDono(String(userId ?? '')) && (canal === 'discord_dm' || canal === 'app') ? pedidoDeLive(texto) : null;
      if (!p) return { handled: false };
      if (p.tipo === 'entrar') return { handled: true, text: await entrar(p.link, canal, p.horas) };
      return { handled: true, text: p.tipo === 'sair' ? sair(canal) : status() };
    },
    /** Na subida: se havia uma live aberta quando o processo parou, avisa o dono (tentando de novo enquanto o Discord não volta). Nunca volta para ela. */
    avisarReinicio,
    /** Encerramento do processo: para o laço sem apagar a marca (a próxima subida avisa o dono). */
    parar() {
      pararLaco();
      adaptador?.desligar();
    },
    estado: () => adaptador?.estado ?? null,
    /** Só leitura, para o painel do dono (veja `painel` acima). */
    painel,
  };
}
