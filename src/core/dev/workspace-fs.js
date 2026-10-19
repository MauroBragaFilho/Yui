import fs from 'fs/promises';
import path from 'path';
import { applyDiff } from './diff.js';

/**
 * Acesso a arquivos RESTRITO ao projeto aberto.
 *
 * Correções em relação ao Jarvis:
 *  - a checagem era `resolved.startsWith(root)`: a pasta irmã "C:\proj-evil"
 *    passava como se estivesse dentro de "C:\proj", e links simbólicos furavam o
 *    limite. Aqui usamos path.relative e realpath;
 *  - arquivos sensíveis (.env, chaves, certificados) nunca são lidos nem gravados
 *    pela IA, para não irem parar num provedor de nuvem;
 *  - o backup não fica mais ao lado do arquivo (.jarvis.bak espalhado pelo
 *    projeto): vai para .yui/backups/<data>/ e a gravação é atômica;
 *  - leitura limitada, arquivos binários recusados.
 */

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'build', '.next', '.nuxt', '__pycache__', '.venv', 'venv', 'coverage', '.yui', '.idea', '.vscode', 'target', 'out']);
const SENSITIVE_RE = /(^|[\\/])(\.env(\..*)?|.*\.pem|.*\.key|.*\.pfx|.*\.p12|id_rsa(\.pub)?|id_ed25519|\.npmrc|\.netrc|credentials(\.json)?|secrets?(\.json|\.ya?ml)?)$/i;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_BYTES = 5 * 1024 * 1024;

const LANGUAGES = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
  '.py': 'python', '.java': 'java', '.cs': 'csharp', '.go': 'go', '.rs': 'rust', '.php': 'php', '.rb': 'ruby',
  '.html': 'html', '.css': 'css', '.json': 'json', '.md': 'markdown', '.yml': 'yaml', '.yaml': 'yaml', '.sql': 'sql', '.sh': 'bash', '.bat': 'batch', '.ps1': 'powershell',
};

class WorkspaceError extends Error {
  constructor(message, code = 'ERRO') {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

function isSensitive(relPath) {
  return SENSITIVE_RE.test(String(relPath).replace(/\\/g, '/'));
}

async function createWorkspaceFs(rootInput) {
  const root = await fs.realpath(path.resolve(rootInput));
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new WorkspaceError('O caminho do projeto não é uma pasta.', 'NAO_PASTA');

  const inside = (target) => {
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };

  /** Resolve um caminho do projeto garantindo que fica dentro dele (inclusive após links simbólicos). */
  async function resolve(relPath = '', { mustExist = true } = {}) {
    const input = String(relPath ?? '');
    if (input.includes('\0')) throw new WorkspaceError('Caminho inválido.', 'CAMINHO');
    const lexical = path.resolve(root, input);
    if (!inside(lexical)) throw new WorkspaceError('Acesso negado: o caminho está fora do projeto.', 'FORA');

    let real;
    try {
      real = await fs.realpath(lexical);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      if (mustExist) throw new WorkspaceError(`Não existe: ${input}`, 'NAO_EXISTE');
      // Arquivo novo: confere o link simbólico da pasta mais próxima que existe.
      let probe = path.dirname(lexical);
      while (inside(probe)) {
        try {
          const realProbe = await fs.realpath(probe);
          if (!inside(realProbe)) throw new WorkspaceError('Acesso negado: o caminho está fora do projeto.', 'FORA');
          break;
        } catch (e2) {
          if (e2 instanceof WorkspaceError) throw e2;
          if (e2.code !== 'ENOENT') throw e2;
          const parent = path.dirname(probe);
          if (parent === probe) break;
          probe = parent;
        }
      }
      return lexical;
    }
    if (!inside(real)) throw new WorkspaceError('Acesso negado: o caminho leva para fora do projeto (link simbólico).', 'FORA');
    return real;
  }

  const relative = (absolute) => path.relative(root, absolute).split(path.sep).join('/');

  async function listDir(relPath = '') {
    const dir = await resolve(relPath);
    const items = await fs.readdir(dir, { withFileTypes: true });
    return items
      .filter((i) => !IGNORED_DIRS.has(i.name) && !i.name.startsWith('.') && !isSensitive(i.name))
      .map((i) => ({ name: i.name, isDirectory: i.isDirectory(), path: relative(path.join(dir, i.name)) }))
      .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
  }

  async function readFile(relPath) {
    if (isSensitive(relPath)) throw new WorkspaceError('Arquivo sensível (chaves/senhas): a Yui não lê esse tipo de arquivo.', 'SENSIVEL');
    const file = await resolve(relPath);
    const info = await fs.stat(file);
    if (!info.isFile()) throw new WorkspaceError('Isso não é um arquivo.', 'NAO_ARQUIVO');
    if (info.size > MAX_READ_BYTES) throw new WorkspaceError('Arquivo muito grande para ler (limite de 2 MB).', 'GRANDE');
    const buffer = await fs.readFile(file);
    if (buffer.subarray(0, 8000).includes(0)) throw new WorkspaceError('Arquivo binário: não dá para ler como texto.', 'BINARIO');
    return {
      name: path.basename(file),
      path: relative(file),
      content: buffer.toString('utf8'),
      language: LANGUAGES[path.extname(file).toLowerCase()] || 'text',
    };
  }

  async function backup(file) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(root, '.yui', 'backups', stamp, relative(file));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(file, target);
    const gitignore = path.join(root, '.yui', '.gitignore');
    await fs.writeFile(gitignore, '*\n', { flag: 'wx' }).catch(() => {});
    return relative(target);
  }

  async function atomicWrite(file, content) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.yui-${process.pid}-${Date.now()}.tmp`;
    await fs.writeFile(temp, content, 'utf8');
    await fs.rename(temp, file);
  }

  function assertWritable(relPath, file) {
    if (isSensitive(relPath)) throw new WorkspaceError('Arquivo sensível: a Yui não grava esse tipo de arquivo.', 'SENSIVEL');
    const rel = relative(file);
    if (rel.split('/').some((part) => part === '.git' || part === 'node_modules' || part === '.yui')) {
      throw new WorkspaceError('A Yui não grava dentro de .git, node_modules nem .yui.', 'PROTEGIDO');
    }
  }

  async function writeFile(relPath, content) {
    const file = await resolve(relPath, { mustExist: false });
    assertWritable(relPath, file);
    if (Buffer.byteLength(String(content), 'utf8') > MAX_WRITE_BYTES) throw new WorkspaceError('Conteúdo grande demais (limite de 5 MB).', 'GRANDE');
    let backupPath = null;
    try {
      if ((await fs.stat(file)).isFile()) backupPath = await backup(file);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    await atomicWrite(file, String(content));
    return { path: relative(file), backupPath, created: backupPath === null };
  }

  async function applyDiffToFile(relPath, diffText) {
    const file = await resolve(relPath);
    assertWritable(relPath, file);
    const original = await readFile(relPath);
    const { content, blocks } = applyDiff(original.content, diffText);
    const backupPath = await backup(file);
    await atomicWrite(file, content);
    return { path: relative(file), backupPath, blocks };
  }

  /** Busca de texto simples (sem regex do usuário) nos arquivos do projeto. */
  async function searchText(query, { maxResults = 30 } = {}) {
    const needle = String(query ?? '').toLowerCase();
    if (!needle.trim()) return [];
    const results = [];
    async function walk(dir) {
      if (results.length >= maxResults) return;
      let items;
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        if (results.length >= maxResults) return;
        if (IGNORED_DIRS.has(item.name) || item.name.startsWith('.')) continue;
        const full = path.join(dir, item.name);
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) {
          await walk(full);
        } else if (LANGUAGES[path.extname(item.name).toLowerCase()] && !isSensitive(item.name)) {
          try {
            if ((await fs.stat(full)).size > 512 * 1024) continue;
            const lines = (await fs.readFile(full, 'utf8')).split('\n');
            for (let i = 0; i < lines.length && results.length < maxResults; i++) {
              if (lines[i].toLowerCase().includes(needle)) results.push({ path: relative(full), line: i + 1, text: lines[i].trim().slice(0, 200) });
            }
          } catch {
            /* arquivo ilegível: ignora */
          }
        }
      }
    }
    await walk(root);
    return results;
  }

  /** Lista de arquivos de código (para o índice), com tamanho e data. */
  async function listCodeFiles({ maxFiles = 3000 } = {}) {
    const files = [];
    async function walk(dir) {
      if (files.length >= maxFiles) return;
      let items;
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        if (files.length >= maxFiles) return;
        if (IGNORED_DIRS.has(item.name) || item.name.startsWith('.') || item.isSymbolicLink()) continue;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) await walk(full);
        else if (LANGUAGES[path.extname(item.name).toLowerCase()] && !isSensitive(item.name)) {
          try {
            const info = await fs.stat(full);
            if (info.size <= 256 * 1024) files.push({ path: relative(full), size: info.size, mtimeMs: info.mtimeMs });
          } catch {
            /* some */
          }
        }
      }
    }
    await walk(root);
    return files;
  }

  return { root, resolve, listDir, readFile, writeFile, applyDiff: applyDiffToFile, searchText, listCodeFiles, isSensitive };
}

export { createWorkspaceFs, WorkspaceError, isSensitive, IGNORED_DIRS, LANGUAGES };
