import fs from 'fs';
import path from 'path';

/**
 * Skills da Yui: "receitas" em texto que o DONO escreve e a Yui segue quando o
 * pedido combina com elas (ex.: "resumo do dia", "revisar PR", "plano de treino").
 *
 *   skills/<nome>/SKILL.md          (ou skills/<nome>.md)
 *   ---
 *   name: resumo-do-dia
 *   description: Monta um resumo curto da agenda e das pendências
 *   ---
 *   (instruções em português...)
 *
 * Segurança: uma skill é só TEXTO de instrução. Ela não ganha ferramentas, não
 * executa nada e roda numa conversa sem ferramentas; quem decide o que a Yui
 * pode fazer continua sendo o backend. Só o dono, em DM ou canal privado, vê as skills.
 * A pasta é lida a cada uso (editar um arquivo vale na hora).
 */

const MAX_FILE_BYTES = 20 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function skillsDir(env = process.env) {
  return path.resolve(String(env.YUI_SKILLS_DIR || '').trim() || path.join(process.cwd(), 'skills'));
}

function parseFile(text, fallbackName) {
  const clean = String(text).replace(/\r\n/g, '\n');
  const m = clean.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  let body = clean;
  if (m) {
    body = m[2];
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
  }
  const name = String(meta.name || fallbackName).trim().toLowerCase();
  return { name, description: String(meta.description || '').slice(0, 200), instructions: body.trim() };
}

/** Lê as skills válidas da pasta (arquivo grande, nome inválido ou vazio é ignorado). */
export function loadSkills(env = process.env) {
  const dir = skillsDir(env);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const skills = [];
  for (const e of entries) {
    const file = e.isDirectory() ? path.join(dir, e.name, 'SKILL.md') : e.isFile() && e.name.toLowerCase().endsWith('.md') ? path.join(dir, e.name) : null;
    if (!file) continue;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      const skill = parseFile(fs.readFileSync(file, 'utf8'), e.isDirectory() ? e.name : e.name.replace(/\.md$/i, ''));
      if (NAME_RE.test(skill.name) && skill.instructions && !skills.some((s) => s.name === skill.name)) skills.push(skill);
    } catch { /* arquivo ilegível: ignora */ }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(name, env = process.env) {
  const key = String(name ?? '').trim().toLowerCase();
  return loadSkills(env).find((s) => s.name === key) || null;
}

export function describeSkills(skills) {
  return skills.map((s) => `- ${s.name}${s.description ? ` — ${s.description}` : ''}`).join('\n');
}
