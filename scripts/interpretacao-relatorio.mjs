// Relatório do interpretador em observação (Fase B): lê logs/interpretacao.jsonl (e os arquivos girados, com --tudo) e mostra a concordância com a pré-rota,
// a distribuição de intenções, a latência p50/p95 e as falhas. Só leitura: não chama IA nem altera nada. A lógica está em src/core/inteligencia/relatorio.js.
// Uso: node scripts/interpretacao-relatorio.mjs [arquivo] [--tudo] [--dias N] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { lerRegistros, resumir, formatar } from '../src/core/inteligencia/relatorio.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const valor = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const posicional = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--dias');
const arquivo = path.resolve(posicional || process.env.YUI_INTERPRETACAO_ARQUIVO || path.join('logs', 'interpretacao.jsonl'));

if (!fs.existsSync(arquivo)) {
  console.log(`Sem registros em ${arquivo}. Ligue YUI_INTERPRETADOR=observar e converse com a Yui.`);
  process.exit(0);
}
const { registros, ilegiveis } = lerRegistros(arquivo, { tudo: flag('--tudo') });
if (!registros.length) {
  console.log(`Sem registros em ${arquivo}. Ligue YUI_INTERPRETADOR=observar e converse com a Yui.`);
  process.exit(0);
}
const resumo = resumir(registros, { dias: Number.parseInt(valor('--dias') ?? '', 10), ilegiveis, arquivo });
console.log(flag('--json') ? JSON.stringify(resumo, null, 2) : formatar(resumo));
