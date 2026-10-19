import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Projetos que a Yui pode abrir no módulo de código (lista de permissão).
 *
 * Duas fontes: YUI_PROJECTS no .env ("Nome=Pasta|Outro=Pasta") e os projetos
 * adicionados pelo app (arquivo secrets/dev-projects.json, fora do Git). O
 * caminho NUNCA vem do texto da conversa nem do modelo de IA: só do .env ou de um
 * cadastro explícito do dono feito no próprio computador.
 */

export class ProjectError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ProjectError';
    this.status = status;
  }
}

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;
const MAX_PANEL_PROJECTS = 30;

export const slug = (name) => String(name).trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function forbiddenRoots(env) {
  return [env.SystemRoot, env.windir, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData, '/etc', '/usr', '/bin', '/sbin', '/var', '/System']
    .filter(Boolean)
    .map((p) => path.resolve(p).toLowerCase());
}

/** Recusa pastas perigosas para abrir como projeto (raiz do disco, perfil do usuário, sistema, chaves). */
export function checkProjectPath(input, env = process.env) {
  const raw = String(input ?? '').trim();
  if (!raw || raw.includes('\0')) throw new ProjectError(400, 'Informe a pasta do projeto.');
  const resolved = path.resolve(raw);
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw new ProjectError(400, 'Essa pasta não existe.');
  }
  if (!fs.statSync(real).isDirectory()) throw new ProjectError(400, 'O caminho não é uma pasta.');
  const lower = real.toLowerCase();
  if (path.parse(real).root.toLowerCase() === lower) throw new ProjectError(400, 'Não use a raiz do disco: escolha a pasta de um projeto.');
  if (lower === os.homedir().toLowerCase()) throw new ProjectError(400, 'Não use a pasta pessoal inteira: escolha a pasta de um projeto.');
  if (forbiddenRoots(env).some((root) => lower === root || lower.startsWith(root + path.sep))) throw new ProjectError(400, 'Pasta do sistema: não pode ser aberta como projeto.');
  if (real.split(path.sep).some((part) => ['.ssh', '.aws', '.gnupg', '.kube'].includes(part.toLowerCase()))) throw new ProjectError(400, 'Pasta de credenciais: não pode ser aberta como projeto.');
  return real;
}

export function createProjects({ env = process.env, file = env.YUI_DEV_PROJECTS_FILE || path.join(process.cwd(), 'secrets', 'dev-projects.json') } = {}) {
  const fromEnv = () => {
    const out = [];
    for (const item of String(env.YUI_PROJECTS || '').split('|')) {
      const i = item.indexOf('=');
      if (i <= 0) continue;
      const name = item.slice(0, i).trim();
      const folder = item.slice(i + 1).trim();
      if (name && folder) out.push({ id: slug(name), name, path: path.resolve(folder), source: 'env' });
    }
    return out;
  };

  const readPanel = () => {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return (Array.isArray(data.projects) ? data.projects : []).filter((p) => p && p.name && p.path).map((p) => ({ id: slug(p.name), name: String(p.name), path: String(p.path), source: 'panel' }));
    } catch {
      return [];
    }
  };

  const writePanel = (projects) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, projects: projects.map(({ name, path: p }) => ({ name, path: p })) }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  };

  function list() {
    const seen = new Set();
    const all = [];
    for (const p of [...fromEnv(), ...readPanel()]) {
      if (!p.id || seen.has(p.id)) continue;
      seen.add(p.id);
      all.push({ ...p, exists: fs.existsSync(p.path) });
    }
    return all;
  }

  const get = (id) => list().find((p) => p.id === String(id).toLowerCase()) || null;

  function add({ name, path: folder }) {
    const cleanName = String(name ?? '').trim();
    if (!NAME_RE.test(cleanName)) throw new ProjectError(400, 'Nome inválido (até 40 caracteres: letras, números, espaço, ponto, hífen).');
    const id = slug(cleanName);
    if (!id) throw new ProjectError(400, 'Nome inválido.');
    if (get(id)) throw new ProjectError(409, 'Já existe um projeto com esse nome.');
    const real = checkProjectPath(folder, env);
    const panel = readPanel();
    if (panel.length >= MAX_PANEL_PROJECTS) throw new ProjectError(400, `Limite de ${MAX_PANEL_PROJECTS} projetos cadastrados pelo app.`);
    writePanel([...panel, { name: cleanName, path: real }]);
    return get(id);
  }

  function remove(id) {
    const target = get(id);
    if (!target) throw new ProjectError(404, 'Projeto não encontrado.');
    if (target.source !== 'panel') throw new ProjectError(400, 'Este projeto vem do .env (YUI_PROJECTS); remova por lá.');
    writePanel(readPanel().filter((p) => p.id !== target.id));
    return { ok: true };
  }

  return { list, get, add, remove };
}
