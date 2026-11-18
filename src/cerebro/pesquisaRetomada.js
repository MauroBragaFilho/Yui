// A RETOMADA da pesquisa depois de um reinício do cérebro, sem repetição cega (etapa 6, ajustes da Liz: §10 e §11 do
// docs/RELATORIO_ETAPA6_PESQUISA.md; contrato em docs/ETAPA3_DONOS_E_CONTRATO.md §9).
//
// O problema: o cache de idempotência do canal vive na memória. Se o cérebro REINICIAR no meio de uma pesquisa, o bot repete o pedido com a
// MESMA chave (`research.turn:<id da mensagem>:<n>`, `chat.yui:<id da interação>`, `chat.turn:<id>:<passo>`) e o cérebro novo, sem o cache,
// faria tudo de novo: outra busca no buscador externo (que gasta cota e não garante execução única), outra leitura, outra síntese.
//
// A solução: um DIÁRIO por pesquisa, gravado pelo cérebro (dono: o cérebro) em <DATABASE_DIR>/pesquisa-retomada/<pessoa>.json:
//  - estados da pesquisa (por chave): `pending` (registrada, nada enviado), `running` (em andamento), `completed` (resposta pronta) e
//    `uncertain` (um pedido ao buscador saiu e não tem resultado registrado);
//  - cada ETAPA guardada com o resultado: cada busca (`agente:1`, `agente:2`, `rapida:1`), cada página lida (`pagina:<hash>`) e cada síntese
//    (`sintese:1`). Uma busca é marcada `running` NO DISCO antes de ir ao buscador e `completed` (com o resultado) quando volta;
//  - na volta de um reinício, a mesma chave RETOMA de onde parou: a busca concluída e guardada NÃO roda de novo (o resultado vem do diário)
//    e a cota por hora dela é devolvida ao contador do processo novo (budget.restoreUse: ela já foi feita e continua contando); a página lida
//    e a síntese pronta também não se repetem;
//  - a busca que ficou `running` (pedido enviado, sem resultado registrado) vira `uncertain`: o buscador externo não garante execução única.
//    A nova tentativa é CONTROLADA: uma só (no máximo 2 tentativas por etapa), registrada no diário, contada na cota UMA vez (a do pedido que
//    se perdeu morreu com o processo antigo; a nova conta normalmente) e visível no log e na saúde (só números). Se a nova tentativa também
//    for interrompida, a etapa desiste (sem uma 3ª busca) e a Yui diz "pede de novo";
//  - página e síntese que ficaram pela metade rodam de novo (leitura de página e IA não gastam cota de busca e não têm efeito fora daqui).
// Privacidade: UM arquivo por pessoa (o nome é um hash do id, nunca o id), então o conteúdo de uma pesquisa pública nunca fica no arquivo de
// outra pessoa; o log só recebe números e estados (nunca a pergunta, a consulta, a URL ou o texto da web); prazo de validade curto
// (YUI_PESQUISA_RETOMADA_MIN, 30 min). Com a pesquisa CONCLUÍDA, o conteúdo das etapas sai e fica só a resposta pronta (para a repetição com a
// mesma chave devolver a mesma resposta). YUI_PESQUISA_RETOMADA=false desliga o diário (o comportamento da etapa 6: a pesquisa perdida roda de
// novo).
//
// PESQUISA PRIVADA (segunda revisão da Liz, §12 e §13 do relatório da etapa 6): NUNCA tem conteúdo em disco. Do registro dela só ficam o estado,
// a chave protegida, as etapas (pelo nome e pela ordem: "agente:1", "pagina:2") e os horários; nada da pergunta, da consulta (nem o hash), das
// páginas, da síntese ou da resposta. O conteúdo fica só na memória enquanto a pesquisa roda. Depois de um reinício, a pesquisa privada que não
// pode ser reconstruída sem o conteúdo (qualquer etapa já começada, ou já concluída) vira "uncertain" e a Yui pede à pessoa para mandar de novo
// (TEXTO_PRIVADA_REENVIAR); ela NÃO pesquisa sozinha de novo. A privada que ainda estava "pending" sem etapa nenhuma (nada saiu para o buscador)
// roda normalmente, com o pedido que o bot repete. A antiga opção YUI_PESQUISA_RETOMADA_PRIVADA (guardar o conteúdo da privada) foi REMOVIDA: se
// ela ainda estiver no .env, é ignorada e o log avisa uma vez.
// CHAVE PROTEGIDA: a chave de idempotência (que leva o id da mensagem do Discord) nunca vai para o disco; o arquivo guarda só um hash dela.
// DIÁRIO ANTIGO: arquivo de uma versão anterior (a versão 1 podia ter conteúdo de pesquisa privada), arquivo ilegível e os ".corrompido-*" que a
// versão anterior guardava ao lado são APAGADOS na subida (nunca guardados ao lado: podiam ter conteúdo privado).
// Gravação ATÔMICA e durável (temporário + fsync + rename: o mesmo writeJsonAtomic da idempotência persistente do bot).
//
// FALHAR FECHADO (revisão da Liz, §12 do relatório da etapa 8): nenhuma pesquisa externa começa sem a marca persistente. Se o diário NÃO consegue gravar a
// marca `running` da busca (disco cheio, somente leitura, arquivo travado), a busca NÃO sai, SEJA A PESQUISA PRIVADA OU PÚBLICA, automática ou explícita,
// e nada é cobrado: a Yui continua conversando e avisa que a pesquisa está temporariamente indisponível (o MESMO texto de src/search/indisponivel.js).
// Nunca se contorna com a cota só em memória. Só YUI_PESQUISA_RETOMADA=false (desligar o diário DE PROPÓSITO) segue sem a marca: é escolha explícita do dono.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic } from '../core/channel/idemPersistente.js';
import { TEXTO_PESQUISA_INDISPONIVEL, resultadoIndisponivel } from '../search/indisponivel.js';

export const ESTADOS = Object.freeze({ PENDENTE: 'pending', RODANDO: 'running', CONCLUIDA: 'completed', INCERTA: 'uncertain' });
const ESTADOS_VALIDOS = new Set(Object.values(ESTADOS));
// Versão 2: chave protegida (hash) e pesquisa privada sem conteúdo. A versão 1 (chave em texto, privada com conteúdo) é apagada na subida.
const VERSAO = 2;
const CHAVE_DISCO_RE = /^[0-9a-f]{32}$/;
/** A busca original + UMA nova tentativa controlada. */
export const MAX_TENTATIVAS = 2;
const MAX_PESQUISAS_POR_PESSOA = 50;
const MAX_RESULTADOS = 20;
const MAX_TEXTO = 20_000;
const CHAVE_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
export const TEXTO_INTERROMPIDA = 'A pesquisa foi interrompida por um reinício e não deu para concluir sem repetir a busca às cegas. Pede de novo daqui a pouco.';
/**
 * A pesquisa cuja marca de envio NÃO deu para gravar no disco (etapa 8, condição da Liz, §9 da etapa 7: "a marca persistente vem ANTES do despacho ao
 * buscador; qualquer dúvida vira uncertain"; e, na revisão da Liz da etapa 8, vale TAMBÉM para a pública). Sem a marca, um reinício não conseguiria provar o
 * que saiu; por isso NADA é enviado ao buscador. O texto é o aviso ÚNICO de pesquisa temporariamente indisponível (o mesmo dos outros casos).
 */
export const TEXTO_SEM_MARCA = TEXTO_PESQUISA_INDISPONIVEL;
/** A pesquisa PRIVADA interrompida por um reinício: o conteúdo dela nunca fica em disco, então não dá para continuar; a pessoa manda de novo. */
export const TEXTO_PRIVADA_REENVIAR = 'Fui reiniciada no meio da sua pesquisa. Por privacidade, eu não guardo o conteúdo das pesquisas privadas, então não dá para continuar de onde parou: manda o pedido de novo, por favor.';

const flag = (v, fallback) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return fallback;
  if (['false', '0', 'off', 'no', 'nao', 'não'].includes(s)) return false;
  if (['true', '1', 'on', 'yes', 'sim'].includes(s)) return true;
  return fallback;
};

/**
 * Configuração: YUI_PESQUISA_RETOMADA (padrão true) e YUI_PESQUISA_RETOMADA_MIN (padrão 30, de 1 a 1440). A privada nunca guarda conteúdo
 * (sem opção). `opcaoPrivadaRemovida`: a antiga YUI_PESQUISA_RETOMADA_PRIVADA ainda está no ambiente (é ignorada; o log avisa).
 */
export function retomadaConfig(env = process.env) {
  const min = Number.parseInt(String(env.YUI_PESQUISA_RETOMADA_MIN ?? '').trim(), 10);
  return {
    ligada: flag(env.YUI_PESQUISA_RETOMADA, true),
    validadeMs: (Number.isInteger(min) && min >= 1 ? Math.min(min, 1440) : 30) * 60_000,
    opcaoPrivadaRemovida: String(env.YUI_PESQUISA_RETOMADA_PRIVADA ?? '').trim() !== '',
  };
}

/** A pasta do diário (dono: o cérebro): <DATABASE_DIR>/pesquisa-retomada. */
export function pastaDaRetomada(env = process.env) {
  return path.join(env.DATABASE_DIR || path.join(process.cwd(), 'database'), 'pesquisa-retomada');
}

const hash = (s, n = 16) => crypto.createHash('sha256').update(String(s ?? '')).digest('hex').slice(0, n);
/** O nome do arquivo de uma pessoa: um hash do id (o id nunca vai para o nome do arquivo). */
export const arquivoDaPessoa = (userId) => `${hash(`yui-pesquisa:${userId ?? 'anonimo'}`, 32)}.json`;
/** A chave de recuperação como ela fica no disco: um hash (a chave tem o id da mensagem do Discord e nunca vai em texto para o arquivo). */
export const chaveProtegida = (chave) => hash(`yui-pesquisa-chave:${chave}`, 32);
const clip = (v, n) => String(v ?? '').slice(0, n);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** O resultado de uma busca, reduzido ao que o agente e a busca automática usam (sem objetos estranhos, com tamanho limitado). */
function resultadoDeBusca(found) {
  const r = found && typeof found === 'object' ? found : {};
  return {
    provider: typeof r.provider === 'string' ? clip(r.provider, 60) : null,
    results: (Array.isArray(r.results) ? r.results : []).slice(0, MAX_RESULTADOS).map((x) => ({ title: clip(x?.title, 300), url: clip(x?.url, 500), snippet: clip(x?.snippet, 1000) })),
    errors: (Array.isArray(r.errors) ? r.errors : []).slice(0, 10).map((e) => clip(e, 200)),
    ...(r.limited === 'user' || r.limited === 'global' ? { limited: r.limited } : {}),
    ...(Number(r.retryAfterMs) > 0 ? { retryAfterMs: Number(r.retryAfterMs) } : {}),
    ...(r.cached === true ? { cached: true } : {}),
    ...(typeof r.reason === 'string' ? { reason: clip(r.reason, 40) } : {}),
    ...(typeof r.cause === 'string' ? { cause: clip(r.cause, 40) } : {}),
    ...(typeof r.message === 'string' ? { message: clip(r.message, 300) } : {}),
  };
}

/** A busca gastou a cota por hora? Recusada pelo limite, ou servida pelo cache do providers.js, não gasta. */
const gastouCota = (r) => r && !r.limited && r.cached !== true;

/**
 * O diário das pesquisas do cérebro. Tudo injetável para teste.
 * @param {{ dir?: string, env?: object, now?: () => number, logger?: object, budget?: { restoreUse?: Function } | null }} [o]
 */
export function createRetomadaDePesquisa({ dir = null, env = process.env, now = Date.now, logger = null, budget = null } = {}) {
  const cfg = retomadaConfig(env);
  const pasta = path.resolve(dir ?? pastaDaRetomada(env));
  const boot = crypto.randomUUID();
  /** arquivo da pessoa -> Map(chave -> registro) */
  const pessoas = new Map();
  /** etapas cuja cota já foi devolvida NESTE processo (chave|etapa) */
  const cotaDevolvida = new Set();
  let fechado = false;
  const contadores = {
    abertas: 0, retomadas: 0, respostasReaproveitadas: 0, buscasReaproveitadas: 0, paginasReaproveitadas: 0, sintesesReaproveitadas: 0,
    incertasNaCarga: 0, novasTentativas: 0, desistencias: 0, cotaDevolvida: 0, gravacoes: 0, falhasDeGravacao: 0, vencidas: 0, semConteudo: 0, descartadas: 0,
    // a pesquisa privada (sem conteúdo em disco): as que pediram para mandar de novo, as interrompidas na carga, os diários antigos e ilegíveis
    // apagados e os registros privados de quem foi tirado algum conteúdo (defesa em profundidade)
    privadasReenviar: 0, privadasIncertasNaCarga: 0, antigosApagados: 0, ilegiveisApagados: 0, privadasSaneadas: 0,
    // a privada cuja marca de envio não gravou (nada foi enviado ao buscador: sem a marca, qualquer dúvida vale como não enviar)
    privadasSemMarca: 0,
    // qualquer pesquisa (privada ou pública) cuja marca de envio não gravou: a busca não saiu e a Yui avisou que a pesquisa está indisponível
    buscasSemMarca: 0,
  };
  // A última gravação do diário falhou? (e quando): a saúde mostra `gravacaoComFalha` por 5 minutos depois da falha, para o diagnóstico dizer "pesquisa indisponível".
  let ultimaGravacaoFalhou = false;
  let ultimaFalhaEm = 0;
  const log = (level, msg) => { try { logger?.[level]?.(msg); } catch { /* o log nunca derruba a pesquisa */ } };
  if (cfg.opcaoPrivadaRemovida) {
    log('warn', '[Pesquisa] retomada: YUI_PESQUISA_RETOMADA_PRIVADA foi removida e é ignorada: a pesquisa privada nunca guarda conteúdo em disco (só o estado).');
  }

  const vencido = (reg, t = now()) => !Number.isFinite(reg?.criadaEm) || t - reg.criadaEm > cfg.validadeMs;

  function gravar(arquivo) {
    if (fechado) return false;
    const mapa = pessoas.get(arquivo);
    if (!mapa) return true;
    const file = path.join(pasta, arquivo);
    try {
      const t = now();
      for (const [k, reg] of mapa) if (vencido(reg, t)) { mapa.delete(k); contadores.vencidas += 1; }
      while (mapa.size > MAX_PESQUISAS_POR_PESSOA) mapa.delete(mapa.keys().next().value);
      if (!mapa.size) {
        pessoas.delete(arquivo);
        try { fs.rmSync(file, { force: true }); } catch { /* */ }
        return true;
      }
      writeJsonAtomic(file, { versao: VERSAO, gravadoEm: new Date(t).toISOString(), pesquisas: Object.fromEntries(mapa) });
      contadores.gravacoes += 1;
      ultimaGravacaoFalhou = false;
      return true;
    } catch (err) {
      // Disco com problema: a falha fica na saúde (nunca o conteúdo no log). Quem precisa da marca ANTES de despachar a busca (o wrapper da busca) NÃO despacha
      // sem ela (falhar fechado); os outros registros do diário (página, síntese, fim) são melhor esforço.
      contadores.falhasDeGravacao += 1;
      ultimaGravacaoFalhou = true;
      ultimaFalhaEm = now();
      log('warn', `[Pesquisa] retomada: não consegui gravar o diário (${clip(err?.code ?? 'erro', 30)}); nenhuma busca nova sai enquanto o diário não gravar.`);
      return false;
    }
  }

  // ── Carga: o que ficou de um processo anterior ──
  /** Tira de um registro PRIVADO qualquer conteúdo (defesa em profundidade: a versão atual nunca grava, mas um arquivo pode ter vindo de fora). */
  function sanearPrivada(reg) {
    let tirou = false;
    if (reg.resultado !== undefined) { delete reg.resultado; tirou = true; }
    for (const e of Object.values(reg.etapas ?? {})) {
      for (const campo of ['resultado', 'consulta']) if (e && e[campo] !== undefined) { delete e[campo]; tirou = true; }
    }
    if (tirou) contadores.privadasSaneadas += 1;
    return tirou;
  }

  function carregar() {
    let arquivos = [];
    try { arquivos = fs.readdirSync(pasta); } catch { return; }
    const t = now();
    for (const nome of arquivos) {
      const file = path.join(pasta, nome);
      if (nome.endsWith('.tmp')) { try { fs.rmSync(file, { force: true }); } catch { /* */ } continue; }
      // Os ilegíveis que a versão anterior guardava ao lado: podiam ter conteúdo de pesquisa privada. APAGADOS.
      if (/\.corrompido-\d+$/.test(nome)) { try { fs.rmSync(file, { force: true }); contadores.ilegiveisApagados += 1; } catch { /* */ } continue; }
      if (!/^[0-9a-f]{32}\.json$/.test(nome)) continue;
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // Ilegível: APAGADO (nunca guardado ao lado: podia ter conteúdo privado). A retomada daquela pessoa recomeça vazia.
        try { fs.rmSync(file, { force: true }); } catch { /* */ }
        contadores.ilegiveisApagados += 1;
        log('warn', '[Pesquisa] retomada: um arquivo do diário estava ilegível e foi apagado (recomeçado vazio).');
        continue;
      }
      if (parsed?.versao !== VERSAO) {
        // Diário de uma versão anterior (a 1 guardava a chave em texto e o conteúdo da pesquisa privada): APAGADO na subida.
        try { fs.rmSync(file, { force: true }); } catch { /* */ }
        contadores.antigosApagados += 1;
        continue;
      }
      const lista = parsed.pesquisas && typeof parsed.pesquisas === 'object' ? parsed.pesquisas : {};
      const mapa = new Map();
      let mudou = false;
      for (const [chave, reg] of Object.entries(lista)) {
        if (!CHAVE_DISCO_RE.test(chave) || !reg || !ESTADOS_VALIDOS.has(reg.estado) || vencido(reg, t)) { mudou = true; contadores.vencidas += 1; continue; }
        const etapas = reg.etapas && typeof reg.etapas === 'object' ? reg.etapas : {};
        reg.etapas = etapas;
        if (reg.privado === true) {
          if (sanearPrivada(reg)) mudou = true;
          // A privada não pode ser reconstruída sem o conteúdo: só a que ainda não começou nada (pending, sem etapas) roda de novo.
          const comecou = reg.estado !== ESTADOS.PENDENTE || Object.keys(etapas).length > 0;
          if (comecou && !reg.reenviar) {
            reg.reenviar = true;
            if (reg.estado !== ESTADOS.CONCLUIDA) { reg.estado = ESTADOS.INCERTA; reg.interrompida = true; contadores.privadasIncertasNaCarga += 1; }
            for (const e of Object.values(etapas)) if (e?.estado === ESTADOS.RODANDO) e.estado = ESTADOS.INCERTA;
            mudou = true;
          }
          mapa.set(chave, reg);
          continue;
        }
        let incerta = false;
        for (const e of Object.values(etapas)) {
          if (e?.estado !== ESTADOS.RODANDO) continue;
          // Busca enviada sem resultado registrado: INCERTA (o buscador não garante execução única). Página e síntese: rodam de novo.
          if (e.tipo === 'busca') { e.estado = ESTADOS.INCERTA; incerta = true; contadores.incertasNaCarga += 1; } else e.estado = ESTADOS.PENDENTE;
          mudou = true;
        }
        if (incerta) reg.estado = ESTADOS.INCERTA;
        if (reg.estado !== ESTADOS.CONCLUIDA) reg.interrompida = true;
        mapa.set(chave, reg);
      }
      if (mapa.size) pessoas.set(nome, mapa);
      if (mudou || !mapa.size) {
        if (!mapa.size) { try { fs.rmSync(file, { force: true }); } catch { /* */ } } else gravar(nome);
      }
    }
    if (contadores.antigosApagados) log('warn', `[Pesquisa] retomada: ${contadores.antigosApagados} arquivo(s) do diário de uma versão anterior apagado(s) na subida (podiam ter conteúdo de pesquisa privada).`);
    if (contadores.privadasIncertasNaCarga) log('warn', `[Pesquisa] retomada: ${contadores.privadasIncertasNaCarga} pesquisa(s) PRIVADA(S) interrompida(s); o conteúdo não fica em disco, então a Yui vai pedir para mandar de novo (sem pesquisar sozinha).`);
    const n = [...pessoas.values()].reduce((s, m) => s + [...m.values()].filter((r) => r.interrompida && r.privado !== true).length, 0);
    if (n) log('warn', `[Pesquisa] retomada: ${n} pesquisa(s) interrompida(s) por um reinício no diário; ${contadores.incertasNaCarga} busca(s) incerta(s) (pedido enviado sem resultado registrado). Retomam quando o bot repetir o pedido.`);
  }
  if (cfg.ligada) carregar();

  /**
   * Abre (ou retoma) o diário de UMA pesquisa. `null` com o diário desligado ou chave inválida (o chamador segue sem ele).
   * @param {string} chave  a chave de idempotência do pedido (a mesma que o bot repete)
   * @param {{ userId: string|number|null, privado?: boolean, tipo?: string }} o
   */
  function abrir(chave, { userId = null, privado = false, tipo = 'pesquisa' } = {}) {
    if (!cfg.ligada || fechado || typeof chave !== 'string' || !CHAVE_RE.test(chave)) return null;
    const arquivo = arquivoDaPessoa(userId);
    if (!pessoas.has(arquivo)) pessoas.set(arquivo, new Map());
    const mapa = pessoas.get(arquivo);
    // No disco (e no mapa), só o hash da chave.
    const k = chaveProtegida(chave);
    let reg = mapa.get(k);
    const t = now();
    const retomada = Boolean(reg && !vencido(reg, t));
    if (!retomada) {
      reg = { tipo: clip(tipo, 30), estado: ESTADOS.PENDENTE, privado: privado === true, criadaEm: t, atualizadaEm: t, etapas: {} };
      mapa.set(k, reg);
      contadores.abertas += 1;
      gravar(arquivo);
    } else if (reg.privado === true && reg.reenviar === true) {
      // Privada interrompida por um reinício: sem o conteúdo não dá para continuar; a Yui pede para mandar de novo (nada roda).
      contadores.privadasReenviar += 1;
      log('info', `[Pesquisa] retomada: ${clip(reg.tipo, 30)} PRIVADA interrompida por um reinício; sem conteúdo guardado, a Yui pede para mandar de novo (nenhuma busca).`);
    } else if (reg.estado !== ESTADOS.CONCLUIDA) {
      contadores.retomadas += 1;
      const incertas = Object.values(reg.etapas ?? {}).filter((e) => e?.estado === ESTADOS.INCERTA).length;
      const guardadas = Object.values(reg.etapas ?? {}).filter((e) => e?.estado === ESTADOS.CONCLUIDA).length;
      log('info', `[Pesquisa] retomada: ${clip(reg.tipo, 30)} retomando de onde parou (${guardadas} etapa(s) guardada(s), ${incertas} busca(s) incerta(s)).`);
    }
    // A pesquisa privada NUNCA guarda conteúdo (nem o hash da consulta, nem o da URL: as etapas dela vão pela ordem).
    const semConteudo = reg.privado === true;
    const ordem = {};
    let desistiu = false;
    // devolve se o diário foi gravado (a pesquisa PRIVADA só despacha a busca com a marca no disco)
    const salvar = () => { reg.atualizadaEm = now(); return gravar(arquivo); };
    let motivoDesistencia = null;

    /** Devolve à cota por hora (do processo novo) uma busca que um processo anterior fez, uma vez por processo. */
    function devolverCota(id, etapa) {
      const gastou = etapa.resultado !== undefined ? gastouCota(etapa.resultado) : etapa.cotaGasta === true;
      if (etapa.boot === boot || !gastou || !Number.isFinite(etapa.cotaEm)) return;
      const kc = `${k}|${id}`;
      if (cotaDevolvida.has(kc)) return;
      cotaDevolvida.add(kc);
      try { if (budget?.restoreUse?.(etapa.cotaUsuario ? userId : null, etapa.cotaEm, env)) contadores.cotaDevolvida += 1; } catch { /* */ }
    }

    const handle = {
      chave,
      get estado() { return reg.estado; },
      get retomada() { return retomada && reg.estado !== ESTADOS.CONCLUIDA; },
      get desistiu() { return desistiu; },
      /** O texto que a Yui diz quando a pesquisa desistiu: interrompida por um reinício, ou sem conseguir gravar a marca de envio (pesquisa indisponível). */
      get textoDaDesistencia() { return motivoDesistencia === 'sem-marca' ? TEXTO_SEM_MARCA : TEXTO_INTERROMPIDA; },
      get decisao() { return reg.decisao ?? null; },
      /** A pesquisa PRIVADA foi interrompida por um reinício e não pode ser reconstruída: a Yui pede para mandar de novo (TEXTO_PRIVADA_REENVIAR). */
      get reenviar() { return reg.privado === true && reg.reenviar === true; },
      /** Guarda a decisão de pesquisar (o /yui): a retomada usa a MESMA decisão, mesmo que a cota do processo novo esteja diferente. */
      guardarDecisao(d) { if (!reg.decisao && d && typeof d === 'object') { reg.decisao = { modo: clip(d.modo, 20), motivo: clip(d.motivo, 30), explicito: d.explicito === true }; salvar(); } },
      /** A resposta pronta de uma pesquisa já concluída (a repetição com a mesma chave devolve a mesma), ou null. */
      concluida() {
        if (reg.estado !== ESTADOS.CONCLUIDA || reg.resultado === undefined) return null;
        contadores.respostasReaproveitadas += 1;
        // as buscas que essa pesquisa fez num processo anterior continuam contando na cota por hora deste
        for (const [id, e] of Object.entries(reg.etapas ?? {})) if (e?.tipo === 'busca') devolverCota(id, e);
        log('info', `[Pesquisa] retomada: ${clip(reg.tipo, 30)} já estava concluída; devolvendo a resposta guardada (sem buscar nem chamar a IA de novo).`);
        return clone(reg.resultado);
      },
      /**
       * Envolve uma função de BUSCA (a do agente, a busca rápida do ramo antigo ou a da busca automática): (consulta, opções) => resultado.
       * `tipo` separa as ordens ("agente", "rapida"): a mesma sequência se repete na retomada.
       */
      busca(tipoBusca, fn) {
        return async (query, o = {}) => {
          ordem[tipoBusca] = (ordem[tipoBusca] ?? 0) + 1;
          const id = `${clip(tipoBusca, 20)}:${ordem[tipoBusca]}`;
          let etapa = reg.etapas[id];
          const existia = Boolean(etapa); // a etapa já estava no registro (para desfazer o que esta tentativa fizer, se a marca não gravar)
          if (etapa?.estado === ESTADOS.CONCLUIDA) {
            if (etapa.resultado !== undefined) {
              contadores.buscasReaproveitadas += 1;
              devolverCota(id, etapa);
              log('info', `[Pesquisa] retomada: busca ${id} já feita e guardada; NÃO roda de novo.`);
              return clone(etapa.resultado);
            }
            // privada sem conteúdo guardado: não repete às cegas (a busca feita continua contando na cota)
            devolverCota(id, etapa);
            desistiu = true;
            contadores.desistencias += 1;
            log('warn', `[Pesquisa] retomada: busca ${id} da pesquisa privada foi feita, mas o conteúdo não fica guardado; não repito às cegas.`);
            return { provider: null, results: [], errors: ['retomada: pesquisa privada interrompida'] };
          }
          if (etapa?.estado === ESTADOS.INCERTA || etapa?.estado === ESTADOS.RODANDO) {
            if ((etapa.tentativas ?? 1) >= MAX_TENTATIVAS) {
              desistiu = true;
              contadores.desistencias += 1;
              log('warn', `[Pesquisa] retomada: busca ${id} incerta de novo (${etapa.tentativas} tentativas); sem uma terceira busca.`);
              return { provider: null, results: [], errors: ['retomada: busca incerta interrompida de novo'] };
            }
            etapa.tentativas = (etapa.tentativas ?? 1) + 1;
            contadores.novasTentativas += 1;
            log('warn', `[Pesquisa] retomada: busca ${id} INCERTA (o pedido saiu e o resultado não foi registrado); nova tentativa controlada (${etapa.tentativas} de ${MAX_TENTATIVAS}), contada na cota uma vez.`);
          } else {
            etapa = { tipo: 'busca', tentativas: 1 };
            reg.etapas[id] = etapa;
          }
          // Fase 1: "enviando" NO DISCO antes de ir ao buscador. A cota por hora desta tentativa é contada pelo próprio buscador (takeUser).
          const antes = { reg: reg.estado, etapa: etapa.estado, existia };
          Object.assign(etapa, { estado: ESTADOS.RODANDO, boot, cotaEm: now(), cotaUsuario: o?.userId !== null && o?.userId !== undefined, inicio: now() });
          if (!semConteudo) etapa.consulta = hash(query, 12); // na privada, nem o hash da consulta vai para o disco
          delete etapa.resultado;
          reg.estado = ESTADOS.RODANDO;
          const marcou = salvar();
          if (!marcou) {
            // SEM A MARCA no disco (pública OU privada): um reinício depois NÃO conseguiria provar que nada (ou o que) saiu. Qualquer dúvida vale como "não enviar":
            // nada vai ao buscador (e nada é cobrado), a etapa volta ao que era e a Yui avisa que a pesquisa está temporariamente indisponível. Nunca se contorna
            // com a cota só em memória (revisão da Liz, §12).
            if (antes.existia) { if (antes.etapa === undefined) delete etapa.estado; else etapa.estado = antes.etapa; } else delete reg.etapas[id];
            reg.estado = antes.reg;
            desistiu = true;
            motivoDesistencia = 'sem-marca';
            contadores.buscasSemMarca += 1;
            if (semConteudo) contadores.privadasSemMarca += 1;
            log('warn', `[Pesquisa] retomada: não consegui gravar a marca de envio da busca ${id} de uma pesquisa ${semConteudo ? 'PRIVADA' : 'pública'}; por segurança NADA foi enviado ao buscador (sem a marca, um reinício não provaria o que saiu).`);
            return resultadoIndisponivel('registro-do-diario');
          }
          let found;
          try {
            found = await fn(query, o);
          } catch (err) {
            // A busca terminou com erro (sabemos que acabou): concluída sem resultado, para a retomada não repetir.
            found = { provider: null, results: [], errors: [`erro: ${clip(err?.code ?? err?.message ?? 'erro', 60)}`] };
          }
          const guardado = resultadoDeBusca(found);
          etapa.estado = ESTADOS.CONCLUIDA;
          etapa.fim = now();
          if (semConteudo) { etapa.cotaGasta = gastouCota(guardado); contadores.semConteudo += 1; } else etapa.resultado = guardado;
          if (!gastouCota(guardado)) etapa.cotaEm = null;
          else etapa.cotaGasta = true;
          salvar();
          return found;
        };
      },
      /** Envolve o LEITOR DE PÁGINAS: (url, opções) => texto|null. Página lida não é lida de novo na retomada. */
      pagina(fn) {
        return async (url, o = {}) => {
          // Na privada, a página vai pela ordem (nem o hash da URL vai para o disco); ela nunca é reaproveitada mesmo.
          const id = semConteudo ? `pagina:${(ordem.pagina = (ordem.pagina ?? 0) + 1)}` : `pagina:${hash(`${url}|${o?.maxChars ?? ''}`, 16)}`;
          const etapa = reg.etapas[id];
          if (etapa?.estado === ESTADOS.CONCLUIDA && etapa.resultado !== undefined) { contadores.paginasReaproveitadas += 1; return etapa.resultado; }
          reg.etapas[id] = { tipo: 'pagina', estado: ESTADOS.RODANDO, boot, inicio: now() };
          const text = await fn(url, o);
          const e = reg.etapas[id];
          e.estado = ESTADOS.CONCLUIDA;
          e.fim = now();
          if (!semConteudo) e.resultado = typeof text === 'string' ? text.slice(0, MAX_TEXTO) : null;
          salvar();
          return text;
        };
      },
      /** Envolve a SÍNTESE (uma chamada à IA): (args) => texto. Síntese pronta não roda de novo na retomada; pela metade, roda. */
      sintese(fn) {
        return async (...args) => {
          ordem.sintese = (ordem.sintese ?? 0) + 1;
          const id = `sintese:${ordem.sintese}`;
          const etapa = reg.etapas[id];
          if (etapa?.estado === ESTADOS.CONCLUIDA && etapa.resultado !== undefined) { contadores.sintesesReaproveitadas += 1; return etapa.resultado; }
          reg.etapas[id] = { tipo: 'sintese', estado: ESTADOS.RODANDO, boot, inicio: now() };
          salvar();
          const text = await fn(...args);
          const e = reg.etapas[id];
          e.estado = ESTADOS.CONCLUIDA;
          e.fim = now();
          if (!semConteudo) e.resultado = String(text ?? '').slice(0, MAX_TEXTO);
          salvar();
          return text;
        };
      },
      /**
       * Fim da pesquisa. Com `resultado` (a resposta pronta, devolvida a quem repetir a chave), o conteúdo das etapas sai e ficam só os estados.
       * Sem `resultado` (o passo da conversa), as etapas ficam (a repetição reaproveita a web sem buscar de novo) até vencerem.
       */
      concluir(resultado) {
        reg.estado = ESTADOS.CONCLUIDA;
        delete reg.interrompida;
        if (resultado !== undefined && !semConteudo) {
          reg.resultado = clone(resultado);
          for (const e of Object.values(reg.etapas)) delete e.resultado;
        }
        reg.concluidaEm = now();
        salvar();
      },
      /** Nada a retomar (o /yui que não pesquisou): o registro sai. */
      descartar() {
        mapa.delete(k);
        contadores.descartadas += 1;
        gravar(arquivo);
      },
    };
    return handle;
  }

  return {
    pasta,
    boot,
    abrir,
    /** Só números (saúde do cérebro e log): estados das pesquisas no diário e os contadores da retomada. */
    stats() {
      const porEstado = { pending: 0, running: 0, completed: 0, uncertain: 0 };
      let interrompidas = 0;
      for (const mapa of pessoas.values()) {
        for (const reg of mapa.values()) { porEstado[reg.estado] = (porEstado[reg.estado] ?? 0) + 1; if (reg.interrompida) interrompidas += 1; }
      }
      return {
        ligada: cfg.ligada, privadaSemConteudo: true, validadeMin: Math.round(cfg.validadeMs / 60_000), pessoas: pessoas.size, porEstado, interrompidas, ...contadores,
        gravacaoComFalha: ultimaGravacaoFalhou && now() - ultimaFalhaEm < 5 * 60_000,
      };
    },
    /** Para de gravar (desligamento; nos testes, simula o processo que morreu: nada mais vai ao disco). */
    fechar() { fechado = true; },
  };
}
