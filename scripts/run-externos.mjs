// Executa os testes EXTERNOS da Yui: os que acessam serviços ou programas de verdade (o Reddit, a voz do Windows, o ffprobe, o Python do Deezer, o spotdl, o PowerShell...).
// Eles NÃO entram na CI (scripts/run-ci.mjs) e só rodam de propósito: com YUI_TESTES_EXTERNOS=true. Sem isso, nada é executado.
//
//   YUI_TESTES_EXTERNOS=true npm run test:externos            todos
//   YUI_TESTES_EXTERNOS=true npm run test:externos:reddit     uma área (reddit | tts | deezer | spotdl | media)
//   YUI_TESTES_EXTERNOS=true npm run test:tts-e2e             um teste só (o nome do script do package.json)
//
// O registro único é tests/externos.json (lista "externos": o teste, a área, o comando, o recurso de fora e a justificativa). Cada script externo do package.json
// aponta para este arquivo: `node scripts/run-externos.mjs <teste>`. No PowerShell: $env:YUI_TESTES_EXTERNOS='true'; npm run test:externos.
// Código de saída: 0 = tudo passou; 1 = algum teste falhou; 2 = pedido inválido; 3 = NÃO rodou (faltou YUI_TESTES_EXTERNOS=true).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { lerRegistro, ARQUIVO_REGISTRO } from '../tests/helpers/coberturaBloqueio.mjs';

const raiz = path.resolve(import.meta.dirname, '..');
const alvo = String(process.argv[2] ?? 'todos').trim();
// Só nos testes deste executor (NODE_ENV=test): um registro falso, para provar o que ele faz sem rodar nenhum teste externo de verdade.
const registroDoTeste = String(process.env.NODE_ENV ?? '').toLowerCase() === 'test' ? String(process.env.YUI_REGISTRO_EXTERNOS ?? '').trim() : '';
const { externos } = lerRegistro(registroDoTeste || ARQUIVO_REGISTRO);
const areas = [...new Set(externos.map((e) => e.area))];

const escolhidos = alvo === 'todos' ? externos : externos.filter((e) => e.area === alvo || e.teste === alvo);
if (!escolhidos.length) {
  console.error(`Não conheço "${alvo}". Use "todos", uma área (${areas.join(', ')}) ou o nome de um teste externo (${externos.map((e) => e.teste).join(', ')}).`);
  process.exit(2);
}

const linhas = escolhidos.map((e) => `  - ${e.teste} [${e.area}]: ${e.recurso}`).join('\n');
if (String(process.env.YUI_TESTES_EXTERNOS ?? '').trim().toLowerCase() !== 'true') {
  console.error([
    '',
    'NÃO RODEI: estes testes acessam serviços ou programas de VERDADE (fora do processo do teste) e por isso são opt-in, separados da CI:',
    linhas,
    '',
    'Para rodar de propósito: defina YUI_TESTES_EXTERNOS=true (bash: YUI_TESTES_EXTERNOS=true npm run test:externos; PowerShell: $env:YUI_TESTES_EXTERNOS=\'true\'; npm run test:externos).',
    '',
  ].join('\n'));
  process.exit(3);
}

console.log([
  '',
  '######################################################################################################',
  '# ATENÇÃO: os testes abaixo vão ACESSAR SERVIÇOS OU PROGRAMAS EXTERNOS DE VERDADE (YUI_TESTES_EXTERNOS=true).      #',
  '# Eles não fazem parte da CI. Confira o recurso de cada um antes de continuar.                                    #',
  '######################################################################################################',
  linhas,
  '',
].join('\n'));

const resultados = [];
for (const e of escolhidos) {
  const argv = String(e.comando).trim().split(/\s+/);
  if (argv[0] !== 'node') { console.error(`O comando de ${e.teste} não é "node ...": ${e.comando}`); process.exit(2); }
  console.log(`\n=== ${e.teste} [${e.area}] ===  (${e.justificativa})`);
  const t0 = Date.now();
  // (process.execArgv: se este executor estiver sob o bloqueio de integração externa dos testes, o teste filho herda o mesmo bloqueio; no uso normal é vazio)
  const r = spawnSync(process.execPath, [...process.execArgv, ...argv.slice(1)], { cwd: raiz, stdio: 'inherit', env: { ...process.env, ...(e.env ?? {}) } });
  resultados.push({ teste: e.teste, ok: r.status === 0, ms: Date.now() - t0 });
}
console.log('\nResumo dos testes externos:');
for (const r of resultados) console.log(`  ${r.ok ? 'OK    ' : 'FALHOU'} ${r.teste} (${(r.ms / 1000).toFixed(1)}s)`);
process.exit(resultados.every((r) => r.ok) ? 0 : 1);
