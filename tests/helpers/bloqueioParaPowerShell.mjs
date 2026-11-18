// O bloqueio de integração externa (tests/helpers/bloqueioExterno.mjs) para os testes em PowerShell (npm run test:atualizador), que abrem o `node`
// por funções do scripts/atualizar-yui.ps1 e não passam argumentos de linha de comando: o bloqueio vai pelo AMBIENTE (NODE_OPTIONS=--import=...),
// que os processos filhos herdam. Este arquivo é só a ponte: a regra e o registro são os mesmos do criarBloqueio (bloqueioExternoTeste.js).
//
//   node bloqueioParaPowerShell.mjs criar    <pasta> <teste> <arquivo-excecoes.json>
//       cria o registro, as portas e as liberações (a DECLARAÇÃO de cada exceção, com o motivo e o nome do teste) e imprime em JSON as variáveis de
//       ambiente que o teste põe no PRÓPRIO processo: { variaveis: { NOME: valor, ... } }. `arquivo-excecoes.json`: { "programa:icacls": "o motivo", ... }.
//   node bloqueioParaPowerShell.mjs conferir <pasta> <arquivo-esperados.json> [<onde>]
//       confere as tentativas BLOQUEADAS desde a última conferência (o ponteiro fica em <pasta>/conferidas.txt): cada tentativa tem de casar com um
//       esperado ({ tipo, alvo: "regex", motivo, opcional? }) e cada esperado não opcional tem de aparecer; senão, imprime o motivo e sai com 1.
//   node bloqueioParaPowerShell.mjs resumo   <pasta> <arquivo-excecoes.json>
//       imprime as exceções declaradas e quantas vezes cada uma foi usada.
// Só liga com NODE_ENV=test (como o bloqueio). Este arquivo roda SEM o bloqueio carregado: ele só lê e escreve arquivos.
import fs from 'node:fs';
import path from 'node:path';
import { criarBloqueio, lerBloqueios, BLOQUEIO_URL } from './bloqueioExternoTeste.js';

const [, , comando, pasta, a3, a4, a5] = process.argv;
if (String(process.env.NODE_ENV ?? '').toLowerCase() !== 'test' && comando !== 'resumo') { console.error('só para teste (NODE_ENV=test)'); process.exit(97); }
const lerJson = (arquivo, padrao) => { try { return JSON.parse(fs.readFileSync(arquivo, 'utf8').replace(/^﻿/, '')); } catch { return padrao; } };

if (comando === 'criar') {
  const excecoes = lerJson(a4, {});
  const b = criarBloqueio(pasta, { teste: a3, liberar: excecoes });
  fs.writeFileSync(path.join(pasta, 'conferidas.txt'), '0');
  const env = b.env('processo');
  // o papel de cada processo é o nome do script (cerebro.js, index.js...): sem YUI_TESTE_BLOQUEIO_PAPEL
  delete env.YUI_TESTE_BLOQUEIO_PAPEL;
  process.stdout.write(JSON.stringify({ variaveis: { ...env, NODE_OPTIONS: `--import=${BLOQUEIO_URL}`, NODE_ENV: 'test' } }));
} else if (comando === 'conferir') {
  const esperados = lerJson(a3, []).map((e) => ({ ...e, alvo: new RegExp(e.alvo, 'i') }));
  const registro = path.join(pasta, 'bloqueio-externo.jsonl');
  const ponteiro = path.join(pasta, 'conferidas.txt');
  const todas = lerBloqueios(registro);
  const antes = Number(fs.readFileSync(ponteiro, 'utf8')) || 0;
  const novas = todas.slice(antes);
  fs.writeFileSync(ponteiro, String(todas.length));
  const onde = a4 ? ` (${a4})` : '';
  const casa = (l) => esperados.some((e) => e.tipo === l.tipo && e.alvo.test(String(l.alvo)));
  const fora = novas.filter((l) => !casa(l));
  if (fora.length) {
    console.log(`INTEGRACAO EXTERNA TENTADA num teste de arquitetura${onde}: ${fora.length} tentativa(s) bloqueada(s):\n${fora.slice(0, 20).map((l) => JSON.stringify(l)).join('\n')}`);
    process.exit(1);
  }
  for (const e of esperados) {
    if (e.opcional) continue;
    if (!novas.some((l) => l.tipo === e.tipo && e.alvo.test(String(l.alvo)))) {
      console.log(`${onde.trim() || 'conferencia'}: a tentativa esperada (e bloqueada) nao aconteceu: ${e.tipo} ${e.alvo} (${e.motivo})`);
      process.exit(1);
    }
  }
  console.log(`${novas.length} tentativa(s) bloqueada(s), todas esperadas`);
} else if (comando === 'resumo') {
  const excecoes = Object.keys(lerJson(a3, {}));
  const usos = fs.existsSync(path.join(pasta, 'bloqueio-liberacoes.jsonl'))
    ? fs.readFileSync(path.join(pasta, 'bloqueio-liberacoes.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.tipo === 'uso')
    : [];
  console.log(excecoes.map((e) => `${e} (${usos.filter((u) => u.excecao === e).length} uso(s))`).join(', ') || 'nenhuma');
} else {
  console.error('uso: criar | conferir | resumo');
  process.exit(2);
}
