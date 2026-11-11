// Carimbo do código-fonte do app: um hash de tudo que entra no painel web compilado.
// Serve para o teste avisar quando alguém muda o app e esquece de recompilar o painel versionado (painel-web/).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FILES = ['App.tsx', 'index.ts', 'app.json', 'package-lock.json', 'tsconfig.json']; // package.json fora de propósito: mexer nos scripts de teste não muda o painel (as dependências estão no package-lock)
const DIRS = ['src', 'assets', 'public'];
const TEXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.css', '.md', '.txt']);

function walk(dir, base, out) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
}

/** Lista (ordenada, com barras normais) dos arquivos que entram no carimbo. */
export function fonteFiles(appDir) {
  const out = [];
  for (const f of FILES) if (fs.existsSync(path.join(appDir, f))) out.push(f);
  for (const d of DIRS) walk(path.join(appDir, d), appDir, out);
  return out.sort();
}

/** SHA-256 do conteúdo. Texto é normalizado (CRLF -> LF) para o carimbo ser igual no Windows e no zip do GitHub. */
export function fonteHash(appDir) {
  const h = crypto.createHash('sha256');
  for (const rel of fonteFiles(appDir)) {
    let buf = fs.readFileSync(path.join(appDir, rel));
    if (TEXT.has(path.extname(rel).toLowerCase())) buf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    h.update(rel).update('\0').update(buf).update('\0');
  }
  return h.digest('hex');
}
