// DISCORD FALSO para os testes de operação do bot separado (tests/test-operacao.js, tests/test-entrega-lembretes.js).
// NUNCA vale em produção.
//
// Só liga com as TRÊS condições: YUI_TESTE_DISCORD_FALSO=true, NODE_ENV=test e o bot com o cérebro separado
// (YUI_CEREBRO_EXTERNO=true). Fora disso a variável é ignorada e o bot avisa no log (mesmo padrão da IA falsa do cérebro).
//
// Com ele o bot NÃO faz login no Discord: o processo sobe de verdade (bancos com trava, canal com o cérebro, ações do canal,
// idempotência persistente, desligamento limpo) e fica de pé. O arquivo YUI_TESTE_DISCORD_FALSO_ARQUIVO faz o papel do
// SERVIDOR do Discord (sobrevive aos reinícios do bot):
//  - cada mensagem privada vira uma linha JSON ({ userId, text, nonce, messageId, authorId, at }), gravada com fsync;
//  - `nonce` + `enforceNonce: true`: se já existe uma mensagem com a mesma nonce dentro da janela (padrão 120 s), ela é
//    devolvida e nada é gravado (como o Discord faz);
//  - o histórico da DM (`user.createDM().messages.fetch`) lê esse arquivo.
// Comportamentos ajustáveis SEM reiniciar o bot, pelo arquivo JSON YUI_TESTE_DISCORD_FALSO_CONTROLE (relido a cada envio):
//  { "semHistorico": true }       o histórico da DM falha (sem permissão), como o Discord fora ou a DM bloqueada;
//  { "atrasoAntesMs": 3000 }      espera ANTES de gravar a mensagem (janela para derrubar o bot antes de sair);
//  { "atrasoDepoisMs": 3000 }     espera DEPOIS de gravar (a mensagem saiu, a confirmação não): o mesmo que
//                                 YUI_TESTE_DISCORD_FALSO_ATRASO_MS;
//  { "janelaNonceMs": 120000 }    a janela da nonce.
//
// Conversa (etapa 5, tests/test-chat-turn.js): com YUI_TESTE_DISCORD_FALSO_ENTRADA, cada linha JSON NOVA desse arquivo
// ({ id, userId, username, guildId, channelId, content, at }) vira uma mensagem que o bot recebe pelo messageCreate DE VERDADE (fila do
// llmHandler, turno do cérebro). As respostas e edições vão para YUI_TESTE_DISCORD_FALSO_CANAL, uma linha JSON por envio
// ({ tipo: 'reply'|'edit'|'send'|'delete', paraMensagem, mensagemId, content, at, pid }). As linhas que já estavam na entrada quando o bot
// subiu são ignoradas (o Discord não entrega de novo o que chegou enquanto o bot estava fora).
// Etapa 6 (tests/test-pesquisa-cerebro.js): as respostas têm id numérico (como o Discord) e levam o canal (`canal`); o client.channels.fetch
// relê esse arquivo para buscar e editar uma mensagem do bot (é assim que o "Processando..." guardado é avisado depois de um reinício).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const FAKE_BOT_ID = '900000000000000001';

/** 'on' (ligar), 'off' (variável ausente) ou 'refused' (variável ligada fora de NODE_ENV=test ou sem o cérebro separado). */
export function fakeDiscordMode(env = process.env) {
  const wanted = String(env.YUI_TESTE_DISCORD_FALSO ?? '').trim().toLowerCase() === 'true';
  if (!wanted) return 'off';
  const test = String(env.NODE_ENV ?? '').trim().toLowerCase() === 'test';
  const separated = String(env.YUI_CEREBRO_EXTERNO ?? '').trim().toLowerCase() === 'true';
  return test && separated ? 'on' : 'refused';
}

function appendDurable(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, `${line}\n`);
    try { fs.fsyncSync(fd); } catch { /* melhor esforço */ }
  } finally {
    fs.closeSync(fd);
  }
}

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

/** Um canal do Discord falso reconstruído do arquivo de saída (só o que o "Processando..." guardado usa: buscar a mensagem e editar). */
function fakeChannelFromLog(channelId, env) {
  const outFile = path.resolve(String(env.YUI_TESTE_DISCORD_FALSO_CANAL ?? '').trim() || path.join('logs', 'discord-falso-canal.jsonl'));
  const write = (event) => appendDurable(outFile, JSON.stringify({ ...event, at: new Date().toISOString(), pid: process.pid }));
  const naoExiste = () => Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 });
  return {
    id: channelId,
    messages: {
      async fetch(messageId) {
        const id = String(messageId);
        const lines = readLines(outFile).filter((e) => e.mensagemId === id);
        const first = lines.find((e) => e.tipo === 'reply' || e.tipo === 'send');
        if (!first || first.canal !== channelId || lines.some((e) => e.tipo === 'delete')) throw naoExiste();
        const last = [...lines].reverse().find((e) => e.tipo === 'reply' || e.tipo === 'send' || e.tipo === 'edit');
        const msg = {
          id, channelId, channel: { id: channelId }, author: { id: FAKE_BOT_ID, bot: true }, reference: { messageId: first.paraMensagem },
          content: String(last?.content ?? ''),
          async edit(payload) { write({ tipo: 'edit', paraMensagem: first.paraMensagem, mensagemId: id, canal: channelId, content: typeof payload === 'string' ? payload : String(payload?.content ?? '') }); return msg; },
        };
        return msg;
      },
    },
  };
}

/** Cliente falso com o pedaço da interface do discord.js que as ações do canal usam (isReady, users.fetch().send, createDM). */
export function createFakeDiscordClient({ env = process.env } = {}) {
  const file = path.resolve(String(env.YUI_TESTE_DISCORD_FALSO_ARQUIVO ?? '').trim() || path.join('logs', 'discord-falso-dms.jsonl'));
  const controlFile = String(env.YUI_TESTE_DISCORD_FALSO_CONTROLE ?? '').trim();
  const baseDelay = Math.max(0, Number(env.YUI_TESTE_DISCORD_FALSO_ATRASO_MS) || 0);
  const controle = () => {
    let c = {};
    if (controlFile) { try { c = JSON.parse(fs.readFileSync(controlFile, 'utf8')) || {}; } catch { c = {}; } }
    return {
      semHistorico: c.semHistorico === true,
      atrasoAntesMs: Math.max(0, Number(c.atrasoAntesMs) || 0),
      atrasoDepoisMs: Math.max(0, Number(c.atrasoDepoisMs ?? baseDelay) || 0),
      janelaNonceMs: Number.isFinite(Number(c.janelaNonceMs)) ? Number(c.janelaNonceMs) : 120_000,
    };
  };
  const sleep = (ms) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  const asMessage = (m) => ({ id: m.messageId, content: m.text, nonce: m.nonce ?? null, author: { id: m.authorId ?? FAKE_BOT_ID }, createdTimestamp: Date.parse(m.at) });
  let ready = true;
  return {
    falso: true,
    arquivo: file,
    isReady: () => ready,
    user: { id: FAKE_BOT_ID, tag: 'YuiTeste#0000' },
    guilds: { cache: new Map() },
    // Etapa 6: o "servidor" das mensagens do canal é o arquivo de saída (YUI_TESTE_DISCORD_FALSO_CANAL): buscar uma mensagem do bot relê o
    // arquivo (o conteúdo é o da última edição) e editar acrescenta uma linha. Sobrevive ao reinício do bot, como o Discord.
    channels: { cache: new Map(), fetch: async (channelId) => fakeChannelFromLog(String(channelId), env) },
    users: {
      cache: new Map(),
      async fetch(userId) {
        const uid = String(userId);
        const dmChannel = {
          messages: {
            async fetch({ limit = 50 } = {}) {
              if (controle().semHistorico) throw Object.assign(new Error('Missing Access'), { code: 50001, status: 403 });
              const msgs = readLines(file).filter((m) => m.userId === uid).slice(-Math.min(100, limit)).reverse().map(asMessage);
              return new Map(msgs.map((m) => [m.id, m]));
            },
          },
        };
        return {
          id: uid,
          username: `pessoa_${uid.slice(-4)}`,
          globalName: null,
          dmChannel: null,
          async createDM() { return dmChannel; },
          async send(opts) {
            const c = controle();
            const content = typeof opts === 'string' ? opts : String(opts?.content ?? '');
            const nonce = typeof opts === 'object' && opts?.nonce ? String(opts.nonce) : null;
            if (typeof opts === 'object' && opts?.enforceNonce && !nonce) throw new Error('Message nonce is required when enforceNonce is true.');
            if (nonce && nonce.length > 25) throw Object.assign(new Error('Invalid Form Body: nonce'), { status: 400, code: 50035 });
            await sleep(c.atrasoAntesMs);
            if (nonce && opts?.enforceNonce) {
              const existing = readLines(file).find((m) => m.userId === uid && m.nonce === nonce && Date.now() - Date.parse(m.at) < c.janelaNonceMs);
              if (existing) return asMessage(existing); // o Discord devolve a mensagem que já existe
            }
            const msg = { userId: uid, text: content, nonce, messageId: `falso-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, authorId: FAKE_BOT_ID, pid: process.pid, at: new Date().toISOString() };
            appendDurable(file, JSON.stringify(msg));
            await sleep(c.atrasoDepoisMs);
            return asMessage(msg);
          },
        };
      },
    },
    async destroy() { ready = false; },
  };
}

/**
 * Entrada de mensagens falsas (só teste; ver o cabeçalho). Lê as linhas NOVAS de YUI_TESTE_DISCORD_FALSO_ENTRADA a cada `intervalMs` e
 * entrega cada uma a `onMessage(mensagem)` (o messageCreate de verdade). Devolve { parar() } ou null sem a variável.
 */
export function startFakeInbox({ client, onMessage, onInteraction = null, env = process.env, intervalMs = 100, logger = null } = {}) {
  const inbox = String(env.YUI_TESTE_DISCORD_FALSO_ENTRADA ?? '').trim();
  if (!inbox || typeof onMessage !== 'function') return null;
  const outFile = path.resolve(String(env.YUI_TESTE_DISCORD_FALSO_CANAL ?? '').trim() || path.join('logs', 'discord-falso-canal.jsonl'));
  const write = (event) => appendDurable(outFile, JSON.stringify({ ...event, at: new Date().toISOString(), pid: process.pid }));
  const text = (payload) => (typeof payload === 'string' ? payload : String(payload?.content ?? ''));
  let offset = 0;
  try { offset = fs.statSync(inbox).size; } catch { offset = 0; } // o que chegou antes de o bot subir não é entregue
  let pending = '';
  const guilds = new Map();
  const guildOf = (id) => {
    if (!id) return null;
    if (!guilds.has(id)) guilds.set(id, { id, name: 'Servidor de Teste', client, channels: { cache: new Map() }, members: { me: null } });
    return guilds.get(id);
  };
  const toMessage = (m) => {
    const guild = guildOf(m.guildId ? String(m.guildId) : null);
    const id = String(m.id);
    let seq = 0;
    const canalId = String(m.channelId);
    const sent = (paraMensagem) => {
      // id numérico, como o do Discord (etapa 6: o "Processando..." guardado só aceita ids do Discord)
      const mensagemId = `${id}${String(++seq).padStart(2, '0')}`;
      const msg = {
        id: mensagemId, channelId: canalId, author: { id: FAKE_BOT_ID, bot: true }, reference: { messageId: paraMensagem },
        async edit(payload) { write({ tipo: 'edit', paraMensagem, mensagemId, canal: canalId, content: text(payload) }); return msg; },
        async delete() { write({ tipo: 'delete', paraMensagem, mensagemId, canal: canalId }); },
      };
      return msg;
    };
    const channel = {
      id: String(m.channelId), name: 'geral', type: guild ? 0 : 1, guild,
      isTextBased: () => true, permissionsFor: () => ({ has: () => true }),
      messages: { fetch: async () => new Map() },
      async sendTyping() {},
      async send(payload) {
        const ref = typeof payload === 'object' ? payload?.reply?.messageReference?.id ?? null : null;
        const msg = sent(ref ?? id);
        write({ tipo: 'send', paraMensagem: ref ?? id, mensagemId: msg.id, canal: channel.id, content: text(payload) });
        msg.channel = channel;
        return msg;
      },
    };
    const content = String(m.content ?? '');
    return {
      id, createdTimestamp: Number(m.at) || Date.now(), content, guildId: guild?.id ?? null, channelId: channel.id, guild, channel, client,
      author: { id: String(m.userId), username: String(m.username ?? `pessoa_${String(m.userId).slice(-4)}`), tag: `${String(m.username ?? 'pessoa')}#0001`, bot: false },
      member: null, reference: null, attachments: new Map(),
      mentions: { has: () => content.includes(`<@${FAKE_BOT_ID}>`), everyone: false, repliedUser: null, users: new Map() },
      async reply(payload) {
        const msg = sent(id);
        msg.channel = channel;
        write({ tipo: 'reply', paraMensagem: id, mensagemId: msg.id, canal: channel.id, content: text(payload) });
        return msg;
      },
    };
  };
  // Etapa 7 (tests/test-comentarios-cerebro.js): uma linha { tipo: 'comando', id, comando, opcoes, userId, username, guildId, channelId, at }
  // vira uma INTERAÇÃO de comando de barra entregue ao interactionCreate DE VERDADE (onInteraction). O que a interação responde vai para o
  // mesmo arquivo de saída: { tipo: 'interacao-adiada'|'interacao-resposta'|'interacao-edicao'|'interacao-seguimento', paraInteracao, content,
  // embeds: [{ title, description }] }.
  const embedsDe = (payload) => (Array.isArray(payload?.embeds) ? payload.embeds.map((e) => { const d = e?.data ?? e ?? {}; return { title: d.title ?? null, description: String(d.description ?? '').slice(0, 300) }; }) : []);
  const toInteraction = (m) => {
    const guild = guildOf(m.guildId ? String(m.guildId) : null);
    const id = String(m.id);
    const canalId = String(m.channelId);
    const opcoes = m.opcoes && typeof m.opcoes === 'object' ? m.opcoes : {};
    const opcao = (n) => (Object.hasOwn(opcoes, n) ? opcoes[n] : null);
    const saida = (tipo, payload) => write({ tipo, paraInteracao: id, canal: canalId, content: text(payload), embeds: embedsDe(payload) });
    const channel = {
      id: canalId, name: 'geral', type: guild ? 0 : 1, guild, isTextBased: () => true, permissionsFor: () => ({ has: () => true }),
      messages: { fetch: async () => new Map() },
      async send(payload) { write({ tipo: 'send', paraMensagem: id, canal: canalId, content: text(payload) }); return { id: `${id}99`, channelId: canalId }; },
    };
    const username = String(m.username ?? `pessoa_${String(m.userId).slice(-4)}`);
    const it = {
      id, createdTimestamp: Number(m.at) || Date.now(), guildId: guild?.id ?? null, channelId: canalId, guild, channel, client,
      user: { id: String(m.userId), username, tag: `${username}#0001`, bot: false }, member: null, memberPermissions: null,
      commandName: String(m.comando ?? ''), customId: undefined, deferred: false, replied: false,
      isAutocomplete: () => false, isChatInputCommand: () => true, isCommand: () => true, isButton: () => false, isStringSelectMenu: () => false,
      isModalSubmit: () => false, isRepliable: () => true,
      options: {
        getSubcommand: () => null, getFocused: () => '',
        getString: (n) => (opcao(n) === null ? null : String(opcao(n))),
        getNumber: (n) => (typeof opcao(n) === 'number' ? opcao(n) : null),
        getInteger: (n) => (Number.isInteger(opcao(n)) ? opcao(n) : null),
        getBoolean: (n) => (typeof opcao(n) === 'boolean' ? opcao(n) : null),
      },
      async deferReply() { it.deferred = true; write({ tipo: 'interacao-adiada', paraInteracao: id, canal: canalId }); },
      async reply(payload) { it.replied = true; saida('interacao-resposta', payload); },
      async editReply(payload) { saida('interacao-edicao', payload); },
      async followUp(payload) { saida('interacao-seguimento', payload); },
    };
    return it;
  };
  const tick = () => {
    let size = 0;
    try { size = fs.statSync(inbox).size; } catch { return; }
    if (size <= offset) return;
    let chunk = '';
    try {
      const fd = fs.openSync(inbox, 'r');
      try {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        chunk = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { return; }
    offset = size;
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m?.tipo === 'comando') {
        if (typeof onInteraction === 'function') {
          Promise.resolve().then(() => onInteraction(toInteraction(m))).catch((err) => logger?.warn?.(`[Discord falso] interação não entregue: ${String(err?.message ?? err).slice(0, 120)}`));
        }
        continue;
      }
      Promise.resolve().then(() => onMessage(toMessage(m))).catch((err) => logger?.warn?.(`[Discord falso] mensagem não entregue: ${String(err?.message ?? err).slice(0, 120)}`));
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { parar() { clearInterval(timer); }, arquivo: inbox, saida: outFile };
}
