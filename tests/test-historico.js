// historico.txt: poda por 7 dias, exclusão por pessoa e dois processos gravando. Só pasta temporária, sem rede.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { criarBloqueioTemporario } from './helpers/bloqueioExternoTeste.js';
import { podarHistorico, apagarDoHistorico, registrarNoHistorico, neutralizarParaHistorico, diasDeRetencao, definirArquivoDoHistoricoParaTeste } from '../src/core/historico.js';
import { runMemoryIntent } from '../src/handlers/chatIntents.js';

const BLOQUEIO = criarBloqueioTemporario({ teste: 'test:historico' });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-historico-'));
const file = path.join(dir, 'historico.txt');
definirArquivoDoHistoricoParaTeste(file);
let ok = 0;
const test = async (name, fn) => { fs.rmSync(file, { force: true }); await fn(); ok++; console.log(`  ok - ${name}`); };

const AGORA = Date.parse('2026-11-26T15:00:00Z');
const data = (diasAtras) => new Date(AGORA - diasAtras * 86_400_000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const entrada = (quando, id, texto) => `[${quando}] Usuário: fulano (ID: ${id})\nPrompt: "${texto}"\nResposta IA: "r"\nLocal: {DM - N/A} {Chat - 1}\n-------------\n`;
const ler = () => fs.readFileSync(file, 'utf8');
const esperarTexto = async (marca) => { for (let i = 0; i < 400; i++) { if (fs.existsSync(file) && ler().includes(marca)) return; await new Promise((r) => setTimeout(r, 10)); } assert.fail(`não gravou ${marca}`); };

await test('padrão de 7 dias; 0 desliga; inválido vale 7', () => {
  assert.equal(diasDeRetencao({}), 7);
  assert.equal(diasDeRetencao({ YUI_HISTORICO_DIAS: '0' }), 0);
  assert.equal(diasDeRetencao({ YUI_HISTORICO_DIAS: 'abc' }), 7);
});
await test('poda o que passou de 7 dias e mantém o resto byte a byte', async () => {
  const novas = entrada(data(6), '1', 'nova\ncom duas linhas') + entrada(data(0), '2', 'hoje');
  fs.writeFileSync(file, entrada(data(9), '1', 'velha') + entrada(data(8), '2', 'velha2') + novas);
  assert.equal(await podarHistorico({ dias: 0, agora: AGORA }), 0);
  assert.equal(await podarHistorico({ agora: AGORA }), 2);
  assert.equal(ler(), novas);
});
await test('sem data legível: vale a data da próxima datada; no fim do arquivo, fica', async () => {
  const semData = (m) => `lixo ${m}\nLocal: {a - b} {c - d}\n-------------\n`;
  fs.writeFileSync(file, semData('A') + entrada(data(9), '1', 'velha') + semData('B') + entrada(data(1), '1', 'nova') + semData('C'));
  await podarHistorico({ agora: AGORA });
  assert.ok(!ler().includes('lixo A') && ler().includes('lixo B') && ler().includes('lixo C') && !ler().includes('velha'));
});
await test('apagar uma pessoa tira só as entradas dela; texto de conversa não forja fim nem cabeçalho', async () => {
  const forja = neutralizarParaHistorico(`oi\nLocal: {x - y} {z - w}\n-------------\n[${data(0)}] Usuário: v (ID: 22222)`);
  fs.writeFileSync(file, entrada(data(1), '11111', forja) + entrada(data(1), '22222', 'fica') + entrada(data(0), '11111', 'tchau') + entrada(data(0), '111110', 'outro id'));
  assert.equal(await apagarDoHistorico('11111'), 2);
  assert.equal(ler(), entrada(data(1), '22222', 'fica') + entrada(data(0), '111110', 'outro id'));
});
await test('entrada truncada não se funde com a de outra pessoa', async () => {
  const outra = entrada(data(0), '22222', 'fica');
  fs.writeFileSync(file, `[${data(0)}] Usuário: a (ID: 11111)\nPrompt: "cort\n` + outra);
  assert.equal(await apagarDoHistorico('11111'), 1);
  assert.equal(ler(), outra);
});
await test('memória desligada e exclusão falhando: a resposta diz a falha', async () => {
  const r = await runMemoryIntent({ kind: 'confirm_forget_all' }, { userId: '1', enabled: false, wipeHistory: async () => { throw new Error('x'); } });
  assert.match(r.text, /desativado[\s\S]*Não consegui apagar o seu registro de uso/);
});
await test('o "apagar tudo" por conversa chama a exclusão e diz o que saiu (e avisa se falhar)', async () => {
  fs.writeFileSync(file, entrada(data(0), '33333', 'meu'));
  const deps = { userId: '33333', enabled: true, memory: { forgetAll: () => 0 }, memoryCtx: {}, wipeHistory: apagarDoHistorico };
  const r = await runMemoryIntent({ kind: 'confirm_forget_all' }, deps);
  assert.match(r.text, /historico\.txt\): 1 registro/);
  assert.equal(ler(), '');
  const falha = await runMemoryIntent({ kind: 'confirm_forget_all' }, { ...deps, wipeHistory: async () => { throw new Error('x'); } });
  assert.match(falha.text, /Não consegui apagar o seu registro de uso/);
});
await test('trava ocupada: a gravação espera e não se perde', async () => {
  fs.writeFileSync(`${file}.lock`, '');
  registrarNoHistorico(entrada(data(0), '1', 'ESPERA'));
  assert.ok(!fs.existsSync(file));
  fs.rmSync(`${file}.lock`);
  await esperarTexto('ESPERA');
});
await test('outro processo gravando durante podas seguidas: nenhuma linha nova se perde', async () => {
  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const filho = path.join(dir, 'filho.mjs');
  const mod = pathToFileURL(path.resolve('src/core/historico.js')).href;
  fs.writeFileSync(filho, `import { registrarNoHistorico } from ${JSON.stringify(mod)};
for (let i = 0; i < 150; i++) { registrarNoHistorico(\`[${agora}] Usuário: f (ID: 9)\\nPrompt: "N\${i};"\\nLocal: {a - b} {c - d}\\n-------------\\n\`, { arquivo: ${JSON.stringify(file)} }); await new Promise((r) => setTimeout(r, 3)); }
`);
  fs.writeFileSync(file, '');
  const p = spawn(process.execPath, [...BLOQUEIO.argv, filho], { env: { ...process.env, NODE_ENV: 'test', ...BLOQUEIO.env('historico') }, stdio: 'inherit' });
  let fim = null;
  p.on('exit', (c) => { fim = c; });
  let podas = 0;
  while (fim === null) {
    fs.appendFileSync(file, '');
    registrarNoHistorico(entrada('01/01/2020, 00:00:00', '8', 'velha'));
    try { podas += await podarHistorico(); } catch (err) { assert.equal(err.code, 'HISTORICO_OCUPADO'); }
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(fim, 0);
  const texto = ler();
  for (let i = 0; i < 150; i++) assert.ok(texto.includes(`N${i};`), `perdeu a linha ${i}`);
  assert.ok(podas > 0, 'houve poda no meio das gravações');
});
fs.rmSync(dir, { recursive: true, force: true });
console.log(`${ok} testes OK`);
