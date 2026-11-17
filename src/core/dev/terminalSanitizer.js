import fs from 'fs';
import path from 'path';
import { isSensitive } from './workspace-fs.js';

/**
 * Terminal seguro da aba Código (Fase 1, R03): NUNCA passa por um shell.
 *
 *   texto do comando -> argv (sem interpretar nada) -> executável da lista fechada -> regras por programa
 *   -> caminhos dentro do projeto e sem arquivos sensíveis -> (arquivo, argumentos) para o spawn com shell:false
 *
 * `shell:false` sozinho NÃO basta: `node -e`, `python -c`, `git -c core.sshCommand=...`, `npm exec`, `npx pacote`
 * executam código arbitrário sem precisar de um shell. Por isso cada programa tem regras próprias abaixo, e o que
 * não está na lista é recusado (negar por padrão). Quem usa: `policy.js` (nega antes de perguntar) e
 * `terminal.js` (confere de novo na hora de executar: a aprovação nunca contorna estas regras).
 */

export const DEFAULT_ALLOWED = Object.freeze(['git', 'node', 'npm', 'npx', 'pytest', 'python', 'tsc', 'eslint']);

/** Nunca liberados, nem se estiverem em YUI_DEV_ALLOWED_EXECUTABLES: interpretadores de comando e executores genéricos. */
const HARD_DENY = new Set([
  'cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'wsl', 'wscript', 'cscript', 'mshta', 'rundll32',
  'regsvr32', 'certutil', 'bitsadmin', 'msiexec', 'schtasks', 'sc', 'reg', 'wmic', 'curl', 'wget', 'ssh', 'scp', 'sudo', 'su', 'runas', 'start', 'explorer',
]);

const MAX_COMMAND_CHARS = 2000;
const MAX_ARGS = 40;
const SHELL_SYNTAX = /[;&|<>`\0\r\n]|\$\(|\$\{/;

/** Executáveis permitidos: YUI_DEV_ALLOWED_EXECUTABLES (lista separada por vírgula) ou o padrão. Nunca inclui os de HARD_DENY. */
export function allowedExecutables(env = process.env) {
  const raw = String(env.YUI_DEV_ALLOWED_EXECUTABLES ?? '').trim();
  const list = raw ? raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9][a-z0-9_-]{0,30}$/.test(s)) : DEFAULT_ALLOWED;
  return new Set(list.filter((n) => !HARD_DENY.has(n)));
}

/** Divide em argumentos respeitando aspas simples e duplas. Não expande nada (sem $VAR, sem curingas, sem ~). */
function tokenize(command) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || cur) { out.push(cur); cur = ''; started = false; }
    } else {
      cur += ch;
    }
  }
  if (quote) return null;
  if (started || cur) out.push(cur);
  return out;
}

const deny = (reason) => ({ ok: false, reason });

const NODE_BLOCKED = /^(-e|--eval|-p|--print|-pe|-r|--require|--import|--loader|--experimental-loader|--input-type|-i|--interactive|--run|--watch-path|--inspect.*|--eval=.*|--print=.*|--require=.*|--import=.*)$/;
const NODE_ALONE_OK = new Set(['--version', '-v', '--test', '--check', '-c', '--help', '-h']);

function checkNode(args) {
  for (const a of args) if (NODE_BLOCKED.test(a)) return `node ${a} executa código em linha ou carrega módulos arbitrários`;
  const firstPositional = args.find((a) => !a.startsWith('-'));
  const hasAlone = args.some((a) => NODE_ALONE_OK.has(a) || a.startsWith('--test'));
  if (!firstPositional && !hasAlone) return 'node precisa de um arquivo do projeto, --test ou --version';
  return null;
}

const PY_OK_MODULES = new Set(['pytest', 'unittest']);
function checkPython(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || /^-c.+/.test(a)) return 'python -c executa código em linha';
    if (a === '-i') return 'python -i abre um interpretador interativo';
    if (a === '-m') {
      if (!PY_OK_MODULES.has(String(args[i + 1] ?? '').toLowerCase())) return 'python -m só é permitido com pytest ou unittest';
    } else if (/^-m.+/.test(a)) return 'python -m só é permitido com pytest ou unittest (separado: -m pytest)';
  }
  if (!args.length) return 'python precisa de um arquivo, -m pytest ou --version';
  return null;
}

const GIT_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'blame', 'grep', 'describe', 'shortlog', 'tag',
  'add', 'commit', 'checkout', 'switch', 'restore', 'stash', 'merge', 'pull', 'fetch', 'push', 'cherry-pick', 'revert', 'init',
]);
const GIT_GLOBAL_BLOCKED = /^(-c|-C|--git-dir.*|--work-tree.*|--exec-path.*|--config-env.*|--super-prefix.*|--namespace.*|--attr-source.*)$/;
const GIT_ANY_BLOCKED = /^(--upload-pack.*|--receive-pack.*|--exec.*|-x|--ext-diff|--textconv|--open-files-in-pager.*|--no-verify|-u.+|--output(=.*)?|--no-index)$/; // --output grava arquivo; --no-index lê fora do repositório
function checkGit(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (GIT_GLOBAL_BLOCKED.test(args[i])) return `git ${args[i]} muda a configuração ou a pasta do repositório`;
    if (!/^(--no-pager|--paginate|-p|--bare|--no-optional-locks|--version|-v|--help)$/.test(args[i])) return `opção global do git não permitida: ${args[i]}`;
    i += 1;
  }
  if (i >= args.length) return args.some((a) => a === '--version' || a === '-v') ? null : 'git precisa de um subcomando';
  const sub = args[i].toLowerCase();
  if (!GIT_SUBCOMMANDS.has(sub)) return `git ${sub} não está liberado (config, alias, hooks e execução externa ficam de fora)`;
  for (const a of args.slice(i + 1)) if (GIT_ANY_BLOCKED.test(a)) return `git ${sub} ${a}: opção que executa programas externos`;
  if (sub === 'remote' && args.slice(i + 1).some((a) => /^(add|set-url|remove|rm|rename|set-head|prune|update)$/.test(a))) return 'git remote só para consulta (-v)';
  return null;
}

const NPM_SUBCOMMANDS = new Set(['test', 't', 'run', 'run-script', 'start', 'ls', 'list', 'outdated', 'install', 'i', 'ci', 'uninstall', 'update', 'audit', '--version', '-v']);
const NPM_BLOCKED_FLAGS = /^(-g|--global|--prefix.*|--userconfig.*|--globalconfig.*|--script-shell.*|--shell.*|--cache.*|--registry.*|-C)$/;
function checkNpm(args) {
  const sub = args.find((a) => !a.startsWith('-')) ?? args.find((a) => a === '--version' || a === '-v');
  if (!sub) return 'npm precisa de um subcomando';
  if (!NPM_SUBCOMMANDS.has(sub.toLowerCase())) return `npm ${sub} não está liberado (exec, init, create, config, publish, link... ficam de fora)`;
  for (const a of args) if (NPM_BLOCKED_FLAGS.test(a)) return `npm ${a} muda onde ou como o npm roda`;
  return null;
}

/** Ferramentas de projeto que o npx pode chamar: viram execução DIRETA do binário local (sem npx e sem baixar nada). */
const LOCAL_TOOLS = Object.freeze({
  tsc: { pkg: 'typescript', bin: 'tsc' },
  eslint: { pkg: 'eslint', bin: 'eslint' },
  prettier: { pkg: 'prettier', bin: 'prettier' },
  jest: { pkg: 'jest', bin: 'jest' },
  vitest: { pkg: 'vitest', bin: 'vitest' },
  mocha: { pkg: 'mocha', bin: 'mocha' },
});

function checkLocalTool(name, args) {
  if (name === 'eslint' && args.some((a) => a === '--init' || /^--init=/.test(a))) return 'eslint --init instala pacotes';
  return null;
}

function checkPytest(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-p' && !/^no:/.test(String(args[i + 1] ?? ''))) return 'pytest -p carrega plugins arbitrários';
    if (/^-p.+/.test(a) && !/^-pno:/.test(a)) return 'pytest -p carrega plugins arbitrários';
  }
  return null;
}

function checkNpx(args) {
  const bad = args.find((a) => /^(-p|--package.*|-c|--call.*|-y|--yes|--shell.*|--node-arg.*)$/.test(a));
  if (bad) return `npx ${bad} instala ou executa pacotes arbitrários`;
  const tool = args.find((a) => !a.startsWith('-'));
  if (!tool) return 'npx precisa do nome de uma ferramenta do projeto';
  if (!Object.hasOwn(LOCAL_TOOLS, tool.toLowerCase())) return `npx ${tool}: só ${Object.keys(LOCAL_TOOLS).join(', ')} (ferramentas já instaladas no projeto)`;
  return null;
}

/**
 * Análise SEM tocar o disco: sintaxe, executável e opções. (Os caminhos são conferidos em prepareCommand.)
 * @returns {{ ok: true, exe: string, args: string[] } | { ok: false, reason: string }}
 */
export function analyzeCommand(command, { env = process.env } = {}) {
  const text = String(command ?? '');
  if (!text.trim()) return deny('comando vazio');
  if (text.length > MAX_COMMAND_CHARS) return deny('comando longo demais');
  if (SHELL_SYNTAX.test(text)) return deny('sintaxe de shell (; & | < > ` $( ${ ou quebra de linha) não é aceita: um comando por vez');
  const argv = tokenize(text);
  if (!argv) return deny('aspas sem fechar');
  if (!argv.length) return deny('comando vazio');
  if (argv.length > MAX_ARGS) return deny('argumentos demais');

  const [rawExe, ...args] = argv;
  if (/[\\/]/.test(rawExe) || /^[a-zA-Z]:/.test(rawExe) || rawExe.startsWith('.') || rawExe.startsWith('~')) return deny('o executável deve ser só o nome (sem caminho)');
  if (/\.(cmd|bat|ps1|vbs|js|msi|com|scr|lnk)$/i.test(rawExe)) return deny('somente programas da lista, sem scripts do sistema');
  const exe = rawExe.toLowerCase().replace(/\.exe$/, '');
  if (HARD_DENY.has(exe)) return deny(`${exe} nunca é liberado (interpretador de comandos ou execução remota)`);
  const allowed = allowedExecutables(env);
  if (!allowed.has(exe)) return deny(`${exe} não está na lista de executáveis permitidos (${[...allowed].join(', ')})`);
  if (args.some((a) => a.includes('\0'))) return deny('argumento inválido');

  let reason = null;
  if (exe === 'node') reason = checkNode(args);
  else if (exe === 'python') reason = checkPython(args);
  else if (exe === 'git') reason = checkGit(args);
  else if (exe === 'npm') reason = checkNpm(args);
  else if (exe === 'npx') reason = checkNpx(args);
  else if (exe === 'pytest') reason = checkPytest(args);
  else if (Object.hasOwn(LOCAL_TOOLS, exe)) reason = checkLocalTool(exe, args);
  else reason = `sem regras de segurança para ${exe}: não liberado`;
  return reason ? deny(reason) : { ok: true, exe, args };
}

function realInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Argumento que parece caminho (e valor depois de "--opcao=valor"). */
function pathCandidates(args) {
  const out = [];
  for (const a of args) {
    const value = a.startsWith('-') ? (a.includes('=') ? a.slice(a.indexOf('=') + 1) : null) : a;
    if (!value) continue;
    if (/[\\/]/.test(value) || value.startsWith('.') || value.startsWith('~') || /^[a-zA-Z]:/.test(value)) out.push(value);
    else if (/\.[A-Za-z0-9]{1,8}$/.test(value)) out.push(value); // "arquivo.ext"
  }
  return out;
}

/** Caminhos dentro do projeto (sem "..", sem links para fora) e sem arquivos sensíveis. */
export function checkPaths(args, cwd) {
  let root;
  try { root = fs.realpathSync(cwd); } catch { return deny('pasta do projeto indisponível'); }
  // Nome de arquivo sensível vale mesmo sem parecer caminho (ex.: "git add id_rsa").
  for (const a of args) {
    const value = a.startsWith("-") ? (a.includes("=") ? a.slice(a.indexOf("=") + 1) : "") : a;
    if (value && isSensitive(value)) return deny(`arquivo sensível (chaves/senhas): ${value}`);
  }
  for (const value of pathCandidates(args)) {
    if (value.startsWith('~')) return deny(`caminho fora do projeto: ${value}`);
    const lexical = path.resolve(root, value);
    if (!realInside(root, lexical)) return deny(`caminho fora do projeto: ${value}`);
    let real = lexical;
    try { real = fs.realpathSync(lexical); } catch { /* ainda não existe: vale o lexical */ }
    if (!realInside(root, real)) return deny(`caminho aponta para fora do projeto: ${value}`);
    if (isSensitive(path.relative(root, lexical))) return deny(`arquivo sensível (chaves/senhas): ${value}`);
  }
  return { ok: true };
}

/** Binário JS de um pacote do projeto (procura em node_modules da pasta e das de cima), sem passar por .cmd/.bin. */
export function resolveLocalBin(pkg, binName, cwd) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 12; i++) {
    const pkgDir = path.join(dir, 'node_modules', pkg);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      const rel = typeof meta.bin === 'string' ? meta.bin : meta.bin?.[binName];
      if (rel) {
        const file = path.resolve(pkgDir, rel);
        if (realInside(pkgDir, file) && fs.existsSync(file)) return file;
      }
    } catch { /* tenta a pasta de cima */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function npmCliFile(which, execPath) {
  const dir = path.dirname(execPath);
  const candidates = [
    path.join(dir, 'node_modules', 'npm', 'bin', `${which}-cli.js`), // Windows
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', `${which}-cli.js`), // Linux/macOS
  ];
  return candidates.find((f) => fs.existsSync(f)) ?? null;
}

/**
 * Valida TUDO e devolve o que o spawn vai executar (sempre com shell:false).
 * npm roda como `node npm-cli.js`; tsc/eslint/... como `node <bin local>`; o npx vira a execução direta da ferramenta.
 * @returns {{ ok: true, file: string, args: string[], display: string } | { ok: false, reason: string }}
 */
export function prepareCommand(command, { cwd, env = process.env, execPath = process.execPath } = {}) {
  const analysis = analyzeCommand(command, { env });
  if (!analysis.ok) return analysis;
  if (!cwd) return deny('nenhum projeto aberto');
  const paths = checkPaths(analysis.args, cwd);
  if (!paths.ok) return paths;

  const { exe, args } = analysis;
  const display = [exe, ...args].join(' ');
  if (exe === 'node') return { ok: true, file: execPath, args, display };
  if (exe === 'git' || exe === 'python' || exe === 'pytest') return { ok: true, file: exe, args, display };
  if (exe === 'npm') {
    const cli = npmCliFile('npm', execPath);
    return cli ? { ok: true, file: execPath, args: [cli, ...args], display } : deny('npm não encontrado junto do Node');
  }
  const toolName = exe === 'npx' ? args.find((a) => !a.startsWith('-')).toLowerCase() : exe;
  const toolArgs = exe === 'npx' ? args.slice(args.findIndex((a) => !a.startsWith('-')) + 1) : args;
  const tool = LOCAL_TOOLS[toolName];
  if (!tool) return deny(`sem regras de segurança para ${toolName}`);
  const bin = resolveLocalBin(tool.pkg, tool.bin, cwd);
  return bin ? { ok: true, file: execPath, args: [bin, ...toolArgs], display } : deny(`${toolName} não está instalado neste projeto (node_modules/${tool.pkg}); a Yui não baixa pacotes sozinha`);
}
