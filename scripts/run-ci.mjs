// Executa as suítes OFFLINE da Yui (sem Discord, sem chaves, sem rede) e resume o resultado.
//   npm run test:ci            roda tudo
//   npm run test:ci -- core    roda só as que contêm "core" no nome
//
// Cada suíte é um script do package.json ("test:...") que começa com `node`. Falha = código de saída
// diferente de zero. Exceção documentada: no Node 24 para Windows, algumas suítes terminam com um aborto
// do libuv DEPOIS de imprimir "N testes OK" (defeito ao sair com handles abertos, anterior ao CI);
// isso só é aceito se a saída mostrar o resumo de sucesso e nenhum erro de asserção.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;

/** Suítes que rodam sem rede, sem Discord e sem Windows específico. Acrescente aqui ao criar uma nova. */
export const SUITES = [
  'test:core', 'test:core-api', 'test:core-agent', 'test:readonly', 'test:permgaps', 'test:panel', 'test:alerts',
  'test:persona', 'test:mentions', 'test:search', 'test:gateway', 'test:config', 'test:memperm', 'test:hybrid',
  'test:audit', 'test:backup', 'test:dmowner', 'test:chatintents', 'test:imageintent', 'test:library',
  'test:reminders', 'test:remindersapi', 'test:llmsafety', 'test:context', 'test:safefetch', 'test:netdefaults',
  'test:healthreport', 'test:guilddelete', 'test:redditguard', 'test:chromeprofile', 'test:interactionstats',
  'test:dev', 'test:security', 'test:approvals', 'test:routes', 'test:discordguard',
];

function argvOf(command) {
  const parts = command.trim().split(/\s+/);
  if (parts[0] !== 'node') throw new Error(`só scripts "node ..." são aceitos: ${command}`);
  return parts.slice(1).map((p) => p.replace(/^"|"$/g, ''));
}

const filter = process.argv[2] ?? '';
const results = [];
for (const name of SUITES) {
  if (filter && !name.includes(filter)) continue;
  if (!scripts[name]) { results.push({ name, status: 'AUSENTE', ms: 0 }); continue; }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, argvOf(scripts[name]), { cwd: root, encoding: 'utf8', timeout: 180_000, env: { ...process.env, NO_COLOR: '1' } });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const okSummary = /\b(\d+) testes? OK\b|ℹ fail 0|\bpass \d+/.test(out);
  const libuvExit = /UV_HANDLE_CLOSING/.test(out) && okSummary && !/AssertionError|ℹ fail [1-9]|✖/.test(out);
  const passed = r.status === 0 || libuvExit;
  results.push({ name, status: passed ? 'ok' : 'FALHOU', ms: Date.now() - t0, note: r.status !== 0 && libuvExit ? 'aborto do libuv ao sair (tolerado)' : '', out: passed ? '' : out.split('\n').slice(-25).join('\n') });
  console.log(`${passed ? '✔' : '✖'} ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)${results.at(-1).note ? ` — ${results.at(-1).note}` : ''}`);
}

const failed = results.filter((r) => r.status !== 'ok');
for (const f of failed) console.log(`\n── ${f.name}: ${f.status}\n${f.out ?? ''}`);
console.log(`\n${results.length - failed.length}/${results.length} suítes OK${failed.length ? `; falharam: ${failed.map((f) => f.name).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
