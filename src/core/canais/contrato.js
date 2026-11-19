// CONTRATO ÚNICO ENTRE CANAL E CÉREBRO (docs/PROPOSTA_CEREBRO_UNICO_YUI.md §4.1; docs/CANAIS_NOVOS.md). PREPARADO, SEM EFEITO: nada o chama ainda.
//
// Todo canal (o bot do Discord, o app, o programa do PC e o bot de YouTube Live) fala com o cérebro do mesmo jeito:
//   PEDIDO   canal -> cérebro:  { canal, pessoa, conversa, texto, anexos, capacidades }
//   RESPOSTA cérebro -> canal:  { texto (já no tamanho do canal), acoes, confirmacao }
// O PAPEL (dono, membro, público) NUNCA vem do pedido: é decidido pelo cérebro a partir da `pessoa` que o canal conferiu (nunca do texto, nem de um campo do
// pedido). Um pedido que traga `papel`, `role`, `dono`, `permissoes`... é recusado inteiro. Cada canal ainda tem um TETO de papel (o chat do YouTube é
// público até para o dono: `limitarPapel`).
//
// Este arquivo é PURO: sem rede, sem disco, sem estado e sem nenhum import (nem de Discord, nem de outro arquivo da Yui). A validação é ESTRITA: campo
// desconhecido é recusado, limite de tamanho é recusado (nunca cortado em silêncio), e o resultado traz TODOS os erros (campo, código e um texto curto
// sem o conteúdo recebido), no mesmo formato de src/core/ai/perfis.js.

/** A lista FECHADA de canais. Um canal que não está aqui é recusado. */
export const CANAIS = Object.freeze(['discord_dm', 'discord_guild', 'app', 'pc', 'youtube_live']);
/** Os papéis, do menor para o maior. */
export const PAPEIS = Object.freeze(['publico', 'membro', 'dono']);
/** O papel máximo que cada canal pode ter. No chat de uma live todo mundo é público, inclusive o dono (§7.4: ordens do dono só valem pelo Discord ou pelo app). */
export const PAPEL_MAXIMO_DO_CANAL = Object.freeze({
  discord_dm: 'dono', discord_guild: 'dono', app: 'dono', pc: 'dono', youtube_live: 'publico',
});

/** As capacidades que cada canal pode declarar (lista fechada: um canal não inventa uma capacidade). Num canal sem a capacidade, a ferramenta nem aparece para o modelo (§4.2). */
export const CAPACIDADES_DO_CANAL = Object.freeze({
  discord_dm: Object.freeze(['discord.dm.enviar', 'discord.voz.entrar', 'discord.voz.sair', 'discord.voz.falar', 'discord.radio.tocar', 'discord.anexo.enviar', 'discord.menu.mostrar']),
  discord_guild: Object.freeze(['discord.voz.entrar', 'discord.voz.sair', 'discord.voz.falar', 'discord.radio.tocar', 'discord.automod.agir', 'discord.anexo.enviar', 'discord.menu.mostrar']),
  app: Object.freeze(['app.notificacao.enviar', 'app.anexo.enviar', 'app.confirmacao.mostrar']),
  pc: Object.freeze(['pc.notificacao.enviar', 'pc.confirmacao.mostrar', 'pc.voz.falar']),
  youtube_live: Object.freeze(['youtube.chat.enviar']),
});

/** O YouTube corta em 200 caracteres (o limite da mensagem do chat ao vivo). */
export const YOUTUBE_MAX_CARACTERES = 200;

/**
 * TAMANHO e ESTILO por canal.
 *  - maxTextoPedido: o maior texto que o canal pode mandar ao cérebro (caracteres);
 *  - maxResposta: o maior texto que o cérebro pode devolver; maxParte: o tamanho de UMA mensagem do canal; dividePartes: o canal divide o texto em várias mensagens;
 *  - maxAnexos: anexos por pedido; acoes: o canal executa ações do cérebro; confirmacao: o canal mostra pedido de confirmação (só canais privados do dono);
 *  - estilo: o que o texto pode conter (markdown, listas, links, código, menções) e se vale "uma ideia por mensagem" (sem quebra de linha).
 * Discord: como hoje (src/discord/longReply.js: 2000 por mensagem, até 20000 caracteres por resposta). PC: igual ao app. YouTube: 200, sem lista, sem link, uma ideia.
 */
const ESTILO_COMPLETO = Object.freeze({ markdown: true, listas: true, links: true, codigo: true, mencoes: true, umaIdeiaPorMensagem: false });
const ESTILO_DO_APP = Object.freeze({ markdown: true, listas: true, links: true, codigo: true, mencoes: false, umaIdeiaPorMensagem: false });
export const REGRAS_DO_CANAL = Object.freeze({
  discord_dm: Object.freeze({ maxTextoPedido: 4000, maxResposta: 20000, maxParte: 2000, dividePartes: true, maxAnexos: 10, acoes: true, confirmacao: true, estilo: ESTILO_COMPLETO }),
  discord_guild: Object.freeze({ maxTextoPedido: 4000, maxResposta: 20000, maxParte: 2000, dividePartes: true, maxAnexos: 10, acoes: true, confirmacao: false, estilo: ESTILO_COMPLETO }),
  app: Object.freeze({ maxTextoPedido: 8000, maxResposta: 20000, maxParte: 20000, dividePartes: false, maxAnexos: 5, acoes: true, confirmacao: true, estilo: ESTILO_DO_APP }),
  pc: Object.freeze({ maxTextoPedido: 8000, maxResposta: 20000, maxParte: 20000, dividePartes: false, maxAnexos: 5, acoes: true, confirmacao: true, estilo: ESTILO_DO_APP }),
  youtube_live: Object.freeze({
    maxTextoPedido: 300, maxResposta: YOUTUBE_MAX_CARACTERES, maxParte: YOUTUBE_MAX_CARACTERES, dividePartes: false, maxAnexos: 0, acoes: false, confirmacao: false,
    estilo: Object.freeze({ markdown: false, listas: false, links: false, codigo: false, mencoes: false, umaIdeiaPorMensagem: true }),
  }),
});

export const LIMITES = Object.freeze({
  idMax: 96, anexoNomeMax: 120, anexoMimeMax: 100, anexoRefMax: 300, anexoBytesMax: 50 * 1024 * 1024,
  acoesMax: 8, parametrosBytesMax: 4000, confirmacaoResumoMax: 200, confirmacaoExpiraMinMs: 1000, confirmacaoExpiraMaxMs: 5 * 60_000,
});

const CAMPOS_DO_PEDIDO = new Set(['canal', 'pessoa', 'conversa', 'texto', 'anexos', 'capacidades']);
const CAMPOS_DA_RESPOSTA = new Set(['texto', 'acoes', 'confirmacao']);
const CAMPOS_DO_ANEXO = new Set(['tipo', 'nome', 'mime', 'bytes', 'ref']);
const CAMPOS_DA_ACAO = new Set(['id', 'tipo', 'parametros']);
const CAMPOS_DA_CONFIRMACAO = new Set(['id', 'resumo', 'nivel', 'expiraEmMs']);
/** Campos que tentariam dizer QUEM a pessoa é para o cérebro: o papel é decisão do cérebro, nunca do pedido. */
const CAMPO_DE_PAPEL_RE = /^(?:papel|papeis|role|roles|dono|owner|isowner|is_owner|admin|isadmin|is_admin|autoridade|permiss\w*|permission\w*|nivel|level|trust\w*|confian\w*|privilegi\w*)$/i;

export const TIPOS_DE_ANEXO = Object.freeze(['imagem', 'audio', 'video', 'arquivo']);
export const NIVEIS_DE_CONFIRMACAO = Object.freeze(['normal', 'critico']);

const ID_RE = /^[A-Za-z0-9_.:@-]+$/;
const ID_DA_ACAO_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MIME_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;
const REF_RE = /^[A-Za-z0-9_.:@/-]+$/;
// Caracteres de controle (menos tabulação e quebras de linha). Texto com NUL ou controle é recusado, não "limpo".
// eslint-disable-next-line no-control-regex
const CONTROLE_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const erro = (campo, codigo, texto) => ({ campo, codigo, texto });
const ehObjetoSimples = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

// ── Detectores de estilo (usados pela validação e por src/core/canais/estilo.js) ─────────────────────────────────────────────────────

/** O texto tem um link (endereço http(s), www, ou um domínio com final comum, como "youtu.be/x" ou "discord.gg/x")? */
export function temLink(texto) {
  return /(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|br|io|gg|tv|me|co|app|dev|xyz|ly|be|link|site|online|shop|store)\b(?:\/\S*)?/i.test(String(texto ?? ''));
}
/** O texto tem um item de lista no começo de alguma linha ("- x", "* x", "• x", "1. x", "1) x")? */
export function temLista(texto) {
  return /(?:^|\n)[ \t]*(?:[-*•]|\d{1,3}[.)])[ \t]+\S/.test(String(texto ?? ''));
}
/** O texto tem marcas de Markdown (negrito, itálico, código, título, citação, link com colchetes)? */
export function temMarkdown(texto) {
  return /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|~~[^~\n]+~~|(?:^|\n)#{1,6}[ \t]|(?:^|\n)>[ \t]|\[[^\]\n]+\]\([^)\n]+\))/.test(String(texto ?? ''));
}

// ── Papel ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * O papel que o cérebro DECIDIU, limitado pelo teto do canal: no YouTube Live ninguém passa de "publico", nem o dono. O papel decidido vem do cérebro
 * (src/core/permissions.js); esta função só aplica o teto do canal e nunca eleva ninguém.
 * @returns {'dono'|'membro'|'publico'}
 */
export function limitarPapel(canal, papelDecidido) {
  const teto = PAPEL_MAXIMO_DO_CANAL[canal];
  if (!teto) return 'publico'; // canal desconhecido: o menor papel
  const rankDecidido = PAPEIS.indexOf(papelDecidido);
  if (rankDecidido < 0) return 'publico';
  return PAPEIS[Math.min(rankDecidido, PAPEIS.indexOf(teto))];
}

// ── Pedido (canal -> cérebro) ────────────────────────────────────────────────────────────────────────────────────────────────────────

function validarAnexo(bruto, i, erros) {
  const base = `anexos[${i}]`;
  if (!ehObjetoSimples(bruto)) { erros.push(erro(base, 'anexo-invalido', 'Cada anexo precisa ser um objeto.')); return; }
  for (const c of Object.keys(bruto)) if (!CAMPOS_DO_ANEXO.has(c)) erros.push(erro(`${base}.${c.slice(0, 30)}`, 'campo-desconhecido', 'Campo desconhecido no anexo.'));
  if (!TIPOS_DE_ANEXO.includes(bruto.tipo)) erros.push(erro(`${base}.tipo`, 'anexo-tipo-invalido', `O tipo do anexo precisa ser um destes: ${TIPOS_DE_ANEXO.join(', ')}.`));
  if (typeof bruto.nome !== 'string' || !bruto.nome || bruto.nome.length > LIMITES.anexoNomeMax || /[\\/\u0000-\u001f]/.test(bruto.nome)) erros.push(erro(`${base}.nome`, 'anexo-nome-invalido', `O nome do anexo precisa ter de 1 a ${LIMITES.anexoNomeMax} caracteres, sem barras nem controles.`));
  if (typeof bruto.mime !== 'string' || bruto.mime.length > LIMITES.anexoMimeMax || !MIME_RE.test(bruto.mime)) erros.push(erro(`${base}.mime`, 'anexo-mime-invalido', 'O tipo MIME do anexo é inválido.'));
  if (!Number.isInteger(bruto.bytes) || bruto.bytes < 0 || bruto.bytes > LIMITES.anexoBytesMax) erros.push(erro(`${base}.bytes`, 'anexo-tamanho-invalido', `O tamanho do anexo precisa ser um inteiro de 0 a ${LIMITES.anexoBytesMax} bytes.`));
  if (typeof bruto.ref !== 'string' || !bruto.ref || bruto.ref.length > LIMITES.anexoRefMax || !REF_RE.test(bruto.ref)) erros.push(erro(`${base}.ref`, 'anexo-ref-invalida', 'A referência do anexo precisa ser um identificador do canal (sem espaços nem endereço com parâmetros).'));
}

/**
 * Valida um PEDIDO (o que o canal manda ao cérebro).
 * @returns {{ ok: true, pedido: Readonly<{canal:string, pessoa:string, conversa:string, texto:string, anexos:readonly object[], capacidades:readonly string[]}> } | { ok: false, erros: {campo:string|null, codigo:string, texto:string}[] }}
 */
export function validarPedido(bruto) {
  const erros = [];
  if (!ehObjetoSimples(bruto)) return { ok: false, erros: [erro(null, 'pedido-invalido', 'O pedido precisa ser um objeto.')] };
  for (const campo of Object.keys(bruto)) {
    if (CAMPOS_DO_PEDIDO.has(campo)) continue;
    if (CAMPO_DE_PAPEL_RE.test(campo)) erros.push(erro(campo.slice(0, 30), 'papel-no-pedido', 'O papel (dono, membro, público) é decidido pelo cérebro: o pedido não pode trazer papel, permissão nem nível de confiança.'));
    else erros.push(erro(campo.slice(0, 30), 'campo-desconhecido', 'Campo desconhecido no pedido.'));
  }

  const canalValido = typeof bruto.canal === 'string' && CANAIS.includes(bruto.canal);
  if (!canalValido) erros.push(erro('canal', 'canal-invalido', `O canal precisa ser um destes: ${CANAIS.join(', ')}.`));
  const regras = canalValido ? REGRAS_DO_CANAL[bruto.canal] : null;

  for (const campo of ['pessoa', 'conversa']) {
    const v = bruto[campo];
    if (typeof v !== 'string' || !v || v.length > LIMITES.idMax || !ID_RE.test(v)) erros.push(erro(campo, `${campo}-invalida`, `"${campo}" precisa ser um identificador de 1 a ${LIMITES.idMax} caracteres (letras, números, ponto, dois-pontos, arroba, sublinhado e hífen).`));
  }

  const anexosBrutos = bruto.anexos === undefined ? [] : bruto.anexos;
  let anexos = [];
  if (!Array.isArray(anexosBrutos)) erros.push(erro('anexos', 'anexos-invalidos', '"anexos" precisa ser uma lista.'));
  else {
    anexos = anexosBrutos;
    if (regras && anexos.length > regras.maxAnexos) erros.push(erro('anexos', 'anexos-demais', regras.maxAnexos === 0 ? 'Este canal não aceita anexos.' : `Este canal aceita até ${regras.maxAnexos} anexos por pedido.`));
    else anexos.forEach((a, i) => validarAnexo(a, i, erros));
  }

  if (typeof bruto.texto !== 'string') erros.push(erro('texto', 'texto-invalido', '"texto" precisa ser um texto (pode ser vazio quando há anexo).'));
  else {
    if (CONTROLE_RE.test(bruto.texto)) erros.push(erro('texto', 'texto-com-controle', 'O texto tem caracteres de controle.'));
    if (regras && bruto.texto.length > regras.maxTextoPedido) erros.push(erro('texto', 'texto-longo', `O texto passa do limite deste canal (${regras.maxTextoPedido} caracteres).`));
    if (!bruto.texto.trim() && !(Array.isArray(anexosBrutos) && anexosBrutos.length)) erros.push(erro('texto', 'texto-vazio', 'O pedido não tem texto nem anexo.'));
  }

  const capsBrutas = bruto.capacidades;
  let capacidades = [];
  if (!Array.isArray(capsBrutas)) erros.push(erro('capacidades', 'capacidades-invalidas', '"capacidades" precisa ser a lista do que o canal sabe executar (pode ser vazia).'));
  else {
    capacidades = capsBrutas;
    const conhecidas = canalValido ? CAPACIDADES_DO_CANAL[bruto.canal] : [];
    if (capacidades.length > 32) erros.push(erro('capacidades', 'capacidades-demais', 'Capacidades demais.'));
    const vistas = new Set();
    for (const c of capacidades.slice(0, 32)) {
      if (typeof c !== 'string' || !conhecidas.includes(c)) erros.push(erro('capacidades', 'capacidade-desconhecida', `Capacidade fora da lista deste canal${canalValido ? ` (${conhecidas.join(', ')})` : ''}.`));
      else if (vistas.has(c)) erros.push(erro('capacidades', 'capacidade-repetida', 'Capacidade repetida.'));
      else vistas.add(c);
    }
  }

  if (erros.length) return { ok: false, erros };
  return {
    ok: true,
    pedido: Object.freeze({
      canal: bruto.canal, pessoa: bruto.pessoa, conversa: bruto.conversa, texto: bruto.texto,
      anexos: Object.freeze(anexos.map((a) => Object.freeze({ tipo: a.tipo, nome: a.nome, mime: a.mime, bytes: a.bytes, ref: a.ref }))),
      capacidades: Object.freeze([...capacidades]),
    }),
  };
}

// ── Resposta (cérebro -> canal) ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** O texto cumpre o ESTILO do canal (tamanho, quebras, links, listas, Markdown)? Devolve a lista de códigos que descumpre. */
export function problemasDeEstilo(canal, texto) {
  const regras = REGRAS_DO_CANAL[canal];
  const t = String(texto ?? '');
  if (!regras) return ['canal-invalido'];
  const out = [];
  if (t.length > regras.maxResposta) out.push('texto-longo');
  const e = regras.estilo;
  if (e.umaIdeiaPorMensagem && /[\r\n]/.test(t)) out.push('texto-com-quebra');
  if (!e.links && temLink(t)) out.push('texto-com-link');
  if (!e.listas && temLista(t)) out.push('texto-com-lista');
  if (!e.markdown && temMarkdown(t)) out.push('texto-com-markdown');
  return out;
}

const TEXTO_DO_PROBLEMA = Object.freeze({
  'texto-longo': 'O texto passa do tamanho que este canal aceita.',
  'texto-com-quebra': 'Este canal aceita uma ideia por mensagem, sem quebra de linha.',
  'texto-com-link': 'Este canal não aceita link no texto.',
  'texto-com-lista': 'Este canal não aceita lista no texto.',
  'texto-com-markdown': 'Este canal não aceita Markdown no texto.',
});

function validarAcao(bruto, i, canal, capacidades, erros) {
  const base = `acoes[${i}]`;
  if (!ehObjetoSimples(bruto)) { erros.push(erro(base, 'acao-invalida', 'Cada ação precisa ser um objeto.')); return; }
  for (const c of Object.keys(bruto)) if (!CAMPOS_DA_ACAO.has(c)) erros.push(erro(`${base}.${c.slice(0, 30)}`, 'campo-desconhecido', 'Campo desconhecido na ação.'));
  if (typeof bruto.id !== 'string' || !ID_DA_ACAO_RE.test(bruto.id)) erros.push(erro(`${base}.id`, 'acao-id-invalido', 'Cada ação precisa de um id (até 64 caracteres) para o resultado voltar ao cérebro.'));
  const conhecidas = CAPACIDADES_DO_CANAL[canal] ?? [];
  if (typeof bruto.tipo !== 'string' || !conhecidas.includes(bruto.tipo)) erros.push(erro(`${base}.tipo`, 'acao-desconhecida', 'A ação não existe neste canal.'));
  else if (Array.isArray(capacidades) && !capacidades.includes(bruto.tipo)) erros.push(erro(`${base}.tipo`, 'acao-sem-capacidade', 'O canal não declarou a capacidade desta ação.'));
  if (bruto.parametros !== undefined) {
    if (!ehObjetoSimples(bruto.parametros)) erros.push(erro(`${base}.parametros`, 'parametros-invalidos', '"parametros" precisa ser um objeto.'));
    else {
      let bytes = Infinity;
      try { bytes = Buffer.byteLength(JSON.stringify(bruto.parametros), 'utf8'); } catch { /* circular ou não serializável */ }
      if (bytes > LIMITES.parametrosBytesMax) erros.push(erro(`${base}.parametros`, 'parametros-grandes', `Os parâmetros da ação passam de ${LIMITES.parametrosBytesMax} bytes (ou não viram JSON).`));
    }
  }
}

function validarConfirmacao(bruto, erros) {
  if (!ehObjetoSimples(bruto)) { erros.push(erro('confirmacao', 'confirmacao-invalida', '"confirmacao" precisa ser um objeto.')); return; }
  for (const c of Object.keys(bruto)) if (!CAMPOS_DA_CONFIRMACAO.has(c)) erros.push(erro(`confirmacao.${c.slice(0, 30)}`, 'campo-desconhecido', 'Campo desconhecido na confirmação.'));
  if (typeof bruto.id !== 'string' || !ID_DA_ACAO_RE.test(bruto.id)) erros.push(erro('confirmacao.id', 'confirmacao-id-invalido', 'A confirmação precisa de um id (até 64 caracteres).'));
  if (typeof bruto.resumo !== 'string' || !bruto.resumo.trim() || bruto.resumo.length > LIMITES.confirmacaoResumoMax || /[\r\n]/.test(bruto.resumo) || CONTROLE_RE.test(bruto.resumo)) erros.push(erro('confirmacao.resumo', 'confirmacao-resumo-invalido', `O resumo da operação precisa ter de 1 a ${LIMITES.confirmacaoResumoMax} caracteres, em uma linha.`));
  if (!NIVEIS_DE_CONFIRMACAO.includes(bruto.nivel)) erros.push(erro('confirmacao.nivel', 'confirmacao-nivel-invalido', `O nível precisa ser ${NIVEIS_DE_CONFIRMACAO.join(' ou ')}.`));
  if (!Number.isInteger(bruto.expiraEmMs) || bruto.expiraEmMs < LIMITES.confirmacaoExpiraMinMs || bruto.expiraEmMs > LIMITES.confirmacaoExpiraMaxMs) erros.push(erro('confirmacao.expiraEmMs', 'confirmacao-prazo-invalido', `O prazo precisa ser um inteiro de ${LIMITES.confirmacaoExpiraMinMs} a ${LIMITES.confirmacaoExpiraMaxMs} ms (a confirmação nunca vale para sempre).`));
}

/**
 * Valida uma RESPOSTA (o que o cérebro devolve ao canal). O texto precisa vir JÁ no tamanho e no estilo do canal (src/core/canais/estilo.js:
 * ajustarTextoAoCanal faz o ajuste): o contrato recusa, não corta.
 * @param {string} canal
 * @param {object} bruto
 * @param {{ capacidades?: readonly string[] | null }} [opcoes] as capacidades que o canal declarou no pedido: uma ação fora dela é recusada
 * @returns {{ ok: true, resposta: Readonly<{texto:string, acoes:readonly object[], confirmacao:object|null}> } | { ok: false, erros: object[] }}
 */
export function validarResposta(canal, bruto, { capacidades = null } = {}) {
  const erros = [];
  if (typeof canal !== 'string' || !CANAIS.includes(canal)) return { ok: false, erros: [erro('canal', 'canal-invalido', `O canal precisa ser um destes: ${CANAIS.join(', ')}.`)] };
  if (!ehObjetoSimples(bruto)) return { ok: false, erros: [erro(null, 'resposta-invalida', 'A resposta precisa ser um objeto.')] };
  const regras = REGRAS_DO_CANAL[canal];
  for (const campo of Object.keys(bruto)) {
    if (CAMPOS_DA_RESPOSTA.has(campo)) continue;
    if (CAMPO_DE_PAPEL_RE.test(campo)) erros.push(erro(campo.slice(0, 30), 'papel-na-resposta', 'A resposta não carrega papel nem permissão.'));
    else erros.push(erro(campo.slice(0, 30), 'campo-desconhecido', 'Campo desconhecido na resposta.'));
  }

  const acoes = bruto.acoes === undefined ? [] : bruto.acoes;
  if (!Array.isArray(acoes)) erros.push(erro('acoes', 'acoes-invalidas', '"acoes" precisa ser uma lista.'));
  else if (acoes.length > LIMITES.acoesMax) erros.push(erro('acoes', 'acoes-demais', `No máximo ${LIMITES.acoesMax} ações por resposta.`));
  else if (acoes.length && !regras.acoes) erros.push(erro('acoes', 'acoes-nao-permitidas', 'Este canal não executa ações: o texto da resposta é tudo que ele faz.'));
  else acoes.forEach((a, i) => validarAcao(a, i, canal, capacidades, erros));

  const temConfirmacao = bruto.confirmacao !== undefined && bruto.confirmacao !== null;
  if (temConfirmacao) {
    if (!regras.confirmacao) erros.push(erro('confirmacao', 'confirmacao-nao-permitida', 'Este canal não mostra pedido de confirmação (só os canais privados do dono).'));
    else validarConfirmacao(bruto.confirmacao, erros);
  }

  if (typeof bruto.texto !== 'string') erros.push(erro('texto', 'texto-invalido', '"texto" precisa ser um texto.'));
  else {
    if (CONTROLE_RE.test(bruto.texto)) erros.push(erro('texto', 'texto-com-controle', 'O texto tem caracteres de controle.'));
    for (const codigo of problemasDeEstilo(canal, bruto.texto)) erros.push(erro('texto', codigo, TEXTO_DO_PROBLEMA[codigo] ?? 'O texto não cumpre o estilo do canal.'));
    if (!bruto.texto.trim() && !(Array.isArray(acoes) && acoes.length) && !temConfirmacao) erros.push(erro('texto', 'resposta-vazia', 'A resposta não tem texto, ação nem confirmação.'));
  }

  if (erros.length) return { ok: false, erros };
  return {
    ok: true,
    resposta: Object.freeze({
      texto: bruto.texto,
      acoes: Object.freeze(acoes.map((a) => Object.freeze({ id: a.id, tipo: a.tipo, ...(a.parametros !== undefined ? { parametros: a.parametros } : {}) }))),
      confirmacao: temConfirmacao ? Object.freeze({ id: bruto.confirmacao.id, resumo: bruto.confirmacao.resumo, nivel: bruto.confirmacao.nivel, expiraEmMs: bruto.confirmacao.expiraEmMs }) : null,
    }),
  };
}
