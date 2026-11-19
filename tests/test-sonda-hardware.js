// Item 7 (preparo): a SONDA DE HARDWARE (scripts/sonda-hardware.mjs), só leitura e sem rede, testada com saídas SIMULADAS do PowerShell (Get-CimInstance) e do nvidia-smi: este teste NÃO abre
// nenhum programa. Cobre a leitura (CPU, núcleos, RAM total e livre, GPU e VRAM, disco livre), a recomendação por faixa em palavras claras e a tabela de estimativas.
// Execução: npm run test:sondahardware   (node tests/test-sonda-hardware.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const arquivo = path.join(repoRoot, 'scripts', 'sonda-hardware.mjs');
// Importar o script NÃO pode imprimir nem executar nada (só roda como programa principal)
const impressoes = [];
const logReal = console.log;
console.log = (...a) => impressoes.push(a.join(' '));
const S = await import(pathToFileURL(arquivo).href);
console.log = logReal;
const { GIB, COMANDO_CIM, ARGS_NVIDIA_SMI, TABELA_DE_FAIXAS, ESTIMATIVA, converterCim, converterNvidiaSmi, ehPlacaIntegrada, juntarPlacas, coletar, maiorVram, recomendar, formatarBytes, formatarRelatorio, main, executarLeitura } = S;

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (err) { failures.push(name); console.log(`  FALHA - ${name}\n      ${String(err?.stack || err).split('\n').slice(0, 7).join('\n      ')}`); }
};

// Saídas SIMULADAS (formato real do Get-CimInstance e do nvidia-smi)
const CIM_NEON = '{"cpu":[{"Name":"11th Gen Intel(R) Core(TM) i5-11300H @ 3.10GHz","NumberOfCores":4,"NumberOfLogicalProcessors":8,"MaxClockSpeed":3110}],"gpu":[{"Name":"Virtual Display Adapter","AdapterRAM":null,"DriverVersion":"1.10.9.289"},{"Name":"Intel(R) Iris(R) Xe Graphics","AdapterRAM":2147479552,"DriverVersion":"32.0.101.7092"},{"Name":"NVIDIA GeForce GTX 1650","AdapterRAM":4293918720,"DriverVersion":"32.0.16.2101"}]}';
const SMI_NEON = 'NVIDIA GeForce GTX 1650, 4096, 3894\n';
const CIM_NOTEBOOK = '{"cpu":{"Name":"Intel(R) Core(TM) i5-4210U CPU @ 1.70GHz","NumberOfCores":2,"NumberOfLogicalProcessors":4,"MaxClockSpeed":2400},"gpu":{"Name":"Intel(R) HD Graphics Family","AdapterRAM":1073741824,"DriverVersion":"20.19.15.4624"}}';
const CIM_ESTACAO = '{"cpu":[{"Name":"AMD Ryzen 9 7950X 16-Core Processor","NumberOfCores":16,"NumberOfLogicalProcessors":32,"MaxClockSpeed":4500}],"gpu":[{"Name":"NVIDIA GeForce RTX 4090","AdapterRAM":4293918720,"DriverVersion":"32.0.15.6094"}]}';
const SMI_ESTACAO = 'NVIDIA GeForce RTX 4090, 24564, 23000\n';

const sistemaFalso = ({ modelo = 'CPU de teste', nucleos = 8, totalGB = 24, livreGB = 10 } = {}) => ({
  cpus: () => Array.from({ length: nucleos }, () => ({ model: modelo })), totalmem: () => totalGB * GIB, freemem: () => livreGB * GIB, release: () => '10.0.26320', arch: () => 'x64',
});
const discoFalso = (pasta) => ({ bsize: 4096, blocks: Math.floor((900 * GIB) / 4096), bavail: Math.floor((150 * GIB) / 4096), pasta });
/** O "executar" simulado: devolve as saídas combinadas e REGISTRA o que foi pedido. */
function executarFalso({ cim = null, smi = null } = {}) {
  const chamadas = [];
  const executar = (programa, args) => { chamadas.push({ programa, args }); return /powershell/i.test(programa) ? cim : /nvidia-smi/i.test(programa) ? smi : null; };
  executar.chamadas = chamadas;
  return executar;
}
const retrato = ({ cim, smi, ...sistema }, plataforma = 'win32') => coletar({ sistema: sistemaFalso(sistema), executar: executarFalso({ cim, smi }), statfs: discoFalso, pasta: 'D:/modelos', plataforma });

await test('importar o script não imprime nem executa nada (só roda como programa principal)', () => {
  assert.deepEqual(impressoes, []);
  assert.equal(typeof main, 'function');
  assert.equal(typeof executarLeitura, 'function');
});
await test('converterCim: lê CPU (nome, núcleos físicos e lógicos) e placas; aceita objeto único ou lista, BOM, VRAM nula, e devolve vazio para lixo', () => {
  const r = converterCim(CIM_NEON);
  assert.deepEqual(r.cpus, [{ nome: '11th Gen Intel(R) Core(TM) i5-11300H @ 3.10GHz', nucleos: 4, nucleosLogicos: 8, mhz: 3110 }]);
  assert.deepEqual(r.gpus.map((g) => [g.nome, g.vramBytes]), [['Virtual Display Adapter', null], ['Intel(R) Iris(R) Xe Graphics', 2147479552], ['NVIDIA GeForce GTX 1650', 4293918720]]);
  const n = converterCim(CIM_NOTEBOOK);
  assert.equal(n.cpus.length, 1);
  assert.equal(n.gpus.length, 1);
  assert.equal(n.gpus[0].nome, 'Intel(R) HD Graphics Family');
  assert.equal(converterCim(`\uFEFF${CIM_NOTEBOOK}`).cpus.length, 1);
  for (const lixo of ['', '   ', 'não é json', '{', 'null', '[]', '{"cpu":null,"gpu":null}', undefined, null, 42]) assert.deepEqual(converterCim(lixo), { cpus: [], gpus: [] }, String(lixo));
});
await test('converterNvidiaSmi: nome, VRAM total e livre (em MiB, convertidas em bytes); várias placas; nome com vírgula; linhas quebradas são ignoradas', () => {
  assert.deepEqual(converterNvidiaSmi(SMI_NEON), [{ nome: 'NVIDIA GeForce GTX 1650', vramBytes: 4096 * 1024 * 1024, vramLivreBytes: 3894 * 1024 * 1024 }]);
  const duas = converterNvidiaSmi('NVIDIA RTX A6000, 49140, 48000\r\nNVIDIA GeForce RTX 3060, 12288, 100\r\n');
  assert.deepEqual(duas.map((g) => [g.nome, g.vramBytes / (1024 * 1024)]), [['NVIDIA RTX A6000', 49140], ['NVIDIA GeForce RTX 3060', 12288]]);
  assert.equal(converterNvidiaSmi('Placa, com vírgula, 8192, 8000')[0].nome, 'Placa, com vírgula');
  for (const lixo of ['', 'NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.', 'a, b', 'x, y, z', null, undefined]) assert.deepEqual(converterNvidiaSmi(lixo), [], String(lixo));
});
await test('juntarPlacas: a VRAM do nvidia-smi vence a do CIM (que trava em uns 4 GB); placa integrada e virtual são marcadas e não contam; placa só do nvidia-smi entra', () => {
  const cim = converterCim(CIM_ESTACAO).gpus;
  const placas = juntarPlacas(cim, converterNvidiaSmi(SMI_ESTACAO));
  assert.equal(placas.length, 1);
  assert.equal(placas[0].vramFonte, 'nvidia-smi');
  assert.equal(placas[0].vramBytes, 24564 * 1024 * 1024, 'o CIM dizia 4 GB: errado para uma placa de 24 GB');
  assert.equal(placas[0].integrada, false);
  const neon = juntarPlacas(converterCim(CIM_NEON).gpus, converterNvidiaSmi(SMI_NEON));
  assert.deepEqual(neon.map((g) => [g.nome, g.integrada, g.vramFonte]), [['Virtual Display Adapter', true, null], ['Intel(R) Iris(R) Xe Graphics', true, 'cim'], ['NVIDIA GeForce GTX 1650', false, 'nvidia-smi']]);
  assert.equal(maiorVram(neon), 4096 * 1024 * 1024, 'só a placa dedicada conta');
  const soSmi = juntarPlacas([], converterNvidiaSmi('NVIDIA L4, 23034, 22000'));
  assert.equal(soSmi.length, 1);
  assert.equal(soSmi[0].integrada, false);
  for (const nome of ['Intel(R) UHD Graphics 630', 'Intel(R) Iris(R) Xe Graphics', 'Intel(R) HD Graphics Family', 'AMD Radeon(TM) Graphics', 'AMD Radeon Vega 8 Graphics', 'Microsoft Basic Display Adapter', 'VMware SVGA 3D', 'Parsec Virtual Display', 'Virtual Display Adapter']) assert.equal(ehPlacaIntegrada(nome), true, nome);
  for (const nome of ['NVIDIA GeForce GTX 1650', 'NVIDIA GeForce RTX 4090', 'AMD Radeon RX 7900 XTX', 'Intel(R) Arc(TM) A770']) assert.equal(ehPlacaIntegrada(nome), false, nome);
});
await test('coletar (Windows): CPU, núcleos (físicos e lógicos), RAM total e livre, GPU com a VRAM certa e o disco livre, só com as saídas simuladas', () => {
  const info = retrato({ cim: CIM_NEON, smi: SMI_NEON, totalGB: 23.8, livreGB: 2.6, nucleos: 8 });
  assert.deepEqual(info.so, { plataforma: 'win32', versao: '10.0.26320', arquitetura: 'x64' });
  assert.deepEqual(info.cpu, { modelo: '11th Gen Intel(R) Core(TM) i5-11300H @ 3.10GHz', nucleosLogicos: 8, nucleosFisicos: 4 });
  assert.equal(info.ram.totalBytes, 23.8 * GIB);
  assert.equal(info.ram.livreBytes, 2.6 * GIB);
  assert.equal(info.gpus.length, 3);
  const gtx = info.gpus.find((g) => /GTX/.test(g.nome));
  assert.deepEqual([gtx.vramBytes, gtx.vramLivreBytes, gtx.vramFonte, gtx.integrada], [4096 * 1024 * 1024, 3894 * 1024 * 1024, 'nvidia-smi', false]);
  assert.equal(info.disco.pasta, path.resolve('D:/modelos'));
  assert.ok(Math.abs(info.disco.livreBytes - 150 * GIB) < 4096);
  assert.ok(Math.abs(info.disco.totalBytes - 900 * GIB) < 4096);
  assert.deepEqual(info.avisos, []);
});
await test('coletar: SÓ lê, e SÓ pede estes dois programas: o PowerShell com Get-CimInstance (sem nada que grave, instale, baixe ou apague) e o nvidia-smi só de consulta; fora do Windows nem o PowerShell', () => {
  const executar = executarFalso({ cim: CIM_NEON, smi: SMI_NEON });
  coletar({ sistema: sistemaFalso(), executar, statfs: discoFalso, plataforma: 'win32' });
  assert.deepEqual(executar.chamadas.map((c) => c.programa), ['powershell.exe', 'nvidia-smi']);
  const ps = executar.chamadas[0].args.join(' ');
  assert.ok(ps.includes('Get-CimInstance Win32_Processor') && ps.includes('Get-CimInstance Win32_VideoController'));
  assert.equal(ps, `-NoProfile -NonInteractive -Command ${COMANDO_CIM}`);
  assert.ok(!/\b(?:Set|Remove|New|Add|Start|Stop|Restart|Invoke|Out|Install|Enable|Disable|Clear|Move|Copy|Rename|Register|Unregister|Import|Export|Write|Send)-\w+|>|\bsc\b|\breg\b|\bnet\b|http|iwr|curl|wget|\bdel\b|\brm\b/i.test(COMANDO_CIM), 'o comando do PowerShell não pode ter nada além de consulta');
  assert.deepEqual(executar.chamadas[1].args, ARGS_NVIDIA_SMI);
  assert.ok(ARGS_NVIDIA_SMI.every((a) => a.startsWith('--query-gpu=') || a.startsWith('--format=')), 'o nvidia-smi só consulta');
  const linux = executarFalso({ smi: SMI_NEON });
  coletar({ sistema: sistemaFalso(), executar: linux, statfs: discoFalso, plataforma: 'linux' });
  assert.deepEqual(linux.chamadas.map((c) => c.programa), ['nvidia-smi'], 'fora do Windows não chama o PowerShell');
});
await test('coletar: quando as leituras falham (PowerShell sem resposta, sem nvidia-smi, disco ilegível) o relatório sai assim mesmo, com avisos claros, usando o que o sistema sabe', () => {
  const info = coletar({ sistema: sistemaFalso({ modelo: 'CPU qualquer', nucleos: 6, totalGB: 8, livreGB: 3 }), executar: executarFalso(), statfs: () => { throw new Error('sem acesso'); }, plataforma: 'win32' });
  assert.deepEqual(info.cpu, { modelo: 'CPU qualquer', nucleosLogicos: 6, nucleosFisicos: null });
  assert.deepEqual(info.gpus, []);
  assert.equal(info.disco, null);
  assert.ok(info.avisos.some((a) => /PowerShell/.test(a)));
  assert.ok(info.avisos.some((a) => /placa de vídeo/i.test(a)));
  assert.ok(info.avisos.some((a) => /disco/i.test(a)));
  assert.ok(formatarRelatorio(info).includes('Aviso:'));
  const so = coletar({ sistema: sistemaFalso({ nucleos: 2 }), executar: executarFalso(), statfs: discoFalso, plataforma: 'darwin' });
  assert.ok(so.avisos.some((a) => /Fora do Windows/.test(a)));
  const vazio = coletar({ sistema: { cpus: () => [], totalmem: () => 4 * GIB, freemem: () => GIB, release: () => '', arch: () => '' }, executar: executarFalso(), statfs: discoFalso, plataforma: 'linux' });
  assert.equal(vazio.cpu.modelo, 'desconhecido');
  assert.equal(vazio.cpu.nucleosLogicos, null);
  assert.equal(recomendar(vazio).faixa, 'externo');
});
await test('o aviso do CIM: uma placa de uns 4 GB lida só pelo Windows pode ser maior de verdade (o número trava em 32 bits)', () => {
  const info = retrato({ cim: CIM_ESTACAO, smi: null });
  assert.ok(info.avisos.some((a) => /trava em uns 4 GB/.test(a)), JSON.stringify(info.avisos));
  const comSmi = retrato({ cim: CIM_ESTACAO, smi: SMI_ESTACAO });
  assert.ok(!comSmi.avisos.some((a) => /trava/.test(a)));
});
await test('RECOMENDAÇÃO por faixa: o notebook do servidor (4 GB, sem placa) => só provedores externos; o PC do dono (24 GB, GTX 1650 de 4 GB) => pequenos locais, só na CPU; estação (64 GB, 24 GB de VRAM) => médios', () => {
  const notebook = recomendar(retrato({ cim: CIM_NOTEBOOK, smi: null, totalGB: 4, livreGB: 1.2, nucleos: 4 }));
  assert.equal(notebook.faixa, 'externo');
  assert.match(notebook.texto, /provedores externos/);
  assert.ok(notebook.motivos[0].includes('4.0 GB'), notebook.motivos[0]);
  const neon = recomendar(retrato({ cim: CIM_NEON, smi: SMI_NEON, totalGB: 23.8, livreGB: 10, nucleos: 8 }));
  assert.equal(neon.faixa, 'pequeno');
  assert.match(neon.motivos[0], /só na CPU, devagar/);
  assert.match(neon.motivos[0], /placa de 4 GB só ajuda com modelos de uns 3 bilhões/);
  const neonApertado = recomendar(retrato({ cim: CIM_NEON, smi: SMI_NEON, totalGB: 23.8, livreGB: 2.6, nucleos: 8 }));
  assert.equal(neonApertado.faixa, 'pequeno', 'a RAM livre de agora (que muda) não troca a faixa');
  assert.ok(neonApertado.motivos.some((m) => /agora só há 2\.6 GB de RAM livres/.test(m)), 'mas vira aviso');
  const estacao = recomendar(retrato({ cim: CIM_ESTACAO, smi: SMI_ESTACAO, totalGB: 64, livreGB: 50, nucleos: 32 }));
  assert.equal(estacao.faixa, 'medio');
  assert.match(estacao.motivos[0], /24 GB de VRAM/);
  assert.match(estacao.texto, /agente de código/);
  for (const r of [notebook, neon, estacao]) { assert.equal(r.estimativa, true); assert.ok(r.titulo && r.texto && r.motivos.length); }
});
await test('os limites das faixas (ESTIMATIVAS): 16 GB de VRAM => médio (15 não); 6 GB de VRAM => pequeno (5 não); 32 GB de RAM com 8 núcleos => médio na CPU; 16 GB com 4 núcleos => pequeno; integrada não conta', () => {
  const info = ({ vramGB = 0, totalGB = 8, nucleos = 4, integrada = false }) => ({ cpu: { modelo: 'x', nucleosLogicos: nucleos, nucleosFisicos: null }, ram: { totalBytes: totalGB * GIB, livreBytes: totalGB * GIB * 0.7 }, gpus: vramGB ? [{ nome: 'Placa', vramBytes: vramGB * GIB, integrada }] : [] });
  const faixa = (p) => recomendar(info(p)).faixa;
  assert.equal(faixa({ vramGB: 16, totalGB: 8 }), 'medio');
  assert.equal(faixa({ vramGB: 15, totalGB: 8 }), 'pequeno');
  assert.equal(faixa({ vramGB: 15.9, totalGB: 8 }), 'pequeno');
  assert.equal(faixa({ vramGB: 24, totalGB: 8 }), 'medio');
  assert.equal(faixa({ vramGB: 6, totalGB: 8 }), 'pequeno');
  assert.equal(faixa({ vramGB: 5.9, totalGB: 8 }), 'externo');
  assert.equal(faixa({ vramGB: 5.9, totalGB: 16, nucleos: 4 }), 'pequeno');
  assert.equal(faixa({ totalGB: 32, nucleos: 8 }), 'medio');
  assert.equal(faixa({ totalGB: 32, nucleos: 7 }), 'pequeno');
  assert.equal(faixa({ totalGB: 31.9, nucleos: 16 }), 'pequeno');
  assert.equal(faixa({ totalGB: 16, nucleos: 4 }), 'pequeno');
  assert.equal(faixa({ totalGB: 16, nucleos: 2 }), 'externo');
  assert.equal(faixa({ totalGB: 15.9, nucleos: 16 }), 'externo');
  assert.equal(faixa({ totalGB: 8, nucleos: 8 }), 'externo');
  assert.equal(faixa({ vramGB: 24, totalGB: 64, nucleos: 16, integrada: true }), 'medio', '64 GB de RAM e 16 núcleos: médio na CPU, mesmo com a placa integrada ignorada');
  assert.equal(faixa({ vramGB: 24, totalGB: 8, nucleos: 4, integrada: true }), 'externo', 'a "VRAM" de uma placa integrada não conta');
  assert.equal(recomendar({}).faixa, 'externo', 'sem dados, a faixa mais segura');
});
await test('a TABELA de faixas existe, tem as três faixas na ordem, diz o que cada uma exige de RAM e VRAM e está marcada como ESTIMATIVA', () => {
  assert.equal(ESTIMATIVA, true);
  assert.deepEqual(TABELA_DE_FAIXAS.map((f) => f.id), ['externo', 'pequeno', 'medio']);
  assert.ok(Object.isFrozen(TABELA_DE_FAIXAS));
  for (const f of TABELA_DE_FAIXAS) { assert.ok(f.nome && f.exige && f.modelos && f.observacao, f.id); }
  assert.match(TABELA_DE_FAIXAS[0].nome, /provedores externos/i);
  assert.match(TABELA_DE_FAIXAS[1].exige, /6 GB de VRAM/);
  assert.match(TABELA_DE_FAIXAS[1].exige, /16 GB de RAM/);
  assert.match(TABELA_DE_FAIXAS[2].exige, /16 GB de VRAM/);
  assert.match(TABELA_DE_FAIXAS[2].exige, /32 GB de RAM/);
  assert.match(TABELA_DE_FAIXAS[1].modelos, /1 a 8 bilhões/);
  assert.match(TABELA_DE_FAIXAS[2].modelos, /14 a 32 bilhões/);
});
await test('o relatório em texto: sistema, processador, RAM, placa, disco, a recomendação em palavras claras, a tabela marcada como estimativa e só a faixa recomendada com "<= esta máquina"', () => {
  const info = retrato({ cim: CIM_NEON, smi: SMI_NEON, totalGB: 23.8, livreGB: 10, nucleos: 8 });
  const texto = formatarRelatorio(info);
  for (const trecho of ['SONDA DE HARDWARE (só leitura, sem rede)', 'Sistema: win32', 'i5-11300H', '4 núcleos (8 lógicos)', 'Memória RAM: 23.8 GB no total, 10.0 GB livres', 'NVIDIA GeForce GTX 1650, VRAM 4.0 GB (fonte: nvidia-smi)',
    '(integrada ou virtual)', 'Disco (', '150.0 GB livres de 900.0 GB', 'RECOMENDAÇÃO: Modelos pequenos locais', 'APROXIMADOS', 'estimativas', 'Apenas provedores externos (nuvem)', 'Modelos médios locais']) {
    assert.ok(texto.includes(trecho), `faltou no relatório: ${trecho}\n${texto}`);
  }
  assert.equal(texto.split('<= esta máquina').length - 1, 1, 'só uma faixa é marcada');
  assert.ok(/Modelos pequenos locais\s+<= esta máquina/.test(texto));
  assert.equal(formatarBytes(1.5 * GIB), '1.5 GB');
  assert.equal(formatarBytes(512 * 1024 * 1024), '512 MB');
  assert.equal(formatarBytes(NaN), 'desconhecido');
  assert.ok(formatarRelatorio(coletar({ sistema: sistemaFalso(), executar: executarFalso(), statfs: () => { throw new Error('x'); }, plataforma: 'win32' })).includes('Placa de vídeo: nenhuma identificada'));
});
await test('main(--json) imprime JSON válido com a leitura, a recomendação e a tabela; sem --json imprime o texto; --pasta= muda o disco medido (tudo com leituras simuladas, nada é aberto)', () => {
  const saidas = [];
  const antes = console.log;
  console.log = (...a) => saidas.push(a.join(' '));
  try {
    const deps = { sistema: sistemaFalso({ totalGB: 64, livreGB: 40, nucleos: 16 }), executar: executarFalso({ cim: CIM_ESTACAO, smi: SMI_ESTACAO }), statfs: discoFalso, plataforma: 'win32' };
    main(['--json', '--pasta=E:/ia'], deps);
    main([], deps);
  } finally { console.log = antes; }
  const j = JSON.parse(saidas[0]);
  assert.deepEqual(Object.keys(j).sort(), ['estimativa', 'info', 'recomendacao', 'tabela']);
  assert.equal(j.estimativa, true);
  assert.equal(j.recomendacao.faixa, 'medio');
  assert.equal(j.info.disco.pasta, path.resolve('E:/ia'));
  assert.equal(j.tabela.length, 3);
  assert.match(saidas[1], /^SONDA DE HARDWARE/);
});
await test('o script é só leitura e sem rede: nenhum módulo de rede, nenhum fetch, nenhuma escrita em disco, nenhum programa além do PowerShell (Get-CimInstance) e do nvidia-smi', () => {
  const fonte = fs.readFileSync(arquivo, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  for (const m of fonte.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)) assert.ok(/^node:(?:fs|os|path|child_process|url)$/.test(m[1]), `importa ${m[1]}`);
  assert.ok(!/\bfetch\s*\(|\bhttps?\.|\bnet\.|\bdgram\b|\bdns\b|XMLHttpRequest|WebSocket|\.connect\s*\(/.test(fonte), 'tem rede');
  assert.ok(!/writeFile|appendFile|mkdirSync|mkdir\(|rmSync|unlink|rename|copyFile|createWriteStream|chmod/.test(fonte), 'grava no disco');
  const programas = [...fonte.matchAll(/(?:executar|executarLeitura)\(\s*'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(programas, ['nvidia-smi', 'powershell.exe']);
  assert.deepEqual([...new Set([...fonte.matchAll(/execFileSync\(([^,]+),/g)].map((m) => m[1].trim()))], ['programa'], 'só o executarLeitura abre programa, e sem shell (execFileSync)');
  assert.ok(!/\bexecSync\b|shell:\s*true|\bspawn\b/.test(fonte));
});

console.log(`\n${passed} testes OK${failures.length ? `; ${failures.length} FALHARAM: ${failures.join(' | ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
