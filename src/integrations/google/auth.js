// O CLIENTE DA AUTORIZAÇÃO do Google (etapa 15): guarda o refresh token num arquivo, renova o access token (REST, sem biblioteca) e cuida da expiração.
//
//  - o refresh token vem do script de autorização (scripts/google-autorizar.mjs), feito UMA vez num PC com navegador; o access token vive só em memória (nunca em disco);
//  - cada renovação é UMA chamada, com prazo curto, sem repetir; várias chamadas ao mesmo tempo dividem a mesma renovação;
//  - falha de rede, de prazo ou do servidor do Google (5xx, 429): a integração diz "rede" e NÃO tenta de novo por 30 s (nada de martelar o Google);
//  - `invalid_grant` (a autorização expirou ou foi revogada; também `invalid_client` e `unauthorized_client`, que uma nova tentativa não resolve): a integração fica
//    "precisa autorizar de novo", o dono é avisado e a Yui PARA de tentar. A marca fica dentro do próprio arquivo (com a impressão do refresh token): um arquivo novo,
//    vindo de uma nova autorização, não tem a marca e volta a funcionar sozinho. O AVISO só conta como feito depois de CONFIRMADO (a DM saiu): `avisadoEm` no arquivo só é
//    gravado nessa hora, então reiniciar a Yui depois da confirmação não repete; uma DM que não saiu (Discord fora do ar, DM fechada, alertas ainda sem o cliente) é
//    reentregue no próximo uso, a cada 15 min no máximo, até ser confirmada (uma entrega por vez, nunca duas confirmadas);
//  - nada de token, segredo, corpo de resposta ou texto de erro do Google vai para o log, para o aviso ou para um erro: só códigos fixos.
import { alertOwnerConfirmado } from '../../core/alerts.js';
import { logger as loggerPadrao } from '../../utils/logger.js';
import { hostsDoGoogle, temEscopo } from './endpoints.js';
import { arquivoDoToken, googleLigado, PRAZO_DA_CHAMADA_MS } from './config.js';
import { lerArquivoDeToken, gravarArquivoDeToken, impressaoDoToken } from './arquivoToken.js';
import { pedirJson } from './http.js';
import { formulario, trocarCodigoPorTokens } from './troca.js';

// A troca do código de autorização pelos tokens (usada pelo script de autorização) vive em troca.js, que não carrega o log nem os alertas; aqui só se reexporta.
export { trocarCodigoPorTokens };

/** Os códigos de erro do Google que dizem "esta autorização não serve mais": tentar de novo não resolve. */
export const CODIGOS_DE_AUTORIZACAO_PERDIDA = Object.freeze(['invalid_grant', 'invalid_client', 'unauthorized_client']);
/** Depois de uma falha transitória, quanto tempo sem tentar de novo. */
export const ESPERA_APOS_FALHA_MS = 30_000;
const MARGEM_DO_TOKEN_MS = 60_000;
const VALIDADE_MAXIMA_S = 3600;
/**
 * A reentrega do aviso: enquanto a DM não for CONFIRMADA, tenta de novo no próximo uso depois deste intervalo. O intervalo do alerter para esta chave é MENOR
 * (ele o consome antes do envio, mesmo que a DM falhe), para não bloquear a reentrega.
 */
export const INTERVALO_DA_REENTREGA_MIN = 15;
const INTERVALO_DO_ALERTER_MIN = 10;

export const TEXTO_DO_AVISO = 'O Google recusou a autorização guardada (ela expirou ou foi revogada), então parei de ler a agenda e as tarefas. Para voltar: rode `node scripts/google-autorizar.mjs --cliente <arquivo do cliente>` no PC com navegador, copie o novo arquivo de token para o servidor (YUI_GOOGLE_TOKEN_ARQUIVO) e reinicie a Yui.';

/**
 * O autenticador do processo. Tudo injetável para teste.
 * @param {{ env?: object, fetchImpl?: Function, hosts?: () => object, agora?: () => number, alertar?: Function, log?: object, timeoutMs?: number, restringir?: Function }} [deps]
 */
export function criarAutenticador(deps = {}) {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? ((...a) => globalThis.fetch(...a));
  const hosts = deps.hosts ?? hostsDoGoogle;
  const agora = deps.agora ?? Date.now;
  // O alerter devolve (ou resolve para) `true` SÓ quando a DM saiu; qualquer outra coisa conta como "não entregue".
  const alertar = deps.alertar ?? ((...a) => alertOwnerConfirmado(...a));
  const log = deps.log ?? loggerPadrao;
  const timeoutMs = deps.timeoutMs ?? PRAZO_DA_CHAMADA_MS;
  const gravar = (file, dados) => gravarArquivoDeToken(file, dados, deps.restringir ? { restringir: deps.restringir } : undefined);

  let cache = null; // { impressao, token, expiraEm }
  let falhaTransitoria = null; // { impressao, ate }
  let perdidaEmMemoria = null; // impressao da autorização que o Google recusou (vale mesmo se o arquivo não puder ser regravado)
  let emVoo = null;
  let avisoEmVoo = null; // a entrega do aviso de "autorizar de novo" em andamento (uma só por vez)
  let avisoConfirmado = null; // impressão da autorização cujo aviso já foi CONFIRMADO neste processo (vale mesmo se o arquivo não puder ser regravado)
  let proximaEntrega = { impressao: null, ate: 0 }; // a reentrega do aviso só é adiada para a MESMA autorização
  const contadores = { renovacoes: 0, falhasDeRede: 0, autorizacaoPerdida: 0, avisos: 0, tentativasDeAviso: 0 };
  let ultimaRenovacaoEm = null;

  function aviso(texto) {
    try { log.warn?.(texto); } catch { /* o log nunca derruba a chamada */ }
  }

  /** O Google recusou a autorização: marca (memória e arquivo, ainda SEM o aviso confirmado), para de tentar e começa a entregar o aviso ao dono. */
  function marcarPerdida(file, dados, impressao, codigo) {
    perdidaEmMemoria = impressao;
    cache = null;
    contadores.autorizacaoPerdida += 1;
    const marca = dados.invalido?.impressao === impressao ? dados.invalido : { em: new Date(agora()).toISOString(), avisadoEm: null, impressao };
    if (marca !== dados.invalido) {
      try {
        gravar(file, { ...dados, invalido: marca });
      } catch (err) {
        aviso(`[Google] não consegui gravar a marca de "autorizar de novo" no arquivo (${String(err?.message ?? err).slice(0, 80)}); fica só em memória até reiniciar.`);
      }
    }
    aviso(`[Google] o Google recusou a autorização guardada (${codigo}): parei de tentar até haver uma autorização nova.`);
    garantirAviso(file, { ...dados, invalido: marca }, impressao);
  }

  /**
   * Garante que o dono recebe UM aviso de "autorizar de novo": se já foi confirmado (neste processo ou no arquivo), não faz nada; senão tenta entregar (uma entrega por vez,
   * no máximo a cada INTERVALO_DA_REENTREGA_MIN) e só grava `avisadoEm` no arquivo quando o alerter CONFIRMA (`true`). Nunca bloqueia quem pediu o token.
   */
  function garantirAviso(file, dados, impressao) {
    if (avisoEmVoo || avisoConfirmado === impressao) return;
    if (dados.invalido?.impressao === impressao && dados.invalido.avisadoEm) { avisoConfirmado = impressao; return; }
    if (proximaEntrega.impressao === impressao && agora() < proximaEntrega.ate) return;
    proximaEntrega = { impressao, ate: agora() + INTERVALO_DA_REENTREGA_MIN * 60_000 };
    contadores.tentativasDeAviso += 1;
    avisoEmVoo = (async () => {
      let entregue = false;
      try { entregue = (await alertar('google-reautorizar', 'Preciso que você autorize o Google de novo', TEXTO_DO_AVISO, { level: 'warn', cooldownMinutes: INTERVALO_DO_ALERTER_MIN })) === true; } catch { entregue = false; }
      if (!entregue) { aviso(`[Google] o aviso de "autorizar de novo" não saiu; tento de novo no próximo uso, depois de ${INTERVALO_DA_REENTREGA_MIN} min.`); return; }
      avisoConfirmado = impressao;
      contadores.avisos += 1;
      // Anota no arquivo que o aviso foi confirmado (lê de novo: se uma autorização NOVA já trocou o arquivo nesse meio tempo, não se mexe nele).
      try {
        const atual = lerArquivoDeToken(file);
        if (atual.ok && impressaoDoToken(atual.dados.refresh_token) === impressao) {
          const agoraIso = new Date(agora()).toISOString();
          gravar(file, { ...atual.dados, invalido: { em: atual.dados.invalido?.impressao === impressao ? atual.dados.invalido.em : agoraIso, avisadoEm: agoraIso, impressao } });
        }
      } catch (err) {
        aviso(`[Google] não consegui anotar no arquivo que o aviso foi entregue (${String(err?.message ?? err).slice(0, 80)}); fica só em memória até reiniciar.`);
      }
    })().finally(() => { avisoEmVoo = null; });
  }

  async function renovar(file, dados, impressao) {
    const r = await pedirJson(hosts().token, {
      metodo: 'POST', fetchImpl, timeoutMs,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      corpo: formulario({ client_id: dados.client_id, client_secret: dados.client_secret, refresh_token: dados.refresh_token, grant_type: 'refresh_token' }),
    });
    if (!r.ok) {
      if (r.status >= 400 && r.status < 500 && r.status !== 429 && CODIGOS_DE_AUTORIZACAO_PERDIDA.includes(r.erro)) {
        marcarPerdida(file, dados, impressao, r.erro);
        return { ok: false, motivo: 'precisa-autorizar' };
      }
      contadores.falhasDeRede += 1;
      falhaTransitoria = { impressao, ate: agora() + ESPERA_APOS_FALHA_MS };
      aviso(`[Google] não consegui renovar o acesso agora (${r.motivo}${r.status ? ` ${r.status}` : ''}); tento de novo em ${Math.round(ESPERA_APOS_FALHA_MS / 1000)} s.`);
      return { ok: false, motivo: 'rede' };
    }
    const token = typeof r.json.access_token === 'string' ? r.json.access_token : '';
    if (!token || token.length > 4096 || /\s/.test(token)) {
      contadores.falhasDeRede += 1;
      falhaTransitoria = { impressao, ate: agora() + ESPERA_APOS_FALHA_MS };
      aviso('[Google] a resposta da renovação veio sem um token utilizável.');
      return { ok: false, motivo: 'erro' };
    }
    const validadeS = Math.min(VALIDADE_MAXIMA_S, Math.max(60, Number(r.json.expires_in) || VALIDADE_MAXIMA_S));
    cache = { impressao, token, expiraEm: agora() + validadeS * 1000 };
    falhaTransitoria = null;
    contadores.renovacoes += 1;
    ultimaRenovacaoEm = agora();
    // O Google quase nunca troca o refresh token; se trocar, o arquivo acompanha (atômico e restrito).
    if (typeof r.json.refresh_token === 'string' && r.json.refresh_token && r.json.refresh_token !== dados.refresh_token) {
      try { gravar(file, { ...dados, refresh_token: r.json.refresh_token, invalido: null }); cache.impressao = impressaoDoToken(r.json.refresh_token); } catch { /* o antigo continua valendo */ }
    }
    return { ok: true, token, escopos: dados.escopos };
  }

  return {
    /**
     * O access token de agora. { ok: true, token, escopos } ou { ok: false, motivo }:
     * 'desligado' | 'nao-conectado' (sem arquivo) | 'arquivo-invalido' | 'precisa-autorizar' | 'rede' | 'erro'.
     * @param {{ recurso?: 'agenda'|'tarefas'|'gmail' }} [o]  se a autorização guardada não tem o escopo do recurso: 'precisa-autorizar' (sem chamar o Google)
     */
    async obterToken({ recurso = null } = {}) {
      if (!googleLigado(env)) return { ok: false, motivo: 'desligado' };
      const file = arquivoDoToken(env);
      const lido = lerArquivoDeToken(file);
      if (!lido.ok) return { ok: false, motivo: lido.motivo === 'ausente' ? 'nao-conectado' : 'arquivo-invalido' };
      const dados = lido.dados;
      const impressao = impressaoDoToken(dados.refresh_token);
      if (recurso && !temEscopo(dados.escopos, recurso)) return { ok: false, motivo: 'precisa-autorizar' };
      if (perdidaEmMemoria === impressao || dados.invalido?.impressao === impressao) {
        garantirAviso(file, dados, impressao); // a DM ainda não foi confirmada? tenta de novo (a cada 15 min no máximo); confirmada: não faz nada
        return { ok: false, motivo: 'precisa-autorizar' };
      }
      if (cache && cache.impressao === impressao && cache.expiraEm - agora() > MARGEM_DO_TOKEN_MS) return { ok: true, token: cache.token, escopos: dados.escopos };
      if (falhaTransitoria && falhaTransitoria.impressao === impressao && agora() < falhaTransitoria.ate) return { ok: false, motivo: 'rede' };
      if (!emVoo) {
        emVoo = renovar(file, dados, impressao).catch(() => ({ ok: false, motivo: 'erro' })).finally(() => { emVoo = null; });
      }
      return emVoo;
    },
    /** Espera a entrega do aviso de "autorizar de novo" que estiver em andamento (para teste; a chamada normal nunca espera por ela). */
    async aguardarAviso() { try { await avisoEmVoo; } catch { /* */ } },
    /** O Google recusou o access token (401): descarta o que está em memória para a próxima chamada renovar. */
    descartarToken() { cache = null; },
    /** O estado para diagnóstico (nunca leva token, segredo nem o conteúdo do arquivo). */
    estado() {
      const lido = googleLigado(env) ? lerArquivoDeToken(arquivoDoToken(env)) : null;
      const impressao = lido?.ok ? impressaoDoToken(lido.dados.refresh_token) : null;
      return {
        ligado: googleLigado(env),
        arquivo: !lido ? null : lido.ok ? 'ok' : lido.motivo,
        escopos: lido?.ok ? lido.dados.escopos : null,
        precisaAutorizar: Boolean(lido?.ok && (perdidaEmMemoria === impressao || lido.dados.invalido?.impressao === impressao)),
        avisoPendente: Boolean(lido?.ok && (perdidaEmMemoria === impressao || lido.dados.invalido?.impressao === impressao) && avisoConfirmado !== impressao && !(lido.dados.invalido?.impressao === impressao && lido.dados.invalido.avisadoEm)),
        ultimaRenovacaoEm: ultimaRenovacaoEm ? new Date(ultimaRenovacaoEm).toISOString() : null,
        ...contadores,
      };
    },
  };
}
