// LEITURAS DO PAINEL (lacunas do painel, entrega B, 26/11/2026; docs/PLANO_LACUNAS_PAINEL.md itens 3, 4 e 5): SÓ LEITURA, SÓ O DONO.
//   GET /v1/admin/live     a live do YouTube (src/core/live/servico.js -> painel())
//   GET /v1/admin/google   a autorização do Google (src/integrations/google/auth.js -> estado())
//   GET /v1/admin/planos   os planos com aprovação (src/core/planos/store.js)
//   GET /v1/admin/avisos   a fila de avisos (src/core/avisos/fila.js) e o que o modo observar registrou (src/core/avisos/observar.js)
//
// Entrega D (27/11/2026; itens 9 v1 e 12), também só do dono:
//   GET /v1/admin/gta            o último diário, o último semanal válido, a última notícia, onde cada um saiu e o estado das fontes (LIDO NO BOT)
//   GET /v1/admin/listas         as listas pessoais do dono (src/handlers/listStore.js: lerListasDoUsuario)
//   GET /v1/admin/skills         o catálogo das skills e quais estão permitidas (src/core/skills/carregador.js: carregarCatalogo)
//   GET /v1/admin/continuidade   os projetos e decisões do dono (src/core/continuidade.js); o DELETE de um item fica no admin.js
//
// ONDE O DADO É LIDO: no processo que serve a API, que é o mesmo que roda a live, o Google, os planos e a fila (o cérebro, com os dois processos; o processo
// único, sem eles). O bot separado não serve a API: ele só devolve, pelo canal, o que o modo observar registrou nele e o GTA, cujos bancos são dele
// (src/discord/gtaPainel.js; src/cerebro/painel.js limpa de novo a vista que chega).
//
// SEGURANÇA: cada "vista" abaixo monta a resposta com uma LISTA FECHADA de campos, números, datas e palavras fixas, e corta o que não reconhece. Mesmo que
// a fonte traga um segredo (token, client_id, client_secret, código, corpo de resposta, texto do chat, nome de quem escreveu, argumentos ou resultados de um
// plano, texto de um aviso), ele não tem por onde sair. Os testes (tests/test-painel-leituras.js) envenenam as fontes e conferem a resposta inteira.
import { CLASSES, TABELA, PREFIXOS } from '../avisos/regras.js';

const DIA_MS = 86_400_000;
/** Em modo "Testando" do console do Google a autorização vence 7 dias depois de feita (docs/content_pt/GOOGLE.md). */
export const VALIDADE_TESTANDO_MS = 7 * DIA_MS;
export const MAX_PLANOS = 20;
const MAX_PASSOS = 10;
const MAX_FILA = 50;
const MAX_OBSERVADOS = 30;

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const inteiro = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0; };
const umDe = (v, lista, padrao = null) => (typeof v === 'string' && lista.includes(v) ? v : padrao);
/** Data (ms ou texto ISO) -> ISO, ou null. */
export function dataIso(v) {
  const t = typeof v === 'number' ? v : typeof v === 'string' && v.length <= 40 ? Date.parse(v) : NaN;
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null;
}
/** Texto de fora numa linha só, sem caracteres de controle, cortado. */
export function linhaCurta(v, max) {
  if (typeof v !== 'string') return '';
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
const codigoFixo = (v) => (typeof v === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(v) ? v : null);

// ── Live do YouTube ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const ESTADOS_DA_LIVE = Object.freeze(['desligado', 'ociosa', 'procurando', 'ouvindo', 'encerrada', 'interrompida']);
export const NIVEIS_DA_COTA = Object.freeze(['ok', 'atencao', 'critico', 'esgotada']);

/**
 * A vista da live. `bruto` é o painel() do serviço (ou null, sem serviço neste processo). `disponivel: false` = a chave está ligada mas o serviço não subiu.
 * Só id do vídeo, título curto (80), datas, contadores, cota e o código do último erro.
 */
export function vistaDaLive(bruto, { ligado = false } = {}) {
  const b = obj(bruto);
  const disponivel = Boolean(bruto && typeof bruto === 'object');
  const estado = umDe(b.estado, ESTADOS_DA_LIVE, ligado ? 'ociosa' : 'desligado');
  const ativo = b.ativo === true && (estado === 'procurando' || estado === 'ouvindo');
  const videoId = ativo && typeof b.videoId === 'string' && /^[A-Za-z0-9_-]{6,20}$/.test(b.videoId) ? b.videoId : null;
  const m = b.mensagens && typeof b.mensagens === 'object' ? b.mensagens : null;
  const c = b.cota && typeof b.cota === 'object' ? b.cota : null;
  const erro = b.ultimoErro && typeof b.ultimoErro === 'object' ? b.ultimoErro : null;
  return {
    ligado: ligado === true,
    disponivel: ligado === true && disponivel,
    estado,
    ativo,
    live: ativo ? { videoId, titulo: linhaCurta(b.titulo, 80) || null } : null,
    desde: ativo ? dataIso(b.desde) : null,
    mensagens: m ? { lidas: inteiro(m.lidas), respondidas: inteiro(m.respondidas), espontaneas: inteiro(m.espontaneas) } : null,
    cota: c ? {
      dia: typeof c.dia === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.dia) ? c.dia : null,
      usado: inteiro(c.usado), limiteDiario: inteiro(c.limiteDiario), reserva: inteiro(c.reserva), restante: inteiro(c.restante), nivel: umDe(c.nivel, NIVEIS_DA_COTA, 'ok'),
    } : null,
    ultimoErro: erro && codigoFixo(erro.codigo) ? { codigo: codigoFixo(erro.codigo), em: dataIso(erro.em) } : null,
  };
}

// ── Google ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const ESCOPOS_CURTOS = Object.freeze([['agenda', /\/auth\/calendar(\.|$)/], ['tarefas', /\/auth\/tasks(\.|$)/], ['gmail', /\/auth\/gmail(\.|$)/]]);
/** O nome curto de um escopo do Google: agenda, tarefas, gmail ou outro (nunca o identificador inteiro). */
export function nomeDoEscopo(escopo) {
  const e = String(escopo ?? '');
  return ESCOPOS_CURTOS.find(([, re]) => re.test(e))?.[0] ?? 'outro';
}
const ARQUIVO_DO_TOKEN = Object.freeze(['ok', 'ausente', 'ilegivel', 'invalido']);
const FALHAS_DO_GOOGLE = Object.freeze(['rede', 'erro', 'precisa-autorizar']);

/**
 * A vista do Google. `bruto` é o estado() da integração (o do autenticador mais os contadores). Só ligado, se há autorização, os escopos em nome curto,
 * quando foi autorizado e quando vence em modo Testando (7 dias; sem a data no arquivo: "nao-informado"), a última renovação, a última falha (código fixo),
 * se a renovação está falhando e se é preciso autorizar de novo. NUNCA token, client_id, client_secret, código ou corpo de resposta.
 * `painel` (entrega F, item 14) vira `reautorizarPeloPainel`: só um booleano, para a tela saber se mostra o botão "Reautorizar o Google".
 */
export function vistaDoGoogle(bruto) {
  const b = obj(bruto);
  const ligado = b.ligado === true;
  const arquivo = ligado ? umDe(b.arquivo, ARQUIVO_DO_TOKEN, 'ilegivel') : null;
  const conectado = arquivo === 'ok';
  const escopos = conectado && Array.isArray(b.escopos)
    ? ['agenda', 'tarefas', 'gmail', 'outro'].filter((n) => b.escopos.slice(0, 20).some((e) => nomeDoEscopo(e) === n))
    : null;
  const autorizadoEm = conectado ? dataIso(b.criadoEm) : null;
  const venceEm = autorizadoEm ? new Date(Date.parse(autorizadoEm) + VALIDADE_TESTANDO_MS).toISOString() : null;
  const ultimaRenovacaoEm = ligado ? dataIso(b.ultimaRenovacaoEm) : null;
  const falha = obj(b.ultimaFalha);
  const ultimoErro = ligado && umDe(falha.motivo, FALHAS_DO_GOOGLE) ? { codigo: falha.motivo, em: dataIso(falha.em) } : null;
  const recusada = conectado && b.precisaAutorizar === true;
  const renovacaoFalhou = Boolean(conectado && !recusada && ultimoErro && ultimoErro.codigo !== 'precisa-autorizar'
    && (!ultimaRenovacaoEm || (ultimoErro.em && ultimoErro.em > ultimaRenovacaoEm)));
  const motivoDeAutorizar = !ligado ? null : recusada ? 'recusada' : arquivo === 'ausente' ? 'sem-arquivo' : !conectado ? 'arquivo-invalido' : null;
  return {
    ligado,
    conectado,
    arquivo,
    escopos,
    autorizadoEm,
    venceEm,
    validade: venceEm ? 'testando-7-dias' : 'nao-informado',
    ultimaRenovacaoEm,
    ultimoErro,
    renovacaoFalhou,
    precisaAutorizar: Boolean(motivoDeAutorizar),
    motivoDeAutorizar,
    avisoPendente: recusada && b.avisoPendente === true,
    renovacoes: ligado ? inteiro(b.renovacoes) : 0,
    // Entrega F, item 14: a tela pode mostrar "Reautorizar o Google" (YUI_GOOGLE_REAUTORIZAR_PAINEL). O servidor ainda confere tudo de novo no pedido.
    reautorizarPeloPainel: b.painel === true,
  };
}

// ── Planos ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const ESTADOS_DO_PLANO = Object.freeze(['a_entregar', 'aguardando', 'aprovado', 'executando', 'concluido', 'interrompido', 'cancelado', 'recusado', 'expirado', 'falhou']);
export const ESTADOS_DO_PASSO = Object.freeze(['pendente', 'executando', 'feito', 'falhou', 'incerto']);

/**
 * A vista dos planos (os últimos 20, do mais novo para o mais antigo). De cada um: id, versão, prefixo de 16 do hash, estado, criado em, validade, aprovado em
 * (e se foi automático), encerrado em e o motivo do encerramento (o estado final); dos passos, SÓ o nome da ferramenta e o estado. NUNCA args nem resultados.
 * `painel` (entrega E, item 3 v2): a tela pode mostrar Aprovar e Recusar (YUI_PLANOS_PAINEL e os planos ligados). O id, a versão e o prefixo do hash que a
 * vista já mostra são o que a decisão pede (POST /v1/admin/planos/:id/decisao).
 */
export function vistaDosPlanos(lista, { ligado = false, auto = false, ilegivel = false, painel = false, resumir = null } = {}) {
  const validos = (Array.isArray(lista) ? lista : []).filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && /^[0-9a-f]{6,32}$/.test(p.id) && Array.isArray(p.passos));
  const quando = (p) => (Number.isFinite(Number(p.criadoEm)) ? Number(p.criadoEm) : 0);
  const planos = [...validos].sort((a, b) => quando(b) - quando(a)).slice(0, MAX_PLANOS).map((p) => {
    const estado = umDe(p.estado, ESTADOS_DO_PLANO, 'desconhecido');
    const encerradoEm = dataIso(Number(p.encerradoEm));
    const a = obj(p.aprovacao);
    // "só pela DM" olha TODOS os passos, inclusive os que não cabem na vista
    const aprovarSoPelaDm = p.passos.some((s) => resumoDoPasso(resumir, s).soPelaDm);
    return {
      aprovarSoPelaDm,
      id: p.id,
      versao: inteiro(p.versao),
      hash: typeof p.hash === 'string' && /^[0-9a-f]{16,128}$/.test(p.hash) ? p.hash.slice(0, 16) : null,
      estado,
      criadoEm: dataIso(Number(p.criadoEm)),
      validade: dataIso(Number(p.validade)),
      aprovadoEm: dataIso(Number(a.em)),
      aprovacao: a.em ? (a.automatica === true ? 'automatica' : 'dono') : null,
      encerradoEm,
      motivo: encerradoEm ? estado : null,
      passos: p.passos.slice(0, MAX_PASSOS).map((s) => ({
        ferramenta: typeof s?.ferramenta === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(s.ferramenta) ? s.ferramenta : 'desconhecida',
        estado: umDe(s?.estado, ESTADOS_DO_PASSO, 'desconhecido'),
        resumo: resumoDoPasso(resumir, s),
      })),
    };
  });
  return { ligado: ligado === true, auto: auto === true, painel: ligado === true && painel === true, ilegivel: ilegivel === true, total: validos.length, planos };
}

// O resumo seguro de um passo na vista (correção C1): quem monta é src/core/planos/ferramentas.js (resumoSeguroDoPasso), pelo `resumir` que o admin passa.
// Aqui só a LISTA FECHADA de campos passa, com tamanho e valores conferidos: nada de argumento cru, mesmo se o `resumir` errar. Sem `resumir`, ou se ele
// falhar, o passo fica "desconhecido" e o plano só se aprova pela DM.
const SAIDAS_DA_VISTA = Object.freeze(['internet', 'google', 'rede-local', 'nao', 'desconhecida']);
const CAMPOS_LIVRES_DA_VISTA = Object.freeze(['nome buscado', 'texto da pesquisa', 'nome da lista', 'texto']);
const RESUMO_NA_VISTA_DESCONHECIDO = Object.freeze({ acao: 'Ferramenta que este painel não conhece', servico: 'Desconhecido', acesso: 'desconhecido', saida: 'desconhecida', textoLivre: [], soPelaDm: true });
function resumoDoPasso(resumir, passo) {
  let r = null;
  try { r = typeof resumir === 'function' ? resumir(passo) : null; } catch { r = null; }
  if (!r || typeof r !== 'object') return { ...RESUMO_NA_VISTA_DESCONHECIDO, textoLivre: [] };
  const textoLivre = (Array.isArray(r.textoLivre) ? r.textoLivre : []).slice(0, 5).map((t) => ({
    campo: CAMPOS_LIVRES_DA_VISTA.includes(t?.campo) ? t.campo : 'texto',
    caracteres: Number.isSafeInteger(t?.caracteres) && t.caracteres >= 0 ? Math.min(t.caracteres, 10_000) : 0,
  }));
  const saida = SAIDAS_DA_VISTA.includes(r.saida) ? r.saida : 'desconhecida';
  return {
    acao: linhaCurta(r.acao, 120) || RESUMO_NA_VISTA_DESCONHECIDO.acao,
    servico: linhaCurta(r.servico, 40) || 'Desconhecido',
    acesso: r.acesso === 'leitura' ? 'leitura' : 'desconhecido',
    saida,
    textoLivre,
    soPelaDm: r.soPelaDm !== false || saida === 'desconhecida' || r.acesso !== 'leitura',
  };
}

// ── Avisos ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const CLASSES_DOS_AVISOS = Object.freeze(Object.values(CLASSES));
const FAMILIAS = Object.freeze(Object.keys(PREFIXOS).map((p) => p.slice(0, -1)));
/** O assunto só passa se for uma chave FIXA da tabela ou o nome de uma família ("provider", "crash"); o resto vira null (o painel mostra só a classe). */
export const assuntoSeguro = (v) => (typeof v === 'string' && (Object.hasOwn(TABELA, v) || FAMILIAS.includes(v)) ? v : null);
const ACOES = Object.freeze(['enviar', 'adiar', 'descartar']);

function vistaDoObservado(r) {
  const x = obj(r);
  return { em: dataIso(x.em), assunto: assuntoSeguro(x.assunto), classe: umDe(x.classe, CLASSES_DOS_AVISOS, 'critico'), acao: umDe(x.acao, ACOES, 'adiar'), motivo: codigoFixo(x.motivo), ate: dataIso(x.ate) };
}

/**
 * O que o modo observar de UM processo registrou (o cérebro ou o bot): contagem das decisões e as últimas que adiariam ou descartariam, na ordem em que
 * aconteceram (a tela põe as mais novas primeiro). Passar duas vezes pela vista dá o mesmo resultado (o cérebro limpa de novo o que o bot mandou).
 */
export function vistaDosObservados(bruto, origem) {
  const b = obj(bruto);
  const c = obj(b.contagem);
  return {
    origem: umDe(origem, ['cerebro', 'bot', 'unico'], 'unico'),
    desde: dataIso(b.desde),
    contagem: { enviar: inteiro(c.enviar), adiar: inteiro(c.adiar), descartar: inteiro(c.descartar) },
    registros: (Array.isArray(b.registros) ? b.registros : []).slice(-MAX_OBSERVADOS).map(vistaDoObservado),
  };
}

/**
 * A vista dos avisos: o modo do filtro (off, observar, ligar), a fila durável (o que está guardado e até quando) e o que o modo observar registrou em cada
 * processo. De cada aviso: assunto (chave fixa, família ou null), classe, motivo e até quando. NUNCA o texto do aviso.
 */
export function vistaDosAvisos({ modo = 'off', fila = null, observados = [] } = {}) {
  const f = obj(fila);
  return {
    modo: umDe(modo, ['off', 'observar', 'ligar'], 'off'),
    fila: {
      existe: f.existe === true,
      ilegivel: f.ilegivel === true,
      resumoPendente: f.resumoPendente === true,
      total: inteiro(f.total),
      itens: (Array.isArray(f.itens) ? f.itens : []).slice(0, MAX_FILA).map((i) => {
        const x = obj(i);
        return {
          assunto: assuntoSeguro(x.assunto), classe: umDe(x.classe, CLASSES_DOS_AVISOS, 'critico'), motivo: umDe(x.motivo, ['silencio', 'teto', 'falha'], 'falha'),
          ate: dataIso(x.ate), estado: x.estado === 'enviando' ? 'enviando' : 'pendente', criadoEm: dataIso(x.criadoEm),
        };
      }),
    },
    observados: (Array.isArray(observados) ? observados : []).slice(0, 3).map((o) => {
      if (o?.indisponivel === true) return { origem: umDe(o.origem, ['cerebro', 'bot', 'unico'], 'bot'), indisponivel: true };
      return vistaDosObservados(o, o?.origem);
    }),
  };
}

// ── GTA (entrega D, item 9 v1) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Lido NO BOT (os bancos do GTA são dele: src/discord/gtaPainel.js); a vista é montada lá e, com o cérebro separado, LIMPA DE NOVO no cérebro.
// Sai só um resumo legível: datas, locais e nomes curtos (Van de Armas, comerciantes, bônus, descontos), o título e o link (de fonte conhecida) e onde
// cada um foi publicado. NUNCA o texto inteiro do post ou do artigo, a análise da IA, a miniatura, o id da mensagem nem nada fora da lista.

export const MAX_PUBLICADOS = 50;
const ESTADO_LIGADO = Object.freeze(['ligado', 'desligado']);
export const ESTADOS_DO_REDDIT = Object.freeze(['ligado', 'desligado', 'em-espera']);
const FONTES_DO_SEMANAL = Object.freeze(['reddit', 'gtabase', 'newswire', 'outra']);
const ERROS_DO_GTA = Object.freeze(['diario', 'semanal', 'noticia', 'canais']);
const HOSTS_DO_GTA = Object.freeze(['rockstargames.com', 'www.rockstargames.com', 'reddit.com', 'www.reddit.com', 'old.reddit.com', 'gtabase.com', 'www.gtabase.com']);
const lista = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const textoOuNull = (v, max) => linhaCurta(v, max) || null;
const idDiscord = (v) => ((typeof v === 'string' || typeof v === 'number') && /^\d{5,25}$/.test(String(v)) ? String(v) : null);
const diaIso = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const inteiroOuNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Math.floor(Number(v)));
const porcentagem = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= 100 && v !== null && v !== '' ? Math.round(Number(v)) : null);

/** Data do SQLite ("2026-11-27 06:00:05", que é UTC) ou ISO -> ISO; o resto, null. */
export function dataDoBanco(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) return dataIso(`${v.replace(' ', 'T')}Z`);
  return dataIso(v);
}

/** Link público de uma fonte conhecida do GTA (https, Rockstar, Reddit ou GTABase, sem usuário nem senha); o resto, null. */
export function linkDoGta(v) {
  if (typeof v !== 'string' || v.length > 300) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && HOSTS_DO_GTA.includes(u.hostname) && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

function limparPublicado(p) {
  const x = obj(p);
  const servidorId = idDiscord(x.servidorId);
  if (!servidorId) return null;
  return { servidorId, servidor: textoOuNull(x.servidor, 60), canalId: idDiscord(x.canalId), canal: textoOuNull(x.canal, 60), em: dataIso(x.em) };
}
const limparPublicados = (v) => lista(v, MAX_PUBLICADOS).map(limparPublicado).filter(Boolean);
/** Onde dá para republicar (item 9 v2): servidor e canal configurado daquele tipo (ids e nomes curtos; nada mais). */
function limparAlvo(p) {
  const x = obj(p);
  const servidorId = idDiscord(x.servidorId);
  const canalId = idDiscord(x.canalId);
  return servidorId && canalId ? { servidorId, servidor: textoOuNull(x.servidor, 60), canalId, canal: textoOuNull(x.canal, 60) } : null;
}
const limparAlvos = (v) => lista(v, MAX_PUBLICADOS).map(limparAlvo).filter(Boolean);

function limparFonte(v, { intervalo = false, aoReiniciar = false } = {}) {
  const x = obj(v);
  return {
    estado: umDe(x.estado, ESTADO_LIGADO, 'desligado'),
    ...(aoReiniciar ? { aoReiniciar: umDe(x.aoReiniciar, ESTADO_LIGADO, null) } : {}),
    ...(intervalo ? { intervaloMin: inteiroOuNull(x.intervaloMin) } : {}),
  };
}

/**
 * A vista do GTA com a LISTA FECHADA de campos. Passar duas vezes dá o mesmo resultado: o cérebro limpa de novo o que veio do bot pelo canal.
 * Recebe o formato da própria vista (montarVistaDoGta traduz o dado cru para ele).
 */
export function limparVistaDoGta(v) {
  const b = obj(v);
  const f = obj(b.fontes);
  const r = obj(f.reddit);
  const c = obj(b.canais);
  const a = obj(b.alvos);
  const d = b.diario && typeof b.diario === 'object' ? b.diario : null;
  const s = b.semanal && typeof b.semanal === 'object' ? b.semanal : null;
  const n = b.noticia && typeof b.noticia === 'object' ? b.noticia : null;
  const van = d && d.vanDeArmas && typeof d.vanDeArmas === 'object' ? d.vanDeArmas : null;
  const redditEstado = umDe(r.estado, ESTADOS_DO_REDDIT, 'desligado');
  return {
    fontes: {
      diario: { estado: 'ligado', horario: '06:00 UTC' },
      semanal: limparFonte(f.semanal, { intervalo: true, aoReiniciar: true }),
      reddit: { estado: redditEstado, voltaEm: redditEstado === 'em-espera' ? dataIso(r.voltaEm) : null, falhas: inteiro(r.falhas) },
      reserva: limparFonte(f.reserva),
      newswire: limparFonte(f.newswire, { intervalo: true, aoReiniciar: true }),
    },
    canais: { diario: inteiro(c.diario), semanal: inteiro(c.semanal), noticias: inteiro(c.noticias) },
    alvos: { diario: limparAlvos(a.diario), semanal: limparAlvos(a.semanal), noticia: limparAlvos(a.noticia) },
    diario: d ? {
      data: diaIso(d.data),
      coletadoEm: dataIso(d.coletadoEm),
      vanDeArmas: van ? {
        local: textoOuNull(van.local, 60),
        armas: lista(van.armas, 5).map((a) => ({ nome: linhaCurta(obj(a).nome, 60), desconto: porcentagem(obj(a).desconto) })).filter((a) => a.nome),
      } : null,
      comerciantes: lista(d.comerciantes, 6).map((x) => ({ local: linhaCurta(obj(x).local, 60), produto: textoOuNull(obj(x).produto, 40) })).filter((x) => x.local),
      naufragio: textoOuNull(d.naufragio, 60),
      baus: inteiro(d.baus),
      desafios: lista(d.desafios, 3).map((x) => ({ nome: linhaCurta(obj(x).nome, 40), local: textoOuNull(obj(x).local, 60) })).filter((x) => x.nome),
      publicado: limparPublicados(d.publicado),
    } : null,
    semanal: s ? {
      semana: typeof s.semana === 'string' && /^[\w-]{1,20}$/.test(s.semana) ? s.semana : null,
      fonte: umDe(s.fonte, FONTES_DO_SEMANAL, 'outra'),
      titulo: textoOuNull(s.titulo, 120),
      periodo: { inicio: diaIso(obj(s.periodo).inicio), fim: diaIso(obj(s.periodo).fim) },
      bonus: lista(s.bonus, 6).map((x) => ({
        multiplicador: Number.isFinite(Number(obj(x).multiplicador)) && Number(obj(x).multiplicador) > 0 && Number(obj(x).multiplicador) <= 20 ? Number(obj(x).multiplicador) : null,
        atividades: lista(obj(x).atividades, 6).map((a) => linhaCurta(a, 80)).filter(Boolean),
      })).filter((x) => x.atividades.length),
      descontos: lista(s.descontos, 10).map((x) => linhaCurta(x, 80)).filter(Boolean),
      podio: textoOuNull(s.podio, 60),
      premio: textoOuNull(s.premio, 60),
      temAnalise: s.temAnalise === true,
      link: linkDoGta(s.link),
      salvoEm: dataIso(s.salvoEm),
      publicado: limparPublicados(s.publicado),
    } : null,
    noticia: n ? {
      titulo: textoOuNull(n.titulo, 120),
      categoria: textoOuNull(n.categoria, 40),
      publicadaEm: dataIso(n.publicadaEm),
      link: linkDoGta(n.link),
      publicado: limparPublicados(n.publicado),
    } : null,
    erros: lista(b.erros, 8).filter((e) => ERROS_DO_GTA.includes(e)),
  };
}

/**
 * Do dado CRU do bot (src/discord/gtaPainel.js: lerGtaDoBot) para a vista. `nomeDoServidor` e `nomeDoCanal` dão o nome a partir do id (o cliente do Discord
 * do bot); sem eles, só os ids. O Reddit DESLIGADO (semanal desligado ou REDDIT_FETCH_MODE=off) aparece como "desligado", nunca como erro; em recuo depois
 * de falhas, "em-espera" com a hora da próxima tentativa.
 */
export function montarVistaDoGta(bruto, { nomeDoServidor = () => null, nomeDoCanal = () => null, agora = Date.now() } = {}) {
  const b = obj(bruto);
  const f = obj(b.fontes);
  const ligado = (v) => (v === true ? 'ligado' : 'desligado');
  const salvo = (v, efetivo) => {
    const s = String(v ?? '').trim().toLowerCase();
    const quer = s === 'true' ? 'ligado' : s === 'false' ? 'desligado' : null;
    return quer && quer !== efetivo ? quer : null;
  };
  const nome = (fn, id) => { try { const t = fn(String(id)); return typeof t === 'string' ? t : null; } catch { return null; } };
  const pubs = (v) => lista(v, MAX_PUBLICADOS).map((p) => ({ servidorId: obj(p).guildId, servidor: nome(nomeDoServidor, obj(p).guildId), canalId: obj(p).channelId, canal: nome(nomeDoCanal, obj(p).channelId), em: dataDoBanco(obj(p).em) }));
  const alvos = (v) => lista(v, MAX_PUBLICADOS).map((p) => ({ servidorId: obj(p).guildId, servidor: nome(nomeDoServidor, obj(p).guildId), canalId: obj(p).channelId, canal: nome(nomeDoCanal, obj(p).channelId) }));
  const al = obj(b.alvos);
  const espera = obj(f.redditEspera);
  const semanalLigado = ligado(f.semanal);
  const redditDesligado = semanalLigado === 'desligado' || String(f.redditModo ?? '').trim().toLowerCase() === 'off';
  const emEspera = !redditDesligado && espera.ok === false;
  const p = obj(b.publicacoes);

  const dr = b.diario && typeof b.diario === 'object' ? b.diario : null;
  const dd = obj(dr?.data);
  const gv = dd.gunVan && typeof dd.gunVan === 'object' ? dd.gunVan : null;
  const tt = obj(dd.timeTrials);
  const sr = b.semanal && typeof b.semanal === 'object' ? b.semanal : null;
  const sd = obj(sr?.data);
  const fonteDoSemanal = ['reddit', 'gtabase', 'newswire'].includes(sd.source) ? sd.source : 'outra';
  const nr = b.noticia && typeof b.noticia === 'object' ? b.noticia : null;

  return limparVistaDoGta({
    fontes: {
      semanal: { estado: semanalLigado, aoReiniciar: salvo(f.salvoSemanal, semanalLigado), intervaloMin: f.intervaloSemanal },
      reddit: { estado: redditDesligado ? 'desligado' : emEspera ? 'em-espera' : 'ligado', voltaEm: emEspera ? agora + (Number(espera.retryInMs) || 0) : null, falhas: f.redditFalhas },
      reserva: { estado: semanalLigado === 'ligado' ? ligado(f.reserva) : 'desligado' },
      newswire: { estado: ligado(f.newswire), aoReiniciar: salvo(f.salvoNewswire, ligado(f.newswire)), intervaloMin: f.intervaloNewswire },
    },
    canais: b.canais,
    alvos: { diario: alvos(al.diario), semanal: alvos(al.semanal), noticia: alvos(al.noticia) },
    diario: dr ? {
      data: diaIso(dd.date) ?? diaIso(dr.resetDate),
      coletadoEm: dataIso(dd.collectedAt) ?? dataDoBanco(dr.criadoEm),
      vanDeArmas: gv ? { local: gv.locationName, armas: lista(gv.weapons, 5).map((w) => ({ nome: obj(w).name, desconto: obj(w).discountPercent })) } : null,
      comerciantes: lista(obj(dd.streetDealers).dealers, 6).map((x) => ({ local: obj(x).locationName, produto: obj(x).premiumProduct })),
      naufragio: obj(obj(dd.collectibles).shipwreck).locationName,
      baus: Array.isArray(obj(dd.collectibles).treasureChests) ? obj(dd.collectibles).treasureChests.length : 0,
      desafios: [
        tt.rcBandito ? { nome: 'RC Bandito', local: obj(tt.rcBandito).locationName } : null,
        tt.junkEnergyBike ? { nome: 'Junk Energy Bike', local: obj(tt.junkEnergyBike).locationName } : null,
      ].filter(Boolean),
      publicado: pubs(p.diario),
    } : null,
    semanal: sr ? {
      semana: sr.eventWeek,
      fonte: fonteDoSemanal,
      titulo: sd.title,
      periodo: obj(sd.periodo),
      bonus: lista(sd.bonus, 6).map((x) => ({ multiplicador: obj(x).multiplicador, atividades: obj(x).atividades })),
      descontos: Array.isArray(sd.descontos) ? sd.descontos.filter((x) => typeof x === 'string') : [],
      podio: obj(sd.veiculos).podium,
      premio: obj(sd.veiculos).prizeRide,
      temAnalise: Boolean(sd.analysis),
      link: sd.url,
      salvoEm: dataDoBanco(sr.criadoEm),
      publicado: pubs(p.semanal),
    } : null,
    noticia: nr ? { titulo: nr.title, categoria: nr.category, publicadaEm: dataDoBanco(nr.publishedAt), link: nr.url, publicado: pubs(p.noticia) } : null,
    erros: b.erros,
  });
}

// ── Listas pessoais do dono (entrega D, item 12) ────────────────────────────────────────────────────────────────────────────────────────────
// Só as listas do PRÓPRIO dono (o arquivo dele, escolhido pelo id da sessão; a rota não recebe id). É o conteúdo dele, para ele.
export const MAX_LISTAS = 30;
const MAX_ITENS = 500;

/** As listas do dono: nome (60), itens (500 caracteres cada, até 500 por lista) e se cada um está feito, mais quando a lista mudou. Em ordem alfabética. */
export function vistaDasListas(bruto, { ligado = true } = {}) {
  const b = obj(bruto);
  const listas = lista(b.listas, MAX_LISTAS).map((l) => {
    const x = obj(l);
    const itens = lista(x.itens, MAX_ITENS).map((i) => ({ texto: linhaCurta(obj(i).texto, 500), feito: obj(i).feito === true })).filter((i) => i.texto);
    return { nome: linhaCurta(x.nome, 60), total: itens.length, feitos: itens.filter((i) => i.feito).length, atualizadaEm: dataIso(Number(x.atualizadaEm)), itens };
  }).filter((l) => l.nome).sort((a, z) => a.nome.localeCompare(z.nome, 'pt-BR'));
  return { ligado: ligado === true, situacao: umDe(b.situacao, ['ok', 'ausente', 'ilegivel'], 'ausente'), total: listas.length, listas };
}

// ── Skills instaladas (entrega D, item 12; só leitura) ──────────────────────────────────────────────────────────────────────────────────────
const NOME_DE_SKILL_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ORIGENS_DE_SKILL = Object.freeze(['yui', 'dono', 'extra']);
const nomeDeSkill = (v) => (typeof v === 'string' && v.length <= 64 && NOME_DE_SKILL_RE.test(v) ? v : null);
const pastaSegura = (v) => String(v ?? '').replace(/[^A-Za-z0-9._*-]/g, '?').slice(0, 64);

/**
 * O catálogo das skills (src/core/skills/carregador.js: carregarCatalogo) e quais estão permitidas (YUI_SKILLS_PERMITIDAS; vazia = todas as válidas).
 * De cada skill: nome, descrição curta (300), de onde veio (yui, dono, extra), licença e o que foi ignorado (scripts, allowed-tools). Das pastas que não
 * carregaram, o nome da pasta (só letras seguras) e o motivo (palavra fixa). NUNCA o caminho no disco, o corpo da skill nem os metadados.
 */
export function vistaDasSkills(bruto) {
  const b = obj(bruto);
  const cat = obj(b.catalogo);
  const permitidas = Array.isArray(b.permitidas) ? [...new Set(b.permitidas.slice(0, 100).map((n) => nomeDeSkill(String(n ?? '').trim().toLowerCase())).filter(Boolean))] : null;
  const skills = lista(cat.skills, 100).map((s) => {
    const x = obj(s);
    const nome = nomeDeSkill(x.nome);
    if (!nome) return null;
    return {
      nome,
      descricao: linhaCurta(x.descricao, 300),
      origem: umDe(x.origem, ORIGENS_DE_SKILL, 'extra'),
      licenca: textoOuNull(x.licenca, 60),
      permitida: permitidas ? permitidas.includes(nome) : true,
      ignorados: lista(x.ignorados, 4).filter((i) => i === 'scripts' || i === 'allowed-tools'),
    };
  }).filter(Boolean);
  const instaladas = new Set(skills.map((s) => s.nome));
  return {
    ligado: b.ligado === true,
    filtro: permitidas ? 'lista' : 'todas',
    permitidas,
    naoInstaladas: permitidas ? permitidas.filter((n) => !instaladas.has(n)) : [],
    total: skills.length,
    ativas: skills.filter((s) => s.permitida).length,
    skills,
    avisos: lista(cat.avisos, 50).map((a) => ({ pasta: pastaSegura(obj(a).pasta), origem: umDe(obj(a).origem, ORIGENS_DE_SKILL, 'extra'), motivo: codigoFixo(obj(a).motivo) ?? 'ilegivel' })),
  };
}

// ── Continuidade: projetos e decisões (entrega D, item 12) ──────────────────────────────────────────────────────────────────────────────────
export const MAX_CONTINUIDADE = 200;

/** Os projetos e as decisões do dono: número, tipo (projeto ou decisao), texto (500) e datas. Mais nada da memória sai por aqui. */
export function vistaDaContinuidade(bruto) {
  const b = obj(bruto);
  const itens = lista(b.itens, MAX_CONTINUIDADE).map((r) => {
    const x = obj(r);
    const id = Number(x.id);
    const tipo = x.tipo === 'project' ? 'projeto' : x.tipo === 'decision' ? 'decisao' : null;
    if (!Number.isInteger(id) || id < 1 || !tipo) return null;
    return { id, tipo, texto: linhaCurta(x.texto, 500), criadoEm: dataIso(Number(x.criadoEm)), atualizadoEm: dataIso(Number(x.atualizadoEm)) };
  }).filter((x) => x && x.texto);
  return {
    ligado: b.ligado === true,
    memoria: b.memoria !== false,
    total: itens.length,
    projetos: itens.filter((i) => i.tipo === 'projeto').length,
    decisoes: itens.filter((i) => i.tipo === 'decisao').length,
    itens,
  };
}

// ── As leituras de verdade (no processo que serve a API) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * As leituras padrão. Imports na hora do uso: a API não carrega a live, o Google, os planos nem a fila só por subir. Cada uma devolve o dado CRU, que o
 * admin passa pela vista. `processo`: 'cerebro' | 'unico' | 'bot' (só muda a origem do que o modo observar registrou).
 */
export function criarLeiturasPadrao({ env = process.env, raizesDasSkills = null } = {}) {
  return {
    // Entrega D (item 12). As listas: o arquivo do DONO da sessão em <DATABASE_DIR>/listas (lido sem gravar nem renomear; quem grava é o bot ou, com
    // YUI_APP_COMANDOS, o cérebro, sempre de forma atômica). As skills: o catálogo das pastas de skills (`raizesDasSkills` só para teste).
    async listas(userId) {
      const { lerListasDoUsuario, defaultListDir } = await import('../../handlers/listStore.js');
      const { listasLigadas } = await import('../../handlers/listAssistant.js');
      return { ...lerListasDoUsuario(userId, { dir: defaultListDir(env) }), ligado: listasLigadas(env) };
    },
    async skills() {
      const { carregarCatalogo, raizesDeSkills } = await import('../skills/carregador.js');
      const { nomesPermitidos } = await import('../skills/catalogo.js');
      const { skillsLigadas } = await import('../skills/integracao.js');
      const permitidos = nomesPermitidos(env);
      return { ligado: skillsLigadas(env), permitidas: permitidos ? [...permitidos] : null, catalogo: carregarCatalogo({ env, raizes: raizesDasSkills ?? raizesDeSkills(env) }) };
    },
    async live() {
      const { portaDaLive } = await import('../../adaptadores/youtube/porta.js');
      const { youtubeLigado } = await import('../../adaptadores/youtube/adaptador.js');
      const porta = portaDaLive();
      return { ligado: youtubeLigado(env), bruto: typeof porta?.painel === 'function' ? porta.painel() : null };
    },
    async google() {
      const { googleLigado, reautorizacaoPeloPainelLigada } = await import('../../integrations/google/config.js');
      // `painel` (entrega F, item 14): a tela mostra o botão "Reautorizar o Google" (YUI_GOOGLE_REAUTORIZAR_PAINEL; não depende de YUI_GOOGLE).
      const painel = reautorizacaoPeloPainelLigada(env);
      if (!googleLigado(env)) return { ligado: false, painel };
      const { googleDoProcesso } = await import('../../integrations/google/index.js');
      return { ...googleDoProcesso(env).estado(), painel };
    },
    async planos() {
      const { planosLigados, planosAuto, planosPeloPainel } = await import('../planos/pedido.js');
      const { criarStoreDePlanos } = await import('../planos/store.js');
      let lista = [];
      let ilegivel = false;
      try { lista = criarStoreDePlanos({ env }).ler(); } catch { ilegivel = true; }
      return { lista, ligado: planosLigados(env), auto: planosAuto(env), painel: planosPeloPainel(env), ilegivel };
    },
    async avisos() {
      const { modoDoFiltro } = await import('../avisos/observar.js');
      const { lerFilaParaPainel } = await import('../avisos/fila.js');
      return { modo: modoDoFiltro(env), fila: lerFilaParaPainel({ env }) };
    },
    async observados() {
      const { registrosDoObservar } = await import('../avisos/observar.js');
      return registrosDoObservar();
    },
  };
}
