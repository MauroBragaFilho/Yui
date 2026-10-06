import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { registerToolPolicy, clearToolPolicies, ROLES, TOOL_ACCESS } from '../permissions.js';

/**
 * Registro de ferramentas do Agent.
 *
 * Cada ferramenta declara: nome, descrição (o LLM vê), parâmetros tipados
 * (validados no backend), política de acesso (papel mínimo, só canal privado,
 * confirmação) e `run(args, ctx)`.
 *
 * Princípios:
 *  - Nada de shell livre. Ferramentas do PC trabalham com ALLOWLISTS definidas
 *    pelo dono no .env (projetos, apps, pastas).
 *  - O LLM só escolhe o NOME e os ARGUMENTOS; caminhos e executáveis reais
 *    vêm das allowlists, nunca do texto do usuário/LLM.
 *  - Ferramentas do PC só existem se YUI_TOOLS_PC_ENABLED=true (ligue apenas
 *    na máquina onde o Core roda como assistente pessoal).
 */

const tools = new Map();

export function registerTool(def) {
  const required = ['name', 'description', 'run'];
  for (const k of required) if (!def[k]) throw new Error(`Ferramenta inválida: falta "${k}"`);
  // `access` ausente = "write" (bloqueado no modo somente leitura). Ver permissions.js.
  const tool = { params: {}, minRole: ROLES.OWNER, confirm: false, access: TOOL_ACCESS.WRITE, ...def };
  tools.set(tool.name, tool);
  registerToolPolicy(tool.name, { minRole: tool.minRole, privateOnly: tool.privateOnly, confirm: tool.confirm, access: tool.access });
  return tool;
}

export function getTool(name) {
  return tools.get(name) || null;
}

export function listTools() {
  return [...tools.values()];
}

export function clearTools() {
  tools.clear();
  clearToolPolicies();
}

/** Valida e normaliza os argumentos contra o esquema da ferramenta. */
export function validateArgs(tool, rawArgs) {
  const args = {};
  const src = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  for (const key of Object.keys(src)) {
    if (!(key in tool.params)) throw new Error(`argumento desconhecido: ${key}`);
  }
  for (const [key, spec] of Object.entries(tool.params)) {
    let v = src[key];
    if (v === undefined || v === null || v === '') {
      if (spec.required) throw new Error(`argumento obrigatório ausente: ${key}`);
      continue;
    }
    if (spec.type === 'number') {
      v = Number(v);
      if (!Number.isFinite(v)) throw new Error(`${key} deve ser número`);
    } else {
      v = String(v).trim();
      if (v.length > (spec.max || 200)) throw new Error(`${key} muito longo`);
    }
    if (spec.enum && !spec.enum.includes(v)) throw new Error(`${key} deve ser um de: ${spec.enum.join(', ')}`);
    args[key] = v;
  }
  return args;
}

/** Descrição das ferramentas para o prompt do LLM. */
export function describeTools(names) {
  return names.map((n) => {
    const t = tools.get(n);
    const params = Object.entries(t.params)
      .map(([k, s]) => `${k}${s.required ? '*' : ''}:${s.enum ? s.enum.join('|') : s.type || 'string'}`)
      .join(', ');
    return `- ${t.name}(${params}) — ${t.description}`;
  }).join('\n');
}

// ───────────────────────── Allowlists do .env ─────────────────────────

/** "BDS=C:\\Dev\\BDS|LAC=D:\\LAC" -> Map(chave minúscula -> caminho) */
export function parseAllowlist(raw) {
  const map = new Map();
  for (const item of String(raw || '').split('|')) {
    const i = item.indexOf('=');
    if (i <= 0) continue;
    const key = item.slice(0, i).trim().toLowerCase();
    const value = item.slice(i + 1).trim();
    if (key && value) map.set(key, value);
  }
  return map;
}

function parseRoots(raw) {
  return String(raw || '').split('|').map((s) => s.trim()).filter(Boolean).map((p) => path.resolve(p));
}

/** Abre sem shell, desanexado, com argumentos fixos. */
function launch(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function walk(root, needle, { maxDepth = 5, maxEntries = 8000, maxResults = 20 } = {}) {
  const results = [];
  let visited = 0;
  const stack = [[root, 0]];
  while (stack.length && results.length < maxResults && visited < maxEntries) {
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      visited++;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.name.toLowerCase().includes(needle)) results.push(full);
      if (e.isDirectory() && !e.isSymbolicLink() && depth < maxDepth) stack.push([full, depth + 1]);
      if (results.length >= maxResults) break;
    }
  }
  return results;
}

// ───────────────────────── Ferramentas embutidas ─────────────────────────

/** Registra as ferramentas do PC (apenas se YUI_TOOLS_PC_ENABLED=true). */
export function registerBuiltinTools() {
  if (String(process.env.YUI_TOOLS_PC_ENABLED || 'false').toLowerCase() !== 'true') return [];

  registerTool({
    name: 'system.info',
    description: 'Mostra informações do computador (SO, CPU, memória, uptime).',
    minRole: ROLES.OWNER,
    access: TOOL_ACCESS.READ,
    async run() {
      const gb = (b) => (b / 1024 ** 3).toFixed(1);
      return [
        `SO: ${os.type()} ${os.release()} (${os.arch()})`,
        `CPU: ${os.cpus()[0]?.model || 'desconhecida'} x${os.cpus().length}`,
        `RAM: ${gb(os.totalmem() - os.freemem())} GB usados de ${gb(os.totalmem())} GB`,
        `Uptime: ${(os.uptime() / 3600).toFixed(1)} h`,
      ].join('\n');
    },
  });

  registerTool({
    name: 'projects.open',
    description: 'Abre um projeto pré-cadastrado (YUI_PROJECTS) no editor/explorador.',
    params: { name: { type: 'string', required: true, max: 50 } },
    minRole: ROLES.OWNER,
    access: TOOL_ACCESS.OPEN,
    async run({ name }) {
      const projects = parseAllowlist(process.env.YUI_PROJECTS);
      const configured = projects.get(name.toLowerCase());
      if (!configured) throw new Error(`projeto "${name}" não está cadastrado. Disponíveis: ${[...projects.keys()].join(', ') || 'nenhum'}`);
      // path.resolve normaliza as barras (no .env podem ser "/" no Windows).
      const target = path.resolve(configured);
      if (!fs.existsSync(target)) throw new Error(`pasta do projeto não existe: ${target}`);
      const editor = (process.env.YUI_EDITOR_COMMAND || '').trim();
      if (editor) await launch(editor, [target]);
      else if (process.platform === 'win32') await launch('explorer.exe', [target]);
      else if (process.platform === 'darwin') await launch('open', [target]);
      else await launch('xdg-open', [target]);
      return `Projeto ${name} aberto.`;
    },
  });

  registerTool({
    name: 'apps.open',
    description: 'Abre um programa pré-cadastrado (YUI_APPS).',
    params: { name: { type: 'string', required: true, max: 50 } },
    minRole: ROLES.OWNER,
    access: TOOL_ACCESS.EXECUTE,
    confirm: true,
    async run({ name }) {
      const apps = parseAllowlist(process.env.YUI_APPS);
      const exe = apps.get(name.toLowerCase());
      if (!exe) throw new Error(`programa "${name}" não está cadastrado. Disponíveis: ${[...apps.keys()].join(', ') || 'nenhum'}`);
      await launch(exe, []);
      return `Programa ${name} aberto.`;
    },
  });

  registerTool({
    name: 'files.search',
    description: 'Procura arquivos/pastas pelo nome dentro das pastas autorizadas (YUI_FILE_ROOTS). Somente leitura.',
    params: { query: { type: 'string', required: true, max: 80 } },
    minRole: ROLES.OWNER,
    access: TOOL_ACCESS.READ,
    async run({ query }) {
      if (/[\\/]/.test(query) || query.includes('..')) throw new Error('a busca é só por nome, sem caminhos');
      const roots = parseRoots(process.env.YUI_FILE_ROOTS);
      if (!roots.length) throw new Error('nenhuma pasta autorizada (YUI_FILE_ROOTS)');
      const needle = query.toLowerCase();
      const found = roots.flatMap((r) => walk(r, needle));
      return found.length ? found.slice(0, 20).join('\n') : 'Nada encontrado.';
    },
  });

  return listTools().map((t) => t.name);
}

/**
 * Ponte para ferramentas MCP. O transporte MCP (stdio/HTTP) ainda não foi
 * implementado; esta função define como as ferramentas de um servidor MCP
 * entram no Agent: SOMENTE as listadas em YUI_MCP_ALLOW ("servidor.ferramenta,...")
 * são registradas, todas como OWNER + canal privado + confirmação.
 */
export function registerMcpTools(serverName, mcpTools, callMcp) {
  const allow = new Set(String(process.env.YUI_MCP_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean));
  // Ferramentas MCP têm efeito desconhecido: tratadas como "write" (bloqueadas no
  // modo somente leitura) a menos que você as declare de leitura em YUI_MCP_READ_ONLY.
  const readOnly = new Set(String(process.env.YUI_MCP_READ_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean));
  const registered = [];
  for (const t of mcpTools) {
    const full = `${serverName}.${t.name}`;
    if (!allow.has(full)) continue;
    registerTool({
      name: full,
      description: t.description || `Ferramenta MCP ${full}`,
      params: Object.fromEntries(Object.keys(t.inputSchema?.properties || {}).map((k) => [k, { type: 'string', max: 500 }])),
      minRole: ROLES.OWNER,
      access: readOnly.has(full) ? TOOL_ACCESS.READ : TOOL_ACCESS.WRITE,
      confirm: true,
      run: (args) => callMcp(t.name, args),
    });
    registered.push(full);
  }
  return registered;
}
