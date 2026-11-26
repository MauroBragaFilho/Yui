// O SERVIÇO da live: roda no cérebro (ou no processo único), uma live por vez. Faz o laço de passo() no ritmo que o adaptador pede, atende os comandos do dono,
// avisa quando para e, depois de um reinício, NÃO volta sozinho: só avisa. A única coisa gravada em disco é a marca "estava numa live" (<DATABASE_DIR>/youtube-live.json).
import fs from 'node:fs';
import path from 'node:path';
import { criarAdaptadorYoutube, youtubeLigado } from '../../adaptadores/youtube/adaptador.js';
import { criarClienteYoutube, BASE_PADRAO } from '../../adaptadores/youtube/api.js';
import { arquivoDaCredencial, lerCredencial, criarObterToken } from './credencial.js';
import { criarPonteDoCerebro, temPalavraProibida } from './ponte.js';
import { pedidoDeLive } from '../../adaptadores/youtube/pedido.js';
import { hostsDoGoogle } from '../../integrations/google/endpoints.js';

/** Os padrões que cabem numa live de 4 horas (docs/GUIA_YOUTUBE_LIVE.md): leitura a cada 15 s = 4.800 unidades; até 5 mensagens a cada 15 min = 1.600 nas 4 horas. */
export const PADROES_DA_LIVE = Object.freeze({ intervaloMinimoLeituraMs: 15_000 });
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

/**
 * @param {{ env?: object, ai?: object, avisarDono: (texto: string) => Promise<unknown>, ehDono: (id: string) => boolean, logger?: object, agora?: () => number,
 *   baseUrl?: string, tokenUrl?: string, fetchImpl?: typeof fetch, config?: object, agendar?: Function, cancelar?: Function }} o
 */
export function criarServicoDaLive({
  env = process.env, ai, avisarDono, ehDono, logger = console, agora = Date.now, baseUrl = BASE_PADRAO, tokenUrl = null, fetchImpl = globalThis.fetch, config = {},
  agendar = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, cancelar = clearTimeout,
} = {}) {
  const marca = arquivoDaMarca(env);
  const arquivo = arquivoDaCredencial(env);
  let adaptador = null;
  let canalDoAdaptador = null;
  let titulo = '';
  let timer = null;
  let timerDoAviso = null;
  let geracao = 0; // muda a cada entrar/sair/parar: um laço antigo nunca continua
  let entrando = false;

  const avisar = async (texto) => {
    try { return (await avisarDono(texto)) !== false; } catch { logger.warn?.('[Live] não consegui avisar o dono.'); return false; }
  };
  const apagarMarca = () => { try { fs.rmSync(marca, { force: true }); } catch { /* */ } };
  const gravarMarca = (aviso) => {
    try { fs.mkdirSync(path.dirname(marca), { recursive: true }); fs.writeFileSync(marca, JSON.stringify({ em: new Date(agora()).toISOString(), ...(aviso ? { aviso } : {}) })); } catch { logger.warn?.('[Live] não consegui gravar a marca da live.'); }
  };
  const pararLaco = () => { geracao += 1; if (timer) cancelar(timer); if (timerDoAviso) cancelar(timerDoAviso); timer = null; timerDoAviso = null; };

  /** A marca (com o texto do aviso) só é apagada quando o dono recebe: até lá tenta de novo, e a próxima subida também. */
  async function entregarAviso(texto, minha, tentativa = 1) {
    if (minha !== geracao) return;
    if (await avisar(texto)) { if (minha === geracao) apagarMarca(); return; }
    if (tentativa < AVISO_TENTATIVAS && minha === geracao) timerDoAviso = agendar(() => entregarAviso(texto, minha, tentativa + 1), AVISO_ESPERA_MS);
  }
  const notificar = (texto) => { gravarMarca(texto); return entregarAviso(texto, geracao); };

  function criar(canalId) {
    if (adaptador && canalDoAdaptador === canalId) return adaptador; // o contador de cota do dia fica com o adaptador
    canalDoAdaptador = canalId;
    const ligado = youtubeLigado(env);
    const obterToken = criarObterToken({ arquivo, tokenUrl: tokenUrl ?? hostsDoGoogle().token, fetchImpl, agora });
    adaptador = criarAdaptadorYoutube({
      ligado,
      cliente: criarClienteYoutube({ ligado, obterToken, baseUrl, fetchImpl }),
      cerebro: criarPonteDoCerebro({ ...(ai ? { ai } : {}), agora }),
      agora,
      avisarDono: ({ evento }) => notificar(`Saí da live: ${MOTIVO_DA_PARADA[evento] ?? 'algo deu errado'}.`),
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
        adaptador.sair({ canal: 'app', papel: 'dono' });
        await notificar('Saí da live: as leituras do chat falharam várias vezes seguidas.');
        return;
      }
      if (minha !== geracao) return;
      if (r.proximoEmMs !== null) { laco(minha, r.proximoEmMs); return; }
      if (adaptador.estado === 'encerrada') await notificar('A live acabou e eu saí do chat.'); // as outras paradas o adaptador já avisou
    }, ms);
  }

  async function entrar(link, canal) {
    if (entrando) return 'Já estou tentando entrar. Um instante.';
    const lida = lerCredencial(arquivo);
    if (!lida.ok) return TEXTOS['sem-credencial'];
    entrando = true;
    try {
      const ad = criar(lida.dados.canalId);
      const r = await ad.entrar({ link, canal, papel: 'dono' });
      if (!r.ok) return TEXTOS[r.codigo] ?? 'Não consegui entrar na live.';
      pararLaco();
      titulo = r.titulo;
      gravarMarca();
      laco(geracao, 0);
      return `Entrei no chat da live${titulo ? ` "${titulo}"` : ''}. Respondo quando me chamarem pelo nome. Para parar: "sai da live".`;
    } finally {
      entrando = false;
    }
  }

  function sair(canal) {
    const r = adaptador?.sair({ canal, papel: 'dono' });
    if (!r?.ok) return 'Não estou em nenhuma live.';
    pararLaco();
    apagarMarca();
    return 'Saí da live.';
  }

  function status() {
    if (!adaptador) return 'Não estou em nenhuma live (desde que liguei).';
    const r = adaptador.retrato();
    const onde = r.estado === 'ouvindo' ? `Estou na live${titulo ? ` "${titulo}"` : ''}.`
      : r.estado === 'interrompida' ? 'Parei por um problema e não estou em live.'
        : r.estado === 'procurando' ? 'Estou procurando o chat.' : 'Não estou em nenhuma live.';
    const espera = r.guarda?.esperaDoTetoMs > 0 ? ` Atingi o teto de mensagens; volto a responder em cerca de ${Math.ceil(r.guarda.esperaDoTetoMs / 60_000)} min.` : '';
    return `${onde}${espera} Mensagens lidas: ${r.contadores.lidas}; respostas: ${r.contadores.respondidas}; assuntos puxados: ${r.contadores.espontaneas}. Cota de hoje contada por mim: ${r.cota.usado} de ${r.cota.limiteDiario} unidades.`;
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
      if (p.tipo === 'entrar') return { handled: true, text: await entrar(p.link, canal) };
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
  };
}
