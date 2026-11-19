// O CLIENTE DA AUTORIZAÇÃO do Google (etapa 15): guarda o refresh token num arquivo, renova o access token (REST, sem biblioteca) e cuida da expiração.
//
//  - o refresh token vem do script de autorização (scripts/google-autorizar.mjs), feito UMA vez num PC com navegador; o access token vive só em memória (nunca em disco);
//  - cada renovação é UMA chamada, com prazo curto, sem repetir; várias chamadas ao mesmo tempo dividem a mesma renovação;
//  - falha de rede, de prazo ou do servidor do Google (5xx, 429): a integração diz "rede" e NÃO tenta de novo por 30 s (nada de martelar o Google);
//  - `invalid_grant` (a autorização expirou ou foi revogada; também `invalid_client` e `unauthorized_client`, que uma nova tentativa não resolve): a integração fica
//    "precisa autorizar de novo", o dono é avisado UMA vez (o alerter existente, com intervalo longo) e a Yui PARA de tentar. A marca fica dentro do próprio arquivo
//    (com a impressão do refresh token): um arquivo novo, vindo de uma nova autorização, não tem a marca e volta a funcionar sozinho; reiniciar a Yui não repete o aviso;
//  - nada de token, segredo, corpo de resposta ou texto de erro do Google vai para o log, para o aviso ou para um erro: só códigos fixos.
import { alertOwner } from '../../core/alerts.js';
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
/** O aviso ao dono: no máximo um por dia (o motivo de parar de tentar já garante uma vez só por autorização). */
const INTERVALO_DO_AVISO_MIN = 24 * 60;

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
  const alertar = deps.alertar ?? ((...a) => alertOwner(...a));
  const log = deps.log ?? loggerPadrao;
  const timeoutMs = deps.timeoutMs ?? PRAZO_DA_CHAMADA_MS;
  const gravar = (file, dados) => gravarArquivoDeToken(file, dados, deps.restringir ? { restringir: deps.restringir } : undefined);

  let cache = null; // { impressao, token, expiraEm }
  let falhaTransitoria = null; // { impressao, ate }
  let perdidaEmMemoria = null; // impressao da autorização que o Google recusou (vale mesmo se o arquivo não puder ser regravado)
  let emVoo = null;
  const contadores = { renovacoes: 0, falhasDeRede: 0, autorizacaoPerdida: 0, avisos: 0 };
  let ultimaRenovacaoEm = null;

  function aviso(texto) {
    try { log.warn?.(texto); } catch { /* o log nunca derruba a chamada */ }
  }

  /** O Google recusou a autorização: marca (memória e arquivo), avisa o dono UMA vez e para de tentar. */
  function marcarPerdida(file, dados, impressao, codigo) {
    perdidaEmMemoria = impressao;
    cache = null;
    contadores.autorizacaoPerdida += 1;
    const jaAvisado = Boolean(dados.invalido?.avisadoEm) && dados.invalido?.impressao === impressao;
    const agoraIso = new Date(agora()).toISOString();
    try {
      gravar(file, { ...dados, invalido: { em: agoraIso, avisadoEm: agoraIso, impressao } });
    } catch (err) {
      aviso(`[Google] não consegui gravar a marca de "autorizar de novo" no arquivo (${String(err?.message ?? err).slice(0, 80)}); fica só em memória até reiniciar.`);
    }
    aviso(`[Google] o Google recusou a autorização guardada (${codigo}): parei de tentar até haver uma autorização nova.`);
    if (!jaAvisado) {
      contadores.avisos += 1;
      try { alertar('google-reautorizar', 'Preciso que você autorize o Google de novo', TEXTO_DO_AVISO, { level: 'warn', cooldownMinutes: INTERVALO_DO_AVISO_MIN }); } catch { /* */ }
    }
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
      if (perdidaEmMemoria === impressao || dados.invalido?.impressao === impressao) return { ok: false, motivo: 'precisa-autorizar' };
      if (cache && cache.impressao === impressao && cache.expiraEm - agora() > MARGEM_DO_TOKEN_MS) return { ok: true, token: cache.token, escopos: dados.escopos };
      if (falhaTransitoria && falhaTransitoria.impressao === impressao && agora() < falhaTransitoria.ate) return { ok: false, motivo: 'rede' };
      if (!emVoo) {
        emVoo = renovar(file, dados, impressao).catch(() => ({ ok: false, motivo: 'erro' })).finally(() => { emVoo = null; });
      }
      return emVoo;
    },
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
        ultimaRenovacaoEm: ultimaRenovacaoEm ? new Date(ultimaRenovacaoEm).toISOString() : null,
        ...contadores,
      };
    },
  };
}
