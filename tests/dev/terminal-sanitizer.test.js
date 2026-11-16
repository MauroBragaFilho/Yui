// Terminal seguro (Fase 1, R03): sem shell, lista fechada de executáveis, opções e caminhos recusados.
// Execução: npm run test:dev
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { analyzeCommand, prepareCommand, checkPaths, allowedExecutables, resolveLocalBin, DEFAULT_ALLOWED } from '../../src/core/dev/terminalSanitizer.js';
import { runCommand } from '../../src/core/dev/terminal.js';
import { createPolicy } from '../../src/core/dev/policy.js';

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-sanit-'));
const outside = path.join(path.dirname(proj), `${path.basename(proj)}-fora`);
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(proj, 'ok.js'), "console.log('rodou')");
fs.writeFileSync(path.join(proj, '.env'), 'SEGREDO=1');
fs.writeFileSync(path.join(outside, 'x.js'), "console.log('fora')");
test.after(() => { fs.rmSync(proj, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });

const ok = (cmd, env) => analyzeCommand(cmd, { env }).ok === true;
const why = (cmd, env) => analyzeCommand(cmd, { env }).reason;

test('lista padrão: git, node, npm, npx, pytest, python (sem -c), tsc, eslint', () => {
  assert.deepEqual([...DEFAULT_ALLOWED], ['git', 'node', 'npm', 'npx', 'pytest', 'python', 'tsc', 'eslint']);
  for (const c of ['git status', 'git diff --stat', 'git log --oneline -5', 'git add src/a.js', 'git commit -m "mensagem com espaço"', 'node ok.js', 'node --version', 'node --test tests', 'npm test', 'npm run lint', 'npm install lodash', 'npm ls --depth=0', 'npx tsc --noEmit', 'npx eslint src', 'tsc --noEmit', 'eslint .', 'pytest -q tests', 'python script.py', 'python -m pytest -q', 'python --version']) {
    assert.equal(ok(c), true, `${c}: ${why(c)}`);
  }
});

test('evasão (especificação §9.6): shells, código em linha, encadeamento e substituição NÃO passam', () => {
  const payloads = [
    'cmd.exe /c calc', 'cmd /c calc', 'powershell -enc AAAA', 'powershell -Command calc', 'pwsh -c calc', 'bash -c "id"', 'sh -c id', 'wsl ls',
    'python -c "import os; os.system(1)"', 'python -c"print(1)"', 'python -m http.server', 'python -i', 'py -c 1',
    'node -e "process.exit(0)"', 'node --eval "1"', 'node -p 1', 'node -pe 1', 'node --print 1', 'node -r ./x.js a.js', 'node --require ./x.js a.js', 'node --import ./x.mjs a.js', 'node --run build', 'node --input-type=module -e 1', 'node', 'node --inspect a.js',
    'foo && bar', 'git status && git push', 'git status; rm -rf x', 'git status | sh', 'git status > out.txt', 'git status < in.txt', 'git status `whoami`', 'git status $(whoami)', 'git status ${HOME}', 'git status\nrm x', 'git status\rrm x',
    'npm exec evil', 'npm x evil', 'npm init x', 'npm create x', 'npm config set script-shell cmd', 'npm publish', 'npm link', 'npm explore x -- cmd', 'npm run x --script-shell=cmd', 'npm install -g x', 'npm --prefix ..\\x test',
    'npx cowsay oi', 'npx -p evil tsc', 'npx --package=evil tsc', 'npx -c "calc"', 'npx -y tsc', 'npx',
    'git -c core.sshCommand=calc fetch', 'git -c alias.x=!calc x', 'git -C .. status', 'git --git-dir=..\\x status', 'git config alias.x !calc', 'git submodule update', 'git clean -fdx', 'git fetch --upload-pack=calc', 'git remote add x http://evil', 'git rebase -x calc main', 'git',
    'eslint --init', 'pytest -p evilplugin', 'pytest -pevilplugin',
    'curl http://x', 'wget http://x', 'ssh host', 'reg add x', 'certutil -urlcache x', 'rundll32 x', 'mshta x', 'schtasks /run /tn x', 'sudo ls',
    'C:\\Windows\\System32\\cmd.exe /c calc', './node ok.js', '..\\node.exe ok.js', '~/bin/git status', 'npm.cmd test', 'git.bat status', 'evil.exe', 'ls', 'dir', 'echo oi', 'type .env', 'cat .env', 'del x', 'rm x', 'powershell', 'start calc', 'explorer .',
    'git "status', "git 'status", '',  '   ',
  ];
  for (const c of payloads) assert.equal(ok(c), false, `deveria bloquear: ${JSON.stringify(c)}`);
});

test('um executável perigoso não entra nem se estiver em YUI_DEV_ALLOWED_EXECUTABLES; a lista pode ser reduzida ou ampliada com segurança', () => {
  const env = { YUI_DEV_ALLOWED_EXECUTABLES: 'git,cmd,powershell,bash,node,dotnet,../x,ru st' };
  assert.deepEqual([...allowedExecutables(env)].sort(), ['dotnet', 'git', 'node']);
  assert.equal(ok('cmd /c calc', env), false);
  assert.equal(ok('powershell -c 1', env), false);
  assert.match(why('dotnet test', env) ?? '', /sem regras de segurança/, 'programa novo sem regras próprias não é liberado');
  assert.equal(ok('npm test', { YUI_DEV_ALLOWED_EXECUTABLES: 'git' }), false);
  assert.equal(ok('git status', { YUI_DEV_ALLOWED_EXECUTABLES: 'git' }), true);
});

test('caminhos: fora do projeto, "..", absolutos, home e arquivos sensíveis são recusados', () => {
  const bad = ['node ..\\x.js', 'node ../x.js', `node ${path.join(outside, 'x.js')}`, 'node ~/x.js', 'git add ../fora', 'git diff --output=../x.txt', 'node C:\\Windows\\win.ini', 'git add .env', 'git add secrets.json', 'node .env', 'git add id_rsa', 'node cert.pem', 'git diff --output=..\\x'];
  for (const c of bad) {
    const p = prepareCommand(c, { cwd: proj });
    assert.equal(p.ok, false, `deveria bloquear: ${c}`);
  }
  for (const c of ['node ok.js', 'node ./ok.js', 'git add .', 'git add src/novo.js', 'git log --format=%H', 'npm run test -- --grep x']) {
    assert.equal(prepareCommand(c, { cwd: proj }).ok, true, `${c}: ${prepareCommand(c, { cwd: proj }).reason}`);
  }
  assert.equal(checkPaths(['x.js'], path.join(proj, 'nao-existe')).ok, false);
});

test('preparar: nada vira shell; npm e as ferramentas rodam como "node <arquivo js>"', () => {
  const git = prepareCommand('git status', { cwd: proj });
  assert.deepEqual([git.file, git.args], ['git', ['status']]);
  const node = prepareCommand('node ok.js', { cwd: proj });
  assert.equal(node.file, process.execPath);
  const npm = prepareCommand('npm test', { cwd: proj });
  assert.equal(npm.file, process.execPath);
  assert.match(npm.args[0], /npm-cli\.js$/);
  assert.deepEqual(npm.args.slice(1), ['test']);
  assert.equal(prepareCommand('git commit -m "a b c"', { cwd: proj }).args.at(-1), 'a b c', 'aspas agrupam sem expandir');
  assert.equal(prepareCommand('git status', { cwd: undefined }).ok, false);
});

test('tsc/eslint/npx: só do node_modules DO PROJETO, direto (sem npx e sem baixar nada)', () => {
  const none = prepareCommand('npx tsc --noEmit', { cwd: proj });
  assert.equal(none.ok, false);
  assert.match(none.reason, /não está instalado neste projeto/);
  const pkg = path.join(proj, 'node_modules', 'typescript');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'typescript', bin: { tsc: './bin/tsc' } }));
  fs.writeFileSync(path.join(pkg, 'bin', 'tsc'), "console.log('tsc-falso', process.argv.slice(2).join(' '))");
  for (const c of ['npx tsc --noEmit', 'tsc --noEmit']) {
    const p = prepareCommand(c, { cwd: proj });
    assert.equal(p.ok, true, c);
    assert.equal(p.file, process.execPath);
    assert.deepEqual(p.args.slice(1), ['--noEmit']);
  }
  assert.ok(resolveLocalBin('typescript', 'tsc', proj));
  // bin apontando para fora do pacote é ignorado
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'typescript', bin: { tsc: '../../../x.js' } }));
  assert.equal(resolveLocalBin('typescript', 'tsc', proj), null);
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'typescript', bin: { tsc: './bin/tsc' } }));
});

test('execução real: roda o que é permitido e BLOQUEIA o resto sem criar processo (nem com aprovação)', async () => {
  const run = await runCommand('node ok.js', { cwd: proj });
  assert.equal(run.success, true);
  assert.equal(run.stdout.trim(), 'rodou');
  assert.equal((await runCommand('node --version', { cwd: proj })).stdout.trim(), process.version);
  const npm = await runCommand('npm --version', { cwd: proj });
  assert.equal(npm.success, true, npm.stderr);
  assert.match(npm.stdout.trim(), /^\d+\.\d+\.\d+/);
  const tsc = await runCommand('npx tsc --noEmit', { cwd: proj });
  assert.equal(tsc.stdout.trim(), 'tsc-falso --noEmit');

  const marker = path.join(proj, 'executou.txt');
  for (const c of [`node -e "require('fs').writeFileSync('executou.txt','x')"`, 'cmd /c echo x > executou.txt', 'node ok.js && node ok.js', 'git status; node ok.js', 'node ../x.js', 'git add .env']) {
    const r = await runCommand(c, { cwd: proj });
    assert.equal(r.blocked, true, c);
    assert.equal(r.success, false);
    assert.match(r.stderr, /^Comando bloqueado: /);
  }
  assert.equal(fs.existsSync(marker), false, 'nada foi executado');
  assert.equal((await runCommand('node ok.js', {})).success, false, 'sem pasta de projeto não roda');
});

test('política: o que o sanitizador recusa é NEGADO antes de perguntar; o permitido segue a regra de aprovação', () => {
  const p = createPolicy({ approvalMode: 'ask' });
  for (const c of ['cmd /c calc', 'node -e 1', 'python -c 1', 'git status && rm x', 'npx cowsay', 'ls', 'git -c a=b fetch']) {
    const v = p.check('run_terminal', { command: c });
    assert.equal(v.decision, 'deny', c);
    assert.match(v.reason, /Comando (não permitido|bloqueado)/, c);
  }
  assert.equal(p.check('run_terminal', { command: 'git status' }).decision, 'allow');
  assert.equal(p.check('run_terminal', { command: 'npm test' }).decision, 'allow');
  assert.equal(p.check('run_terminal', { command: 'npm install lodash' }).decision, 'ask');
  assert.equal(p.check('run_terminal', { command: 'git commit -m x' }).decision, 'ask');
  assert.equal(createPolicy({ approvalMode: 'auto' }).check('run_terminal', { command: 'node -e 1' }).decision, 'deny', 'o modo auto também não libera');
  assert.equal(createPolicy({ approvalMode: 'readonly' }).check('run_terminal', { command: 'git status' }).decision, 'deny');
});

test('o arquivo do terminal não usa mais shell (vigia do código)', () => {
  const src = fs.readFileSync(new URL('../../src/core/dev/terminal.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/shell:\s*true/.test(src));
  assert.match(src, /shell:\s*false/);
  assert.ok(!/\bexec(Sync)?\(/.test(src));
});
