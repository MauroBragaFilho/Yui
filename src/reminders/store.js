/**
 * Lembretes do dono, guardados em UM arquivo JSON (<DATABASE_DIR>/lembretes.json, fora do Git), com gravação atômica
 * (arquivo temporário + rename). Poucos lembretes por vez, então tudo cabe em memória e cada mudança regrava o arquivo.
 *
 * Um lembrete: { id, text, at (ISO, próxima vez), repeat (null | {kind, hour, minute, weekday?, day?}), createdAt, tries, lastFiredAt, userId }.
 * `userId`: null = do dono (os lembretes de antes); um id do Discord = dessa pessoa (o aviso vai por DM para ela).
 * O id é um número pequeno que nunca se repete ("cancela o lembrete 3"). Sem IA, sem rede, relógio injetável.
 */
import fs from 'node:fs';
import path from 'node:path';
import { nextOccurrence } from './when.js';

export const REMINDER_LIMITS = Object.freeze({ maxItems: 200, maxPerUser: 20, maxTextChars: 300, maxFileBytes: 512 * 1024 });

export class ReminderError extends Error {
  constructor(code, message) { super(message); this.name = 'ReminderError'; this.code = code; }
}

export function defaultReminderFile(env = process.env) {
  return path.join(env.DATABASE_DIR || path.join(process.cwd(), 'database'), 'lembretes.json');
}

/** Texto do lembrete: sem controles, espaços colapsados, corte por pontos de código. */
export function cleanReminderText(value) {
  const s = String(value ?? '').normalize('NFC').replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length > REMINDER_LIMITS.maxTextChars ? chars.slice(0, REMINDER_LIMITS.maxTextChars).join('').trimEnd() : s;
}

const toIso = (d) => new Date(d).toISOString();

export function createReminderStore({ file = defaultReminderFile(), now = () => Date.now() } = {}) {
  let state = null;

  function load() {
    if (state) return state;
    state = { nextId: 1, items: [] };
    try {
      if (fs.existsSync(file)) {
        if (fs.statSync(file).size > REMINDER_LIMITS.maxFileBytes) throw new Error('arquivo grande demais');
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw && Array.isArray(raw.items)) {
          state.items = raw.items.filter((r) => r && Number.isInteger(r.id) && typeof r.text === 'string' && !Number.isNaN(Date.parse(r.at)));
          state.nextId = Math.max(Number(raw.nextId) || 1, ...state.items.map((r) => r.id + 1), 1);
        }
      }
    } catch {
      // Arquivo ilegível: guarda uma cópia para olhar depois e começa vazio (nunca derruba a Yui).
      try { fs.copyFileSync(file, `${file}.corrompido-${Date.now()}`); } catch { /* sem cópia */ }
      state = { nextId: 1, items: [] };
    }
    return state;
  }

  function save() {
    const s = load();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ nextId: s.nextId, items: s.items }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  const sorted = () => [...load().items].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id);

  return {
    /** Todos os lembretes, do mais cedo para o mais tarde. */
    list: () => sorted().map((r) => ({ ...r })),
    get: (id) => { const r = load().items.find((x) => x.id === Number(id)); return r ? { ...r } : null; },
    count: () => load().items.length,

    add({ text, at, repeat = null, userId = null }) {
      const s = load();
      const clean = cleanReminderText(text);
      if (!clean) throw new ReminderError('vazio', 'Do que devo te lembrar?');
      if (s.items.length >= REMINDER_LIMITS.maxItems) throw new ReminderError('limite', `Você já tem ${REMINDER_LIMITS.maxItems} lembretes; apague alguns.`);
      const when = new Date(at);
      if (Number.isNaN(when.getTime())) throw new ReminderError('data', 'Data inválida.');
      const uid = userId ? String(userId) : null;
      if (uid && s.items.filter((x) => x.userId === uid).length >= REMINDER_LIMITS.maxPerUser) throw new ReminderError('limite', `Você já tem ${REMINDER_LIMITS.maxPerUser} lembretes; apague alguns para criar outro.`);
      const r = { id: s.nextId++, text: clean, at: toIso(when), repeat: repeat || null, createdAt: toIso(now()), tries: 0, lastFiredAt: null, userId: uid };
      s.items.push(r);
      save();
      return { ...r };
    },

    remove(id) {
      const s = load();
      const before = s.items.length;
      s.items = s.items.filter((r) => r.id !== Number(id));
      if (s.items.length !== before) { save(); return true; }
      return false;
    },

    removeAll() {
      const s = load();
      const n = s.items.length;
      s.items = [];
      if (n) save();
      return n;
    },

    /** Muda o horário de um lembrete (adiar). */
    reschedule(id, at) {
      const r = load().items.find((x) => x.id === Number(id));
      if (!r) return null;
      const when = new Date(at);
      if (Number.isNaN(when.getTime())) throw new ReminderError('data', 'Data inválida.');
      r.at = toIso(when);
      r.tries = 0;
      save();
      return { ...r };
    },

    /** Lembretes cujo horário já chegou. */
    due(at = now()) {
      return sorted().filter((r) => Date.parse(r.at) <= at).map((r) => ({ ...r }));
    },

    /** Depois de avisar: o que repete vai para a próxima vez (nunca no passado); o que não repete sai da lista. */
    complete(id, at = now()) {
      const s = load();
      const r = s.items.find((x) => x.id === Number(id));
      if (!r) return { removed: false, next: null };
      r.lastFiredAt = toIso(at);
      r.tries = 0;
      if (r.repeat) {
        const next = nextOccurrence(r.repeat, new Date(Math.max(at, Date.parse(r.at))));
        if (next) { r.at = toIso(next); save(); return { removed: false, next: r.at }; }
      }
      s.items = s.items.filter((x) => x.id !== r.id);
      save();
      return { removed: true, next: null };
    },

    /** O aviso não saiu (Discord fora do ar): conta a tentativa e tenta de novo na próxima passada. */
    recordFailure(id) {
      const r = load().items.find((x) => x.id === Number(id));
      if (!r) return;
      r.tries = (r.tries || 0) + 1;
      save();
    },

    /** Procura pelo texto (sem acento nem maiúscula). */
    findByText(term) {
      const norm = (x) => String(x).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      const t = norm(term).trim();
      if (!t) return [];
      return sorted().filter((r) => norm(r.text).includes(t)).map((r) => ({ ...r }));
    },
  };
}
