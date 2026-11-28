// RETENÇÃO DA AUDITORIA (decisão do Braga em 28/11/2026: prazo máximo de 2 meses; docs/PLANO_TECNICO_LIVE_AMIGOS_ETAPA1.md §10.1).
//
// Vale para TODA a auditoria, em cada processo só para o PRÓPRIO arquivo (o cérebro do core-audit.jsonl; o bot, separado, do core-audit-bot.jsonl):
//  - o arquivo atual gira quando a PRIMEIRA linha tem mais de 30 dias (além do giro por tamanho, que já existia);
//  - um arquivo girado é apagado quando a PRIMEIRA linha dele (a mais antiga) passa do prazo (YUI_AUDIT_RETENCAO_DIAS, padrão 60): nenhuma linha
//    passa do prazo; as mais novas daquele arquivo saem um pouco antes (até 30 dias), o que está dentro da regra, porque o prazo é um MÁXIMO;
//  - o limite por quantidade (YUI_AUDIT_MAX_ROTATE, padrão 4) pode apagar antes, nunca depois;
//  - a conferência roda na subida e a cada 6 horas, mesmo sem gravação nova.
// ÂNCORA: antes de apagar, grava em <arquivo>-ancoras.jsonl o nome, a primeira e a última seq, o último hash, as datas, a quantidade de linhas e a
// verificação dos arquivos que restam. A âncora é CONFIRMADA (fsync e releitura) ANTES de apagar; se ela falhar, nada é apagado. Se a exclusão falhar
// depois da âncora, a rodada seguinte reconhece a âncora e não grava outra. A âncora não tem dado pessoal; ela registra evidências da cadeia
// apagada, mas não substitui uma cópia independente nem prova sozinha tudo o que existiu.
// Uma execução por vez: uma trava por arquivo neste processo.
import fs from 'node:fs';
import path from 'node:path';
import { auditFilePath, verifyAudit } from './audit.js';

const DIA = 86_400_000;
export const RETENCAO_PADRAO_DIAS = 60;
export const GIRO_POR_IDADE_DIAS = 30;
export const INTERVALO_RETENCAO_MS = 6 * 3_600_000;
const rodando = new Set();

export function retencaoDias(env = process.env) {
  const n = Number.parseInt(String(env.YUI_AUDIT_RETENCAO_DIAS ?? ''), 10);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : RETENCAO_PADRAO_DIAS;
}
export function maxGirados(env = process.env) {
  const n = Number.parseInt(String(env.YUI_AUDIT_MAX_ROTATE ?? ''), 10);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : 4;
}
export const arquivoDasAncoras = (file) => path.join(path.dirname(file), `${path.basename(file, '.jsonl')}-ancoras.jsonl`);

function linhasValidas(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** Data (ms) da primeira linha do arquivo, lendo só o começo. null se vazio ou sem data. */
export function primeiraData(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(16 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const l of buf.toString('utf8', 0, n).split('\n')) {
        if (!l.trim()) continue;
        try { const t = Date.parse(JSON.parse(l).ts); return Number.isFinite(t) ? t : null; } catch { return null; }
      }
      return null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function resumo(file) {
  const linhas = linhasValidas(file);
  if (!linhas.length) return null;
  const encadeadas = linhas.filter((l) => typeof l.seq === 'number');
  const primeira = linhas[0];
  const ultima = linhas[linhas.length - 1];
  return {
    primeiraSeq: encadeadas[0]?.seq ?? null, ultimaSeq: encadeadas.at(-1)?.seq ?? null, ultimoHash: encadeadas.at(-1)?.hash ?? null,
    primeiraData: primeira.ts ?? null, ultimaData: ultima.ts ?? null, linhas: linhas.length,
  };
}

function ancoraExiste(ancoras, nome, ultimoHash) {
  try { return linhasValidas(ancoras).some((a) => a.arquivo === nome && a.ultimoHash === ultimoHash); } catch { return false; }
}

/** Grava a âncora e CONFIRMA (fsync e releitura da última linha). Lança se não conferir. */
function gravarAncora(ancoras, registro) {
  fs.mkdirSync(path.dirname(ancoras), { recursive: true });
  const linha = `${JSON.stringify(registro)}\n`;
  const fd = fs.openSync(ancoras, 'a');
  try { fs.writeSync(fd, linha); try { fs.fsyncSync(fd); } catch { /* melhor esforço */ } } finally { fs.closeSync(fd); }
  const ultima = fs.readFileSync(ancoras, 'utf8').trimEnd().split('\n').at(-1);
  if (ultima !== linha.trimEnd()) throw new Error('âncora não conferiu');
}

/**
 * Apaga um arquivo girado SÓ depois de a âncora estar gravada e confirmada.
 * @returns {boolean} true se o arquivo foi apagado (ou já não existia)
 */
export function apagarComAncora(alvo, motivo, { base, gravar = gravarAncora, apagar = (f) => fs.rmSync(f) } = {}) {
  if (!fs.existsSync(alvo)) return true;
  const ancoras = arquivoDasAncoras(base ?? alvo.replace(/\.\d+$/, ''));
  const nome = path.basename(alvo);
  let r;
  try { r = resumo(alvo); } catch { return false; }
  if (r && !ancoraExiste(ancoras, nome, r.ultimoHash)) {
    const dir = path.dirname(alvo);
    const prefixo = path.basename(alvo).replace(/\.\d+$/, '');
    const restantes = fs.readdirSync(dir).filter((n) => n !== nome && (n === prefixo || (n.startsWith(`${prefixo}.`) && /\.\d+$/.test(n))));
    const verificacao = restantes.map((n) => { try { return { arquivo: n, ok: verifyAudit(path.join(dir, n)).ok }; } catch { return { arquivo: n, ok: false }; } });
    try {
      gravar(ancoras, { evento: 'audit.ancora', ts: new Date().toISOString(), arquivo: nome, motivo, ...r, verificacaoRestantes: verificacao });
    } catch {
      return false; // sem âncora confirmada, nada é apagado
    }
  }
  try { apagar(alvo); return true; } catch { return false; } // a âncora já está gravada: a próxima rodada só apaga
}

/** Gira o arquivo atual (atual -> .1 -> .2 ...). O que passar do limite por quantidade sai COM âncora; sem âncora, não gira. */
export function girarAuditoria(file = auditFilePath(), env = process.env, opcoes = {}) {
  if (!fs.existsSync(file)) return false;
  const max = maxGirados(env);
  for (let i = max; i <= max + 20; i++) {
    const excedente = `${file}.${i}`;
    if (fs.existsSync(excedente) && !apagarComAncora(excedente, 'quantidade', { base: file, ...opcoes })) return false;
  }
  for (let i = max - 1; i >= 1; i--) {
    const src = `${file}.${i}`;
    if (fs.existsSync(src)) fs.renameSync(src, `${file}.${i + 1}`);
  }
  fs.renameSync(file, `${file}.1`);
  return true;
}

/**
 * Uma rodada da retenção: gira o atual pela idade e apaga os girados vencidos (pela primeira linha).
 * @returns {{ ignorado?: boolean, girou: boolean, apagados: number }}
 */
export function aplicarRetencao({ file = auditFilePath(), env = process.env, agora = Date.now(), opcoes = {} } = {}) {
  if (rodando.has(file)) return { ignorado: true, girou: false, apagados: 0 };
  rodando.add(file);
  try {
    let girou = false;
    let apagados = 0;
    const pd = primeiraData(file);
    if (pd !== null && agora - pd > GIRO_POR_IDADE_DIAS * DIA) {
      try { girou = girarAuditoria(file, env, opcoes); } catch { girou = false; }
    }
    const prazo = retencaoDias(env) * DIA;
    const dir = path.dirname(file);
    const base = path.basename(file);
    let nomes = [];
    try { nomes = fs.readdirSync(dir); } catch { nomes = []; }
    for (const n of nomes) {
      if (!n.startsWith(`${base}.`) || !/\.\d+$/.test(n)) continue;
      const alvo = path.join(dir, n);
      const p = primeiraData(alvo);
      if (p !== null && agora - p > prazo && apagarComAncora(alvo, 'prazo', { base: file, ...opcoes })) apagados++;
    }
    return { girou, apagados };
  } finally {
    rodando.delete(file);
  }
}

/**
 * PRÉVIA da retenção (parecer da Liz de 28/11/2026): o que uma rodada FARIA, sem girar, gravar nem apagar nada.
 * Para cada arquivo: a primeira e a última seq, as datas, as linhas e a verificação da cadeia. E: se o atual giraria, o que sairia pelo prazo e
 * pela quantidade, e quantas âncoras seriam criadas.
 */
export function previaDaRetencao({ file = auditFilePath(), env = process.env, agora = Date.now() } = {}) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const prazo = retencaoDias(env) * DIA;
  const max = maxGirados(env);
  let nomes = [];
  try { nomes = fs.readdirSync(dir); } catch { nomes = []; }
  const girados = nomes.filter((n) => n.startsWith(`${base}.`) && /\.\d+$/.test(n)).map((n) => ({ n, i: Number(n.slice(base.length + 1)) })).sort((a, b) => a.i - b.i);
  const ficha = (f) => {
    let r = null;
    try { r = resumo(f); } catch { r = null; }
    let cadeiaOk = null;
    try { cadeiaOk = verifyAudit(f).ok; } catch { cadeiaOk = false; }
    return { arquivo: path.basename(f), ...(r ?? { linhas: 0 }), cadeiaOk };
  };
  const arquivos = [...(fs.existsSync(file) ? [ficha(file)] : []), ...girados.map((g) => ficha(path.join(dir, g.n)))];
  const pd = fs.existsSync(file) ? primeiraData(file) : null;
  const girariaPorIdade = pd !== null && agora - pd > GIRO_POR_IDADE_DIAS * DIA;
  // Depois de um giro, o índice de cada girado sobe 1; os que chegariam a passar do limite saem pela quantidade (com âncora).
  const apagariaPorQuantidade = girariaPorIdade ? girados.filter((g) => g.i >= max).map((g) => g.n) : [];
  const apagariaPorPrazo = girados.filter((g) => !apagariaPorQuantidade.includes(g.n)).filter((g) => {
    const p = primeiraData(path.join(dir, g.n));
    return p !== null && agora - p > prazo;
  }).map((g) => g.n);
  return {
    prazoDias: retencaoDias(env), maxGirados: max, arquivos, girariaPorIdade,
    apagariaPorQuantidade, apagariaPorPrazo, ancorasQueSeriamCriadas: apagariaPorQuantidade.length + apagariaPorPrazo.length,
  };
}

/** Liga a retenção: na subida e a cada 6 horas (o timer não segura o processo). */
export function iniciarRetencaoDaAuditoria({ file = auditFilePath(), env = process.env, logger = null, intervaloMs = INTERVALO_RETENCAO_MS } = {}) {
  const rodar = () => {
    try {
      const r = aplicarRetencao({ file, env });
      if (r.girou || r.apagados) logger?.info?.(`[Auditoria] retenção: ${r.girou ? 'arquivo girado' : 'sem giro'}, ${r.apagados} arquivo(s) vencido(s) apagado(s).`);
    } catch { /* a retenção nunca derruba o processo */ }
  };
  rodar();
  const t = setInterval(rodar, intervaloMs);
  t.unref?.();
  return () => clearInterval(t);
}

/** Para testes: a trava existe e uma segunda chamada simultânea é ignorada. */
export const __travaDaRetencao = rodando;
