// REAUTORIZAR O GOOGLE PELO PAINEL (lacunas do painel, entrega F, item 14, 27/11/2026; docs/DESENHO_PAINEL_APROVACAO_E_GOOGLE.md, seção 2). Roda no processo que
// serve a API (o cérebro, com os dois processos; o processo único, sem eles), o mesmo que lê o arquivo da autorização. O bot nunca faz isto.
//
// O fluxo é o do script (scripts/google-autorizar.mjs: cliente "App para computador", PKCE S256 e `state`), com o endereço do retorno COLADO de volta:
//  1. iniciar: só com um arquivo de autorização que já existe e abre (a primeira vez continua pelo script). Lê dele o client_id, gera o PKCE (o verificador fica
//     SÓ na memória deste processo) e um `state` aleatório, fixa o retorno em http://127.0.0.1:PORTA_DO_RETORNO e devolve SÓ o link de consentimento;
//  2. o dono abre o link no aparelho dele e autoriza; o navegador vai para 127.0.0.1 (a página não abre, o que é esperado) e ele copia o endereço inteiro;
//  3. concluir: recebe esse endereço e APAGA a sessão na hora (uso único: a primeira tentativa, certa ou errada, a consome); confere protocolo, host, porta e
//     caminho, o `state` em tempo constante e a validade (10 min); troca o código com o verificador (troca.js); confere os escopos; e grava o arquivo pelo
//     caminho atômico e restrito de sempre (arquivoToken.js). O arquivo novo não tem a marca de "precisa autorizar": a integração (auth.js) volta sozinha.
// Regras:
//  - escopos: só Agenda e Tarefas, somente leitura. O GMAIL NUNCA entra por aqui: nem é pedido, nem é gravado (mesmo que o Google o devolva por uma autorização
//    antiga). Se o arquivo atual tinha o Gmail, a resposta avisa que ele fica para o script;
//  - uma sessão por vez (um novo início descarta a anterior), só para quem a iniciou, por 10 minutos;
//  - 5 inícios por hora (e cada início permite um retorno só);
//  - NADA sai daqui além do link, de datas, de nomes curtos (agenda, tarefas) e de códigos fixos: nem token, nem client_secret, nem o código, nem o verificador,
//    nem o `state` (fora do próprio link), nem o corpo de resposta do Google. Nenhuma falha é lançada com conteúdo: tudo vira um código fixo.
import crypto from 'node:crypto';
import { hostsDoGoogle, ESCOPOS, ESCOPOS_ACEITOS, temEscopo } from './endpoints.js';
import { arquivoDoToken, PRAZO_DA_CHAMADA_MS } from './config.js';
import { lerArquivoDeToken, gravarArquivoDeToken } from './arquivoToken.js';
import { trocarCodigoPorTokens } from './troca.js';
import { criarPkce, montarUrlDeConsentimento, iguaisEmTempoConstante, CODIGO_DE_AUTORIZACAO_RE } from './consentimento.js';

/** A porta FIXA do retorno (documentada em docs/content_pt/GOOGLE.md). Nada escuta nela: o navegador mostra "não foi possível conectar" e o dono copia o endereço. */
export const PORTA_DO_RETORNO = 47615;
export const ENDERECO_DO_RETORNO = `http://127.0.0.1:${PORTA_DO_RETORNO}`;
/** Quanto tempo uma sessão de reautorização vale. */
export const VALIDADE_DA_SESSAO_MS = 10 * 60_000;
/** Quantos inícios por hora (cada um permite um retorno só). */
export const LIMITE_DE_INICIOS = Object.freeze({ max: 5, janelaMs: 60 * 60_000 });
/** Os escopos pedidos pelo painel: Agenda e Tarefas, somente leitura. Nunca o Gmail. */
export const ESCOPOS_DO_PAINEL = Object.freeze([ESCOPOS.agenda, ESCOPOS.tarefas]);
const ACEITOS_PELO_PAINEL = Object.freeze([...ESCOPOS_ACEITOS.agenda, ...ESCOPOS_ACEITOS.tarefas]);
/** Em modo "Testando" do console do Google a autorização vence 7 dias depois de feita (a mesma regra do GET /v1/admin/google). */
const VALIDADE_TESTANDO_MS = 7 * 86_400_000;
const MAX_ENDERECO = 4096;

/** As frases de cada código fixo de falha (a tela mostra esta frase; a auditoria guarda só o código). */
export const TEXTOS_DAS_FALHAS = Object.freeze({
  'sem-arquivo': 'Ainda não há autorização do Google neste servidor. A primeira vez é pelo script, num PC com navegador: node scripts/google-autorizar.mjs.',
  'arquivo-invalido': 'O arquivo da autorização do Google não abriu. Faça a autorização pelo script, num PC com navegador: node scripts/google-autorizar.mjs.',
  'sem-sessao': 'Não há uma reautorização em andamento (ou ela já foi usada). Clique em "Reautorizar o Google" de novo.',
  'sessao-vencida': 'A reautorização passou dos 10 minutos. Clique em "Reautorizar o Google" de novo.',
  'endereco-invalido': `Esse não é o endereço do retorno (${ENDERECO_DO_RETORNO}/?...). Comece de novo e cole o endereço inteiro da página que não abriu.`,
  'state-diferente': 'Esse endereço é de outra autorização. Comece de novo e use o link novo.',
  negado: 'O Google informou que a autorização não foi concluída. Comece de novo e autorize.',
  'sem-codigo': 'O endereço veio sem o código do Google. Comece de novo e cole o endereço inteiro.',
  'arquivo-mudou': 'O arquivo da autorização mudou durante a reautorização. Comece de novo.',
  rede: 'Não consegui falar com o Google agora. Comece de novo daqui a pouco.',
  'troca-recusada': 'O Google recusou o código (ele vale uma vez só e por poucos minutos). Comece de novo.',
  'sem-refresh': 'O Google não devolveu a autorização de longo prazo. Remova o acesso do app em myaccount.google.com/permissions e comece de novo.',
  'sem-escopo': 'O Google não concedeu nem a Agenda nem as Tarefas (as caixas ficaram desmarcadas). Nada foi trocado: comece de novo e marque as caixas.',
  'gravacao-falhou': 'Não consegui gravar o arquivo da autorização no servidor. Nada foi trocado.',
  limite: 'Muitas tentativas de reautorizar o Google nesta hora (o limite é 5). Espere e tente de novo.',
  erro: 'Algo deu errado na reautorização. Comece de novo.',
});
export const CODIGOS_DE_FALHA = Object.freeze(Object.keys(TEXTOS_DAS_FALHAS));

/** Uma impressão curta (para comparar "o mesmo cliente" sem guardar o valor). */
const impressao = (texto) => crypto.createHash('sha256').update(String(texto ?? '')).digest('hex').slice(0, 12);
/** O arquivo atual tem o Gmail? (só para avisar que ele fica para o script; `escopos` ausente = não dá para saber = não avisa) */
const temGmail = (escopos) => Array.isArray(escopos) && escopos.some((e) => ESCOPOS_ACEITOS.gmail.includes(String(e)));

/**
 * O endereço colado pelo dono -> { state, code, error } (cada um null se ausente), ou null se não for o endereço do retorno: http (ou sem o protocolo, começando
 * por 127.0.0.1:), host 127.0.0.1, a porta fixa, o caminho "/", sem usuário nem senha, sem espaço nem caractere de controle, e cada parâmetro no máximo uma vez.
 */
export function lerEnderecoColado(texto) {
  if (typeof texto !== 'string') return null;
  let s = texto.trim();
  if (!s || s.length > MAX_ENDERECO || /[\s\u0000-\u001f\u007f-\u009f]/.test(s)) return null;
  if (/^127\.0\.0\.1:/.test(s)) s = `http://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.port !== String(PORTA_DO_RETORNO) || u.pathname !== '/' || u.username || u.password) return null;
  const um = (nome) => { const v = u.searchParams.getAll(nome); return v.length === 0 ? null : v.length === 1 ? v[0] : undefined; };
  const state = um('state'); const code = um('code'); const error = um('error');
  if (state === undefined || code === undefined || error === undefined) return null;
  return { state, code, error };
}

/**
 * A reautorização do processo. Tudo injetável para teste.
 * @param {{ env?: object, agora?: () => number, hosts?: () => object, fetchImpl?: Function, restringir?: (arquivo: string) => void, timeoutMs?: number }} [deps]
 */
export function criarReautorizacao(deps = {}) {
  const env = deps.env ?? process.env;
  const agora = deps.agora ?? Date.now;
  const hosts = deps.hosts ?? hostsDoGoogle;
  const fetchImpl = deps.fetchImpl ?? ((...a) => globalThis.fetch(...a));
  const timeoutMs = deps.timeoutMs ?? PRAZO_DA_CHAMADA_MS;
  const opcoesDeGravacao = typeof deps.restringir === 'function' ? { restringir: deps.restringir } : undefined;
  let sessao = null; // { userId, state, verificador, expiraEm, arquivo, cliente, gmail }: SÓ em memória
  const inicios = [];
  const falha = (codigo) => ({ ok: false, codigo: CODIGOS_DE_FALHA.includes(codigo) ? codigo : 'erro' });

  function passouDoLimite() {
    const t = agora();
    while (inicios.length && t - inicios[0] >= LIMITE_DE_INICIOS.janelaMs) inicios.shift();
    if (inicios.length >= LIMITE_DE_INICIOS.max) return true;
    inicios.push(t);
    return false;
  }

  return {
    /**
     * Começa uma reautorização (descarta a anterior). { ok: true, link, expiraEm, gmailFicaNoScript } ou { ok: false, codigo: 'sem-arquivo' | 'arquivo-invalido' | 'limite' }.
     * O limite conta só o início que cria uma sessão.
     */
    iniciar({ userId } = {}) {
      const arquivo = arquivoDoToken(env);
      const lido = lerArquivoDeToken(arquivo);
      if (!lido.ok) return falha(lido.motivo === 'ausente' ? 'sem-arquivo' : 'arquivo-invalido');
      if (passouDoLimite()) return falha('limite');
      const pkce = criarPkce();
      const state = crypto.randomBytes(24).toString('hex');
      sessao = {
        userId: String(userId ?? ''), state, verificador: pkce.verificador, expiraEm: agora() + VALIDADE_DA_SESSAO_MS,
        arquivo, cliente: impressao(lido.dados.client_id), gmail: temGmail(lido.dados.escopos),
      };
      const link = montarUrlDeConsentimento({ hosts: hosts(), clientId: lido.dados.client_id, redirectUri: ENDERECO_DO_RETORNO, escopos: [...ESCOPOS_DO_PAINEL], desafio: pkce.desafio, state });
      return { ok: true, link, expiraEm: new Date(sessao.expiraEm).toISOString(), gmailFicaNoScript: sessao.gmail };
    },

    /**
     * Conclui com o endereço colado. A sessão é apagada ANTES de qualquer conferência (uso único, certa ou errada).
     * { ok: true, venceEm, escopos: ['agenda'|'tarefas'], faltam: [...], gmailFicaNoScript } ou { ok: false, codigo } (um de CODIGOS_DE_FALHA).
     */
    async concluir({ userId, endereco } = {}) {
      const s = sessao;
      sessao = null;
      if (!s || s.userId !== String(userId ?? '')) return falha('sem-sessao');
      if (agora() >= s.expiraEm) return falha('sessao-vencida');
      const lido = lerEnderecoColado(endereco);
      if (!lido) return falha('endereco-invalido');
      if (!iguaisEmTempoConstante(lido.state ?? '', s.state)) return falha('state-diferente');
      if (lido.error) return falha('negado');
      if (!lido.code || !CODIGO_DE_AUTORIZACAO_RE.test(lido.code)) return falha('sem-codigo');
      const atual = lerArquivoDeToken(s.arquivo);
      if (!atual.ok) return falha(atual.motivo === 'ausente' ? 'sem-arquivo' : 'arquivo-invalido');
      if (impressao(atual.dados.client_id) !== s.cliente) return falha('arquivo-mudou');
      let t;
      try {
        t = await trocarCodigoPorTokens({
          hosts: hosts(), fetchImpl, timeoutMs, clientId: atual.dados.client_id, clientSecret: atual.dados.client_secret,
          codigo: lido.code, verificador: s.verificador, redirectUri: ENDERECO_DO_RETORNO,
        });
      } catch {
        return falha('rede');
      }
      if (!t?.ok) return falha(t?.motivo === 'rede' || t?.motivo === 'tempo' ? 'rede' : 'troca-recusada');
      if (!t.refreshToken) return falha('sem-refresh');
      // Só Agenda e Tarefas vão para o arquivo (o Gmail e qualquer outro escopo que o Google devolva por uma autorização antiga ficam de fora).
      const concedidos = [...new Set((Array.isArray(t.escopos) ? t.escopos : []).filter((e) => ACEITOS_PELO_PAINEL.includes(e)))];
      const faltam = ['agenda', 'tarefas'].filter((r) => !temEscopo(concedidos, r));
      if (faltam.length === 2) return falha('sem-escopo');
      const criadoEm = new Date(agora()).toISOString();
      try {
        gravarArquivoDeToken(s.arquivo, {
          client_id: atual.dados.client_id, client_secret: atual.dados.client_secret, refresh_token: t.refreshToken, escopos: concedidos, criadoEm,
        }, opcoesDeGravacao);
      } catch {
        return falha('gravacao-falhou');
      }
      return {
        ok: true, venceEm: new Date(Date.parse(criadoEm) + VALIDADE_TESTANDO_MS).toISOString(),
        escopos: ['agenda', 'tarefas'].filter((r) => !faltam.includes(r)), faltam, gmailFicaNoScript: s.gmail,
      };
    },

    /** Descarta a sessão em andamento (a chave foi desligada). */
    descartar() { sessao = null; },
    /** Há uma sessão em andamento? (só para teste e diagnóstico; nada da sessão sai daqui) */
    emAndamento() { return Boolean(sessao) && agora() < sessao.expiraEm; },
  };
}
