import { READ_ONLY_ACTIONS } from './actions.js';

/**
 * Política de aprovação das ações da Yui.
 *
 * Diferença principal para o Jarvis: lá o modelo executava QUALQUER comando do
 * terminal e gravava arquivos sem perguntar (e o texto vindo da web ou de
 * arquivos podia, em teoria, "mandar" o modelo fazer isso). Aqui:
 *  - leitura é livre dentro do projeto;
 *  - gravar arquivo e rodar comando pedem aprovação do usuário;
 *  - comandos perigosos são negados sempre;
 *  - comandos só de consulta (git status, npm test...) podem rodar sem perguntar.
 *
 * Modos (campo "approvalMode" nas configurações):
 *  - "readonly": só lê; qualquer gravação/comando é negado.
 *  - "ask"     : (padrão) pergunta antes de gravar e de rodar comandos.
 *  - "auto"    : grava sem perguntar (com backup), mas comandos ainda pedem aprovação.
 */

const DANGEROUS = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
  /\brm\s+-rf?\s+[\/~]/i,
  /\b(del|erase|rd|rmdir)\b[^\n]*\s\/[sq]\b/i,
  /\bformat(\.com)?\s+[a-z]:/i,
  /\b(mkfs|fdisk|diskpart)\b/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bRemove-Item\b[^\n]*-Recurse/i,
  /\bgit\s+(push\s+--force|push\s+-f|reset\s+--hard|clean\s+-[a-z]*f)/i,
  /(curl|wget|iwr|Invoke-WebRequest)[^\n|]*\|\s*(sh|bash|zsh|iex|powershell|pwsh)/i,
  /\b(iex|Invoke-Expression)\b/i,
  /\breg\s+(add|delete)\b/i,
  /\bnet\s+user\b/i,
  /:\(\)\s*\{/, // fork bomb
  />\s*\/dev\/(sd|nvme)/i,
];

// Comandos de consulta que podem rodar sem perguntar (sem metacaracteres de shell).
const SAFE = [
  /^git\s+(status|diff|log|branch|show|remote\s+-v|rev-parse|ls-files)(\s+[\w./:=@^~-]+)*$/i,
  /^npm\s+(test|run\s+(test|lint|build|check|typecheck))(\s+--?[\w-]+)*$/i,
  /^npm\s+(ls|list|outdated)(\s+--?[\w-]+)*$/i,
  /^node\s+(--version|-v)$/i,
  /^node\s+--test(\s+[\w./\\-]+)*$/i,
  /^(npx\s+)?(eslint|prettier\s+--check|tsc\s+--noEmit)(\s+[\w./\\-]+)*$/i,
  /^(python|python3|py)\s+(--version|-V)$/i,
  /^(pytest|cargo\s+(test|check)|go\s+(test|vet)(\s+\.\/\.\.\.)?|dotnet\s+(test|build))(\s+--?[\w-]+)*$/i,
  /^(dir|ls|pwd|cd|whoami|echo\s+[\w .-]*)$/i,
];

const SHELL_META = /[;&|`$<>\n\r]|\$\(/;

function classifyCommand(command) {
  const cmd = String(command ?? '').trim();
  if (!cmd) return 'invalid';
  if (cmd.length > 2000) return 'dangerous';
  if (DANGEROUS.some((re) => re.test(cmd))) return 'dangerous';
  if (!SHELL_META.test(cmd) && SAFE.some((re) => re.test(cmd))) return 'safe';
  return 'normal';
}

/**
 * @param {{ approvalMode?: string, allowedActions?: Set<string>|null }} options
 *        allowedActions: restringe as ferramentas (ex.: modo Revisor só lê).
 */
function createPolicy({ approvalMode = 'ask', allowedActions = null } = {}) {
  /**
   * @returns {{ decision: 'allow'|'ask'|'deny', reason?: string, danger?: boolean }}
   */
  function check(action, params = {}) {
    if (allowedActions && !allowedActions.has(action)) {
      return { decision: 'deny', reason: `A ação ${action} não está liberada neste modo da Yui.` };
    }
    if (READ_ONLY_ACTIONS.has(action)) return { decision: 'allow' };

    if (approvalMode === 'readonly') {
      return { decision: 'deny', reason: 'Modo somente leitura: a Yui não grava arquivos nem executa comandos.' };
    }

    if (action === 'run_terminal') {
      const kind = classifyCommand(params.command);
      if (kind === 'invalid') return { decision: 'deny', reason: 'Comando vazio.' };
      if (kind === 'dangerous') return { decision: 'deny', reason: 'Comando bloqueado por segurança (pode apagar dados ou alterar o sistema).', danger: true };
      if (kind === 'safe') return { decision: 'allow' };
      return { decision: 'ask' };
    }

    if (action === 'write_file' || action === 'apply_diff') {
      return approvalMode === 'auto' ? { decision: 'allow' } : { decision: 'ask' };
    }

    return { decision: 'deny', reason: `Ação desconhecida: ${action}.` };
  }

  return { check, approvalMode };
}

export { createPolicy, classifyCommand };
