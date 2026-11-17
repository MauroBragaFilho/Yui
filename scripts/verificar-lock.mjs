// Confere um package-lock.json ANTES de instalar dependências (usado pelo atualizador do notebook e pela CI).
//   node scripts/verificar-lock.mjs <package-lock novo> [<package-lock atual>]
// Recusa (código 2): pacote que não vem do registro oficial do npm (git, http, arquivo, outro registro), pacote sem hash
// de integridade ou com hash fraco (sha1), e lockfile ilegível. Só AVISA (código 0): pacotes novos que rodam script de
// instalação (postinstall...) e pacotes sem "resolved" fora dos casos normais (raiz, links, embutidos).
import fs from 'node:fs';

export const REGISTRY = 'https://registry.npmjs.org/';
const STRONG = /^(sha512|sha384|sha256)-/;

/** @returns {{ errors: string[], warnings: string[], total: number }} */
export function checkLock(lock, previous = null) {
  const errors = [];
  const warnings = [];
  const packages = lock && typeof lock === 'object' && lock.packages && typeof lock.packages === 'object' ? lock.packages : null;
  if (!packages) return { errors: ['package-lock sem o mapa "packages" (lockfileVersion antigo ou arquivo inválido)'], warnings, total: 0 };
  const before = previous?.packages && typeof previous.packages === 'object' ? previous.packages : {};
  let total = 0;
  for (const [key, pkg] of Object.entries(packages)) {
    if (key === '' || !pkg || typeof pkg !== 'object') continue;
    total += 1;
    const name = key.replace(/^.*node_modules\//, '') || key;
    if (pkg.link) continue; // workspace local
    if (!pkg.resolved) {
      if (!pkg.inBundle) warnings.push(`${name}: sem "resolved" (origem desconhecida)`);
      continue;
    }
    if (!String(pkg.resolved).startsWith(REGISTRY)) errors.push(`${name}: não vem do registro oficial do npm (${String(pkg.resolved).slice(0, 80)})`);
    if (!pkg.integrity) errors.push(`${name}: sem hash de integridade`);
    else if (!STRONG.test(String(pkg.integrity))) errors.push(`${name}: hash de integridade fraco (${String(pkg.integrity).split('-')[0]})`);
    if (pkg.hasInstallScript && !(before[key]?.hasInstallScript)) warnings.push(`${name}@${pkg.version ?? '?'}: NOVO pacote com script de instalação`);
  }
  return { errors, warnings, total };
}

function main() {
  const [novo, atual] = process.argv.slice(2);
  if (!novo) { console.error('uso: node scripts/verificar-lock.mjs <package-lock novo> [<atual>]'); process.exit(64); }
  let lock; let previous = null;
  try { lock = JSON.parse(fs.readFileSync(novo, 'utf8')); } catch (err) { console.error(`package-lock ilegível: ${err.message}`); process.exit(2); }
  if (atual && fs.existsSync(atual)) { try { previous = JSON.parse(fs.readFileSync(atual, 'utf8')); } catch { /* sem comparação */ } }
  const { errors, warnings, total } = checkLock(lock, previous);
  for (const w of warnings) console.log(`AVISO: ${w}`);
  for (const e of errors) console.log(`ERRO: ${e}`);
  console.log(errors.length ? `package-lock RECUSADO (${errors.length} problema(s) em ${total} pacotes)` : `package-lock OK (${total} pacotes${warnings.length ? `, ${warnings.length} aviso(s)` : ''})`);
  process.exit(errors.length ? 2 : 0);
}

// Só roda como comando (não quando importado pelos testes).
if (process.argv[1] && process.argv[1].endsWith('verificar-lock.mjs')) main();
