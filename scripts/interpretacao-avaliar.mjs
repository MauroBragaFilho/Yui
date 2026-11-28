// Avalia o interpretador contra a bateria de frases rotuladas (tests/fixtures/interpretacao/frases.jsonl) usando a IA REAL (o perfil `interpretar`).
// OPT-IN: gasta cota de IA, por isso nunca roda no CI e exige --real (ou YUI_AVALIAR_REAL=1). Mede acerto, precisão e cobertura por intenção,
// falsos positivos em conversa comum, capturas por injeção e latência p50/p95.
//
// Antes: configure o perfil no .env (ou no ambiente), por exemplo
//   YUI_IA_PERFIS={"interpretar":{"modelo":"auto/fast","maxTokens":200,"privacidade":"geral","temperatura":0}}
// e o provedor (OmniRoute) cadastrado como de costume.
// Uso: node scripts/interpretacao-avaliar.mjs --real [--limite N] [--pausa MS] [--arquivo caminho.jsonl] [--json] [--erros]
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { interpretarComMeta } from '../src/core/inteligencia/interpretador.js';
import { criarDisjuntor } from '../src/core/ai/disjuntor.js';
import { calcularMetricas, intencaoEfetiva, percentil, pct } from '../src/core/inteligencia/metricas.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const valor = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

if (!flag('--real') && process.env.YUI_AVALIAR_REAL !== '1') {
  console.log('Este script chama a IA de verdade (gasta cota). Rode com --real para confirmar. Nunca roda no CI.');
  process.exit(2);
}

const arquivo = path.resolve(valor('--arquivo') ?? path.join('tests', 'fixtures', 'interpretacao', 'frases.jsonl'));
const limite = Number.parseInt(valor('--limite') ?? '', 10);
const pausa = Number.parseInt(valor('--pausa') ?? '300', 10);
let frases = fs.readFileSync(arquivo, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
if (Number.isInteger(limite) && limite > 0) frases = frases.slice(0, limite);

// disjuntor próprio e folgado: a avaliação não pode abrir o disjuntor do processo nem parar no meio
const disjuntor = criarDisjuntor({ falhas: 1_000_000 });
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const itens = [];
const latencias = [];
let tokens = 0;
let semResposta = 0;
for (const [n, f] of frases.entries()) {
  const r = await interpretarComMeta({ texto: f.texto, assunto: f.assunto ?? null }, { disjuntor });
  const res = r?.resultado ?? null;
  if (!res) semResposta += 1;
  if (Number.isFinite(r?.meta?.latenciaMs)) latencias.push(r.meta.latenciaMs);
  tokens += r?.meta?.tokensEst ?? 0;
  itens.push({ ...f, bruto: res?.intencao ?? null, confianca: res?.confianca ?? null, previsto: res ? intencaoEfetiva(res) : 'conversa', motivo: r?.meta?.motivo ?? null });
  process.stderr.write(`\r${n + 1}/${frases.length}`);
  if (pausa > 0) await dorme(pausa);
}
process.stderr.write('\n');

const m = calcularMetricas(itens.map((i) => ({ esperado: i.intencao, previsto: i.previsto, categoria: i.categoria })));
const saida = { frases: frases.length, semResposta, latenciaMs: { p50: percentil(latencias, 50), p95: percentil(latencias, 95) }, tokensEstimados: tokens, ...m };

if (flag('--json')) { console.log(JSON.stringify(saida, null, 2)); process.exit(0); }

console.log(`Frases: ${frases.length}  sem resposta/esquema inválido: ${semResposta}`);
console.log(`Acerto geral: ${pct(m.acerto)}   acerto nas intenções de leitura: ${pct(m.acertoLeitura)} (meta >= 95%)`);
console.log(`Falso positivo em conversa comum: ${pct(m.falsoPositivoConversaComum)} (meta <= 1%)   em toda a categoria conversa: ${pct(m.falsoPositivoConversa)}`);
console.log(`Capturadas por injeção: ${m.capturadasPorInjecao} (meta 0)`);
console.log(`Latência: p50=${saida.latenciaMs.p50 ?? '-'} ms  p95=${saida.latenciaMs.p95 ?? '-'} ms (meta p95 <= 1500 ms)   tokens estimados: ${tokens}`);
console.log('\nIntenção              precisão  cobertura   tp  fp  fn');
for (const [k, v] of Object.entries(m.porIntencao)) console.log(`${k.padEnd(20)}  ${pct(v.precisao).padStart(7)}  ${pct(v.cobertura).padStart(8)}  ${String(v.tp).padStart(3)} ${String(v.fp).padStart(3)} ${String(v.fn).padStart(3)}`);
if (flag('--erros')) {
  console.log('\nErros:');
  for (const i of itens.filter((x) => x.previsto !== x.intencao)) console.log(`  [${i.categoria}] esperado=${i.intencao} previsto=${i.previsto} (bruto=${i.bruto} conf=${i.confianca}) :: ${i.texto.replace(/\s+/g, ' ').slice(0, 90)}`);
}
