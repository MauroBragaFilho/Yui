// PLANOS COM APROVAÇÃO (Fase 3, parte 3B v1, YUI_PLANOS): propor, validar, pedir aprovação por DM, executar um passo por vez e avisar no fim.
// Roda no cérebro (ou no processo único). Tudo aqui falha FECHADO: na dúvida não executa.
//  - A IA só PROPÕE os passos (chamada privada, sem memória nem histórico); o código valida e escreve o texto do plano pelos argumentos reais.
//  - O plano não muda depois de criado (hash conferido na aprovação e antes de cada passo). Resultado de ferramenta nunca vira passo.
//  - "executando" é gravado ANTES da leitura; queda ou tempo estourado = "incerto", nunca repetido sozinho.
//  - Resultados ficam só em memória; o texto final é montado por código. Log e auditoria sem conteúdo.
import crypto from 'node:crypto';
import { audit } from '../audit.js';
import { logger as loggerPadrao } from '../../utils/logger.js';
import { buildContext, isOwnerId, POLICY_STATES, TOOL_ACCESS } from '../permissions.js';
import { getPolicyEngine } from '../security/policyEngine.js';
import { canonicalAction, ORIGINS } from '../security/permissionMatrix.js';
import { hashParams } from '../security/approvalManager.js';
import { redact } from '../api/panelLogs.js';
import { isolatedChat } from '../ai/manager.js';
import { splitForDiscord } from '../alerts.js';
import { planosLigados, planosAuto, pedidoDePlano, MARCA_RESULTADO } from './pedido.js';
import { criarStoreDePlanos, geracaoDeApagamento } from './store.js';
import { criarFerramentasDePlano, argumentosValidos, MAX_SAIDA_POR_PASSO } from './ferramentas.js';

export const MAX_PASSOS = 5;
export const VALIDADE_MS = 30 * 60_000;
export const PRAZO_DO_PASSO_MS = 75_000;
const ATIVOS = new Set(['a_entregar', 'aguardando', 'aprovado', 'executando']);

export const FRASES = Object.freeze({
  jaTem: 'Já tem um plano em andamento. Aprove, recuse ou diga "cancela o plano" antes de pedir outro.',
  naoMontei: 'Não consegui montar um plano seguro com esse pedido. Os planos só fazem leituras (biblioteca, agenda, tarefas, pesquisa, lembretes, listas e estado do computador), com no máximo 5 passos.',
  indisponivel: 'Os planos estão indisponíveis agora.',
  ilegivel: 'Não consegui ler o arquivo dos planos, então não faço nada com eles.',
  enviado: 'Montei o plano e mandei aqui com os botões. Só começo se você aprovar.',
  semEnvio: 'Montei o plano, mas não consegui mandar os botões agora. Vou tentar de novo; se não der em 30 minutos, ele expira.',
  enviadoAuto: 'Montei o plano, mandei aqui e aprovei automaticamente: já estou começando. Para parar, diga "cancela o plano".',
  semEnvioAuto: 'Montei o plano, mas não consegui mandar agora. Só começo depois que ele chegar a você; se não der em 30 minutos, ele expira.',
  entregaIncerta: 'Não consegui confirmar que o plano chegou até você, então não executei nada. Peça de novo.',
  cancelado: 'Plano cancelado.',
  apagado: 'Você pediu para apagar a sua memória enquanto eu montava o plano, então descartei.',
});

export const hashDoPlano = (p) => hashParams({ id: p.id, versao: p.versao, userId: p.userId, passos: p.passos.map((s) => ({ ferramenta: s.ferramenta, args: s.args })) });

/** Os passos propostos pela IA: só um objeto JSON { passos: [{ ferramenta, args }] }. Qualquer desvio = null (recusa o plano inteiro). */
export function lerProposta(resposta) {
  const t = String(resposta ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!t.startsWith('{') || t.length > 4000) return null;
  let j;
  try { j = JSON.parse(t); } catch { return null; }
  const passos = j?.passos;
  if (!Array.isArray(passos) || passos.length < 1 || passos.length > MAX_PASSOS) return null;
  return passos.every((p) => p && typeof p.ferramenta === 'string' && Object.keys(p).every((k) => k === 'ferramenta' || k === 'args')) ? passos : null;
}

const instrucao = (disponiveis) => [
  'Você só transforma o pedido do dono em uma lista de passos de LEITURA. Não responda ao pedido e não converse.',
  `Responda SOMENTE com JSON: {"passos":[{"ferramenta":"nome","args":{}}]}, de 1 a ${MAX_PASSOS} passos.`,
  'Use apenas as ferramentas abaixo, com esses argumentos (todos em texto). Se o pedido precisar de outra coisa (gravar, enviar, apagar, abrir), responda {"passos":[]}.',
  ...disponiveis.map((f) => `- ${f.name}(${Object.entries(f.params).map(([k, s]) => `${k}${s.required ? '*' : ''}:${s.enum ? s.enum.join('|') : 'texto'}`).join(', ')}): ${f.descricao}`),
].join('\n');

/**
 * @param {{ canal: { entregarPlano: Function, enviarTexto: Function }, env?: object, store?: object, ferramentas?: Map, propor?: Function,
 *   perfil?: Function, engine?: object, auditFn?: Function, logger?: object, now?: () => number, ehDono?: Function, prazoDoPassoMs?: number }} o
 *   O canal responde true / { sent: true } (saiu), { incerto: true } ou false.
 */
export function criarServicoDePlanos({
  canal, env = process.env, store = criarStoreDePlanos({ env }), ferramentas = criarFerramentasDePlano({ env }), propor = isolatedChat, perfil = null,
  engine = getPolicyEngine(), auditFn = audit, logger = loggerPadrao, now = () => Date.now(), ehDono = isOwnerId, prazoDoPassoMs = PRAZO_DO_PASSO_MS,
}) {
  let propondo = false;
  let ocupadoNoTick = false;
  const emCurso = new Map(); // id -> promessa da execução
  const finais = new Map(); // id -> o texto pronto que ainda não saiu (só em memória)
  const ctxDe = (userId) => buildContext({ platform: 'discord', userId: String(userId), isDM: true });
  const anotar = (evento, userId, dados) => { try { auditFn(evento, ctxDe(userId), dados); } catch { /* */ } };
  const aviso = (o, err) => logger.warn?.(`[Planos] ${o} (${String(err?.code ?? err?.name ?? 'erro').slice(0, 40)}).`);
  const saiu = (r) => r === true || r?.ok === true || r?.sent === true || r?.repetido === true;
  const encerrar = (p, estado) => { p.estado = estado; p.encerradoEm = now(); };

  /** A política vale para este passo AGORA? A matriz IMPÕE aqui mesmo com o modo global em observação. Falha fechado: ação fora da matriz ou erro = não. */
  function permitido(f, userId) {
    try {
      if (!ehDono(userId) || f.access !== TOOL_ACCESS.READ || !canonicalAction(f.action)) return false;
      const v = engine.evaluate({ action: f.action, role: ctxDe(userId).role, origin: ORIGINS.DISCORD_DM });
      return v.known === true && (v.decision === POLICY_STATES.AUTO || v.decision === POLICY_STATES.ASK);
    } catch { return false; }
  }

  /** A aprovação automática vale AGORA para estes passos? Falha fechado: chave desligada ou um passo sem "auto: true" = não. */
  const podeAuto = (passos) => planosAuto(env) && passos.every((s) => ferramentas.get(s.ferramenta)?.auto === true);

  const textoDoPlano = (p, auto) => [
    auto ? '**Plano aprovado automaticamente** (só leitura)' : '**Plano para aprovar** (só leitura)',
    ...p.passos.map((s, i) => `${i + 1}. ${ferramentas.get(s.ferramenta).frase(s.args)}`),
    auto ? 'Foi aprovado automaticamente, sem botão: começo agora. Para parar, diga "cancela o plano".'
      : 'Nada começa sem você tocar em Aprovar. A aprovação vale por 30 minutos.',
  ].join('\n');

  function iniciarExecucao(id) {
    emCurso.set(id, executar(id).catch((err) => aviso('a execução parou', err)).finally(() => emCurso.delete(id)));
  }

  /** Manda o plano e devolve a frase da resposta. O automático só começa com a entrega CONFIRMADA e a aprovação já gravada. */
  async function entregar(p) {
    const auto = p.auto === true && podeAuto(p.passos);
    let r = false;
    try {
      r = await canal.entregarPlano(p.userId, { texto: textoDoPlano(p, auto), id: p.id, versao: p.versao, hash: p.hash.slice(0, 16), ...(auto ? { auto: true } : {}) });
    } catch (err) { aviso('a entrega do plano falhou', err); }
    if (!saiu(r) && r?.incerto !== true) return auto ? FRASES.semEnvioAuto : FRASES.semEnvio;
    if (!auto) {
      store.mudar(p.id, (x) => { if (x.estado === 'a_entregar') { x.estado = 'aguardando'; x.entregueEm = now(); x.validade = x.entregueEm + VALIDADE_MS; } });
      return FRASES.enviado;
    }
    if (!saiu(r)) {
      store.mudar(p.id, (x) => { if (x.estado === 'a_entregar') encerrar(x, 'falhou'); });
      return FRASES.entregaIncerta;
    }
    let aprovado = false;
    store.mudar(p.id, (x) => { // se o disco recusar, lança e nada é executado
      if (x.estado !== 'a_entregar' || hashDoPlano(x) !== x.hash) return;
      x.estado = 'aprovado';
      x.entregueEm = now();
      x.validade = x.entregueEm + VALIDADE_MS;
      x.aprovacao = { plano: x.id, versao: x.versao, hash: x.hash, validade: x.validade, em: x.entregueEm, automatica: true };
      aprovado = true;
    });
    if (!aprovado) return FRASES.cancelado; // cancelado ou apagado enquanto a mensagem saía
    anotar('plan.approved', p.userId, { planId: p.id, automatica: true });
    iniciarExecucao(p.id);
    return FRASES.enviadoAuto;
  }

  async function criar(userId, pedido, querAuto) {
    if (propondo || store.ler().some((p) => ATIVOS.has(p.estado))) return FRASES.jaTem;
    propondo = true;
    const geracao = geracaoDeApagamento(userId);
    try {
      const disponiveis = [...ferramentas.values()].filter((f) => f.disponivel() && permitido(f, userId));
      if (!disponiveis.length) return FRASES.indisponivel;
      let resposta;
      try {
        resposta = await propor({
          prompt: pedido, system: instrucao(disponiveis), ctx: ctxDe(userId), sensitive: true, deadlineAt: now() + 60_000,
          ...(perfil ? { perfil: perfil(pedido) } : {}),
        });
      } catch (err) {
        aviso('a IA não propôs o plano', err);
        return FRASES.indisponivel;
      }
      if (geracaoDeApagamento(userId) !== geracao) return FRASES.apagado;
      const propostos = lerProposta(resposta);
      if (!propostos) return FRASES.naoMontei;
      const passos = [];
      for (const s of propostos) {
        const f = disponiveis.find((x) => x.name === s.ferramenta);
        const args = f ? argumentosValidos(f, s.args) : null;
        if (!args) return FRASES.naoMontei;
        passos.push({ ferramenta: f.name, args, estado: 'pendente' });
      }
      const plano = { id: crypto.randomBytes(6).toString('hex'), versao: 1, userId: String(userId), estado: 'a_entregar', criadoEm: now(), passos };
      plano.hash = hashDoPlano(plano);
      if (querAuto && podeAuto(passos)) plano.auto = true;
      store.adicionar(plano);
      anotar('plan.created', userId, { planId: plano.id, passos: passos.length, tools: passos.map((s) => s.ferramenta) });
      return await entregar(plano);
    } finally {
      propondo = false;
    }
  }

  /** O pedido por conversa do dono na DM. { handled: false } = não é sobre planos (a conversa segue). */
  // "digitado": quem chama garante que o texto é uma mensagem escrita pelo próprio dono na DM; sem isso nunca há aprovação automática.
  async function rotear({ userId, texto, digitado = false }) {
    if (!planosLigados(env) || !ehDono(userId)) return { handled: false };
    const p = pedidoDePlano(texto);
    if (!p) return { handled: false };
    try {
      if (p.tipo === 'criar') return { handled: true, text: await criar(String(userId), p.pedido, digitado === true && p.soPlano === false) };
      const ativo = store.ler().find((x) => x.userId === String(userId) && ATIVOS.has(x.estado));
      if (!ativo) return { handled: false };
      if (p.tipo === 'cancelar') {
        store.mudar(ativo.id, (x) => encerrar(x, 'cancelado'));
        finais.delete(ativo.id);
        anotar('plan.cancelled', userId, { planId: ativo.id });
        return { handled: true, text: FRASES.cancelado };
      }
      const nomes = { a_entregar: ativo.auto ? 'esperando eu conseguir mandar a mensagem' : 'esperando eu conseguir mandar os botões', aguardando: 'esperando a sua aprovação', aprovado: 'aprovado, começando', executando: 'em execução' };
      const feitos = ativo.passos.filter((s) => s.estado === 'feito').length;
      return { handled: true, text: `Plano ${nomes[ativo.estado]}: ${feitos} de ${ativo.passos.length} passo(s) feitos.` };
    } catch (err) {
      aviso('o pedido falhou', err);
      return { handled: true, text: err?.code === 'PLANOS_ILEGIVEL' ? FRASES.ilegivel : FRASES.indisponivel };
    }
  }

  /** O botão. `final`: os botões não servem mais. */
  async function decidir({ userId, id, versao, hash, aprovar }) {
    const nao = (text, final = true) => ({ ok: false, final, text });
    try {
      if (!planosLigados(env)) return nao('Os planos estão desligados.');
      if (!ehDono(userId)) return nao('Só o dono decide sobre os planos.', false);
      const p = store.obter(String(id));
      if (!p || p.userId !== String(userId) || p.versao !== Number(versao) || typeof hash !== 'string' || hash.length < 16 || !String(p.hash).startsWith(hash)) return nao('Esse plano não vale mais.');
      if (p.estado === 'a_entregar') return nao('Ainda estou confirmando a entrega; toque de novo em instantes.', false);
      if (p.estado !== 'aguardando') return nao('Esse plano já foi respondido ou não vale mais.');
      if (!(now() < p.validade)) { store.mudar(p.id, (x) => encerrar(x, 'expirado')); return nao('A aprovação desse plano expirou. Peça de novo.'); }
      if (hashDoPlano(p) !== p.hash) { store.mudar(p.id, (x) => encerrar(x, 'falhou')); return nao('Esse plano foi alterado depois de criado; não vou executar.'); }
      if (aprovar !== true) {
        store.mudar(p.id, (x) => encerrar(x, 'recusado'));
        anotar('plan.rejected', userId, { planId: p.id });
        return { ok: true, final: true, text: 'Plano recusado. Nada foi feito.' };
      }
      // Tudo síncrono até aqui: o segundo clique já encontra o estado "aprovado".
      store.mudar(p.id, (x) => { x.estado = 'aprovado'; x.aprovacao = { plano: x.id, versao: x.versao, hash: x.hash, validade: x.validade, em: now() }; });
      anotar('plan.approved', userId, { planId: p.id });
      iniciarExecucao(p.id);
      return { ok: true, final: true, text: 'Aprovado. Aviso aqui quando terminar.' };
    } catch (err) {
      aviso('a decisão falhou', err);
      return nao(err?.code === 'PLANOS_ILEGIVEL' ? FRASES.ilegivel : FRASES.indisponivel, false);
    }
  }

  function comPrazo(f, args, userId) {
    let timer;
    const prazo = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('prazo'), { code: 'PRAZO' })), prazoDoPassoMs); });
    return Promise.race([Promise.resolve().then(() => f.run(args, { userId })), prazo]).finally(() => clearTimeout(timer));
  }

  async function executar(id) {
    await Promise.resolve(); // a resposta do botão sai antes do primeiro passo
    const partes = [];
    let interrompido = false;
    let p = store.mudar(id, (x) => { if (x.estado === 'aprovado') x.estado = 'executando'; });
    if (!p) return;
    const total = p.passos.length;
    for (let i = 0; i < total; i += 1) {
      p = store.obter(id); // relido a cada passo: cancelado ou apagado para aqui
      if (!p || p.estado !== 'executando') return;
      const passo = p.passos[i];
      const f = ferramentas.get(passo.ferramenta);
      const a = p.aprovacao;
      const args = f ? argumentosValidos(f, passo.args) : null;
      const titulo = `**${i + 1}. ${args ? f.frase(args) : 'Passo recusado'}**`;
      const vale = Boolean(planosLigados(env) && a && a.plano === p.id && a.versao === p.versao && a.hash === p.hash && hashDoPlano(p) === p.hash
        && now() < a.validade && (a.automatica !== true || (planosAuto(env) && f?.auto === true)) && passo.estado === 'pendente' && args && hashParams(args) === hashParams(passo.args) && f.disponivel() && permitido(f, p.userId));
      if (!vale) {
        partes.push(`${titulo}\nNão executei: a permissão, a validade ou a configuração não valem mais. Parei aqui.`);
        interrompido = true;
        break;
      }
      store.mudar(id, (x) => { x.passos[i].estado = 'executando'; }); // se o disco recusar, lança e nada é lido
      let estado = 'feito';
      let saida;
      try {
        saida = String(await comPrazo(f, args, p.userId) ?? '');
      } catch (err) {
        estado = err?.code === 'PRAZO' ? 'incerto' : 'falhou';
        saida = estado === 'incerto' ? 'Passou do tempo: não sei se terminou, e não vou repetir. Parei aqui.' : err?.expor ? err.message : 'Não consegui fazer este passo.';
      }
      if (!store.mudar(id, (x) => { x.passos[i].estado = estado; })) return;
      anotar('plan.step', p.userId, { planId: id, step: i + 1, tool: passo.ferramenta, estado });
      partes.push(`${titulo}\n${saida.length > MAX_SAIDA_POR_PASSO ? `${saida.slice(0, MAX_SAIDA_POR_PASSO)}\n(cortado)` : saida}`);
      if (estado === 'incerto') { interrompido = true; break; }
    }
    const texto = redact([interrompido ? '**Plano interrompido**' : '**Plano concluído**', ...partes].join('\n\n'), env);
    // Partes marcadas e contadas aqui: a falha no meio retoma da parte que faltou, sem repetir as que saíram.
    const mensagens = splitForDiscord(texto, 1800).map((t) => `${MARCA_RESULTADO}\n${t}`);
    finais.set(id, { partes: mensagens, enviadas: 0, desde: now(), estado: interrompido ? 'interrompido' : 'concluido' });
    await entregarFinal(id);
  }

  async function entregarFinal(id) {
    const pronto = finais.get(id);
    if (!pronto || pronto.enviando) return;
    const p = store.obter(id);
    if (!p || p.estado !== 'executando') { finais.delete(id); return; }
    pronto.enviando = true;
    while (pronto.enviadas < pronto.partes.length) {
      if (finais.get(id) !== pronto || !store.obter(id)) break; // cancelado ou apagado no meio do envio
      let r = false;
      try { r = await canal.enviarTexto(p.userId, pronto.partes[pronto.enviadas], { idem: `plano-fim:${id}:${pronto.enviadas}` }); } catch (err) { aviso('o resultado não saiu', err); }
      if (!saiu(r) && r?.incerto !== true) break;
      pronto.enviadas += 1;
    }
    pronto.enviando = false;
    if (finais.get(id) !== pronto) return;
    if (pronto.enviadas === pronto.partes.length) {
      finais.delete(id);
      store.mudar(id, (x) => encerrar(x, pronto.estado));
    } else if (now() - pronto.desde > VALIDADE_MS) {
      finais.delete(id);
      store.mudar(id, (x) => { encerrar(x, 'interrompido'); x.avisar = true; });
    }
  }

  /** Na subida: o que estava no meio fica "interrompido"/"incerto" e o dono é avisado. Nada é executado de novo. */
  function recuperar() {
    try {
      for (const p of store.ler().filter((x) => x.estado === 'aprovado' || x.estado === 'executando')) {
        store.mudar(p.id, (x) => {
          for (const s of x.passos) if (s.estado === 'executando') s.estado = 'incerto';
          encerrar(x, 'interrompido');
          x.avisar = true;
        });
        anotar('plan.interrupted', p.userId, { planId: p.id });
      }
    } catch (err) { aviso('não consegui conferir os planos na subida', err); }
  }

  /** A passada periódica: entrega o que falta, expira e apaga o que encerrou há 7 dias. Nunca executa passos. Nunca lança. */
  async function tick() {
    if (ocupadoNoTick) return;
    ocupadoNoTick = true;
    try {
      store.limpar(now());
      for (const { id } of store.ler()) {
        const p = store.obter(id); // relido: durante os envios abaixo, outro plano pode ter terminado
        if (!p) continue;
        if (p.estado === 'a_entregar') {
          if (now() - p.criadoEm >= VALIDADE_MS) store.mudar(p.id, (x) => encerrar(x, 'expirado'));
          else if (planosLigados(env) && !propondo && hashDoPlano(p) === p.hash && p.passos.every((s) => ferramentas.has(s.ferramenta))) {
            // Aqui não há resposta a devolver: a entrega incerta de um automático vira um aviso guardado (sai na próxima passada).
            if (await entregar(p) === FRASES.entregaIncerta) store.mudar(p.id, (x) => { x.avisar = 'entrega'; });
          }
        } else if (p.estado === 'aguardando' && !(now() < p.validade)) {
          store.mudar(p.id, (x) => encerrar(x, 'expirado'));
        } else if (p.estado === 'executando' && finais.has(p.id)) {
          await entregarFinal(p.id);
        } else if ((p.estado === 'aprovado' || p.estado === 'executando') && !emCurso.has(p.id) && !finais.has(p.id)) {
          // A execução parou no meio (ex.: o disco recusou uma gravação): fecha como interrompido, sem repetir nada.
          store.mudar(p.id, (x) => { for (const s of x.passos) if (s.estado === 'executando') s.estado = 'incerto'; encerrar(x, 'interrompido'); x.avisar = true; });
        } else if (p.avisar) {
          const incerto = p.passos.some((s) => s.estado === 'incerto');
          const feitos = p.passos.filter((s) => s.estado === 'feito').length;
          const texto = p.avisar === 'entrega' ? FRASES.entregaIncerta : `Um plano foi interrompido antes de eu entregar o resultado (${feitos} de ${p.passos.length} passo(s) tinham terminado${incerto ? '; um ficou incerto' : ''}). Não vou repetir sozinha: se ainda quiser, peça de novo.`;
          let r = false;
          try { r = await canal.enviarTexto(p.userId, texto, { idem: `plano-interrompido:${p.id}` }); } catch { r = false; }
          if (saiu(r) || r?.incerto === true) store.mudar(p.id, (x) => { delete x.avisar; });
        }
      }
    } catch (err) {
      aviso('a passada falhou', err);
    } finally {
      ocupadoNoTick = false;
    }
  }

  return { rotear, decidir, tick, recuperar, ocioso: () => Promise.all([...emCurso.values()]) };
}

/** Liga o serviço: confere o que ficou no meio e agenda a passada. */
export function iniciarPlanos(opcoes, { tickMs = 30_000 } = {}) {
  const servico = criarServicoDePlanos(opcoes);
  servico.recuperar();
  const timer = setInterval(() => { servico.tick(); }, tickMs);
  timer.unref?.();
  return { ...servico, parar: () => clearInterval(timer) };
}
