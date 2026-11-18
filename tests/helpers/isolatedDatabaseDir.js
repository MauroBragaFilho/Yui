// Pasta de bancos temporária para os testes: NUNCA gravar nos bancos reais de desenvolvimento (D:\...\Yui\database).
//
// Uso (ANTES de importar qualquer módulo de src/, porque src/config/index.js lê DATABASE_DIR na importação):
//
//   import { useIsolatedDatabaseDir, assertNotRealDatabaseDir } from './helpers/isolatedDatabaseDir.js';
//   const isolated = useIsolatedDatabaseDir('yui-test-algo-');
//   const { config } = await import('../src/config/index.js');
//   assertNotRealDatabaseDir(path.resolve(config.database.dir)); // confere o diretório EFETIVO, antes de abrir qualquer banco
//   const { initDatabase } = await import('../src/database/db.js');
//   ...
//   isolated.cleanup(); // no fim (também roda sozinho na saída do processo, como rede de segurança)
//
// Este arquivo não importa nada de src/ de propósito: pode ser importado de forma estática no topo do teste.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A pasta dos bancos reais de desenvolvimento (o padrão do config quando o processo roda na raiz do repositório). */
export const REAL_DATABASE_DIR = path.resolve(REPO_ROOT, 'database');

/**
 * Caminho canônico para comparar: resolve links/junções e nomes curtos do Windows (8.3) pelo ancestral que já existe,
 * e no Windows ignora maiúsculas e minúsculas. Funciona também para pastas que ainda não existem.
 */
function canonical(p) {
  let current = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      current = path.join(fs.realpathSync.native(current), ...rest.reverse());
      break;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) break; // chegou na raiz sem achar nada que exista: fica o caminho resolvido
      rest.push(path.basename(current));
      current = parent;
    }
  }
  return process.platform === 'win32' ? current.toLowerCase() : current;
}

/** `dir` é a pasta real dos bancos ou fica dentro dela? */
export function isRealDatabaseDir(dir) {
  const real = canonical(REAL_DATABASE_DIR);
  const target = canonical(dir);
  const rel = path.relative(real, target);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

/**
 * Lança erro se o caminho for a pasta real dos bancos ou estiver dentro dela. Use depois das importações para conferir o
 * `config.database.dir` efetivo (por exemplo, se o DATABASE_DIR foi definido tarde demais, o config ficou com ./database).
 * @param {string} dirResolvido
 * @returns {string} o mesmo caminho, resolvido
 */
export function assertNotRealDatabaseDir(dirResolvido) {
  if (typeof dirResolvido !== 'string' || !dirResolvido) {
    throw new Error('[isolatedDatabaseDir] caminho da pasta de bancos vazio ou inválido.');
  }
  const resolved = path.resolve(dirResolvido);
  if (isRealDatabaseDir(resolved)) {
    throw new Error(`[isolatedDatabaseDir] o teste ia usar a pasta REAL de bancos (${resolved}; real: ${REAL_DATABASE_DIR}). Abortado antes de gravar.`);
  }
  return resolved;
}

/**
 * Cria uma pasta temporária (fs.mkdtempSync em os.tmpdir()), aponta process.env.DATABASE_DIR para ela e devolve
 * `{ dir, cleanup }`. Lança erro na hora se a pasta (ou o os.tmpdir() onde ela seria criada) for a pasta real dos
 * bancos ou estiver dentro dela: nesse caso nada é criado.
 * @param {string} prefixo nome simples, sem separador de pasta (ex.: 'yui-test-social-')
 * @returns {{ dir: string, cleanup: () => void }}
 */
export function useIsolatedDatabaseDir(prefixo) {
  if (typeof prefixo !== 'string' || !prefixo || /[\\/]/.test(prefixo) || prefixo.includes('..')) {
    throw new Error(`[isolatedDatabaseDir] prefixo inválido: ${JSON.stringify(prefixo)} (use um nome simples, sem "/", "\\" nem "..").`);
  }
  // Confere ANTES de criar: se o TEMP apontasse para a pasta real, o próprio mkdtemp já gravaria lá dentro.
  assertNotRealDatabaseDir(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefixo));
  try {
    assertNotRealDatabaseDir(dir);
  } catch (err) {
    try { fs.rmdirSync(dir); } catch { /* pasta vazia que acabou de ser criada: se não sair, fica */ }
    throw err;
  }

  process.env.DATABASE_DIR = dir;

  let done = false;
  // O DATABASE_DIR NÃO volta ao valor anterior de propósito: algum trabalho assíncrono que termine depois da limpeza e leia
  // a variável na hora (listas, lembretes...) cairia no padrão ./database, que é a pasta real.
  function cleanup() {
    if (done) return;
    done = true;
    process.removeListener('exit', cleanup);
    try {
      assertNotRealDatabaseDir(dir); // nunca apaga nada que resolva para a pasta real
      // Retentativas: no Windows um antivírus/indexador pode segurar o arquivo por um instante.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      console.warn(`[isolatedDatabaseDir] não consegui apagar a pasta temporária ${dir}: ${err.message}`);
    }
  }
  // Rede de segurança: se o teste cair antes do fim (exceção, process.exit), a pasta temporária sai do mesmo jeito.
  process.once('exit', cleanup);

  return { dir, cleanup };
}
