/**
 * Listas salvas por pessoa (conversa natural: "anota na lista X: a, b", "mostra a lista X"...).
 *
 * Armazenamento: UM JSON por usuário em <DATABASE_DIR>/listas/<userId>.json (fora do Git).
 * Privacidade: o arquivo é do dono da conta; nenhuma função lê lista de outro usuário.
 * Segurança: userId só dígitos, nome de lista vira "slug" (sem caminho), texto sem caracteres de
 * controle, limites de tamanho/quantidade, gravação atômica (tmp + rename) e fila por usuário.
 * Puro quanto possível: diretório e relógio são injetáveis; nada acontece ao importar.
 */
import fs from 'node:fs';
import path from 'node:path';

export const LIST_LIMITS = Object.freeze({
  maxLists: 30,
  maxItems: 500,
  maxItemChars: 500,
  maxNameChars: 60,
  maxFileBytes: 512 * 1024,
});

const USER_RE = /^\d{5,25}$/;

export class ListError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ListError';
    this.code = code;
  }
}

export function defaultListDir(env = process.env) {
  return path.join(env.DATABASE_DIR || path.join(process.cwd(), 'database'), 'listas');
}

/** Texto de usuário: sem controles/zero-width/bidi, espaços colapsados, corte por pontos de código. */
export function cleanText(value, max) {
  const s = String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() : s;
}

/** "Lista de Compras!" -> "lista-de-compras" (chave do arquivo; nunca vira caminho). */
export function listSlug(name) {
  const slug = cleanText(name, LIST_LIMITS.maxNameChars)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, 40);
}

const queues = new Map(); // userId -> Promise (serializa leitura-modificação-gravação)

export function createListStore({ dir = defaultListDir(), now = () => Date.now() } = {}) {
  function fileFor(userId) {
    const id = String(userId ?? '');
    if (!USER_RE.test(id)) throw new ListError('USER', 'Usuário inválido.');
    return path.join(dir, `${id}.json`);
  }

  function load(userId) {
    const file = fileFor(userId);
    let raw = null;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') throw new ListError('READ', 'Não consegui ler suas listas agora.');
    }
    if (raw === null) return { version: 1, userId: String(userId), updatedAt: now(), lists: {} };
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || typeof data.lists !== 'object') throw new Error('formato');
      return data;
    } catch {
      // arquivo corrompido: guarda cópia e recomeça (não perde o original)
      try { fs.renameSync(file, `${file}.corrompido-${now()}`); } catch { /* segue */ }
      return { version: 1, userId: String(userId), updatedAt: now(), lists: {} };
    }
  }

  function save(userId, data) {
    const file = fileFor(userId);
    data.updatedAt = now();
    const text = JSON.stringify(data, null, 2);
    if (Buffer.byteLength(text) > LIST_LIMITS.maxFileBytes) throw new ListError('SIZE', 'Suas listas estão grandes demais; apague itens ou listas antigas.');
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${now()}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* ok */ }
      throw new ListError('WRITE', 'Não consegui salvar agora.');
    }
  }

  /** Executa fn(data) com exclusão por usuário; grava se fn devolver { save: true }. */
  function withUser(userId, fn) {
    const key = String(userId);
    const prev = queues.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => {
      const data = load(userId);
      const out = fn(data);
      if (out?.save) save(userId, data);
      return out?.result;
    });
    queues.set(key, run);
    run.finally(() => { if (queues.get(key) === run) queues.delete(key); }).catch(() => {});
    return run;
  }

  const need = (data, name) => {
    const slug = listSlug(name);
    if (!slug) throw new ListError('NAME', 'Qual é o nome da lista?');
    return { slug, list: data.lists[slug] };
  };

  return {
    dir,

    /** Acrescenta itens (cria a lista se não existir). Devolve { name, added, total, duplicated }. */
    addItems: (userId, listName, items) => withUser(userId, (data) => {
      const { slug } = need(data, listName);
      let list = data.lists[slug];
      if (!list) {
        if (Object.keys(data.lists).length >= LIST_LIMITS.maxLists) throw new ListError('LIMIT', `Você já tem ${LIST_LIMITS.maxLists} listas; apague alguma antes.`);
        list = data.lists[slug] = { name: cleanText(listName, LIST_LIMITS.maxNameChars), createdAt: now(), updatedAt: now(), items: [], nextId: 1 };
      }
      let added = 0;
      let duplicated = 0;
      const seen = new Set(list.items.map((i) => i.text.toLowerCase()));
      for (const raw of Array.isArray(items) ? items : [items]) {
        const text = cleanText(raw, LIST_LIMITS.maxItemChars);
        if (!text) continue;
        if (seen.has(text.toLowerCase())) { duplicated++; continue; }
        if (list.items.length >= LIST_LIMITS.maxItems) throw new ListError('LIMIT', `Essa lista já tem ${LIST_LIMITS.maxItems} itens.`);
        list.items.push({ id: list.nextId++, text, done: false, addedAt: now() });
        seen.add(text.toLowerCase());
        added++;
      }
      list.updatedAt = now();
      return { save: added > 0, result: { name: list.name, added, duplicated, total: list.items.length } };
    }),

    /** { name, items: [{ n, id, text, done }] } ou null. */
    getList: (userId, listName) => withUser(userId, (data) => {
      const { list } = need(data, listName);
      if (!list) return { result: null };
      return { result: { name: list.name, items: list.items.map((it, i) => ({ n: i + 1, id: it.id, text: it.text, done: it.done })) } };
    }),

    /** [{ name, count }] */
    listLists: (userId) => withUser(userId, (data) => ({
      result: Object.values(data.lists).map((l) => ({ name: l.name, count: l.items.length })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
    })),

    /** Remove por posição (1..n) ou por texto exato (sem diferenciar maiúsculas). */
    removeItem: (userId, listName, which) => withUser(userId, (data) => {
      const { list } = need(data, listName);
      if (!list) throw new ListError('NOLIST', 'Não achei essa lista.');
      let idx = -1;
      if (typeof which === 'number') idx = which - 1;
      else idx = list.items.findIndex((i) => i.text.toLowerCase() === cleanText(which, LIST_LIMITS.maxItemChars).toLowerCase());
      if (!Number.isInteger(idx) || idx < 0 || idx >= list.items.length) throw new ListError('NOITEM', 'Não achei esse item.');
      const [gone] = list.items.splice(idx, 1);
      list.updatedAt = now();
      return { save: true, result: { name: list.name, removed: gone.text, total: list.items.length } };
    }),

    /** Marca/desmarca como feito (posição 1..n). */
    setDone: (userId, listName, position, done = true) => withUser(userId, (data) => {
      const { list } = need(data, listName);
      if (!list) throw new ListError('NOLIST', 'Não achei essa lista.');
      const it = list.items[position - 1];
      if (!it) throw new ListError('NOITEM', 'Não achei esse item.');
      it.done = !!done;
      list.updatedAt = now();
      return { save: true, result: { name: list.name, item: it.text, done: it.done } };
    }),

    deleteList: (userId, listName) => withUser(userId, (data) => {
      const { slug, list } = need(data, listName);
      if (!list) throw new ListError('NOLIST', 'Não achei essa lista.');
      delete data.lists[slug];
      return { save: true, result: { name: list.name, count: list.items.length } };
    }),

    clearList: (userId, listName) => withUser(userId, (data) => {
      const { list } = need(data, listName);
      if (!list) throw new ListError('NOLIST', 'Não achei essa lista.');
      const count = list.items.length;
      list.items = [];
      list.updatedAt = now();
      return { save: true, result: { name: list.name, count } };
    }),

    /** JSON (texto) de uma lista ou de todas as listas DA PRÓPRIA pessoa. */
    exportJson: (userId, listName) => withUser(userId, (data) => {
      if (listName) {
        const { list } = need(data, listName);
        if (!list) throw new ListError('NOLIST', 'Não achei essa lista.');
        return { result: JSON.stringify({ name: list.name, items: list.items.map((i) => ({ text: i.text, done: i.done })) }, null, 2) };
      }
      const out = Object.values(data.lists).map((l) => ({ name: l.name, items: l.items.map((i) => ({ text: i.text, done: i.done })) }));
      return { result: JSON.stringify({ lists: out }, null, 2) };
    }),
  };
}

/** Texto para o Discord: itens numerados, sem menções ativas (zero-width depois de @ e #). */
export function formatList(list) {
  const safe = (s) => String(s).replace(/@/g, '@​').replace(/[<>]/g, '');
  if (!list.items.length) return `**${safe(list.name)}** está vazia.`;
  const lines = list.items.map((i) => `${i.n}. ${i.done ? '~~' : ''}${safe(i.text)}${i.done ? '~~' : ''}`);
  return `**${safe(list.name)}** (${list.items.length}):\n${lines.join('\n')}`;
}
