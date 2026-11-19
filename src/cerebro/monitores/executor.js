// A EXECUÇÃO dos monitores: uma PASSADA do laço do cérebro (etapa 16, proatividade). Tudo injetável (relógio, busca, orçamento, envio).
//
// Para cada monitor ativo e devido: busca pela PORTA CENTRAL (searchWeb, com `privado: true`: nunca compartilhada nem reaproveitada),
// calcula a ASSINATURA dos 3 primeiros resultados e compara com a última:
//   - primeira checagem (ou a primeira depois de retomar): só guarda a referência, NUNCA avisa;
//   - assinatura igual: nada;
//   - assinatura diferente: UM aviso curto ao dono ("Achei novidade sobre <consulta>: <título do 1º resultado> (<fonte>)"), pelo caminho
//     da entrega dos lembretes (entrega.js: chave por monitor + assinatura, estados e reconciliação).
// Monitor vencido encerra sozinho e avisa UMA vez. O texto dos resultados nunca vai para o disco: só o hash.
//
// DISCIPLINA DE COTA (a mesma da pesquisa, uma reserva PRÓPRIA): os monitores buscam com uma identidade só deles (`MONITOR_USER_ID`, que não
// gasta a cota por pessoa de ninguém) e só enquanto sobra mais que a reserva (YUI_MONITORES_RESERVA, padrão 10% do limite por hora): a conversa
// nunca perde essa parte. Cota cheia, limite por hora, cota mensal perto do fim ou a PORTA DE SAÍDA fechada (sem o dono da cota, sem o registro
// em disco) = ADIA a passada, sem custo e sem erro: nada é gasto e o monitor continua devido para a próxima passada.
//
// Texto da web é DADO não confiável: do 1º resultado só o título (limpo, uma linha, sem menção nem link) e o domínio; nunca vira instrução.
import { cotaDaBusca } from '../pesquisa.js';
import { searchWeb } from '../../search/providers.js';
import { getDefaultBudget } from '../../search/budget.js';
import { LIMITES, MONITOR_USER_ID, intervaloDoMonitorMs, reservaDosMonitores } from './config.js';
import { assinaturaDosResultados, consultaSegura, fonteDoResultado, tituloSeguro } from './assinatura.js';
import { ESTADOS, ESTADOS_DO_AVISO, TIPOS_DE_AVISO } from './store.js';
import { chaveDaNovidade, chaveDoFim, entregarAviso } from './entrega.js';

const iso = (ms) => new Date(ms).toISOString();
const MAX_TEXTOS_EM_RAM = 20;

/** O texto do aviso de novidade: a consulta da pessoa, o título do 1º resultado (limpo) e o domínio. */
export function textoDaNovidade(monitor, resultado) {
  return [
    `Achei novidade sobre ${consultaSegura(monitor.consulta)}: ${tituloSeguro(resultado?.title)} (${fonteDoResultado(resultado)})`,
    `-# Monitor #${monitor.id}. Para parar: “cancela o monitor ${monitor.id}”.`,
  ].join('\n');
}

/** O aviso de novidade DEPOIS de um reinício (o título do resultado nunca foi guardado): só diz que houve novidade. */
export function textoGenericoDaNovidade(monitor) {
  return [
    `Achei novidade sobre ${consultaSegura(monitor.consulta)}. (Reiniciei antes de avisar e não guardo o texto dos resultados: peça “pesquisa ${consultaSegura(monitor.consulta, 60)}” para ver.)`,
    `-# Monitor #${monitor.id}. Para parar: “cancela o monitor ${monitor.id}”.`,
  ].join('\n');
}

export function textoDoFim(monitor) {
  return [
    `O monitor #${monitor.id} (${consultaSegura(monitor.consulta, 80)}) chegou ao fim do prazo e foi encerrado.`,
    '-# Para vigiar de novo, é só pedir outra vez.',
  ].join('\n');
}

/**
 * @param {{ store: ReturnType<import('./store.js').criarStoreDeMonitores>, enviar: Function, ownerId: string|null, env?: object, now?: () => number,
 *           buscar?: Function|null, budget?: object|null, audit?: Function, logger?: object|null, canalPronto?: () => boolean,
 *           passadaPermitida?: () => boolean }} deps
 *   `enviar(texto, { chave, reconciliar, desde })`: pede a DM ao dono (rejeita com o erro do canal ou do bot);
 *   `buscar(consulta, opcoes)`: a porta de busca (o searchWeb);
 *   `canalPronto()`: (pode ser assíncrona) o bot está conectado e com o Discord no ar (sem ele a passada nem começa, como a dos lembretes);
 *   `passadaPermitida()`: o guarda das tarefas automáticas (motor de políticas).
 */
export function criarExecutor({
  store, enviar, ownerId, env = process.env, now = () => Date.now(), buscar = null, budget = null,
  audit = () => {}, logger = null, canalPronto = () => true, passadaPermitida = () => true,
} = {}) {
  const orcamento = budget ?? getDefaultBudget();
  // A porta central (searchWeb), com o MESMO orçamento que a decisão de cota desta passada consulta.
  const porta = buscar ?? ((consulta, opcoes) => searchWeb(consulta, { ...opcoes, budget: orcamento }));
  /** O texto de cada aviso de novidade, só em memória (nunca em disco). */
  const textosEmRam = new Map();
  let ocupado = false;
  const contadores = {
    passadas: 0, buscas: 0, referencias: 0, iguais: 0, novidades: 0, falhas: 0, avisosEnviados: 0, avisosReconciliados: 0, avisosIncertos: 0, encerrados: 0,
    adiadasPorta: 0, adiadasCota: 0, adiadasLimite: 0, pulouOffline: 0, pulouPolitica: 0, ignorados: 0, errosDeDisco: 0,
  };
  const avisadosForaDoDono = new Set();

  const registrar = (evento, dados) => { try { audit(evento, null, dados); } catch { /* a auditoria nunca derruba a passada */ } };
  const textoDoAviso = (m) => {
    if (m.aviso?.tipo === TIPOS_DE_AVISO.FIM) return textoDoFim(m);
    return textosEmRam.get(m.aviso?.chave) ?? textoGenericoDaNovidade(m);
  };
  const guardarTexto = (chave, texto) => {
    textosEmRam.delete(chave);
    textosEmRam.set(chave, texto);
    while (textosEmRam.size > MAX_TEXTOS_EM_RAM) textosEmRam.delete(textosEmRam.keys().next().value);
  };

  /** Pode gastar UMA busca agora? (a reserva própria, a porta de saída, os limites da cota). Nunca gasta nada para perguntar. */
  function podeBuscar() {
    try {
      const saida = orcamento.despacho?.();
      if (saida && saida.permitido === false) return { ok: false, motivo: 'porta' };
      // A mesma conta da decisão do /yui (cotaDaBusca), com a reserva DOS MONITORES: abaixo dela, só a conversa busca.
      const cota = cotaDaBusca(MONITOR_USER_ID, { budget: orcamento, env: { ...env, YUI_CEREBRO_BUSCA_RESERVA: String(reservaDosMonitores(env)) } });
      if (cota.perto) return { ok: false, motivo: 'cota', detalhe: cota.motivo };
      return { ok: true };
    } catch {
      return { ok: false, motivo: 'porta' }; // sem como ler a cota: falha fechada (não gasta)
    }
  }

  async function entregar(m) {
    const r = await entregarAviso({ store, id: m.id, enviar, texto: textoDoAviso, now, audit, logger });
    if (r.resultado === 'enviado') { contadores.avisosEnviados += 1; if (r.reconciliado) contadores.avisosReconciliados += 1; }
    if (r.resultado === 'incerto') contadores.avisosIncertos += 1;
    return r;
  }

  /** Uma checagem: busca, compara a assinatura e, se mudou, abre o aviso e entrega. Devolve uma palavra fixa. */
  async function checar(monitor) {
    const resposta = await porta(monitor.consulta, { userId: MONITOR_USER_ID, privado: true, max: LIMITES.resultadosPedidos });
    const t = now();
    // A busca NÃO saiu (sem o dono da cota, sem o registro em disco, limite estourado): adia sem custo e sem erro; o monitor segue devido.
    if (resposta?.indisponivel === true) { contadores.adiadasPorta += 1; return 'adiada'; }
    if (resposta?.limited) { contadores.adiadasLimite += 1; return 'adiada'; }
    contadores.buscas += 1;
    // O monitor pode ter sido cancelado, pausado ou refeito (retomado) enquanto a busca corria: vale o estado de agora, e um monitor que
    // não está mais ativo não ganha referência nem aviso.
    const m = store.obter(monitor.id);
    if (!m || m.estado !== ESTADOS.ATIVO) return 'descartada';
    const resultados = Array.isArray(resposta?.results) ? resposta.results : [];
    const assinatura = assinaturaDosResultados(resultados);
    const proxima = iso(t + intervaloDoMonitorMs(m, env));
    if (!assinatura) {
      // Sem resultado utilizável (erro do buscador, nada achado): não muda a referência; tenta de novo mais cedo que o intervalo.
      contadores.falhas += 1;
      store.atualizar(m.id, { falhas: (m.falhas ?? 0) + 1, ultimaTentativa: iso(t), proximaChecagem: iso(t + Math.min(LIMITES.falhaNovaTentativaMin * 60_000, intervaloDoMonitorMs(m, env))) });
      return 'falha';
    }
    if (!m.ultimaAssinatura) {
      store.atualizar(m.id, { ultimaAssinatura: assinatura, ultimaChecagem: iso(t), proximaChecagem: proxima, falhas: 0 });
      contadores.referencias += 1;
      return 'referencia';
    }
    if (assinatura === m.ultimaAssinatura) {
      store.atualizar(m.id, { ultimaChecagem: iso(t), proximaChecagem: proxima, falhas: 0 });
      contadores.iguais += 1;
      return 'igual';
    }
    // Mudou: a nova assinatura e o aviso pendente vão para o disco JUNTOS e ANTES de qualquer envio. Uma queda daqui em diante não perde
    // o aviso (o "enviando" é reconciliado) e não o repete (a assinatura já é a nova: a mesma mudança não é detectada de novo).
    const chave = chaveDaNovidade(m.id, assinatura);
    guardarTexto(chave, textoDaNovidade(m, resultados[0]));
    store.atualizar(m.id, {
      ultimaAssinatura: assinatura, ultimaChecagem: iso(t), proximaChecagem: proxima, falhas: 0,
      aviso: { tipo: TIPOS_DE_AVISO.NOVIDADE, estado: ESTADOS_DO_AVISO.PENDENTE, chave, assinatura, tentativas: 0 },
    });
    contadores.novidades += 1;
    await entregar(m);
    return 'novidade';
  }

  /** O prazo acabou: encerra e abre o aviso do fim (uma vez só: a chave é fixa). */
  async function encerrarPorPrazo(m) {
    store.atualizar(m.id, {
      estado: ESTADOS.ENCERRADO, motivoFim: 'vencido', encerradoEm: iso(now()),
      aviso: { tipo: TIPOS_DE_AVISO.FIM, estado: ESTADOS_DO_AVISO.PENDENTE, chave: chaveDoFim(m.id), tentativas: 0 },
    });
    contadores.encerrados += 1;
    registrar('monitor.vencido', { id: m.id });
    await entregar(m);
  }

  /** Uma passada. Nunca lança. */
  async function passada(motivo = 'agenda') {
    if (ocupado) return { pulou: 'ocupado' };
    if (!passadaPermitida()) { contadores.pulouPolitica += 1; return { pulou: 'política' }; }
    if (!ownerId) return { pulou: 'sem dono' };
    ocupado = true;
    let pronto = false;
    try { pronto = (await canalPronto()) === true; } catch { pronto = false; }
    if (!pronto) { ocupado = false; contadores.pulouOffline += 1; return { pulou: 'bot desconectado' }; }
    const saida = { motivo, buscas: 0, referencias: 0, iguais: 0, novidades: 0, falhas: 0, adiadas: 0, encerrados: 0, entregas: 0 };
    try {
      contadores.passadas += 1;
      // 1. Os avisos que ficaram a meio caminho (um reinício, um erro do canal) e os que acabaram de abrir.
      for (const m of store.todos()) {
        if (!m.aviso) continue;
        if (m.dono !== ownerId) { if (!avisadosForaDoDono.has(m.id)) { avisadosForaDoDono.add(m.id); contadores.ignorados += 1; logger?.warn?.(`[Monitores] o monitor #${m.id} não é do dono atual: ignorado (nada é enviado).`); } continue; }
        const r = await entregar(m);
        if (r.resultado === 'enviado') saida.entregas += 1;
      }
      // 2. O prazo: o que venceu encerra sozinho e avisa uma vez.
      for (const m of store.todos()) {
        if (m.estado === ESTADOS.ENCERRADO || m.dono !== ownerId || Date.parse(m.ate) > now()) continue;
        try { await encerrarPorPrazo(m); saida.encerrados += 1; } catch (err) { contadores.errosDeDisco += 1; logger?.warn?.(`[Monitores] não consegui encerrar o monitor #${m.id} (${String(err?.code ?? err?.message ?? 'erro').slice(0, 60)}); tento de novo na próxima passada.`); }
      }
      // 3. As checagens devidas. A cota é de todos: quando uma busca é adiada, as outras também seriam, então a passada para.
      let feitas = 0;
      for (const id of store.todos().map((x) => x.id)) {
        const m = store.obter(id); // o estado de agora (a pessoa pode ter cancelado ou pausado durante a passada)
        if (!m || m.estado !== ESTADOS.ATIVO || m.aviso || m.dono !== ownerId) continue;
        if (Date.parse(m.proximaChecagem) > now()) continue;
        if (feitas >= LIMITES.porPassada) break;
        const pode = podeBuscar();
        if (!pode.ok) { if (pode.motivo === 'cota') contadores.adiadasCota += 1; else contadores.adiadasPorta += 1; saida.adiadas += 1; break; }
        feitas += 1;
        try {
          const r = await checar(m);
          if (r === 'adiada') { saida.adiadas += 1; break; }
          if (r === 'descartada') continue;
          saida.buscas += 1;
          if (r === 'referencia') saida.referencias += 1;
          else if (r === 'igual') saida.iguais += 1;
          else if (r === 'novidade') saida.novidades += 1;
          else if (r === 'falha') saida.falhas += 1;
        } catch (err) {
          contadores.errosDeDisco += 1;
          logger?.warn?.(`[Monitores] a checagem do monitor #${m.id} falhou (${String(err?.code ?? err?.message ?? 'erro').slice(0, 60)}); tento de novo na próxima passada.`);
        }
      }
      return saida;
    } catch (err) {
      logger?.warn?.(`[Monitores] falha na passada: ${String(err?.message ?? err).slice(0, 120)}`);
      return { ...saida, erro: true };
    } finally {
      ocupado = false;
    }
  }

  return {
    passada,
    status: () => ({ ...contadores, textosEmMemoria: textosEmRam.size }),
    /** Só teste: o texto que ficou em memória para um aviso (nunca vai para o disco). */
    _textoEmMemoria: (chave) => textosEmRam.get(chave) ?? null,
  };
}
