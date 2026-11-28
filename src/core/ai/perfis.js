// PERFIS DE IA (etapa 9, docs/RELATORIO_ETAPA9_PERFIS_IA.md): a camada de perfis do Motor 0 (o motor nativo da Yui).
//
// O que é um perfil: uma MODALIDADE DE EXECUÇÃO da IA (conversa, rapido, pesquisa, raciocinio, privado, visao, e o `local`, reservado e desligado).
// Ele diz só COMO chamar a IA: qual `modelo` vai no campo "model" do pedido (o id de um combo do OmniRoute, ou um modelo), quantos tokens no
// máximo, qual a classificação de privacidade e por qual provedor cadastrado na Yui o pedido segue. NÃO é um agente: nenhum perfil tem persona,
// memória, ferramentas nem permissão (a configuração com qualquer campo desses é recusada). O modelo escolhido não concede permissão nenhuma:
// o motor de políticas e o guardToolCall continuam valendo, iguais, para qualquer perfil.
//
// Quem escolhe o quê: o CÉREBRO escolhe o perfil (src/cerebro/seletorPerfil.js, por regras simples, sem chamar IA) e o OMNIROUTE escolhe o
// provedor dentro do combo. A Yui NÃO tem um segundo roteador de modelos: um perfil dá UMA chamada ao OmniRoute (nada de revezar provedores aqui).
//
// Configuração (nada liga por padrão; sem configuração, o fluxo de hoje continua EXATAMENTE igual):
//   YUI_IA_PERFIS          JSON { "conversa": { "modelo": "auto", "maxTokens": 1024, "privacidade": "geral" }, ... }
//   YUI_IA_PERFIS_ARQUIVO  caminho de um arquivo com o mesmo JSON (a variável vence o arquivo, perfil por perfil)
// Cada perfil: `modelo` (obrigatório), `maxTokens` (64 a 8192; o efetivo é cortado pelo teto, veja limiteDoPerfil), `privacidade` EXPLÍCITA
// ("geral" ou "privada"), `provedor` (o id de um provedor cadastrado na Yui; padrão "omniroute"), `habilitado` (padrão true).
// O perfil `privado` é o único "privada" e exige, além disso: `chaveVinculada: true` (a declaração de que a chave do provedor está vinculada ao
// combo no OmniRoute), `provedoresPermitidos` (a lista dos provedores privados permitidos) e `decisao` (o formato estrito do cabeçalho de decisão;
// sem ele o perfil privado não habilita: veja src/core/ai/decisaoOmniRoute.js). O modelo do privado nunca é um combo virtual ("auto", "auto/...").
// NUNCA "auto/chaos" (dispara um painel de modelos em paralelo e gasta cota): qualquer modelo com "chaos" é recusado na validação.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadProviders } from '../../gateway/providers.js';
import { tetoGlobal, CAPACIDADE_PADRAO } from './limitesTokens.js';
import { validarFormatoEstrito, ID_DE_PROVEDOR_RE } from './decisaoOmniRoute.js';

/** Os perfis que existem. `local` é RESERVADO: aceito na configuração, mas nunca ativo nesta fase (o ponto de ligação de uma IA local, no futuro). */
export const NOMES_DE_PERFIL = Object.freeze(['conversa', 'rapido', 'pesquisa', 'raciocinio', 'privado', 'visao', 'interpretar', 'local']);
/** O teto absoluto de saída de um perfil: nenhuma chamada por perfil pede mais que isto, qualquer que seja a configuração. */
export const TETO_DO_PERFIL = 4096;
export const MAX_TOKENS_MIN = 64;
export const MAX_TOKENS_MAX = 8192;
/** O provedor padrão de um perfil: o OmniRoute cadastrado como provedor próprio (aiSettings TEMPLATES, id "omniroute"). */
export const PROVEDOR_PADRAO = 'omniroute';

const CHAVES_DO_PERFIL = new Set(['modelo', 'maxTokens', 'privacidade', 'provedor', 'habilitado', 'chaveVinculada', 'provedoresPermitidos', 'decisao', 'temperatura']);
/** Campos que fariam do perfil um "agente" (persona, memória, ferramentas, permissão...): recusados com um aviso próprio. */
const CAMPO_DE_AGENTE_RE = /persona|memori|memory|permiss|ferrament|tool|system|prompt|agente|agent|papel|role|identidade|skill/i;
const MODELO_RE = /^[A-Za-z0-9][\w.:@/-]{0,119}$/;
const ID_DE_PROVEDOR_DO_PERFIL_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

const erro = (perfil, campo, codigo, texto) => ({ perfil, campo, codigo, texto });

/** O modelo tem "chaos" (o combo que dispara um painel de modelos em paralelo)? Em qualquer posição, sem diferenciar maiúsculas. */
export function ehModeloChaos(modelo) {
  return /chaos/i.test(String(modelo ?? ''));
}
/** O modelo é um combo VIRTUAL do OmniRoute ("auto", "auto/fast"...)? Esses misturam provedores anônimos: nunca valem para o perfil privado. */
export function ehComboVirtual(modelo) {
  return /^auto(?:\/|$)/i.test(String(modelo ?? '').trim());
}

/**
 * Valida UM perfil. Devolve o perfil normalizado ou os erros (nunca os dois).
 * @returns {{ ok: true, perfil: object } | { ok: false, erros: object[] }}
 */
export function validarPerfil(nome, bruto) {
  const erros = [];
  const nada = () => ({ ok: false, erros });
  if (!NOMES_DE_PERFIL.includes(nome)) { erros.push(erro(nome, null, 'perfil-desconhecido', `"${String(nome).slice(0, 30)}" não é um perfil conhecido (${NOMES_DE_PERFIL.join(', ')}).`)); return nada(); }
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) { erros.push(erro(nome, null, 'perfil-invalido', 'O perfil precisa ser um objeto.')); return nada(); }
  for (const campo of Object.keys(bruto)) {
    if (CHAVES_DO_PERFIL.has(campo)) continue;
    if (CAMPO_DE_AGENTE_RE.test(campo)) erros.push(erro(nome, campo, 'campo-de-agente', `O perfil é uma modalidade de execução, não um agente: "${campo.slice(0, 30)}" (persona, memória, ferramentas ou permissão) não existe aqui.`));
    else erros.push(erro(nome, campo, 'campo-desconhecido', `Campo desconhecido: "${campo.slice(0, 30)}".`));
  }
  const privado = nome === 'privado';
  const reservado = nome === 'local';

  // habilitado
  if (bruto.habilitado !== undefined && typeof bruto.habilitado !== 'boolean') erros.push(erro(nome, 'habilitado', 'habilitado-invalido', '"habilitado" precisa ser true ou false.'));
  const habilitado = bruto.habilitado !== false;
  if (reservado && bruto.habilitado === true) erros.push(erro(nome, 'habilitado', 'local-reservado', 'O perfil "local" é reservado e fica desligado nesta fase.'));

  // modelo
  const modelo = typeof bruto.modelo === 'string' ? bruto.modelo.trim() : '';
  if (!modelo) erros.push(erro(nome, 'modelo', 'modelo-ausente', 'Informe o "modelo" (o id do combo ou do modelo que vai no campo model).'));
  else if (!MODELO_RE.test(modelo)) erros.push(erro(nome, 'modelo', 'modelo-invalido', 'Nome de modelo inválido (letras, números, ponto, dois-pontos, arroba, barra, sublinhado e hífen; até 120 caracteres).'));
  else if (ehModeloChaos(modelo)) erros.push(erro(nome, 'modelo', 'modelo-chaos', 'O combo "auto/chaos" nunca pode ser usado: ele dispara um painel de modelos em paralelo e gasta a cota.'));
  else if (privado && ehComboVirtual(modelo)) erros.push(erro(nome, 'modelo', 'modelo-virtual-no-privado', 'O perfil privado exige um combo próprio (autenticado e exclusivo), nunca um combo virtual "auto" (ele mistura provedores anônimos).'));

  // maxTokens
  const maxTokens = bruto.maxTokens;
  if (!Number.isInteger(maxTokens) || maxTokens < MAX_TOKENS_MIN || maxTokens > MAX_TOKENS_MAX) erros.push(erro(nome, 'maxTokens', 'max-tokens-invalido', `"maxTokens" precisa ser um número inteiro de ${MAX_TOKENS_MIN} a ${MAX_TOKENS_MAX} (o efetivo nunca passa de ${TETO_DO_PERFIL}).`));

  // temperatura (opcional, 0 a 2): o interpretador usa 0 (saída estável)
  if (bruto.temperatura !== undefined && !(typeof bruto.temperatura === 'number' && Number.isFinite(bruto.temperatura) && bruto.temperatura >= 0 && bruto.temperatura <= 2)) erros.push(erro(nome, 'temperatura', 'temperatura-invalida', '"temperatura" precisa ser um número de 0 a 2.'));

  // privacidade (explícita)
  if (bruto.privacidade === undefined) erros.push(erro(nome, 'privacidade', 'privacidade-ausente', 'Informe a "privacidade" de forma explícita: "geral" ou "privada".'));
  else if (bruto.privacidade !== 'geral' && bruto.privacidade !== 'privada') erros.push(erro(nome, 'privacidade', 'privacidade-invalida', '"privacidade" só pode ser "geral" ou "privada".'));
  else if (privado && bruto.privacidade !== 'privada') erros.push(erro(nome, 'privacidade', 'privacidade-incoerente', 'O perfil "privado" precisa ter privacidade "privada".'));
  else if (!privado && bruto.privacidade !== 'geral') erros.push(erro(nome, 'privacidade', 'privacidade-incoerente', `O perfil "${nome}" precisa ter privacidade "geral" (só o perfil "privado" é "privada" nesta fase).`));

  // provedor cadastrado na Yui
  const provedor = bruto.provedor === undefined ? PROVEDOR_PADRAO : bruto.provedor;
  if (typeof provedor !== 'string' || !ID_DE_PROVEDOR_DO_PERFIL_RE.test(provedor)) erros.push(erro(nome, 'provedor', 'provedor-invalido', '"provedor" precisa ser o id de um provedor cadastrado na Yui (letras minúsculas, números e hífen).'));

  // só o privado: a declaração da chave vinculada, a lista de provedores privados permitidos e o formato estrito da decisão
  let provedoresPermitidos = null;
  let decisao = null;
  if (privado) {
    if (bruto.chaveVinculada !== true) erros.push(erro(nome, 'chaveVinculada', 'chave-vinculada-ausente', 'O perfil privado exige "chaveVinculada": true (a declaração de que a chave do provedor está vinculada ao combo no OmniRoute).'));
    if (!Array.isArray(bruto.provedoresPermitidos) || !bruto.provedoresPermitidos.length) {
      erros.push(erro(nome, 'provedoresPermitidos', 'provedores-permitidos-ausente', 'O perfil privado exige "provedoresPermitidos": a lista dos provedores privados permitidos.'));
    } else {
      const lista = bruto.provedoresPermitidos.map((p) => (typeof p === 'string' ? p.trim().toLowerCase() : null));
      if (lista.length > 30 || lista.some((p) => !p || !ID_DE_PROVEDOR_RE.test(p))) erros.push(erro(nome, 'provedoresPermitidos', 'provedores-permitidos-invalidos', '"provedoresPermitidos" aceita até 30 ids de provedor (minúsculas, números, ponto, sublinhado e hífen).'));
      else provedoresPermitidos = [...new Set(lista)];
    }
    if (bruto.decisao !== undefined) {
      const f = validarFormatoEstrito(bruto.decisao);
      if (!f.ok) erros.push(erro(nome, 'decisao', 'decisao-invalida', 'O formato estrito do cabeçalho de decisão ("decisao") está inválido (formato "pares" ou "json" e o campo do provedor).'));
      else decisao = f.formato;
    }
  } else {
    for (const c of ['chaveVinculada', 'provedoresPermitidos', 'decisao']) {
      if (bruto[c] !== undefined) erros.push(erro(nome, c, 'campo-so-do-privado', `"${c}" só existe no perfil privado.`));
    }
  }

  if (erros.length) return nada();
  return {
    ok: true,
    perfil: {
      nome, modelo, maxTokens, privacidade: bruto.privacidade, provedor, habilitado: habilitado && !reservado,
      ...(bruto.temperatura !== undefined ? { temperatura: bruto.temperatura } : {}),
      ...(bruto.temperatura !== undefined ? { temperatura: bruto.temperatura } : {}),
      ...(privado ? { chaveVinculada: true, provedoresPermitidos, decisao } : {}),
    },
  };
}

/**
 * Valida a configuração inteira (um objeto { perfil: {...} }). Perfil inválido sai da lista (e vira um erro); os outros seguem.
 * @returns {{ perfis: Record<string, object>, declarados: string[], desligados: string[], erros: object[] }}
 *   `declarados`: os nomes que a configuração cita (mesmo os inválidos): o seletor precisa saber que o `privado` foi pedido;
 *   `desligados`: os que dizem `habilitado: false` (desligados de propósito).
 */
export function validarPerfis(bruto) {
  const out = { perfis: {}, declarados: [], desligados: [], erros: [] };
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) {
    out.erros.push(erro(null, null, 'config-invalida', 'A configuração dos perfis precisa ser um objeto JSON { "conversa": {...}, ... }.'));
    return out;
  }
  for (const [nome, cru] of Object.entries(bruto)) {
    if (NOMES_DE_PERFIL.includes(nome)) out.declarados.push(nome);
    if (cru && typeof cru === 'object' && cru.habilitado === false) out.desligados.push(nome);
    const r = validarPerfil(nome, cru);
    if (r.ok) out.perfis[nome] = r.perfil; else out.erros.push(...r.erros);
  }
  return out;
}

// ── Leitura da configuração (variável e/ou arquivo), com o cache pela assinatura ────────────────────────────────────────────────────

function lerJson(texto, origem, erros) {
  try { return JSON.parse(texto); } catch {
    erros.push(erro(null, null, 'json-invalido', `${origem}: o conteúdo não é um JSON válido (os perfis dessa origem foram ignorados).`));
    return null;
  }
}

const SEM_CONFIG = Object.freeze({ temConfig: false, origem: 'nenhuma', perfis: Object.freeze({}), declarados: Object.freeze([]), desligados: Object.freeze([]), erros: Object.freeze([]), assinatura: 'nenhuma' });
let cache = { chave: null, valor: SEM_CONFIG };

/**
 * A configuração dos perfis lida do ambiente. Barata quando não há nada configurado (nem toca o disco). Relê sozinha quando a variável
 * muda ou o arquivo é trocado (data de modificação): quem chama sempre vê a configuração de agora.
 * @returns {{ temConfig: boolean, origem: string, perfis: Record<string, object>, declarados: string[], desligados: string[], erros: object[], assinatura: string }}
 */
export function carregarPerfis(env = process.env) {
  const inline = String(env?.YUI_IA_PERFIS ?? '').trim();
  const arquivo = String(env?.YUI_IA_PERFIS_ARQUIVO ?? '').trim();
  if (!inline && !arquivo) return SEM_CONFIG;
  let mtime = 0;
  let tamanho = 0;
  if (arquivo) { try { const st = fs.statSync(path.resolve(arquivo)); mtime = st.mtimeMs; tamanho = st.size; } catch { mtime = -1; } }
  const chave = `${inline}\u0000${arquivo}\u0000${mtime}\u0000${tamanho}`;
  if (cache.chave === chave) return cache.valor;

  const erros = [];
  const origens = [];
  let doArquivo = {};
  let doAmbiente = {};
  if (arquivo) {
    if (mtime === -1) erros.push(erro(null, null, 'arquivo-ilegivel', 'YUI_IA_PERFIS_ARQUIVO: não consegui ler o arquivo (os perfis dessa origem foram ignorados).'));
    else {
      try {
        const j = lerJson(fs.readFileSync(path.resolve(arquivo), 'utf8').replace(/^﻿/, ''), 'YUI_IA_PERFIS_ARQUIVO', erros);
        if (j && typeof j === 'object' && !Array.isArray(j)) { doArquivo = j; origens.push('arquivo'); } else if (j !== null) erros.push(erro(null, null, 'config-invalida', 'YUI_IA_PERFIS_ARQUIVO: a configuração dos perfis precisa ser um objeto JSON.'));
      } catch { erros.push(erro(null, null, 'arquivo-ilegivel', 'YUI_IA_PERFIS_ARQUIVO: não consegui ler o arquivo (os perfis dessa origem foram ignorados).')); }
    }
  }
  if (inline) {
    const j = lerJson(inline, 'YUI_IA_PERFIS', erros);
    if (j && typeof j === 'object' && !Array.isArray(j)) { doAmbiente = j; origens.push('ambiente'); } else if (j !== null) erros.push(erro(null, null, 'config-invalida', 'YUI_IA_PERFIS: a configuração dos perfis precisa ser um objeto JSON.'));
  }
  // a variável vence o arquivo, perfil por perfil
  const junto = { ...doArquivo, ...doAmbiente };
  const v = validarPerfis(junto);
  const valor = Object.freeze({
    temConfig: true,
    origem: origens.length ? origens.join('+') : 'nenhuma',
    perfis: Object.freeze(v.perfis),
    declarados: Object.freeze(v.declarados),
    desligados: Object.freeze(v.desligados),
    erros: Object.freeze([...erros, ...v.erros]),
    // a assinatura muda quando a configuração muda (a rota privada volta a exigir verificação): só o hash do que vale, nunca o conteúdo
    assinatura: crypto.createHash('sha256').update(JSON.stringify({ p: v.perfis, d: v.declarados, x: v.desligados, e: erros.map((e) => e.codigo) })).digest('hex').slice(0, 16),
  });
  cache = { chave, valor };
  return valor;
}

/** Só para teste: esquece o cache da configuração. */
export function esquecerConfigDePerfisParaTeste() { cache = { chave: null, valor: SEM_CONFIG }; }

/** Os perfis válidos e habilitados (o `local` nunca entra). */
export function perfisAtivos(env = process.env) {
  const cfg = carregarPerfis(env);
  const out = {};
  for (const [nome, p] of Object.entries(cfg.perfis)) if (p.habilitado && nome !== 'local') out[nome] = p;
  return out;
}

/**
 * O dono pediu o perfil privado (mesmo que a configuração dele esteja incompleta)? Nesse caso a conversa privada NUNCA sai por outro caminho:
 * se o perfil não está completo e verificado, a chamada privada falha fechada. `habilitado: false` desliga de propósito (volta ao fluxo de hoje).
 */
export function privadoDeclarado(env = process.env) {
  const cfg = carregarPerfis(env);
  return cfg.temConfig && cfg.declarados.includes('privado') && !cfg.desligados.includes('privado');
}

// ── O provedor do perfil (cadastrado na Yui) e o limite de tokens ───────────────────────────────────────────────────────────────────

/**
 * O provedor cadastrado na Yui a que o perfil se refere (endpoint, chave, anonimato): o mesmo cadastro do Gateway (YUI_GATEWAY_CUSTOM e o painel).
 * A chave vem SÓ daqui: nunca do pedido de uma pessoa.
 * @returns {{ ok: true, provedor: { id: string, endpoint: string, chave: string|null, anonimo: boolean, maxTokens: number|null } } | { ok: false, codigo: 'provedor-nao-cadastrado' }}
 */
export function resolverProvedorDoPerfil(perfil, env = process.env) {
  let providers = [];
  try { providers = loadProviders(env).providers; } catch { providers = []; }
  const p = providers.find((x) => x.id === perfil?.provedor);
  if (!p) return { ok: false, codigo: 'provedor-nao-cadastrado' };
  return {
    ok: true,
    provedor: {
      id: p.id, endpoint: p.endpoint, chave: p.noAuth ? null : (p.keys?.[0] ?? null), anonimo: Boolean(p.anonymous),
      maxTokens: Number.isInteger(p.maxTokens) ? p.maxTokens : null,
    },
  };
}

/** A capacidade de saída CONHECIDA do provedor (a declarada no cadastro ou a da tabela da Yui), ou null: capacidade desconhecida não se inventa. */
export function capacidadeConhecida(provedor) {
  if (Number.isInteger(provedor?.maxTokens) && provedor.maxTokens >= MAX_TOKENS_MIN) return provedor.maxTokens;
  if (provedor?.id && Object.hasOwn(CAPACIDADE_PADRAO, provedor.id)) return CAPACIDADE_PADRAO[provedor.id];
  return null;
}

/**
 * O limite de tokens EFETIVO de uma chamada por perfil: o MENOR entre o `maxTokens` do perfil, a capacidade conhecida do provedor (se houver) e o
 * teto global (YUI_MAX_TOKENS_TETO, padrão 4096; os perfis nunca passam de 4096, qualquer que seja o teto).
 * @returns {{ efetivo: number, doPerfil: number, capacidade: number|null, teto: number }}
 */
export function limiteDoPerfil(perfil, provedor, env = process.env) {
  const teto = Math.min(tetoGlobal(env), TETO_DO_PERFIL);
  const capacidade = capacidadeConhecida(provedor);
  const candidatos = [perfil.maxTokens, teto, ...(capacidade ? [capacidade] : [])];
  return { efetivo: Math.max(MAX_TOKENS_MIN, Math.min(...candidatos)), doPerfil: perfil.maxTokens, capacidade, teto };
}

/**
 * A configuração do perfil privado está COMPLETA e verificável? (a parte que dá para conferir sem chamar nada). Cada item faltando é um código.
 * @returns {{ ok: boolean, motivos: string[], perfil: object|null, provedor: object|null }}
 */
export function avaliarConfigDoPrivado(env = process.env) {
  const cfg = carregarPerfis(env);
  const motivos = [];
  if (!cfg.declarados.includes('privado')) return { ok: false, motivos: ['perfil-nao-configurado'], perfil: null, provedor: null };
  const perfil = cfg.perfis.privado ?? null;
  if (!perfil) {
    for (const e of cfg.erros.filter((x) => x.perfil === 'privado')) if (!motivos.includes(e.codigo)) motivos.push(e.codigo);
    return { ok: false, motivos: motivos.length ? motivos : ['perfil-invalido'], perfil: null, provedor: null };
  }
  if (perfil.privacidade !== 'privada') motivos.push('privacidade-incoerente');
  if (perfil.chaveVinculada !== true) motivos.push('chave-vinculada-ausente');
  if (!perfil.provedoresPermitidos?.length) motivos.push('provedores-permitidos-ausente');
  if (!perfil.decisao) motivos.push('formato-nao-definido');
  const r = resolverProvedorDoPerfil(perfil, env);
  if (!r.ok) motivos.push(r.codigo);
  else {
    if (r.provedor.anonimo) motivos.push('provedor-anonimo');
    if (!r.provedor.chave) motivos.push('provedor-sem-chave');
  }
  return { ok: motivos.length === 0, motivos, perfil, provedor: r.ok ? r.provedor : null };
}
