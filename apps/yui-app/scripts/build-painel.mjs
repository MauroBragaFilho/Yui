#!/usr/bin/env node
// Compila o painel web para a pasta VERSIONADA painel-web/ (é de lá que o atualizador do notebook leva o painel).
//   npm run painel:build      (dentro de apps/yui-app)  -> rode e comite ANTES de dar push de qualquer mudança no app.
// O build sai SEM endereço de servidor embutido: o painel usa o mesmo endereço em que a página foi aberta (porta 3939),
// por isso a variável EXPO_PUBLIC_YUI_SERVER_URL é removida do ambiente aqui.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fonteHash } from './fonte-hash.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(appDir, 'painel-web');
const env = { ...process.env };
delete env.EXPO_PUBLIC_YUI_SERVER_URL;

console.log('Compilando o painel web (expo export)...');
const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['expo', 'export', '--platform', 'web', '--clear', '--output-dir', 'painel-web'], {
  cwd: appDir, env, stdio: 'inherit', shell: process.platform === 'win32',
});
if (r.status !== 0) {
  console.error('Falhou a compilação do painel.');
  process.exit(r.status ?? 1);
}
if (!fs.existsSync(path.join(out, 'index.html'))) {
  console.error('O build terminou sem gerar painel-web/index.html.');
  process.exit(1);
}
const hash = fonteHash(appDir);
fs.writeFileSync(path.join(out, '.fonte'), hash + '\n', 'ascii');
console.log(`Painel compilado em painel-web/ (carimbo da fonte ${hash.slice(0, 12)}). Comite a pasta junto com a mudança no app.`);
