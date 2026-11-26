// A EXECUÇÃO dos monitores: uma PASSADA do laço do cérebro (etapa 16, proatividade). Tudo injetável (relógio, busca, orçamento, envio).
//
// Para cada monitor ativo e devido: busca pela PORTA CENTRAL (searchWeb, com `privado: true`: nunca compartilhada nem reaproveitada) e compara o CONJUNTO dos
// endereços dos resultados (os 5 primeiros, o hash curto de cada um) com o conjunto que o monitor já viu:
//   - primeira checagem (ou a primeira depois de retomar): só guarda a referência, NUNCA avisa;
//   - nenhum endereço novo (a ordem mudou, um resultado saiu do topo e voltou): nada;
//   - algum endereço novo: UM aviso curto ao dono ("Achei novidade sobre <consulta>: <título do 1º resultado NOVO> (<fonte>)"), pelo caminho
//     da entrega dos lembretes (entrega.js: chave por monitor + hash dos endereços novos, estados e reconciliação).
// (antes o aviso vinha do hash dos 3 primeiros resultados EM ORDEM: qualquer reordenação virava um aviso falso.)
// Busca que falha ou volta vazia: nova tentativa com espera que DOBRA a cada falha seguida, até um teto; uma busca boa zera a conta.
// Monitor vencido encerra sozinho e avisa UMA vez (se há um aviso de novidade aberto, o fim espera ele ser entregue: nunca o sobrescreve).
// O texto dos resultados nunca vai para o disco: só os hashes.
//
// DISCIPLINA DE COTA (a mesma da pesquisa, uma reserva PRÓPRIA): os monitores buscam com uma identidade só deles (`MONITOR_USER_ID`, que não
// gasta a cota por pessoa de ninguém) e só enquanto sobra mais que a reserva (YUI_MONITORES_RESERVA, padrão 10% do limite por hora): a conversa
// nunca perde essa parte. Cota cheia, limite por hora, cota mensal perto do fim ou a PORTA DE SAÍDA fechada (sem o dono da cota, sem o registro
// em disco) = ADIA a passada, sem custo e sem erro: nada é gasto e o monitor continua devido para a próxima passada.
//
// Texto da web é DADO não confiável: do 1º resultado só o título (limpo, uma linha, sem menção nem link) e o domínio; nunca vira instrução.
//
// PRIVACIDADE (ajuste da revisão): a consulta vai a um buscador de terceiros a cada checagem, então, ANTES de cada busca:
//  - a pesquisa privada tem de estar liberada ao dono (privada.js; a chave é relida AGORA, a cada busca): desligada, o monitor fica ADIADO (nada é buscado, nada é
//    gasto da cota, nenhuma consulta sai; nada é encerrado nem apagado) e volta sozinho quando a chave voltar;
//  - a consulta passa de novo pela limpeza de dados pessoais (limpeza.js, falha fechada) e o que vai ao buscador é SEMPRE a versão limpa; se não provar limpeza,
//    o monitor é encerrado (motivo `barrado`) e o texto é apagado;
//  - a busca é privada (`privado: true`: sem cache, sem compartilhamento), e nenhuma IA entra em ponto nenhum (só busca e compara hash).
// Quando um monitor encerra (vence, é barrado ou cancelado), o texto do assunto é APAGADO do registro na mesma gravação; por isso o aviso do fim não cita o assunto
// (ele pode ter de ser refeito depois de um reinício, quando o texto já não existe): diz só "monitor #N". Log e auditoria nunca levam a consulta.
import { cotaDaBusca } from '../pesquisa.js';
import { searchWeb } from '../../search/providers.js';
import { getDefaultBudget } from '../../search/budget.js';
import { LIMITES, MONITOR_USER_ID, intervaloDoMonitorMs, reservaDosMonitores } from './config.js';
import { assinaturaDoConjunto, assinaturaDosResultados, consultaSegura, fonteDoResultado, resultadosComHash, tituloSeguro } from './assinatura.js';
import { ESTADOS, ESTADOS_DO_AVISO, MonitorError, TIPOS_DE_AVISO } from './store.js';
import { chaveDaNovidade, chaveDoFim, entregarAviso } from './entrega.js';
import { limparConsulta } from './limpeza.js';
import { pesquisaPrivadaLiberada } from './privada.js';

const iso = (ms) => new Date(ms).toISOString();
const MAX_TEXTOS_EM_RAM = 20;

/** A espera até a nova tentativa depois de `falhas` falhas seguidas (já contada a de agora): dobra a cada falha, até o teto (4x o intervalo do monitor, no máximo `falhaTetoMin`). */
export function esperaDaFalhaMs(falhas, intervaloMs) {
  const base = Math.min(LIMITES.falhaNovaTentativaMin * 60_000, intervaloMs);
  const teto = Math.max(base, Math.min(LIMITES.falhaTetoMin * 60_000, intervaloMs * 4));
  const n = Math.max(1, Math.min(30, Math.round(Number(falhas) || 1)));
  return Math.min(teto, base * 2 ** (n - 1));
}

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

/** O aviso do fim: SEM o assunto (o texto é apagado do registro ao encerrar, e este aviso pode ser refeito depois de um reinício). */
export function textoDoFim(monitor) {
  if (monitor?.motivoFim === 'barrado') {
    return [
      `O monitor #${monitor.id} foi encerrado: o assunto não passou na limpeza de dados pessoais e foi apagado.`,
      '-# Para vigiar de novo, peça outra vez, reformulando sem dados pessoais.',
    ].join('\n');
  }
  return [
    `O monitor #${monitor.id} chegou ao fim do prazo e foi encerrado.`,
    '-# Para vigiar de novo, é só pedir outra vez.',
  ].join('\n');
}

/**
 * @param {{ store: ReturnType<import('./store.js').criarStoreDeMonitores>, enviar: Function, ownerId: string|null, env?: object, now?: () => number,
 *           buscar?: Function|null, budget?: object|null, audit?: Function, logger?: object|null, canalPronto?: () => boolean,
 *           passadaPermitida?: () => boolean, liberada?: () => boolean, scrub?: Function }} deps
 *   `enviar(texto, { chave, reconciliar, desde })`: pede a DM ao dono (rejeita com o erro do canal ou do bot);
 *   `buscar(consulta, opcoes)`: a porta de busca (o searchWeb);
 *   `liberada()`: a pesquisa privada está liberada ao dono AGORA (padrão: a regra do cérebro, privada.js, relida a cada busca);
 *   `scrub`: a limpeza de dados pessoais (padrão: o scrubQuery da pesquisa privada); injetável só para teste;
 *   `canalPronto()`: (pode ser assíncrona) o bot está conectado e com o Discord no ar (sem ele a passada nem começa, como a dos lembretes);
 *   `passadaPermitida()`: o guarda das tarefas automáticas (motor de políticas).
 */
export function criarExecutor({
  store, enviar, ownerId, env = process.env, now = () => Date.now(), buscar = null, budget = null,
  audit = () => {}, logger = null, canalPronto = () => true, passadaPermitida = () => true, liberada = undefined, scrub = undefined, avisos = null,
} = {}) {
  const pesquisaLiberada = typeof liberada === 'function' ? liberada : () => pesquisaPrivadaLiberada(ownerId);
  const orcamento = budget ?? getDefaultBudget();
  // A porta central (searchWeb), com o MESMO orçamento que a decisão de cota desta passada consulta.
  const porta = buscar ?? ((consulta, opcoes) => searchWeb(consulta, { ...opcoes, budget: orcamento }));
  /** O texto de cada aviso de novidade, só em memória (nunca em disco). */
  const textosEmRam = new Map();
  let ocupado = false;
  const contadores = {
    passadas: 0, buscas: 0, referencias: 0, iguais: 0, novidades: 0, falhas: 0, avisosEnviados: 0, avisosReconciliados: 0, avisosIncertos: 0, encerrados: 0,
    adiadasPorta: 0, adiadasCota: 0, adiadasLimite: 0, adiadasPrivada: 0, barrados: 0, pulouOffline: 0, pulouPolitica: 0, pulouIndisponivel: 0, ignorados: 0, errosDeDisco: 0,
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
      // A pesquisa privada liberada ao dono, lida AGORA (a chave pode ter sido desligada depois da subida): sem ela nada é buscado nem gasto.
      if (pesquisaLiberada() !== true) return { ok: false, motivo: 'privada' };
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
    const r = await entregarAviso({ store, id: m.id, enviar, texto: textoDoAviso, now, audit, logger, avisos });
    if (r.resultado === 'enviado') { contadores.avisosEnviados += 1; if (r.reconciliado) contadores.avisosReconciliados += 1; }
    if (r.resultado === 'incerto') contadores.avisosIncertos += 1;
    return r;
  }

  /** Uma checagem: busca, compara a assinatura e, se mudou, abre o aviso e entrega. Devolve uma palavra fixa. */
  async function checar(monitor) {
    // A consulta é limpa DE NOVO antes de sair (falha fechada) e o que vai ao buscador é a versão limpa, nunca a gravada tal e qual. Sem prova de limpeza o
    // monitor não busca: é encerrado e o texto apagado.
    const limpa = limparConsulta(monitor.consulta, scrub ? { scrub } : {});
    if (!limpa.ok) { await encerrarBarrado(monitor, limpa.motivo); return 'barrada'; }
    // O que fica gravado é a MESMA versão limpa que vai ao buscador (um registro antigo ou mexido à mão é corrigido aqui).
    if (limpa.consulta !== monitor.consulta) { try { store.atualizar(monitor.id, { consulta: limpa.consulta }); } catch { /* segue com a versão limpa em memória; grava na próxima mudança */ } }
    const resposta = await porta(limpa.consulta, { userId: MONITOR_USER_ID, privado: true, max: LIMITES.resultadosPedidos });
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
    const atuais = resultadosComHash(resultados, LIMITES.resultadosPedidos);
    const assinatura = assinaturaDosResultados(resultados);
    const intervalo = intervaloDoMonitorMs(m, env);
    const proxima = iso(t + intervalo);
    if (!atuais.length || !assinatura) {
      // Sem resultado utilizável (erro do buscador, nada achado): não muda a referência; tenta de novo com espera crescente (dobra a cada falha, até o teto).
      contadores.falhas += 1;
      const falhas = (m.falhas ?? 0) + 1;
      store.atualizar(m.id, { falhas, ultimaTentativa: iso(t), proximaChecagem: iso(t + esperaDaFalhaMs(falhas, intervalo)) });
      return 'falha';
    }
    const hashes = atuais.map((x) => x.hash);
    const vistas = Array.isArray(m.vistas) ? m.vistas : [];
    if (!m.ultimaAssinatura || !vistas.length) {
      // A referência (também a de um monitor de antes, que só tinha o hash em ordem): o conjunto de agora é o "já visto"; nunca avisa.
      store.atualizar(m.id, { ultimaAssinatura: assinatura, vistas: hashes, ultimaChecagem: iso(t), proximaChecagem: proxima, falhas: 0 });
      contadores.referencias += 1;
      return 'referencia';
    }
    const jaVistas = new Set(vistas);
    const novos = atuais.filter((x) => !jaVistas.has(x.hash));
    // O conjunto cresce (só os hashes; os mais antigos saem acima do limite): um endereço que sai do topo e volta depois NÃO é novidade.
    const vistasNovas = [...vistas, ...novos.map((x) => x.hash)].slice(-LIMITES.vistasMax);
    if (!novos.length) {
      store.atualizar(m.id, { ultimaAssinatura: assinatura, ultimaChecagem: iso(t), proximaChecagem: proxima, falhas: 0 });
      contadores.iguais += 1;
      return 'igual';
    }
    // Apareceu endereço NOVO: o conjunto novo e o aviso pendente vão para o disco JUNTOS e ANTES de qualquer envio. Uma queda daqui em diante não perde
    // o aviso (o "enviando" é reconciliado) e não o repete (os endereços já estão no conjunto: a mesma novidade não é detectada de novo).
    const assinaturaDoAviso = assinaturaDoConjunto(novos.map((x) => x.hash));
    const chave = chaveDaNovidade(m.id, assinaturaDoAviso);
    guardarTexto(chave, textoDaNovidade({ ...m, consulta: limpa.consulta }, novos[0].resultado));
    store.atualizar(m.id, {
      ultimaAssinatura: assinatura, vistas: vistasNovas, ultimaChecagem: iso(t), proximaChecagem: proxima, falhas: 0,
      aviso: { tipo: TIPOS_DE_AVISO.NOVIDADE, estado: ESTADOS_DO_AVISO.PENDENTE, chave, assinatura: assinaturaDoAviso, tentativas: 0 },
    });
    contadores.novidades += 1;
    await entregar(m);
    return 'novidade';
  }

  /** O prazo acabou: encerra, APAGA o assunto do registro (na mesma gravação) e abre o aviso do fim (uma vez só: a chave é fixa). */
  async function encerrarPorPrazo(visto) {
    // O estado de AGORA (a lista do laço é de antes: a pessoa pode ter cancelado, ou um aviso pode ter aberto, durante as esperas das entregas): só encerra o que
    // continua aberto, vencido e SEM aviso em andamento (um aviso de novidade aberto nunca é sobrescrito pelo do fim: o fim espera a entrega dele).
    const m = store.obter(visto.id);
    if (!m || m.estado === ESTADOS.ENCERRADO || m.aviso || Date.parse(m.ate) > now()) return false;
    store.atualizar(m.id, {
      estado: ESTADOS.ENCERRADO, motivoFim: 'vencido', encerradoEm: iso(now()), consulta: undefined,
      aviso: { tipo: TIPOS_DE_AVISO.FIM, estado: ESTADOS_DO_AVISO.PENDENTE, chave: chaveDoFim(m.id), tentativas: 0 },
    });
    contadores.encerrados += 1;
    registrar('monitor.vencido', { id: m.id });
    await entregar(m);
    return true;
  }

  /** A consulta não provou limpeza (dado pessoal, segredo, palavra proibida ou limpeza que falhou): nada é buscado, o monitor encerra e o assunto é apagado. */
  async function encerrarBarrado(m, motivo) {
    store.atualizar(m.id, {
      estado: ESTADOS.ENCERRADO, motivoFim: 'barrado', encerradoEm: iso(now()), consulta: undefined,
      aviso: { tipo: TIPOS_DE_AVISO.FIM, estado: ESTADOS_DO_AVISO.PENDENTE, chave: chaveDoFim(m.id), tentativas: 0 },
    });
    contadores.barrados += 1;
    registrar('monitor.consulta_barrada', { id: m.id, motivo });
    logger?.warn?.(`[Monitores] o assunto do monitor #${m.id} não provou limpeza (${motivo}): nada foi buscado; o monitor foi encerrado e o assunto apagado.`);
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
      for (const visto of store.todos()) {
        const m = store.obter(visto.id); // o estado de agora: a entrega anterior (esperas do canal) pode ter mudado este monitor
        if (!m?.aviso) continue;
        if (m.dono !== ownerId) { if (!avisadosForaDoDono.has(m.id)) { avisadosForaDoDono.add(m.id); contadores.ignorados += 1; logger?.warn?.(`[Monitores] o monitor #${m.id} não é do dono atual: ignorado (nada é enviado).`); } continue; }
        const r = await entregar(m);
        if (r.resultado === 'enviado') saida.entregas += 1;
      }
      // 2. O prazo: o que venceu encerra sozinho e avisa uma vez.
      for (const visto of store.todos()) {
        if (visto.estado === ESTADOS.ENCERRADO || visto.dono !== ownerId || visto.aviso || Date.parse(visto.ate) > now()) continue;
        try { if (await encerrarPorPrazo(visto)) saida.encerrados += 1; } catch (err) { contadores.errosDeDisco += 1; logger?.warn?.(`[Monitores] não consegui encerrar o monitor #${m.id} (${String(err?.code ?? err?.message ?? 'erro').slice(0, 60)}); tento de novo na próxima passada.`); }
      }
      // 3. As checagens devidas. A cota é de todos: quando uma busca é adiada, as outras também seriam, então a passada para.
      let feitas = 0;
      for (const id of store.todos().map((x) => x.id)) {
        const m = store.obter(id); // o estado de agora (a pessoa pode ter cancelado ou pausado durante a passada)
        if (!m || m.estado !== ESTADOS.ATIVO || m.aviso || m.dono !== ownerId) continue;
        if (Date.parse(m.proximaChecagem) > now()) continue;
        if (feitas >= LIMITES.porPassada) break;
        const pode = podeBuscar();
        if (!pode.ok) { if (pode.motivo === 'cota') contadores.adiadasCota += 1; else if (pode.motivo === 'privada') contadores.adiadasPrivada += 1; else contadores.adiadasPorta += 1; saida.adiadas += 1; break; }
        feitas += 1;
        try {
          const r = await checar(m);
          if (r === 'adiada') { saida.adiadas += 1; break; }
          if (r === 'descartada' || r === 'barrada') continue;
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
      // O arquivo de estado não pôde ser lido agora: o store já avisou UMA vez no log e não grava nada; a passada só espera a próxima.
      if (err instanceof MonitorError && err.codigo === 'indisponivel') { contadores.pulouIndisponivel += 1; return { ...saida, pulou: 'estado indisponível' }; }
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
