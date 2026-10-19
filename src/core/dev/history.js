import fs from 'fs/promises';
import path from 'path';

/**
 * Histórico da conversa de código, por projeto.
 *
 * Guarda só o texto da conversa (pergunta e resposta final). Os passos das
 * ferramentas (conteúdo de arquivos lidos, saídas de comandos) não entram: no
 * Jarvis eles faziam o histórico crescer até estourar o contexto do modelo.
 */

const MAX_STORED_MESSAGES = 200;

/** Mantém as mensagens mais recentes que cabem em `maxChars` (começando por uma fala do usuário). */
export function trimToBudget(messages, maxChars) {
  const kept = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const size = String(messages[i].content).length;
    if (total + size > maxChars && kept.length > 0) break;
    kept.unshift(messages[i]);
    total += size;
  }
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}

export function createHistoryStore({ dir }) {
  const fileFor = (projectId) => path.join(dir, `${String(projectId).replace(/[^a-z0-9_-]/gi, '_')}.json`);

  async function load(projectId) {
    try {
      const data = JSON.parse(await fs.readFile(fileFor(projectId), 'utf8'));
      return Array.isArray(data) ? data.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') : [];
    } catch {
      return [];
    }
  }

  async function save(projectId, messages) {
    const clean = messages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, 20000), at: m.at || Date.now() }))
      .slice(-MAX_STORED_MESSAGES);
    await fs.mkdir(dir, { recursive: true });
    const target = fileFor(projectId);
    const temp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(clean), 'utf8');
    await fs.rename(temp, target);
  }

  async function clear(projectId) {
    await fs.rm(fileFor(projectId), { force: true });
  }

  return { load, save, clear };
}
