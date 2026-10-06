import fs from 'fs';
import path from 'path';

const auditFile = path.resolve('logs', 'core-audit.jsonl');

/**
 * Registro de auditoria append-only (uma linha JSON por evento) para ações
 * sensíveis: acesso à memória pessoal, decisões de ferramenta etc.
 * Nunca registra o conteúdo das memórias, só metadados.
 */
export function audit(event, ctx, details = {}) {
  try {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      userId: ctx?.userId ?? null,
      role: ctx?.role ?? null,
      platform: ctx?.platform ?? null,
      channelKind: ctx?.channelKind ?? null,
      ...details,
    });
    fs.appendFileSync(auditFile, line + '\n');
  } catch {
    // auditoria nunca deve derrubar a requisição
  }
}
