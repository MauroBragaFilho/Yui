/**
 * Protocolo de ações da Yui (como o modelo pede para usar uma ferramenta).
 *
 * O modelo responde com UM objeto JSON { "action", "params", "thought" } quando
 * precisa de uma ferramenta; quando não precisa, responde em texto normal e isso
 * já é a resposta final. (No Jarvis o modelo era obrigado a responder SEMPRE em
 * JSON; modelos locais erravam o formato e a conversa travava em erros de parse.)
 */

const ACTIONS = {
  list_dir: { required: [], optional: ['path'] },
  read_file: { required: ['path'], optional: [] },
  search_code: { required: ['query'], optional: [] },
  write_file: { required: ['path', 'content'], optional: [] },
  apply_diff: { required: ['path', 'diff'], optional: [] },
  run_terminal: { required: ['command'], optional: [] },
  web_search: { required: ['query'], optional: [] },
  reply: { required: ['text'], optional: [] },
};

/** Ferramentas que apenas leem (nunca alteram nada no computador). */
const READ_ONLY_ACTIONS = new Set(['list_dir', 'read_file', 'search_code', 'web_search', 'reply']);

/** Remove blocos de raciocínio dos modelos ("<think>...</think>"). */
function stripThinking(text) {
  return String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
}

/** Acha o primeiro objeto JSON balanceado em um texto, respeitando strings e escapes. */
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { json: text.slice(start, i + 1), start, end: i + 1 };
    }
  }
  return null;
}

/**
 * Interpreta a resposta do modelo.
 * @returns {{ kind: 'action', action: string, params: object, thought: string }
 *          | { kind: 'text', text: string }
 *          | { kind: 'invalid', error: string }}
 */
function parseModelReply(rawText) {
  const text = stripThinking(rawText);
  if (!text) return { kind: 'invalid', error: 'resposta vazia' };

  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  if (!cleaned.startsWith('{')) {
    // Só trata como ação se o JSON estiver num bloco de código; senão é texto normal.
    const fenced = text.match(/```json\s*([\s\S]*?)```/i);
    if (!fenced) return { kind: 'text', text };
    return parseJsonAction(fenced[1].trim(), text);
  }
  return parseJsonAction(cleaned, text);
}

function parseJsonAction(candidate, originalText) {
  const found = extractJsonObject(candidate);
  if (!found) return { kind: 'invalid', error: 'JSON incompleto (faltou fechar { ou ")' };
  let obj;
  try {
    obj = JSON.parse(found.json);
  } catch (err) {
    return { kind: 'invalid', error: `JSON inválido: ${err.message}` };
  }
  if (!obj || typeof obj !== 'object' || typeof obj.action !== 'string') {
    // Um objeto JSON qualquer (ex.: o usuário pediu um exemplo em JSON): é texto.
    return { kind: 'text', text: originalText };
  }
  const spec = ACTIONS[obj.action];
  if (!spec) return { kind: 'invalid', error: `ação desconhecida "${obj.action}". Use: ${Object.keys(ACTIONS).join(', ')}` };
  const params = obj.params && typeof obj.params === 'object' ? obj.params : {};
  for (const key of spec.required) {
    if (typeof params[key] !== 'string' || (key !== 'content' && !params[key].trim())) {
      return { kind: 'invalid', error: `a ação ${obj.action} precisa do parâmetro de texto "${key}"` };
    }
  }
  return { kind: 'action', action: obj.action, params, thought: typeof obj.thought === 'string' ? obj.thought : '' };
}

export { ACTIONS, READ_ONLY_ACTIONS, parseModelReply, stripThinking, extractJsonObject };
