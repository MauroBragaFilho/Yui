// A SEPARAÇÃO dos testes que acessam algo de fora e a prova de que ela vale (etapa 8, rodada depois da revisão da Liz, §12 do docs/RELATORIO_ETAPA8_PRE_PILOTO.md).
// Regras da Liz: toda exceção identifica o teste, o recurso liberado e a justificativa; nenhuma exceção global; nenhum teste normal acessa serviço externo em silêncio.
// Este teste roda SEM REDE (ele mesmo sobe sob o bloqueio de integração externa) e confere, sem executar nenhum teste externo:
//  1. o registro único (tests/externos.json) é válido: cada exceção tem teste, recurso e justificativa, e não há exceção global;
//  2. TODA suíte da CI normal está (a) sob o bloqueio (o teste cria o dele para os processos que abre, ou o scripts/run-ci.mjs sobe o processo dele com o bloqueio
//     carregado e derruba a suíte se houver qualquer tentativa externa) ou (b) declarada no registro com a justificativa (e a declaração é conferida no código);
//  3. nenhum teste externo está na CI normal (nem pelo nome do script, nem pelo arquivo, nem importado por uma suíte da CI);
//  4. os testes externos só rodam de propósito: sem YUI_TESTES_EXTERNOS=true o executor (scripts/run-externos.mjs) não roda nada, e com a chave ele avisa que vai acessar
//     serviços externos (provado com um registro falso, nunca com um teste externo de verdade);
//  5. o que cada teste escreve no código como exceção bate com o registro; a documentação (README_TESTES.md) cita a separação.
// Execução: npm run test:cobertura-bloqueio
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rodarSobBloqueio, EXCECOES_DO_CANAL } from './helpers/bloqueioExternoTeste.js';
import {
  RAIZ, lerRegistro, lerScripts, lerSuitesDaCI, arquivoDoScript, classificarSuite, usaBloqueio, excecoesNoCodigo,
} from './helpers/coberturaBloqueio.mjs';

// O PRÓPRIO teste roda sob o bloqueio (nem uma regressão do executor dos testes externos alcançaria algo de fora): o pai relança este arquivo com o bloqueio.
rodarSobBloqueio(import.meta.url, {
  teste: 'test:cobertura-bloqueio',
  liberar: { 'node:com-bloqueio': 'o teste abre o executor dos testes externos SEM a chave (e com um registro falso, só no modo de teste) para provar que nada roda sem ela; o executor continua bloqueado' },
});

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✔ ${name}`); };
const EXCECAO_RE = /^(programa:[a-z0-9_.-]{1,40}|worker:parseWorker|node:com-bloqueio|nome-local:[a-z0-9.-]{1,60}|ip-da-maquina)$/;
const AREAS = new Set(['reddit', 'tts', 'deezer', 'spotdl', 'media']);
const texto = (v, min = 15) => typeof v === 'string' && v.trim().length >= min;

const registro = lerRegistro();
const scripts = lerScripts();
const suites = lerSuitesDaCI();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-cobertura-'));

try {
  console.log('O registro único (tests/externos.json)');
  await test('cada exceção tem TESTE, RECURSO e JUSTIFICATIVA; é uma das exceções que o bloqueio entende; não há exceção global nem repetida', () => {
    assert.ok(registro.excecoesDaCI.length >= 30, 'o registro lista as exceções dos testes');
    const vistos = new Set();
    for (const e of registro.excecoesDaCI) {
      assert.match(String(e.teste), /^test:[a-z0-9:-]+$/, `teste da exceção: ${JSON.stringify(e)}`);
      assert.match(String(e.excecao), EXCECAO_RE, `exceção desconhecida: ${JSON.stringify(e)}`);
      assert.ok(texto(e.recurso), `${e.teste} ${e.excecao}: falta o recurso liberado`);
      assert.ok(texto(e.justificativa), `${e.teste} ${e.excecao}: falta a justificativa`);
      const chave = `${e.teste}|${e.excecao}`;
      assert.ok(!vistos.has(chave), `exceção repetida: ${chave}`);
      vistos.add(chave);
      assert.ok(Object.hasOwn(scripts, e.teste), `${e.teste}: o teste da exceção não existe no package.json`);
    }
    // não existe exceção global: toda exceção é "por teste" (o criarBloqueio recusa a que não está aqui para o teste que a declara)
    assert.ok(registro.excecoesDaCI.every((e) => e.teste !== '*' && e.teste !== 'global'));
  });

  await test('os testes SEM bloqueio e os EXTERNOS também têm teste, justificativa e recurso; cada externo tem área, comando e arquivo que existe', () => {
    for (const s of registro.semBloqueio) {
      assert.ok(texto(s.justificativa), `${s.teste}: falta a justificativa`);
      assert.ok(suites.includes(s.teste), `${s.teste}: o semBloqueio só vale para suítes da CI`);
    }
    const ids = new Set();
    for (const e of registro.externos) {
      assert.ok(texto(e.recurso) && texto(e.justificativa), `${e.teste}: falta o recurso ou a justificativa`);
      assert.ok(AREAS.has(e.area), `${e.teste}: área desconhecida (${e.area})`);
      assert.match(String(e.comando), /^node tests\/[\w./-]+\.js$/, `${e.teste}: o comando é "node tests/..."`);
      assert.ok(fs.existsSync(path.join(RAIZ, arquivoDoScript(e.comando))), `${e.teste}: o arquivo ${e.comando} não existe`);
      assert.ok(!ids.has(e.teste), `externo repetido: ${e.teste}`);
      ids.add(e.teste);
      if (e.env !== undefined) assert.ok(Object.values(e.env).every((v) => typeof v === 'string'), `${e.teste}: env só com textos`);
    }
    // os que a Liz listou (Reddit real, TTS, Deezer, spotdl e media) estão separados
    for (const id of ['test:weekly-e2e-real', 'test:tts-e2e', 'test:tts-audio', 'test:deezer', 'test:spotdl', 'test:media']) assert.ok(ids.has(id), `${id} deveria estar entre os externos`);
  });

  console.log('\nA CI normal: tudo sob o bloqueio ou declarado');
  const classes = new Map(suites.map((s) => [s, classificarSuite(s, { scripts, registro })]));
  await test('TODA suíte da CI está sob o bloqueio (o teste cria o dele, ou o CI sobe o processo dele bloqueado) ou DECLARADA no registro com a justificativa', () => {
    assert.ok(suites.length >= 60, `a CI tem ${suites.length} suítes`);
    const por = { proprio: [], envolvida: [], declarada: [] };
    for (const [nome, c] of classes) {
      assert.ok(['proprio', 'envolvida', 'declarada'].includes(c.modo), `${nome}: modo ${c.modo}`);
      por[c.modo].push(nome);
      if (c.modo === 'declarada') assert.ok(registro.semBloqueio.some((s) => s.teste === nome && texto(s.justificativa)), `${nome}: declarada sem justificativa`);
    }
    assert.equal(por.proprio.length + por.envolvida.length + por.declarada.length, suites.length, 'nenhuma suíte ficou sem classificação');
    // as suítes que abrem processos auxiliares TÊM de estar no modo próprio (o bloqueio dos filhos) e as que não têm o bloqueio próprio sobem bloqueadas pelo CI
    assert.ok(por.envolvida.length >= 20, 'as suítes de um processo só sobem sob o bloqueio do CI');
    assert.ok(por.proprio.includes('test:cotahora') && por.proprio.includes('test:steamjogo') && por.proprio.includes('test:contextnative'), 'inclusive as que importam outro teste com bloqueio (contextnative)');
    for (const nome of ['test:approvals', 'test:search', 'test:safefetch', 'test:channel', 'test:falhafechada', 'test:weeklygravado']) assert.equal(classes.get(nome).modo, 'envolvida', `${nome} roda sob o bloqueio do CI`);
    console.log(`     próprio: ${por.proprio.length} | sob o bloqueio do CI: ${por.envolvida.length} | declaradas no registro: ${por.declarada.length} (${por.declarada.join(', ')})`);
  });

  await test('a declaração do semBloqueio vale no código: os arquivos de tests/dev (rodados pelo `node --test`) não abrem processo, worker nem rede externa (só o servidor local, no loopback, que o próprio teste abre)', () => {
    const declaradas = [...classes].filter(([, c]) => c.modo === 'declarada').map(([n]) => n);
    assert.deepEqual(declaradas, ['test:dev']);
    const arquivos = fs.readdirSync(path.join(RAIZ, 'tests', 'dev')).filter((f) => /\.test\.js$/.test(f));
    assert.ok(arquivos.length >= 4);
    const PERIGOSO = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(|\bfetch\s*\(|\bnet\.connect|createConnection|new\s+Worker\s*\(|from\s+['"]node:(?:dgram|dns)['"]/;
    for (const f of arquivos) {
      const src = fs.readFileSync(path.join(RAIZ, 'tests', 'dev', f), 'utf8');
      assert.ok(!PERIGOSO.test(src), `tests/dev/${f} usa processo, rede ou worker de verdade`);
      // um http.request só vale contra o servidor local que o PRÓPRIO teste abre no loopback (listen(0, '127.0.0.1'))
      if (/https?\.(?:request|get)\s*\(/.test(src)) assert.ok(/\.listen\(\s*0\s*,\s*['"](?:127\.0\.0\.1|localhost)['"]/.test(src), `tests/dev/${f} faz uma requisição HTTP sem abrir um servidor local no loopback`);
    }
  });

  await test('o scripts/run-ci.mjs roda cada suíte pela MESMA classificação: sobe sob o bloqueio só as "envolvidas", confere o registro e derruba a suíte com qualquer tentativa externa', () => {
    const ci = fs.readFileSync(path.join(RAIZ, 'scripts', 'run-ci.mjs'), 'utf8').replace(/\r\n/g, '\n');
    assert.match(ci, /classificarSuite\(name,/);
    assert.match(ci, /como\.modo === 'envolvida'/);
    assert.match(ci, /criarBloqueio\(pastaBloqueio, \{ teste: name, liberar: liberarDe\(como\.excecoes\) \}\)/, 'as exceções vêm do registro, por suíte');
    assert.match(ci, /bloqueio\.argv/);
    assert.match(ci, /NODE_ENV: 'test'/);
    assert.match(ci, /tentativas\.length === 0/, 'qualquer tentativa bloqueada derruba a suíte');
    // uma suíte que a CI sobe bloqueada NÃO cria o próprio bloqueio (nenhuma classificação mentirosa): a classificação "envolvida" exige que o teste não use o ajudante
    for (const [nome, c] of classes) if (c.modo === 'envolvida') assert.ok(!usaBloqueio(c.arquivo, RAIZ), `${nome}: usa o ajudante de bloqueio mas está como "envolvida"`);
    for (const [nome, c] of classes) if (c.modo === 'proprio') assert.ok(usaBloqueio(c.arquivo, RAIZ), `${nome}: está como "próprio" sem usar o ajudante de bloqueio`);
  });

  console.log('\nNenhum teste externo na CI normal');
  await test('os testes EXTERNOS não estão na CI: nem pelo nome do script, nem pelo arquivo, nem importados por uma suíte da CI; e o `test:ci` só roda a lista da CI', () => {
    const idsExternos = new Set(registro.externos.map((e) => e.teste));
    const arquivosExternos = new Set(registro.externos.map((e) => arquivoDoScript(e.comando)));
    for (const s of suites) {
      assert.ok(!idsExternos.has(s), `${s} é EXTERNO e está na CI normal`);
      const arq = arquivoDoScript(scripts[s]);
      assert.ok(!arquivosExternos.has(arq), `${s} roda o arquivo ${arq}, que é de um teste externo`);
    }
    // nenhum arquivo externo é importado por um teste da CI (até 2 níveis)
    const importa = (arq, vistos = new Set(), prof = 2) => {
      if (!arq || vistos.has(arq) || !fs.existsSync(path.join(RAIZ, arq))) return [];
      vistos.add(arq);
      const achados = [];
      for (const m of fs.readFileSync(path.join(RAIZ, arq), 'utf8').matchAll(/(?:import\s*\(\s*|from\s*|import\s+)['"](\.\/[\w.-]+\.(?:js|mjs))['"]/g)) {
        const alvo = path.posix.join(path.posix.dirname(arq), m[1]);
        if (/^tests\/test-[\w-]+\.(?:js|mjs)$/.test(alvo)) { achados.push(alvo); if (prof > 0) achados.push(...importa(alvo, vistos, prof - 1)); }
      }
      return achados;
    };
    for (const s of suites) for (const alvo of importa(arquivoDoScript(scripts[s]))) assert.ok(!arquivosExternos.has(alvo), `${s} importa o teste externo ${alvo}`);
    assert.equal(scripts['test:ci'], 'node scripts/run-ci.mjs');
    const ci = fs.readFileSync(path.join(RAIZ, 'scripts', 'run-ci.mjs'), 'utf8');
    assert.ok(!/run-externos|YUI_TESTES_EXTERNOS/.test(ci.replace(/\/\/.*$/gm, '')), 'o run-ci não chama o executor dos externos');
    // o `test:tts` (a cadeia documentada) não leva os testes externos de TTS
    for (const e of registro.externos) assert.ok(!scripts['test:tts'].includes(e.comando.replace(/^node /, '')), `test:tts não pode rodar ${e.teste}`);
  });

  await test('todo script externo do package.json passa pelo executor opt-in, e há um `test:externos` geral e um por área', () => {
    for (const e of registro.externos) assert.equal(scripts[e.teste], `node scripts/run-externos.mjs ${e.teste}`, `${e.teste}: o script tem de apontar para o executor opt-in`);
    assert.equal(scripts['test:externos'], 'node scripts/run-externos.mjs todos');
    for (const area of new Set(registro.externos.map((e) => e.area))) assert.equal(scripts[`test:externos:${area}`], `node scripts/run-externos.mjs ${area}`, `falta o script da área ${area}`);
    // o comando verdadeiro de nenhum externo está solto no package.json (o único jeito de rodar é pelo executor)
    // (o modo com "env", como o LIVE=1 do feed do Reddit, divide o arquivo com o modo offline do mesmo teste: o offline segue solto e fora da CI)
    for (const e of registro.externos.filter((x) => x.env === undefined)) for (const [nome, cmd] of Object.entries(scripts)) assert.ok(nome === 'test:tts' || !String(cmd).includes(e.comando.replace(/^node /, '')) || cmd.startsWith('node scripts/run-externos.mjs'), `${nome} roda ${e.teste} direto, sem o executor opt-in`);
  });

  console.log('\nOs externos só rodam de propósito (YUI_TESTES_EXTERNOS=true)');
  const SYSTEM_KEYS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'USERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'ProgramFiles', 'ProgramData', 'SystemDrive'];
  /** Abre o executor dos testes externos (sob o MESMO bloqueio deste teste: o --import do pai e as variáveis do registro vão junto). */
  function executor(args, { chave = null, registroFalso = null } = {}) {
    const env = { ...process.env };
    delete env.YUI_TESTES_EXTERNOS;
    delete env.YUI_REGISTRO_EXTERNOS;
    for (const k of Object.keys(env)) if (!SYSTEM_KEYS.includes(k) && !k.startsWith('YUI_TESTE_BLOQUEIO_') && k !== 'NODE_ENV') delete env[k];
    if (chave !== null) env.YUI_TESTES_EXTERNOS = chave;
    if (registroFalso) env.YUI_REGISTRO_EXTERNOS = registroFalso;
    return spawnSync(process.execPath, [...process.execArgv, path.join(RAIZ, 'scripts', 'run-externos.mjs'), ...args], { cwd: RAIZ, encoding: 'utf8', timeout: 60_000, windowsHide: true, env });
  }
  await test('SEM a chave, nada roda (todos, uma área ou um teste só): sai com o código 3, avisa o que NÃO rodou e nenhum teste é aberto', () => {
    for (const alvo of ['todos', 'tts', 'test:weekly-e2e-real', 'reddit', 'deezer']) {
      const r = executor([alvo]);
      assert.equal(r.status, 3, `${alvo}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /NÃO RODEI/);
      assert.match(r.stderr, /YUI_TESTES_EXTERNOS=true/);
      assert.ok(!/=== test:/.test(r.stdout), `${alvo}: não pode ter começado nenhum teste`);
    }
    // a chave só vale com o texto "true" (qualquer outro valor não liga)
    for (const valor of ['', '1', 'sim', 'false', 'talvez']) assert.equal(executor(['todos'], { chave: valor }).status, 3, `YUI_TESTES_EXTERNOS=${valor}`);
    assert.equal(executor(['nao-existe']).status, 2, 'pedido inválido não roda nada');
  });
  await test('COM a chave o executor AVISA com todas as letras que vai acessar serviços externos e roda só o que foi pedido (provado com um registro falso, nunca com um teste externo de verdade)', () => {
    fs.mkdirSync(path.join(tmp, 'tests'), { recursive: true });
    const ok = path.join(tmp, 'ok.js');
    const ruim = path.join(tmp, 'ruim.js');
    fs.writeFileSync(ok, "console.log('RODOU-O-FALSO-OK');\n");
    fs.writeFileSync(ruim, "console.log('RODOU-O-FALSO-RUIM'); process.exit(1);\n");
    const falso = path.join(tmp, 'externos-falso.json');
    const doTeste = (id, arquivo, area = 'tts') => ({ teste: id, area, comando: `node ${arquivo.replace(/\\/g, '/')}`, recurso: 'um recurso falso de teste', justificativa: 'um teste falso do executor' });
    fs.writeFileSync(falso, JSON.stringify({ excecoesDaCI: [], semBloqueio: [], externos: [doTeste('falso:ok', ok), doTeste('falso:ruim', ruim, 'media')] }));
    const r1 = executor(['falso:ok'], { chave: 'true', registroFalso: falso });
    assert.equal(r1.status, 0, `${r1.stdout}${r1.stderr}`);
    assert.match(r1.stdout, /ATENÇÃO: os testes abaixo vão ACESSAR SERVIÇOS OU PROGRAMAS EXTERNOS DE VERDADE/);
    assert.match(r1.stdout, /falso:ok \[tts\]: um recurso falso de teste/);
    assert.match(r1.stdout, /RODOU-O-FALSO-OK/);
    assert.ok(!/RODOU-O-FALSO-RUIM/.test(r1.stdout), 'só rodou o que foi pedido');
    const r2 = executor(['todos'], { chave: 'true', registroFalso: falso });
    assert.equal(r2.status, 1, 'um teste que falha derruba o conjunto');
    assert.match(r2.stdout, /RODOU-O-FALSO-OK/);
    assert.match(r2.stdout, /RODOU-O-FALSO-RUIM/);
    assert.match(r2.stdout, /FALHOU falso:ruim/);
    const r3 = executor(['media'], { chave: 'true', registroFalso: falso });
    assert.equal(r3.status, 1, 'uma área');
    assert.ok(!/RODOU-O-FALSO-OK/.test(r3.stdout));
    // o registro falso SÓ vale com NODE_ENV=test (nunca muda o que roda de verdade): a regra está no código do executor (este teste já roda com NODE_ENV=test)
    const fonte = fs.readFileSync(path.join(RAIZ, 'scripts', 'run-externos.mjs'), 'utf8');
    assert.match(fonte, /String\(process\.env\.NODE_ENV \?\? ''\)\.toLowerCase\(\) === 'test' \? String\(process\.env\.YUI_REGISTRO_EXTERNOS/);
    // e o executor repassa o bloqueio ao teste filho (sob o bloqueio do CI o teste externo também ficaria bloqueado)
    assert.match(fonte, /\.\.\.process\.execArgv/);
  });

  console.log('\nO código e a documentação batem com o registro');
  await test('o que cada teste da CI escreve no código como exceção ("programa:x", "worker:x", "node:com-bloqueio", "nome-local:x") está no registro PARA ESSE TESTE', () => {
    for (const [nome, c] of classes) {
      if (!c.arquivo) continue;
      const doRegistro = new Set(registro.excecoesDaCI.filter((e) => e.teste === nome).map((e) => e.excecao));
      // o arquivo do próprio teste (os testes que importam outro, como o contextnative, usam o registro do importado, que roda com o próprio nome)
      for (const e of excecoesNoCodigo(c.arquivo)) {
        // (a sonda do bloqueio usa tudo, de propósito, e este teste escreve os formatos das exceções no próprio texto: os dois são conferidos em tempo de execução pelo criarBloqueio)
        if (nome === 'test:bloqueioexterno' || nome === 'test:cobertura-bloqueio') continue;
        assert.ok(doRegistro.has(e), `${nome}: o código declara ${e}, que NÃO está no registro para este teste`);
      }
    }
  });
  await test('o teste de resistência de 2 h tem o PRÓPRIO id (`test:soak2h`): script no package.json, exceções suas no registro, o driver declara com esse id, é MANUAL (fora da CI) e está no README', () => {
    // revisão da Liz (§14 do relatório da etapa 8): cada teste tem o próprio identificador; não vale registrar o teste de resistência como o `test:operacao`
    assert.equal(scripts['test:soak2h'], 'node scripts/soak-dois-processos.mjs --minutos=120');
    assert.ok(fs.existsSync(path.join(RAIZ, 'scripts', 'soak-dois-processos.mjs')));
    const driver = fs.readFileSync(path.join(RAIZ, 'scripts', 'soak-dois-processos.mjs'), 'utf8');
    assert.match(driver, /teste: 'test:soak2h',/, 'o driver declara as exceções com o id próprio');
    assert.ok(!/teste:\s*[^,\n]*'test:operacao'/.test(driver), 'e nunca com o nome de outro teste');
    assert.ok(!/YUI_SOAK_TESTE/.test(driver.replace(/^\s*\/\/.*$/gm, '')), 'sem o desvio por variável de ambiente (que deixaria registrar o teste com outro nome)');
    // as exceções do registro para ele são EXATAMENTE as que o driver declara (as do canal + o supervisor + a trava de dono): nenhuma a mais, nenhuma a menos
    const doRegistro = registro.excecoesDaCI.filter((e) => e.teste === 'test:soak2h').map((e) => e.excecao).sort();
    const doDriver = [...Object.keys(EXCECOES_DO_CANAL), ...excecoesNoCodigo('scripts/soak-dois-processos.mjs')].sort();
    assert.deepEqual(doRegistro, doDriver, 'as exceções do test:soak2h: as do registro são as do driver');
    assert.deepEqual(doRegistro, ['node:com-bloqueio', 'programa:icacls', 'programa:powershell', 'programa:whoami']);
    for (const e of registro.excecoesDaCI.filter((x) => x.teste === 'test:soak2h')) assert.ok(texto(e.recurso) && texto(e.justificativa), `${e.excecao}: falta o recurso ou a justificativa`);
    // MANUAL, de 2 horas, fora da CI (como o test:importarmemoria): não está na lista da CI nem nos testes externos opt-in
    assert.ok(!suites.includes('test:soak2h'), 'o teste de 2 horas não roda na CI');
    assert.ok(!registro.externos.some((e) => e.teste === 'test:soak2h'));
    const doc = fs.readFileSync(path.join(RAIZ, 'README_TESTES.md'), 'utf8');
    const linha = doc.split('\n').find((l) => l.startsWith('npm run test:soak2h')) ?? '';
    assert.match(linha, /MANUAL/);
    assert.match(linha, /2 HORAS/);
    assert.match(linha, /FORA da CI/);
  });
  await test('a documentação (README_TESTES.md) explica a separação: a chave, o executor, o registro e este teste', () => {
    const doc = fs.readFileSync(path.join(RAIZ, 'README_TESTES.md'), 'utf8');
    for (const termo of ['YUI_TESTES_EXTERNOS', 'test:externos', 'tests/externos.json', 'test:cobertura-bloqueio', 'test:weeklygravado', 'run-externos']) assert.ok(doc.includes(termo), `o README_TESTES.md não cita ${termo}`);
  });
  console.log(`\n${passed} testes OK`);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* */ }
}
