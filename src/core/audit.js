import fs from 'fs';
import path from 'path';

/** Caminho do arquivo de auditoria (YUI_AUDIT_FILE permite trocar; usado nos testes). */
export function auditFilePath() {
  return process.env.YUI_AUDIT_FILE || path.resolve('logs', 'core-audit.jsonl');
}

/**
 * Registro de auditoria append-only (uma linha JSON por evento) para ações
 * sensíveis: acesso à memória pessoal, decisões de ferramenta, login, ações do painel.
 * Nunca registra o conteúdo das memórias nem senhas, só metadados.
 */
export function audit(event, ctx, details = {}) {
  try {
    const file = auditFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      userId: ctx?.userId ?? null,
      role: ctx?.role ?? null,
      platform: ctx?.platform ?? null,
      channelKind: ctx?.channelKind ?? null,
      ...details,
    });
    fs.appendFileSync(file, line + '\n');
  } catch {
    // auditoria nunca deve derrubar a requisição
  }
}
