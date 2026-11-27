// Imagem no Chat do app (lacunas do painel, item 11; princípio 9: toda função também por conversa). Liga com YUI_APP_IMAGEM=true (padrão DESLIGADA).
//
// Quem GERA a imagem é o código do bot: src/handlers/imageHandler.js usa o @gradio/client e mora nos handlers, que o Core não pode carregar
// (tests/test-core-import-graph.js). Por isso o gerador é REGISTRADO por quem sobe a API, no mesmo molde da ponte do painel (registrarServidorDoPainel):
//  - processo único: o src/index.js registra o gerador do bot (src/handlers/imagemParaApp.js), que devolve os bytes em memória;
//  - cérebro separado: o src/cerebro.js registra `geradorPeloBot` (abaixo). O pedido vai ao bot pelo canal (`imagem.gerar`); o bot grava a imagem numa
//    pasta temporária com um nome ALEATÓRIO e devolve só esse nome (o quadro do canal tem 1 MB, pouco para uma imagem); o cérebro confere, lê e apaga.
// Sem gerador registrado (testes, dev:api), a ferramenta não aparece e a pré-rota não dispara.
//
// Regras (tests/test-imagem-app.js):
//  - só com a chave ligada, o gerador registrado e a generate_image ligada no padrão global (no app não há servidor: vale o mesmo da DM);
//  - a política: o papel mínimo da ferramenta (imagem.gerar, MEMBER) e o motor de políticas (chat.generate_image; POLICY_CHAT_AUTONOMY aperta);
//  - o MESMO filtro de conteúdo impróprio do despachante do Discord e o MESMO limite por pessoa por hora (YUI_IMAGE_PER_HOUR; o dono não tem limite),
//    contado num lugar só: a memória do bot, somando Discord e app (com o cérebro separado, pela `cotaPeloBot`; correção C4 do parecer da Liz);
//  - a imagem volta ao app por um LINK CURTO, no molde do link dos arquivos do BDS (server.js): o próprio código do link é a credencial, vale o mesmo
//    prazo curto (LINK_TTL_MS) e aponta para os BYTES guardados na memória, nunca para um caminho de arquivo do servidor; o arquivo temporário é apagado na hora;
//  - a auditoria leva só a via, o resultado e o tamanho do pedido: o texto do pedido nunca vai para o log nem para a auditoria.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit as coreAudit } from './audit.js';
import { checkToolAccess, POLICY_STATES, ROLES } from './permissions.js';
import { getPolicyEngine } from './security/policyEngine.js';
import { LINK_TTL_MS } from './api/bds.js';
import { takeImageQuota, imageLimitPerHour, pedidoDeImagemImproprio } from '../handlers/imageIntent.js';

export const FERRAMENTA_DE_IMAGEM = 'imagem.gerar';
/** O mesmo prazo do link curto dos arquivos (o app já mostra esse número em /v1/admin/overview, limits.fileLinkMinutes). */
export const LINK_DA_IMAGEM_MS = LINK_TTL_MS;
/** Prazo da geração. A rota HTTP espera até 120 s e o app até 130 s: a resposta "demorou" chega antes de qualquer um desistir. */
export const PRAZO_DA_IMAGEM_MS = 100_000;
export const MAX_IMAGENS_GUARDADAS = 20;
export const MAX_BYTES_DA_IMAGEM = 8 * 1024 * 1024;
export const PEDIDO_MAX = 400;
export const ALT_MAX = 160;
/** Nome do arquivo que o bot entrega ao cérebro: só hexadecimal (nada de caminho, ponto ou barra). */
export const ID_DA_ENTREGA_RE = /^[a-f0-9]{32}$/;
export const EXTENSAO_DA_ENTREGA = '.img';
/** Arquivo de entrega esquecido (o cérebro desistiu antes de ler) sai depois disto. */
export const IDADE_MAX_DA_ENTREGA_MS = 15 * 60 * 1000;
/** Pasta da entrega bot -> cérebro: os dois processos rodam com o mesmo usuário, na mesma máquina. */
export const pastaDasImagens = () => path.join(os.tmpdir(), 'yui-imagens-app');
/** O caminho que o app recebe: só este formato (o app confere de novo antes de abrir). */
export const URL_DA_IMAGEM_RE = /^\/v1\/imagem\/[A-Za-z0-9_-]{16,64}$/;

export const TEXTOS_DA_IMAGEM = Object.freeze({
  pronta: 'Pronto, aqui está a imagem.',
  improprio: 'Não vou gerar essa imagem: o pedido tem conteúdo impróprio.',
  limite: (min) => `Calma, já gerei várias imagens para você nesta hora. Tenta de novo daqui a ${min} min.`,
  falhou: 'Não consegui gerar a imagem agora. Tenta de novo daqui a pouco.',
  demorou: 'A geração da imagem demorou demais. Tenta de novo daqui a pouco.',
  indisponivel: 'A geração de imagem está indisponível agora.',
  vazio: 'Diga o que você quer na imagem.',
});

export function imagemDoAppLigada(env = process.env) {
  return String(env?.YUI_APP_IMAGEM ?? 'false').trim().toLowerCase() === 'true';
}

// ── A generate_image no padrão global (meta.defaultDisabled do mcp_tools.json): no app não há servidor, então vale o mesmo da DM ──
const MCP_TOOLS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'mcp_tools.json');
let cacheDoPadrao = { arquivo: null, mtimeMs: -1, desligada: false };
/** Falha ao ler = ligada, como o isToolDisabled do bot (sem a lista, nada é desligado por padrão). */
export function imagemDesligadaNoPadrao(arquivo = MCP_TOOLS) {
  try {
    const st = fs.statSync(arquivo);
    if (cacheDoPadrao.arquivo === arquivo && cacheDoPadrao.mtimeMs === st.mtimeMs) return cacheDoPadrao.desligada;
    const lista = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    const t = Array.isArray(lista) ? lista.find((x) => x?.function?.name === 'generate_image') : null;
    cacheDoPadrao = { arquivo, mtimeMs: st.mtimeMs, desligada: Boolean(t?.meta?.defaultDisabled) };
    return cacheDoPadrao.desligada;
  } catch {
    return false;
  }
}

/** O tipo pelo CONTEÚDO (os primeiros bytes), nunca pela extensão. Só os formatos que os provedores devolvem; o resto é recusado. */
export function tipoDaImagem(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  return null;
}

const modeloCurto = (m) => (typeof m === 'string' && m.trim() ? m.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : null);
const SEM_CONTROLE = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();

/** O texto alternativo da imagem (leitor de tela e imagem que não carregou): o assunto pedido, curto. Vai só para quem pediu. */
export function textoAlternativo(pedido) {
  const t = SEM_CONTROLE(pedido);
  const base = t ? `Imagem gerada pela Yui: ${t}` : 'Imagem gerada pela Yui';
  return base.length > ALT_MAX ? `${base.slice(0, ALT_MAX - 1)}…` : base;
}

// ── O gerador registrado por quem sobe a API ──
let geradorRegistrado = null;
let cotaRegistrada = null;
/**
 * @param {null | ((pedido: { prompt: string }) => Promise<null | { buffer: Buffer, modelo?: string|null } | { indisponivel: true }>)} fn
 * @param {{ cota?: (userId: string, o: { isOwner: boolean, limit: number }) => ({ ok: boolean, retryAfterMs?: number } | Promise<{ ok: boolean, retryAfterMs?: number }>) }} [o]
 *   cota: quem conta o limite por hora (correção C4 do parecer da Liz, docs/PLANO_LACUNAS_PAINEL_CORRECOES.md). Sem ela, conta aqui mesmo com a
 *   takeImageQuota do imageIntent.js: no processo único é a MESMA memória do Discord. Com o cérebro separado, o src/cerebro.js registra `cotaPeloBot`,
 *   e o bot conta na memória dele, a mesma do Discord: um limite só por pessoa, somando Discord e app (antes cada processo contava o seu e o limite dobrava).
 */
export function registrarGeradorDeImagem(fn, { cota } = {}) {
  geradorRegistrado = typeof fn === 'function' ? fn : null;
  cotaRegistrada = geradorRegistrado && typeof cota === 'function' ? cota : null;
}
export const geradorDeImagemRegistrado = () => geradorRegistrado;
/** A cota em uso: a registrada (o bot, com o cérebro separado) ou a da memória deste processo (processo único: a mesma do Discord). */
export const cotaDaImagemRegistrada = () => cotaRegistrada ?? takeImageQuota;

/** Apaga as entregas esquecidas (o cérebro desistiu antes de ler). Só arquivos com o nome do formato da entrega; nunca lança. */
export function limparEntregasAntigas({ pasta = pastaDasImagens(), agora = Date.now(), idadeMs = IDADE_MAX_DA_ENTREGA_MS } = {}) {
  let removidos = 0;
  try {
    for (const nome of fs.readdirSync(pasta)) {
      if (!nome.endsWith(EXTENSAO_DA_ENTREGA) || !ID_DA_ENTREGA_RE.test(nome.slice(0, -EXTENSAO_DA_ENTREGA.length))) continue;
      const arquivo = path.join(pasta, nome);
      try {
        if (agora - fs.statSync(arquivo).mtimeMs > idadeMs) { fs.rmSync(arquivo, { force: true }); removidos++; }
      } catch { /* sumiu no meio */ }
    }
  } catch { /* pasta ainda não existe */ }
  return removidos;
}

/**
 * O cérebro lê a entrega do bot: confere o nome (só hexadecimal), o tamanho e o tipo pelo conteúdo, e APAGA o arquivo (sempre, mesmo se recusar).
 * @returns {null | { buffer: Buffer, tipo: string, modelo: string|null }}
 */
export function lerEntregaDoBot({ id, modelo = null, pasta = pastaDasImagens() } = {}) {
  if (!ID_DA_ENTREGA_RE.test(String(id ?? ''))) return null;
  const arquivo = path.join(pasta, `${id}${EXTENSAO_DA_ENTREGA}`);
  try {
    const st = fs.lstatSync(arquivo);
    if (!st.isFile() || st.size > MAX_BYTES_DA_IMAGEM) return null;
    const buffer = fs.readFileSync(arquivo);
    const tipo = tipoDaImagem(buffer);
    return tipo ? { buffer, tipo, modelo: modeloCurto(modelo) } : null;
  } catch {
    return null;
  } finally {
    try { fs.rmSync(arquivo, { force: true }); } catch { /* já saiu */ }
  }
}

/** O gerador do CÉREBRO separado: pede ao bot pelo canal e lê a entrega. Bot fora = indisponível (nada é gerado aqui). */
export function geradorPeloBot({ channel, pasta = pastaDasImagens(), timeoutMs = PRAZO_DA_IMAGEM_MS } = {}) {
  return async ({ prompt }) => {
    if (!channel?.isConnected?.('bot')) return { indisponivel: true };
    const r = await channel.request('bot', 'imagem.gerar', { prompt: String(prompt ?? '').slice(0, PEDIDO_MAX) }, { timeoutMs });
    if (!r || typeof r.id !== 'string') return null;
    return lerEntregaDoBot({ id: r.id, modelo: r.modelo, pasta });
  };
}

/** Prazo da pergunta da cota ao bot: é só uma conta na memória. */
export const PRAZO_DA_COTA_MS = 5_000;

/**
 * A cota do CÉREBRO separado: pergunta ao bot (`imagem.cota`), que conta na mesma memória do Discord e decide sozinho se é o dono e qual é o
 * limite (as regras do Discord). Só vai o ID de quem pediu. Bot fora ou resposta estranha: lança, e o serviço responde "indisponível" sem gerar.
 */
export function cotaPeloBot({ channel, timeoutMs = PRAZO_DA_COTA_MS } = {}) {
  return async (userId) => {
    if (!channel?.isConnected?.('bot')) throw Object.assign(new Error('bot fora do canal'), { code: 'INDISPONIVEL' });
    const r = await channel.request('bot', 'imagem.cota', { userId: String(userId ?? '') }, { timeoutMs });
    if (!r || typeof r.ok !== 'boolean') throw Object.assign(new Error('resposta da cota inválida'), { code: 'INDISPONIVEL' });
    return r.ok ? { ok: true } : { ok: false, retryAfterMs: Number(r.retryAfterMs) || 60 * 60 * 1000 };
  };
}

function comPrazo(promessa, ms) {
  let timer = null;
  const prazo = new Promise((_, rejeitar) => {
    timer = setTimeout(() => rejeitar(Object.assign(new Error('prazo da imagem esgotado'), { code: 'PRAZO' })), ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promessa), prazo]).finally(() => clearTimeout(timer));
}

/**
 * O serviço da imagem no app (um por processo; os testes criam o deles).
 * `gerar` devolve { kind, texto, imagem?, limite? }: o texto é a resposta da Yui; `imagem` é { url, alt, expiresInSec } (o link curto, nunca um caminho);
 * `limite` é { minutos } quando o limite por hora barrou.
 */
export function criarImagensDoApp({
  env = process.env,
  gerador = geradorDeImagemRegistrado,
  now = Date.now,
  token = () => crypto.randomBytes(24).toString('base64url'),
  ttlMs = LINK_DA_IMAGEM_MS,
  max = MAX_IMAGENS_GUARDADAS,
  prazoMs = PRAZO_DA_IMAGEM_MS,
  audit = coreAudit,
  desligadaNoPadrao = () => imagemDesligadaNoPadrao(),
  cota = null, // null = a registrada (cotaDaImagemRegistrada): o bot com o cérebro separado, a memória deste processo no processo único
  policy = getPolicyEngine,
} = {}) {
  const links = new Map(); // código -> { buffer, tipo, expires }

  function prune() {
    const t = now();
    for (const [k, v] of links) if (v.expires <= t) links.delete(k);
    while (links.size > max) links.delete(links.keys().next().value);
  }

  /** Ligada de verdade: a chave, um gerador registrado e a generate_image ligada no padrão global. */
  const ligada = () => imagemDoAppLigada(env) && typeof gerador() === 'function' && !desligadaNoPadrao();

  /** A ferramenta aparece para esta pessoa? (ligada + o papel mínimo da política da ferramenta). */
  function disponivel(ctx) {
    try { return ligada() && checkToolAccess(ctx, FERRAMENTA_DE_IMAGEM).allowed; } catch { return false; }
  }

  /**
   * @param {{ ctx: object, prompt: string, via?: 'prerota'|'ferramenta', origin?: string, conferirPolitica?: boolean }} p
   *   conferirPolitica=false só para quem já passou pelo motor de políticas (o runAgent faz o gate antes de chamar a ferramenta).
   */
  async function gerar({ ctx, prompt, via = 'ferramenta', origin, conferirPolitica = true } = {}) {
    const pedido = SEM_CONTROLE(prompt).slice(0, PEDIDO_MAX);
    const registrar = (resultado, extra = {}) => { try { audit('api.imagem', ctx, { via, resultado, chars: pedido.length, ...extra }); } catch { /* a auditoria nunca derruba o pedido */ } };
    if (!ligada()) { registrar('desligada'); return { kind: 'imagem.indisponivel', texto: TEXTOS_DA_IMAGEM.indisponivel }; }
    const acesso = checkToolAccess(ctx, FERRAMENTA_DE_IMAGEM);
    if (!acesso.allowed) { registrar('negada'); return { kind: 'imagem.negada', texto: `Não posso fazer isso aqui (${acesso.reason}).` }; }
    if (conferirPolitica) {
      const gated = policy().gate({ action: FERRAMENTA_DE_IMAGEM, ctx, origin, legacy: 'allow' });
      if (gated.decision !== POLICY_STATES.AUTO) {
        registrar('negada', { decisao: gated.decision });
        return { kind: 'imagem.negada', decisao: gated.decision, texto: `Não posso fazer isso aqui (${gated.verdict?.reason ?? 'política de segurança'}).` };
      }
    }
    if (!pedido) return { kind: 'imagem.vazia', texto: TEXTOS_DA_IMAGEM.vazio };
    if (pedidoDeImagemImproprio(pedido)) { registrar('improprio'); return { kind: 'imagem.recusada', texto: TEXTOS_DA_IMAGEM.improprio }; }
    let q;
    try {
      q = await (cota ?? cotaDaImagemRegistrada())(ctx?.userId, { isOwner: ctx?.role === ROLES.OWNER, limit: imageLimitPerHour(env) });
    } catch {
      q = null;
    }
    if (!q || typeof q.ok !== 'boolean') { registrar('indisponivel'); return { kind: 'imagem.indisponivel', texto: TEXTOS_DA_IMAGEM.indisponivel }; }
    if (!q.ok) {
      const minutos = Math.max(1, Math.ceil((Number(q.retryAfterMs) || 60 * 60 * 1000) / 60_000));
      registrar('limite');
      return { kind: 'imagem.limite', texto: TEXTOS_DA_IMAGEM.limite(minutos), limite: { minutos } };
    }
    let saida;
    try {
      saida = await comPrazo(gerador()({ prompt: pedido }), prazoMs);
    } catch (err) {
      const demorou = err?.code === 'PRAZO';
      registrar(demorou ? 'demorou' : 'falhou');
      return { kind: 'imagem.falhou', texto: demorou ? TEXTOS_DA_IMAGEM.demorou : TEXTOS_DA_IMAGEM.falhou };
    }
    if (saida?.indisponivel) { registrar('indisponivel'); return { kind: 'imagem.indisponivel', texto: TEXTOS_DA_IMAGEM.indisponivel }; }
    const buffer = saida?.buffer;
    const tipo = Buffer.isBuffer(buffer) && buffer.length <= MAX_BYTES_DA_IMAGEM ? tipoDaImagem(buffer) : null;
    if (!tipo) { registrar('falhou'); return { kind: 'imagem.falhou', texto: TEXTOS_DA_IMAGEM.falhou }; }
    prune();
    const codigo = token();
    links.set(codigo, { buffer, tipo, expires: now() + ttlMs });
    prune();
    registrar('ok', { bytes: buffer.length, modelo: modeloCurto(saida.modelo) });
    return { kind: 'imagem', texto: TEXTOS_DA_IMAGEM.pronta, imagem: { url: `/v1/imagem/${codigo}`, alt: textoAlternativo(pedido), expiresInSec: Math.round(ttlMs / 1000) } };
  }

  /** O link curto -> os bytes e o tipo (null = vencido ou inexistente). */
  function resolver(codigo) {
    prune();
    const v = links.get(String(codigo ?? ''));
    return v && v.expires > now() ? { buffer: v.buffer, tipo: v.tipo } : null;
  }

  return { ligada, disponivel, gerar, resolver, _links: links };
}

let compartilhado = null;
/** O serviço do processo (a ferramenta, a pré-rota e a rota do link usam o mesmo). */
export function imagensDoApp() {
  compartilhado ??= criarImagensDoApp();
  return compartilhado;
}
export function definirImagensDoAppParaTestes(servico) {
  compartilhado = servico ?? null;
}
