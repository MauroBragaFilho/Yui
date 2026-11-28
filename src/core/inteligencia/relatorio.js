// O relatório do interpretador em observação (Fase B), em função pura para o script (scripts/interpretacao-relatorio.mjs) e para o teste.
// Só leitura: lê o JSONL, não chama IA e não altera nada.
import fs from 'node:fs';
import path from 'node:path';
import { percentil, concorda, pct } from './metricas.js';

/** Lê o JSONL (e os girados, com `tudo`). Devolve { registros, ilegiveis }. */
export function lerRegistros(arquivo, { tudo = false } = {}) {
  const lista = [arquivo];
  if (tudo) {
    const dir = path.dirname(arquivo);
    const base = path.basename(arquivo, '.jsonl');
    try { for (const n of fs.readdirSync(dir)) if (n.startsWith(`${base}.`) && n.endsWith('.jsonl')) lista.push(path.join(dir, n)); } catch { /* */ }
  }
  const registros = [];
  let ilegiveis = 0;
  for (const p of lista.filter((x) => fs.existsSync(x))) {
    for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (!l.trim()) continue;
      try { registros.push(JSON.parse(l)); } catch { ilegiveis += 1; }
    }
  }
  return { registros, ilegiveis };
}

/** Os números do relatório. `dias`: só os registros dos últimos N dias. */
export function resumir(registros, { dias = 0, ilegiveis = 0, arquivo = null } = {}) {
  const desde = Number.isInteger(dias) && dias > 0 ? Date.now() - dias * 86_400_000 : 0;
  const regs = registros.filter((r) => !desde || Date.parse(r.data) >= desde);
  const comResultado = regs.filter((r) => r.interpretacao);
  const falhas = regs.filter((r) => !r.interpretacao);
  const motivos = {};
  for (const r of falhas) motivos[r.motivo ?? 'sem-motivo'] = (motivos[r.motivo ?? 'sem-motivo'] ?? 0) + 1;
  const dist = {};
  for (const r of comResultado) dist[r.interpretacao.intencao] = (dist[r.interpretacao.intencao] ?? 0) + 1;
  const pre = {};
  for (const r of regs) pre[r.preRota ?? 'nenhuma'] = (pre[r.preRota ?? 'nenhuma'] ?? 0) + 1;
  const comparaveis = comResultado.map((r) => ({ r, c: concorda(r.preRota, r.interpretacao.intencao) })).filter((x) => x.c !== null);
  const iguais = comparaveis.filter((x) => x.c).length;
  const discord = {};
  for (const { r, c } of comparaveis) if (!c) { const k = `${r.preRota ?? 'nenhuma'} -> ${r.interpretacao.intencao}`; discord[k] = (discord[k] ?? 0) + 1; }
  const lat = regs.map((r) => r.latenciaMs).filter(Number.isFinite);
  const datas = regs.map((r) => r.data).filter(Boolean).sort();
  return {
    arquivo, registros: regs.length, linhasIlegiveis: ilegiveis,
    periodo: { de: datas[0] ?? null, ate: datas.at(-1) ?? null },
    comInterpretacao: comResultado.length, falhas: falhas.length, motivosDeFalha: motivos,
    concordancia: { comparaveis: comparaveis.length, iguais, taxa: comparaveis.length ? iguais / comparaveis.length : null },
    distribuicaoDeIntencoes: dist, preRotas: pre,
    confiantes: comResultado.filter((r) => r.interpretacao.confianca >= 0.8 && !r.interpretacao.ambigua).length,
    latenciaMs: { p50: percentil(lat, 50), p95: percentil(lat, 95) },
    tokensEstimados: regs.map((r) => r.tokensEst).filter(Number.isFinite).reduce((a, b) => a + b, 0),
    discordancias: Object.entries(discord).sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
}

/** O texto do relatório para o terminal. */
export function formatar(s) {
  const o = [];
  o.push(`Interpretador em observação: ${s.registros} registros (${s.periodo.de} a ${s.periodo.ate})`);
  o.push(`Arquivo: ${s.arquivo}${s.linhasIlegiveis ? `  (${s.linhasIlegiveis} linha(s) ilegível(is) ignorada(s))` : ''}`);
  o.push(`\nConcordância com a pré-rota: ${s.concordancia.iguais}/${s.concordancia.comparaveis} (${pct(s.concordancia.taxa)})`);
  o.push(`Pré-rotas que pegaram: ${Object.entries(s.preRotas).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  o.push('\nDistribuição de intenções (interpretador):');
  for (const [k, v] of Object.entries(s.distribuicaoDeIntencoes).sort((a, b) => b[1] - a[1])) o.push(`  ${k.padEnd(20)} ${String(v).padStart(5)}  ${pct(v / s.comInterpretacao)}`);
  o.push(`\nCom confiança >= 0,8 e sem ambiguidade: ${s.confiantes}/${s.comInterpretacao}`);
  o.push(`Latência: p50=${s.latenciaMs.p50 ?? '-'} ms  p95=${s.latenciaMs.p95 ?? '-'} ms (meta p95 <= 1500 ms)`);
  o.push(`Tokens estimados: ${s.tokensEstimados}`);
  o.push(`\nFalhas: ${s.falhas}/${s.registros}${s.falhas ? `  ${Object.entries(s.motivosDeFalha).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`);
  if (s.discordancias.length) {
    o.push('\nDiscordâncias mais comuns (pré-rota -> interpretador):');
    for (const [k, v] of s.discordancias) o.push(`  ${String(v).padStart(4)}  ${k}`);
  }
  return o.join('\n');
}

/** A avaliação com a IA real só roda com --real (ou YUI_AVALIAR_REAL=1): gasta cota. */
export function avaliacaoLiberada(args = [], env = process.env) {
  return args.includes('--real') || env?.YUI_AVALIAR_REAL === '1';
}
