// Política de audiência da Yui (Fase 1, desenho em docs/DESENHO_FASE1_YUI_PERSONAL_AI.md, parecer da Liz de 25/11/2026).
//
// Módulo PURO: sem Discord, sem IA, sem banco, sem relógio, sem rede. Recebe FATOS e devolve o que o turno pode usar.
// A decisão é do CÓDIGO e vem ANTES da IA: o modelo nunca decide se pode ver algo privado.
//
// Três conceitos separados (Liz):
//  - IDENTIDADE: quem está falando (falanteVerificado + falanteEhDono; vem do receiver do Discord, nunca do texto do STT);
//  - AUDIÊNCIA: quem pode ouvir a resposta (humanosNaCall, donoPresente);
//  - AUTORIZAÇÃO: que recursos o turno pode usar (o campo `recursos` da decisão).
// Reconhecer o dono NÃO torna a conversa privada: se há outra pessoa na call, a audiência mudou.
//
// Só dois níveis: 'privado' e 'publico'. Falha fechado: qualquer dúvida (contagem ausente, falante não confirmado, chave desligada) = público.
// Convidado de confiança fica FORA da Fase 1 (a arquitetura aceita um nível a mais depois, sem mudar os chamadores).

export const POLICY_VERSION = 1;

export const NIVEL = Object.freeze({ PRIVADO: 'privado', PUBLICO: 'publico' });
export const INTERFACE = Object.freeze({ DM: 'dm', CANAL: 'canal', VOZ: 'voz' });

/** Motivos de rebaixamento (nunca contêm nome, texto ou id de pessoa). */
export const MOTIVO = Object.freeze({
  CHAVE_DESLIGADA: 'chave_desligada',
  CONTAGEM_INDISPONIVEL: 'contagem_indisponivel',
  FALANTE_NAO_VERIFICADO: 'falante_nao_verificado',
  FALANTE_NAO_DONO: 'falante_nao_dono',
  DONO_AUSENTE: 'dono_ausente',
  OUTROS_HUMANOS: 'outros_humanos',
  SEM_PROMOCAO_NO_TURNO: 'sem_promocao_no_turno',
  CANAL_PUBLICO: 'canal_publico',
  NAO_DONO: 'nao_dono',
  AUDIENCIA_MUDOU: 'audiencia_mudou',
  INTERFACE_DESCONHECIDA: 'interface_desconhecida',
});

const RECURSOS_NENHUM = Object.freeze({
  memoriaPessoal: false, contextoPessoal: false, personaDono: false, fioDM: false,
  google: false, ferramentas: 'nenhuma', climaPesquisa: 'nenhum',
});

const congela = (o) => Object.freeze({ ...o });

function decisao(nivel, recursos, extra = {}) {
  return Object.freeze({
    nivel,
    recursos: congela(recursos),
    rebaixadaPor: extra.rebaixadaPor ?? null,
    speakerVerified: extra.speakerVerified === true,
    ownerPresent: extra.ownerPresent === true,
    humanCount: Number.isInteger(extra.humanCount) && extra.humanCount >= 0 ? extra.humanCount : null,
    directed: extra.directed === true,
    interface: extra.interface ?? null,
    policyVersion: POLICY_VERSION,
  });
}

const eInteiro = (n) => Number.isInteger(n) && n >= 0;

/**
 * Recursos do canal público de voz: só o que não é pessoal. Clima só se a Yui foi chamada; a pesquisa por intenção
 * também só se foi chamada (a busca já tem as próprias travas de privacidade no cérebro).
 */
function recursosPublicos(dirigida) {
  return { ...RECURSOS_NENHUM, climaPesquisa: dirigida ? 'clima' : 'nenhum' };
}

/**
 * Decide a audiência de UM turno.
 *
 * @param {object} f fatos
 * @param {'dm'|'canal'|'voz'} f.interface
 * @param {boolean} [f.ehDono]              texto: o autor é o dono (papel resolvido pelo cérebro, não pelo texto)
 * @param {boolean} [f.falanteVerificado]   voz: a identidade veio do receiver (SSRC→usuário) e está confirmada agora
 * @param {boolean} [f.falanteEhDono]       voz: o falante confirmado é o dono
 * @param {boolean} [f.donoPresente]        voz: o dono está na call neste instante
 * @param {number|null} [f.humanosNaCall]   voz: humanos no canal de voz AGORA, mutados e ensurdecidos incluídos (bots não contam); null = falhou
 * @param {boolean} [f.dirigida]            voz: a Yui foi chamada pelo nome
 * @param {boolean} [f.chaveLigada]         voz: YUI_VOZ_UNIFICADA
 * @param {boolean} [f.googleVoz]           voz: YUI_VOZ_GOOGLE
 * @param {boolean} [f.ferramentasVoz]      voz: YUI_VOZ_TOOLS (só vale com o bloqueio efetivo no executor)
 * @param {object} [opts]
 * @param {'privado'|'publico'|null} [opts.nivelInicialDoTurno] nível decidido no INÍCIO deste mesmo turno; público não é promovido dentro do turno
 */
export function decidirAudiencia(f = {}, opts = {}) {
  const fatos = f && typeof f === 'object' ? f : {};
  const base = { interface: fatos.interface, directed: fatos.dirigida === true };

  if (fatos.interface === INTERFACE.DM) {
    // Texto privado: como hoje (a quem pertence a DM é decidido pelo papel; o dono tem tudo, os outros têm o escopo público de sempre).
    if (fatos.ehDono === true) {
      return decisao(NIVEL.PRIVADO, {
        memoriaPessoal: true, contextoPessoal: true, personaDono: true, fioDM: true,
        google: true, ferramentas: 'conforme_permissoes', climaPesquisa: 'tudo',
      }, { ...base, speakerVerified: true, ownerPresent: true });
    }
    return decisao(NIVEL.PUBLICO, { ...RECURSOS_NENHUM, ferramentas: 'conforme_permissoes', climaPesquisa: 'tudo' }, { ...base, rebaixadaPor: MOTIVO.NAO_DONO });
  }

  if (fatos.interface === INTERFACE.CANAL) {
    return decisao(NIVEL.PUBLICO, { ...RECURSOS_NENHUM, ferramentas: 'conforme_permissoes', climaPesquisa: 'tudo' }, { ...base, rebaixadaPor: MOTIVO.CANAL_PUBLICO });
  }

  if (fatos.interface !== INTERFACE.VOZ) {
    // Interface que a política não conhece: tudo fechado.
    return decisao(NIVEL.PUBLICO, RECURSOS_NENHUM, { ...base, rebaixadaPor: MOTIVO.INTERFACE_DESCONHECIDA });
  }

  // ── Voz ──
  const humanCount = eInteiro(fatos.humanosNaCall) ? fatos.humanosNaCall : null;
  const comum = { ...base, humanCount, speakerVerified: fatos.falanteVerificado === true, ownerPresent: fatos.donoPresente === true };
  const publico = (motivo) => decisao(NIVEL.PUBLICO, recursosPublicos(fatos.dirigida === true), { ...comum, rebaixadaPor: motivo });

  if (fatos.chaveLigada !== true) return publico(MOTIVO.CHAVE_DESLIGADA);
  if (opts.nivelInicialDoTurno === NIVEL.PUBLICO) return publico(MOTIVO.SEM_PROMOCAO_NO_TURNO);
  if (humanCount === null) return publico(MOTIVO.CONTAGEM_INDISPONIVEL);
  if (fatos.falanteVerificado !== true) return publico(MOTIVO.FALANTE_NAO_VERIFICADO);
  if (fatos.falanteEhDono !== true) return publico(MOTIVO.FALANTE_NAO_DONO);
  if (fatos.donoPresente !== true) return publico(MOTIVO.DONO_AUSENTE);
  if (humanCount !== 1) return publico(MOTIVO.OUTROS_HUMANOS); // 0 também é incoerente (o dono falou): falha fechado

  const dirigida = fatos.dirigida === true;
  return decisao(NIVEL.PRIVADO, {
    memoriaPessoal: true, contextoPessoal: true, personaDono: true, fioDM: true,
    google: fatos.googleVoz === true,
    ferramentas: fatos.ferramentasVoz === true ? 'leitura' : 'nenhuma',
    climaPesquisa: dirigida ? 'tudo' : 'nenhum',
  }, comum);
}

/**
 * Reavalia a decisão ANTES de cada passo sensível (enviar contexto ao provedor, executar ferramenta, incorporar resultado
 * externo, entregar a resposta). Um turno privado só continua privado se a política de AGORA também diz privado e ninguém novo
 * entrou: caso contrário o turno privado é INVALIDADO (o chamador descarta o contexto privado e responde como público ou desiste;
 * nunca "tira algumas mensagens e segue").
 *
 * @returns {{ mantem: boolean, decisao: object, motivo: string|null }}
 */
export function revalidar(inicial, fatosAgora, opts = {}) {
  const agora = decidirAudiencia(fatosAgora, { ...opts, nivelInicialDoTurno: inicial?.nivel ?? NIVEL.PUBLICO });
  if (inicial?.nivel !== NIVEL.PRIVADO) return { mantem: agora.nivel === NIVEL.PUBLICO, decisao: agora, motivo: null };
  if (agora.nivel !== NIVEL.PRIVADO) return { mantem: false, decisao: agora, motivo: agora.rebaixadaPor ?? MOTIVO.AUDIENCIA_MUDOU };
  if (Number.isInteger(inicial.humanCount) && Number.isInteger(agora.humanCount) && agora.humanCount > inicial.humanCount) {
    return { mantem: false, decisao: agora, motivo: MOTIVO.OUTROS_HUMANOS };
  }
  return { mantem: true, decisao: agora, motivo: null };
}

/**
 * As chaves da voz unificada, lidas num lugar só (bot e cérebro leem igual). Tudo nasce DESLIGADO: só o texto exato "true" liga.
 *  - YUI_VOZ_UNIFICADA: liga a política de audiência na voz;
 *  - YUI_VOZ_GOOGLE: dono sozinho pode consultar a agenda por voz (só leitura, resposta curta);
 *  - YUI_VOZ_TOOLS: dono sozinho pode usar a lista fechada de ferramentas só de leitura (exige o bloqueio do executor);
 *  - YUI_VOZ_PRAZO_S: prazo da resposta de voz em segundos (padrão 8, de 3 a 12: tem de ficar abaixo da idade máxima da medição da call, 15 s).
 *    YUI_VOZ_TOOLS: RESERVADA nesta fase (o executor deny-by-default existe, mas a oferta de ferramentas à voz continua fechada).
 */
export function lerChavesVoz(env = process.env) {
  const ligada = (v) => String(v ?? '').trim().toLowerCase() === 'true';
  const n = Number.parseInt(String(env.YUI_VOZ_PRAZO_S ?? '').trim(), 10);
  const prazoS = Number.isFinite(n) ? Math.min(12, Math.max(3, n)) : 8;
  return {
    unificada: ligada(env.YUI_VOZ_UNIFICADA),
    google: ligada(env.YUI_VOZ_GOOGLE),
    ferramentas: ligada(env.YUI_VOZ_TOOLS),
    prazoMs: prazoS * 1000,
  };
}

/** Idade máxima de uma medição da call (humanos, dono presente) para valer como "agora". Passou disso: contagem indisponível = público. */
export const MEDICAO_MAX_IDADE_MS = 15_000;
const ID_RE = /^\d{5,25}$/;

/**
 * Valida o bloco de audiência que o BOT manda no turno de voz (`call.audiencia`) e devolve os FATOS para decidirAudiencia.
 * O cérebro NUNCA aceita um "nível" pronto do bot: só fatos, e o que ele sabe sozinho (quem é o dono, quem é o autor do turno,
 * o relógio) manda. Qualquer campo faltando, fora de forma ou velho vira o fato mais fechado (contagem indisponível, falante não confirmado).
 *
 * @param {object|null} wire { v:1, falanteId, falanteVerificado, donoPresente, humanosNaCall, dirigida, medidoEm, turnoId }
 * @param {{ autorId: string, autorEhDono: boolean, chaves: ReturnType<typeof lerChavesVoz>, agora: number, maxIdadeMs?: number }} p
 */
export function fatosDaVoz(wire, { autorId, autorEhDono, chaves, agora, maxIdadeMs = MEDICAO_MAX_IDADE_MS } = {}) {
  const w = wire && typeof wire === 'object' && !Array.isArray(wire) && wire.v === 1 ? wire : {};
  const frescor = Number.isFinite(w.medidoEm) && Number.isFinite(agora) && w.medidoEm <= agora + 5_000 && agora - w.medidoEm <= maxIdadeMs;
  const humanos = Number.isInteger(w.humanosNaCall) && w.humanosNaCall >= 0 && w.humanosNaCall <= 1000 && frescor ? w.humanosNaCall : null;
  const falanteVerificado = w.falanteVerificado === true && typeof w.falanteId === 'string' && ID_RE.test(w.falanteId) && w.falanteId === String(autorId ?? '');
  return {
    interface: INTERFACE.VOZ,
    chaveLigada: chaves?.unificada === true,
    falanteVerificado,
    falanteEhDono: falanteVerificado && autorEhDono === true,
    donoPresente: frescor && w.donoPresente === true,
    humanosNaCall: humanos,
    dirigida: w.dirigida === true,
    googleVoz: chaves?.google === true,
    ferramentasVoz: chaves?.ferramentas === true,
  };
}

/** Uma ferramenta pode rodar nesta decisão? Deny by default: o executor consulta isto, não o prompt. */
export function ferramentaPermitida(decisaoAtual, { nome, somenteLeitura, permitidas = [] } = {}) {
  if (!decisaoAtual || typeof nome !== 'string' || !nome) return false;
  const modo = decisaoAtual.recursos?.ferramentas;
  if (modo === 'conforme_permissoes') return true; // texto: as travas de sempre (guardToolCall, toggles) seguem valendo
  if (modo !== 'leitura') return false;
  return somenteLeitura === true && Array.isArray(permitidas) && permitidas.includes(nome);
}

/**
 * O evento de auditoria `politica.audiencia` (ou `politica.audiencia.bloqueio`). SEM texto, sem nome e sem id de pessoa:
 * só números, flags e códigos. Quem grava é o código de autorização, nunca a IA.
 */
export function eventoAuditoria(decisaoAtual, { turnId, timestamp, bloqueio = null } = {}) {
  const d = decisaoAtual ?? {};
  const permitidos = Object.entries(d.recursos ?? {})
    .filter(([, v]) => v === true || (typeof v === 'string' && v !== 'nenhuma' && v !== 'nenhum'))
    .map(([k]) => k);
  const base = {
    turn_id: typeof turnId === 'string' ? turnId.slice(0, 80) : null,
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
    interface: d.interface ?? null,
    audience_level: d.nivel ?? NIVEL.PUBLICO,
    speaker_verified: d.speakerVerified === true,
    owner_present: d.ownerPresent === true,
    human_count: Number.isInteger(d.humanCount) ? d.humanCount : null,
    directed: d.directed === true,
    policy_version: d.policyVersion ?? POLICY_VERSION,
    downgrade_reason: d.rebaixadaPor ?? null,
    resources_allowed: permitidos,
  };
  if (bloqueio) base.blocked_resource = String(bloqueio).slice(0, 40);
  return { action: bloqueio ? 'politica.audiencia.bloqueio' : 'politica.audiencia', ...base };
}
