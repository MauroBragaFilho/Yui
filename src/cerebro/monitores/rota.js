// A PRÉ-ROTA dos monitores na conversa (etapa 16, proatividade): o dono pede em português, o CÓDIGO decide e responde, sem IA.
//
//   "me avisa quando sair o patch 1.5 do jogo X por 7 dias"   cria o monitor e CONFIRMA de volta em uma frase curta
//   "meus monitores" / "lista meus monitores"                  lista (id, consulta, estado, próxima checagem)
//   "cancela o monitor 2" / "pausa o monitor 3" / "retoma o monitor 3"
//
// Regras de segurança (todas por código, nunca pelo modelo):
//  - SÓ O DONO (o papel vem do contexto que o cérebro remontou, nunca do que o bot afirmou). Qualquer outra pessoa: a frase segue para a
//    conversa de sempre (nada é criado, nada é dito sobre monitores);
//  - SÓ MENSAGEM DIRIGIDA À YUI (DM, menção, nome dela ou resposta a ela; nunca conversa espontânea, voz ou prompt em nome de terceiro);
//  - o que muda estado passa pelo motor de políticas (a mesma ação dos lembretes do painel): em `observe` só registra; em `enforce`
//    DENY e CRITICAL recusam (o dono num canal público é "membro" na matriz: fica só a conversa privada);
//  - a consulta é o texto da própria pessoa, limpo (sem menção, sem link, curto); nunca texto da web;
//  - PESQUISA PRIVADA: criar um monitor exige a pesquisa privada liberada ao dono (privada.js: a mesma regra do cérebro); sem ela, a frase fixa recusa;
//  - LIMPEZA ANTES DE GRAVAR: o assunto passa pela limpeza de dados pessoais (limpeza.js, falha fechada) dentro do `store.criar`: sem prova de limpeza o monitor NÃO é
//    criado e a Yui responde uma frase fixa (nunca repete o texto). A confirmação diz onde o assunto fica guardado e que é enviado ao serviço de busca.
// O que sai daqui NÃO entra no contexto por horas (quem chama marca o turno como "pesquisado", como os lembretes).
import { ROLES, POLICY_STATES } from '../../core/permissions.js';
import { getPolicyEngine, originFor } from '../../core/security/policyEngine.js';
import { describeWhen } from '../../reminders/when.js';
import { LIMITES } from './config.js';
import { consultaSegura } from './assinatura.js';
import { interpretarPedido } from './pedido.js';
import { ESTADOS, MonitorError } from './store.js';
import { TEXTO_CONSULTA_BARRADA } from './limpeza.js';
import { pesquisaPrivadaLiberada, TEXTO_PESQUISA_PRIVADA_DESLIGADA } from './privada.js';

const DIA_MS = 24 * 60 * 60_000;
const HORA_MS = 60 * 60_000;

export const TEXTO_PEDIR_CONSULTA = 'Sobre o que devo ficar de olho? Por exemplo: “me avisa quando sair o patch 1.5 do jogo X”.';
export const TEXTO_SEM_PERMISSAO = 'Não posso mexer nos monitores por aqui agora (política de segurança). Peça em conversa privada comigo.';
/** A linha FIXA da confirmação: onde o assunto fica guardado, por quanto tempo e para onde vai. */
export const TEXTO_ONDE_FICA_O_ASSUNTO = '-# Use só assuntos públicos (sem endereços, nomes de terceiros, dados pessoais ou assuntos confidenciais): o assunto fica em texto puro no disco da máquina onde a Yui está executando enquanto o monitor estiver ativo ou pausado (some quando ele acabar ou for cancelado) e é enviado de tempos em tempos ao serviço de busca.';
/** Acrescentada à lista quando a pesquisa privada está desligada: os monitores existem, mas estão suspensos. */
export const TEXTO_MONITORES_SUSPENSOS = '-# A pesquisa privada não está liberada: os monitores estão suspensos (nada é buscado) até ela voltar.';

/** A mensagem é dirigida à Yui (DM, menção, nome ou resposta a ela) e é uma fala do próprio autor? */
export function dirigidaAYui(call, ctx) {
  if (!call || call.entry !== 'fila' || call.type !== 'mention') return false;
  if (call.chatter || call.voice || call.voiceInteraction || call.voiceItem || call.thirdParty) return false;
  return !ctx?.guildId || Boolean(call.mentionsBot || call.hasBotName || call.repliesToBot);
}

function descreverPrazo(ms) {
  if (ms >= DIA_MS) { const d = Math.round(ms / DIA_MS); return `${d} dia${d === 1 ? '' : 's'}`; }
  const h = Math.max(1, Math.round(ms / HORA_MS));
  return `${h} hora${h === 1 ? '' : 's'}`;
}
function descreverIntervalo(min) {
  if (min % 1440 === 0) { const d = min / 1440; return d === 1 ? 'dia' : `${d} dias`; }
  const h = Math.round(min / 60);
  return h === 1 ? 'hora' : `${h} horas`;
}

function tagDoAviso(m) {
  const e = m.aviso?.estado;
  if (e === 'incerto') return ' ⚠️ **aviso com entrega incerta** (não sei se chegou; tento confirmar sozinha)';
  if (e === 'enviando' || e === 'pendente') return ' ⏳ confirmando a entrega de um aviso';
  return '';
}

/** A lista em palavras fixas: id, consulta, estado e a próxima checagem. */
export function formatarLista(monitores, now = new Date()) {
  const abertos = monitores.filter((m) => m.estado !== ESTADOS.ENCERRADO);
  const encerrados = monitores.length - abertos.length;
  if (!abertos.length) return `Você não tem monitores. Para criar: “me avisa quando sair o patch 1.5 do jogo X”.${encerrados ? `\n-# ${encerrados} encerrado${encerrados === 1 ? '' : 's'} recentemente.` : ''}`;
  const linhas = abertos.map((m) => {
    const proxima = m.estado === ESTADOS.ATIVO ? ` · próxima checagem ${describeWhen(m.proximaChecagem, now)}` : '';
    return `**#${m.id}** · “${consultaSegura(m.consulta, 60)}” · ${m.estado}${proxima} · vale até ${describeWhen(m.ate, now)}${tagDoAviso(m)}`;
  });
  return [`**Seus monitores** (${abertos.length})`, ...linhas, ...(encerrados ? [`-# ${encerrados} encerrado${encerrados === 1 ? '' : 's'} recentemente.`] : [])].join('\n');
}

/**
 * O roteador dos monitores. Tudo injetável para teste.
 * @param {{ store: ReturnType<import('./store.js').criarStoreDeMonitores>, now?: () => number, audit?: Function, engine?: () => object,
 *           liberada?: (userId: string) => boolean }} deps
 *   `liberada(userId)`: a pesquisa privada está liberada a esta pessoa AGORA (padrão: a regra do cérebro, relida a cada pedido)
 * @returns {{ rotear: (p: {ctx: object, call: object, texto: string|null}) => {handled: boolean, text?: string} }}
 */
export function criarRoteador({ store, now = () => Date.now(), audit = () => {}, engine = () => getPolicyEngine(), liberada = pesquisaPrivadaLiberada } = {}) {
  const NAO = Object.freeze({ handled: false });
  const registrar = (evento, ctx, dados) => { try { audit(evento, ctx, dados); } catch { /* a auditoria nunca derruba a resposta */ } };

  /** O motor de políticas (a ação dos lembretes do painel). Falha da política = bloqueio. */
  function autorizado(ctx) {
    try {
      const { decision, enforced } = engine().gate({ action: 'admin.reminders_edit', ctx, origin: originFor({ platform: ctx.platform, channelKind: ctx.channelKind }), legacy: 'allow', target: 'monitores' });
      if (!enforced) return true;
      return decision !== POLICY_STATES.DENY && decision !== POLICY_STATES.CRITICAL;
    } catch {
      return false;
    }
  }

  /** A pesquisa privada está liberada ao dono agora? Lida neste instante; erro ou dúvida = não (falha fechada). */
  function liberadaAgora(ctx) {
    try { return liberada(ctx.userId) === true; } catch { return false; }
  }

  function aplicar(pedido, ctx) {
    const agora = new Date(now());
    if (pedido.acao === 'listar') {
      const lista = formatarLista(store.todos().filter((m) => m.dono === ctx.userId), agora);
      return liberadaAgora(ctx) ? lista : `${lista}\n${TEXTO_MONITORES_SUSPENSOS}`;
    }
    if (pedido.acao === 'criar-vazio') return TEXTO_PEDIR_CONSULTA;
    if (!autorizado(ctx)) return TEXTO_SEM_PERMISSAO;
    try {
      if (pedido.acao === 'criar') {
        // A pesquisa privada liberada ao dono é condição para criar (e é relida a cada busca: executor.js). Independe da limpeza de dados pessoais, que vem logo a seguir.
        if (!liberadaAgora(ctx)) return TEXTO_PESQUISA_PRIVADA_DESLIGADA;
        // A limpeza roda DENTRO do store.criar, sobre o texto como a pessoa escreveu: o que fica gravado é só a versão limpa.
        const m = store.criar({ dono: ctx.userId, consulta: pedido.consultaBruta ?? pedido.consulta, prazoMs: pedido.prazoMs });
        registrar('monitor.criado', ctx, { id: m.id });
        const prazo = descreverPrazo(Date.parse(m.ate) - Date.parse(m.criadoEm));
        return `Anotado: monitor #${m.id} de “${consultaSegura(m.consulta, 80)}” por ${prazo} (olho a cada ${descreverIntervalo(m.intervaloMin)} e aviso por mensagem privada se aparecer novidade).${pedido.prazoLimitado ? ` Limitei o prazo a ${LIMITES.prazoMaximoDias} dias.` : ''}\n${TEXTO_ONDE_FICA_O_ASSUNTO}`;
      }
      const meu = store.obter(pedido.id);
      if (!meu || meu.dono !== ctx.userId) return `Não achei o monitor #${pedido.id}. Diga “meus monitores” para ver os números.`;
      if (pedido.acao === 'cancelar') {
        const r = store.cancelar(pedido.id);
        if (!r.ok) return `O monitor #${pedido.id} já está encerrado.`;
        registrar('monitor.cancelado', ctx, { id: pedido.id });
        // o assunto já foi APAGADO do registro: a resposta usa a cópia em memória de antes (`meu`), só nesta mensagem
        return `Cancelei o monitor #${pedido.id} (“${consultaSegura(meu.consulta, 80)}”). O assunto foi apagado do arquivo.`;
      }
      if (pedido.acao === 'pausar') {
        const r = store.pausar(pedido.id);
        if (!r.ok) return r.motivo === ESTADOS.PAUSADO ? `O monitor #${pedido.id} já está pausado.` : `O monitor #${pedido.id} já está encerrado.`;
        registrar('monitor.pausado', ctx, { id: pedido.id });
        return `Pausei o monitor #${pedido.id}. Para voltar: “retoma o monitor ${pedido.id}”.`;
      }
      if (pedido.acao === 'retomar') {
        const r = store.retomar(pedido.id);
        if (!r.ok) {
          if (r.motivo === 'limite') return `Você já tem ${LIMITES.maxAtivos} monitores ativos. Cancele ou pause um para retomar o #${pedido.id}.`;
          return r.motivo === ESTADOS.ATIVO ? `O monitor #${pedido.id} já está ativo.` : `O monitor #${pedido.id} já está encerrado.`;
        }
        registrar('monitor.retomado', ctx, { id: pedido.id });
        return `Retomei o monitor #${pedido.id}. A próxima checagem refaz a referência (não aviso por causa do que mudou enquanto ele estava pausado).`;
      }
    } catch (err) {
      if (err instanceof MonitorError) {
        if (err.codigo === 'limite') return `Você já tem ${LIMITES.maxAtivos} monitores ativos. Cancele um (“cancela o monitor N”) para criar outro.`;
        if (err.codigo === 'repetido') return `Já existe o monitor #${err.id} para essa consulta. Diga “meus monitores” para ver.`;
        if (err.codigo === 'consulta') return TEXTO_PEDIR_CONSULTA;
        if (err.codigo === 'dados') { registrar('monitor.consulta_barrada', ctx, { motivo: err.motivo }); return TEXTO_CONSULTA_BARRADA; }
        return 'Não consegui mexer nesse monitor agora.';
      }
      // o disco não gravou: nada foi criado, e a pessoa fica sabendo (sem detalhe técnico)
      return 'Não consegui gravar essa mudança agora. Tente de novo daqui a pouco.';
    }
    return null;
  }

  return {
    /** Se a mensagem é um pedido de monitor do dono, executa e devolve { handled: true, text }. Senão { handled: false }. Nunca lança. */
    rotear({ ctx, call, texto } = {}) {
      try {
        if (!ctx || ctx.role !== ROLES.OWNER) return NAO; // só o dono: para os outros a conversa segue como sempre
        if (!dirigidaAYui(call, ctx)) return NAO;
        const pedido = interpretarPedido(texto);
        if (!pedido) return NAO;
        const resposta = aplicar(pedido, ctx);
        return resposta ? { handled: true, text: resposta } : NAO;
      } catch {
        return NAO;
      }
    },
  };
}
