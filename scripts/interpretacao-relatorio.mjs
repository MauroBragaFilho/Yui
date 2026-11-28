// Relatório do interpretador em observação (Fase B): lê logs/interpretacao.jsonl (e os arquivos girados, com --tudo) e mostra a concordância com a pré-rota,
// a distribuição de intenções, a latência p50/p95 e as falhas. Só leitura: não chama IA nem altera nada.
// Uso: node scripts/interpretacao-relatorio.mjs [arquivo] [--tudo] [--dias N] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { percentil, concorda, pct } from '../src/core/inteligencia/metricas.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const valor = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const posicional = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--dias');
const arquivo = path.resolve(posicional || process.env.YUI_INTERPRETACAO_ARQUIVO || path.join('logs', 'interpretacao.jsonl'));
const dias = Number.parseInt(valor('--dias') ?? '', 10);

function arquivosDoLog() {
  const lista = [arquivo];
  if (flag('--tudo')) {
    const dir = path.dirname(arquivo);
    const base = path.basename(arquivo, '.jsonl');
    try { for (const n of fs.readdirSync(dir)) if (n.startsWith(`${base}.`) && n.endsWith('.jsonl')) lista.push(path.join(dir, n)); } catch { /* */ }
  }
  return lista.filter((p) => fs.existsSync(p));
}

const linhas = [];
let ruins = 0;
for (const p of arquivosDoLog()) {
  for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!l.trim()) continue;
    try { linhas.push(JSON.parse(l)); } catch { ruins += 1; }
  }
}
const desde = Number.isInteger(dias) && dias > 0 ? Date.now() - dias * 86_400_000 : 0;
const regs = linhas.filter((r) => !desde || Date.parse(r.data) >= desde);

if (!regs.length) {
  console.log(`Sem registros em ${arquivo}. Ligue YUI_INTERPRETADOR=observar e converse com a Yui.`);
  process.exit(0);
}

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
const discordancias = comparaveis.filter((x) => !x.c);
const lat = regs.map((r) => r.latenciaMs).filter(Number.isFinite);
const tokens = regs.map((r) => r.tokensEst).filter(Number.isFinite).reduce((a, b) => a + b, 0);
const confiantes = comResultado.filter((r) => r.interpretacao.confianca >= 0.8 && !r.interpretacao.ambigua);

const saida = {
  arquivo, registros: regs.length, linhasIlegiveis: ruins,
  periodo: { de: regs.map((r) => r.data).sort()[0], ate: regs.map((r) => r.data).sort().at(-1) },
  comInterpretacao: comResultado.length, falhas: falhas.length, motivosDeFalha: motivos,
  concordancia: { comparaveis: comparaveis.length, iguais, taxa: comparaveis.length ? iguais / comparaveis.length : null },
  distribuicaoDeIntencoes: dist, preRotas: pre,
  confiantes: confiantes.length,
  latenciaMs: { p50: percentil(lat, 50), p95: percentil(lat, 95) },
  tokensEstimados: tokens,
  discordancias: Object.entries(discordancias.reduce((a, { r }) => { const k = `${r.preRota ?? 'nenhuma'} -> ${r.interpretacao.intencao}`; a[k] = (a[k] ?? 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 10),
};

if (flag('--json')) { console.log(JSON.stringify(saida, null, 2)); process.exit(0); }

console.log(`Interpretador em observação: ${saida.registros} registros (${saida.periodo.de} a ${saida.periodo.ate})`);
console.log(`Arquivo: ${arquivo}${ruins ? `  (${ruins} linha(s) ilegível(is) ignorada(s))` : ''}`);
console.log(`\nConcordância com a pré-rota: ${iguais}/${comparaveis.length} (${pct(saida.concordancia.taxa)})`);
console.log('Pré-rotas que pegaram:', Object.entries(pre).map(([k, v]) => `${k}=${v}`).join(', '));
console.log('\nDistribuição de intenções (interpretador):');
for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${String(v).padStart(5)}  ${pct(v / comResultado.length)}`);
console.log(`\nCom confiança >= 0,8 e sem ambiguidade: ${confiantes.length}/${comResultado.length}`);
console.log(`Latência: p50=${saida.latenciaMs.p50 ?? '-'} ms  p95=${saida.latenciaMs.p95 ?? '-'} ms (meta p95 <= 1500 ms)`);
console.log(`Tokens estimados: ${tokens}`);
console.log(`\nFalhas: ${falhas.length}/${regs.length}${falhas.length ? '  ' + Object.entries(motivos).map(([k, v]) => `${k}=${v}`).join(', ') : ''}`);
if (saida.discordancias.length) {
  console.log('\nDiscordâncias mais comuns (pré-rota -> interpretador):');
  for (const [k, v] of saida.discordancias) console.log(`  ${String(v).padStart(4)}  ${k}`);
}
