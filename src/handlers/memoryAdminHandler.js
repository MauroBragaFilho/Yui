import crypto from 'node:crypto';
import { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { isMemoryEnabled, contextFromDiscord } from '../core/discordAdapter.js';
import { memory, audit } from '../core/index.js';
import { makeEmbed, chunkLines, clampText } from '../discord/embedLimits.js';

const COLOR = 0x8B5CF6;
const ID_RE = /^\d{15,25}$/;

// A descrição do embed aceita 4096 caracteres. A lista é montada linha a linha (nunca corta uma linha no meio, o que deixava
// crase aberta e escondia o id usado em acao:Apagar) e o que não coube vira um aviso com a contagem.
const LINE_MAX = 500;
function fitLines(lines, budget) {
  const oneLine = lines.map((l) => clampText(String(l).replace(/\s+/g, ' ').trim(), LINE_MAX));
  const [first = ''] = chunkLines(oneLine, budget);
  const shown = first ? first.split('\n').length : 0;
  return { text: first, shown, hidden: lines.length - shown };
}

const ts = (ms, style = 'R') => (ms ? `<t:${Math.floor(ms / 1000)}:${style}>` : '—');

// Apagar a memória de OUTRA pessoa (memory.admin_wipe_user, etapa 4): o comando não apaga na hora. Ele mostra quem será
// apagado (o id e, quando o Discord deixa saber, o nome da conta) e pede a CONFIRMAÇÃO EXPLÍCITA DO ALVO num botão:
//  - vinculado a quem pediu (o dono), ao alvo, à lembrança (ou "tudo") e ao prazo de 2 minutos;
//  - de USO ÚNICO: o primeiro clique consome o botão ANTES de qualquer await; um segundo clique, a repetição da interação e o
//    clique duplo rápido são recusados e vão para a auditoria. O vencido também é recusado;
//  - só vale no processo que o emitiu. Por isso o "já usado" não precisa ir para o disco: se o bot reiniciar dentro dos
//    2 minutos, o botão antigo não está no mapa do processo novo e é recusado ("peça de novo"), nunca usado de novo.
// Só o botão apaga, e passa a confirmação adiante (a fachada no processo único, o cérebro no modo separado conferem de novo:
// core/memory/adminWipe.js). Igual nos dois modos: o handler e os botões rodam no bot, que é quem tem o Discord.
const CONFIRM_TTL_S = 120;
const CONFIRM_PREFIX = 'memadm_ok_';
const CANCEL_PREFIX = 'memadm_no_';
const NOME_TIMEOUT_MS = 1500; // a interação precisa de resposta em 3 s: sem o nome a tempo, mostra só o id

/** Confirmações emitidas por ESTE processo: token -> { requester, alvo, item, exp, usadaEm }. */
const emitidas = new Map();
let relogio = () => Date.now();
/** Só para os testes: relógio controlado. */
export function __definirRelogioParaTeste(fn) { relogio = typeof fn === 'function' ? fn : () => Date.now(); }
/** Só para os testes: esquece as confirmações emitidas (é o que acontece num reinício do processo). */
export function __esquecerConfirmacoesParaTeste() { emitidas.clear(); }

function emitirConfirmacao({ requester, alvo, item }) {
  const agora = relogio();
  for (const [t, c] of emitidas) if (agora > c.exp * 1000 + 60_000) emitidas.delete(t); // as vencidas há mais de 1 min saem
  const token = crypto.randomBytes(5).toString('hex');
  const exp = Math.floor(agora / 1000) + CONFIRM_TTL_S;
  emitidas.set(token, { requester, alvo, item: item || 0, exp, usadaEm: null });
  return { token, exp };
}

function confirmRow({ requester, alvo, item, rotulo }) {
  const { token, exp } = emitirConfirmacao({ requester, alvo, item });
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${CONFIRM_PREFIX}${requester}_${alvo}_${item || 0}_${exp}_${token}`).setStyle(ButtonStyle.Danger).setLabel(`Confirmar: apagar de ${rotulo}`.slice(0, 80)),
    new ButtonBuilder().setCustomId(`${CANCEL_PREFIX}${requester}_${token}`).setStyle(ButtonStyle.Secondary).setLabel('Cancelar'),
  );
}

/** Lê o customId do botão de confirmação: { requester, alvo, item, exp, token } ou null. */
export function parseConfirmId(customId) {
  const m = /^memadm_ok_(\d{5,25})_(\d{5,25})_(\d{1,12})_(\d{9,12})_([0-9a-f]{10})$/.exec(String(customId ?? ''));
  return m ? { requester: m[1], alvo: m[2], item: Number(m[3]) || null, exp: Number(m[4]), token: m[5] } : null;
}

/** Nome da conta do alvo (usuário e nome global) pelo Discord deste processo. null se não der (sem falhar). */
export async function nomeDaConta(client, userId) {
  try {
    let user = client?.users?.cache?.get?.(String(userId)) ?? null;
    if (!user && typeof client?.users?.fetch === 'function') {
      let timer;
      user = await Promise.race([
        client.users.fetch(String(userId)),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), NOME_TIMEOUT_MS); }),
      ]).finally(() => clearTimeout(timer));
    }
    if (!user) return null;
    const username = String(user.username ?? '').replace(/\s+/g, ' ').trim().slice(0, 32);
    const globalName = String(user.globalName ?? '').replace(/\s+/g, ' ').trim().slice(0, 32);
    if (!username && !globalName) return null;
    return { username: username || null, globalName: globalName && globalName !== username ? globalName : null };
  } catch {
    return null;
  }
}

const escapar = (s) => String(s).replace(/[\\*_`~|>]/g, (c) => `\\${c}`);
/** Como o alvo aparece na confirmação: id sempre; nome da conta quando houver. */
export function descreverAlvo(alvo, nome) {
  const partes = [nome?.globalName ? `**${escapar(nome.globalName)}**` : null, nome?.username ? `@${escapar(nome.username)}` : null].filter(Boolean);
  return {
    texto: `<@${alvo}> (\`${alvo}\`)${partes.length ? `, conta ${partes.join(' ')}` : ', nome da conta indisponível'}`,
    rotulo: nome?.username ? `@${nome.username} (${alvo})` : nome?.globalName ? `${nome.globalName} (${alvo})` : alvo,
  };
}

/**
 * Subcomando `/yui-criador memorias` (somente o dono; a checagem de dono já é
 * feita no creatorAdminHandler e REPETIDA no backend do Core).
 *
 * Mostra apenas METADADOS das memórias temporárias dos usuários. O conteúdo
 * não é exibido: cada usuário vê o próprio em /yui-memoria ver.
 */
export async function handleMemoriasAdmin(interaction) {
  const reply = (payload) => interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });

  if (!isMemoryEnabled()) return reply({ content: '🧠 O sistema de memória está desativado (YUI_MEMORY_ENABLED).' });

  // O papel OWNER é resolvido pelo backend; o Core recusa qualquer outro papel.
  const ctx = contextFromDiscord({ userId: interaction.user.id, guildId: null });
  const acao = interaction.options.getString('acao', true);
  const userId = interaction.options.getString('usuario_id');
  const memoriaId = interaction.options.getInteger('memoria_id');

  try {
    if (acao === 'listar') {
      const { users, total } = await memory.adminListUsers(ctx, { limit: 25 });
      let description = 'Nenhum usuário com memória no momento.';
      if (users.length) {
        const { text, shown } = fitLines(users.map((u) => `<@${u.userId}> (\`${u.userId}\`) — **${u.count}** lembrança(s) · última interação ${ts(u.lastSeen)} · expira ${ts(u.expiresAt)}`), 3800);
        // `total` conta todos os usuários com memória; a lista traz no máximo 25 (e pode ter perdido linhas por tamanho).
        const hidden = Math.max(users.length, Number(total) || 0) - shown;
        description = hidden > 0 ? `${text}\n(+${hidden} usuário(s) não exibido(s))` : text;
      }
      const embed = makeEmbed({
        color: COLOR,
        title: '🧠 Usuários com memória temporária',
        description,
        footer: `${total} usuário(s) • retenção ${memory.isPermanent?.() ? 'permanente' : `de ${memory.retentionDays()} dias`} • conteúdo oculto por privacidade`
      });
      return reply({ embeds: [embed] });
    }

    if (!userId || !ID_RE.test(userId)) return reply({ content: '❌ Informe um `usuario_id` válido (somente números).' });

    if (acao === 'ver') {
      const rows = await memory.adminListMetadata(ctx, userId, { limit: 25 });
      let body = 'Nenhuma memória ativa.';
      if (rows.length) {
        const { text, hidden } = fitLines(rows.map((r) => `**#${r.id}** · \`${r.type}\` · ${r.chars} caracteres · origem \`${r.source || '—'}\` · criada ${ts(r.createdAt)} · expira ${ts(r.expiresAt)}`), 3600);
        body = hidden > 0 ? `${text}\n(+${hidden} lembrança(s) não exibida(s))` : text;
      }
      const embed = makeEmbed({
        color: COLOR,
        title: '🔎 Memórias do usuário (metadados)',
        description: `<@${userId}> (\`${userId}\`)\n\n${body}`,
        footer: 'O conteúdo não é exibido. Use /yui-criador memorias acao:Apagar para remover.'
      });
      return reply({ embeds: [embed] });
    }

    // Apagar: só pede a confirmação (nada é apagado aqui). O alvo aparece com o id e o nome da conta (quando der).
    if (acao === 'apagar' || acao === 'apagar_usuario') {
      if (acao === 'apagar' && !memoriaId) return reply({ content: '❌ Informe o `memoria_id` da lembrança.' });
      const contar = acao === 'apagar_usuario'
        ? Promise.resolve(memory.adminListMetadata(ctx, userId, { limit: 100 })).then((rows) => rows.length, () => null)
        : Promise.resolve(null);
      const [total, nome] = await Promise.all([contar, nomeDaConta(interaction.client, userId)]);
      const alvo = descreverAlvo(userId, nome);
      const oque = acao === 'apagar'
        ? `a lembrança **#${memoriaId}**`
        : (total === null ? 'TODAS as lembranças' : `**${total}${total >= 100 ? '+' : ''}** lembrança(s)`);
      return reply({
        content: `⚠️ Confirma apagar ${oque} de ${alvo.texto}? Não dá para desfazer.\n-# Só você pode confirmar, uma vez, nos próximos ${CONFIRM_TTL_S / 60} minutos.`,
        components: [confirmRow({ requester: interaction.user.id, alvo: userId, item: acao === 'apagar' ? memoriaId : 0, rotulo: alvo.rotulo })],
        allowedMentions: { parse: [] },
      });
    }
  } catch (err) {
    if (err?.code && err.code === memory.MEMORY_UNAVAILABLE) return reply({ content: `🧠 ${memory.MEMORY_UNAVAILABLE_TEXT}` });
    return reply({ content: `❌ ${err.message}` });
  }
}

/**
 * Botões da confirmação do /yui-criador memorias (memadm_ok_* e memadm_no_*). Só quem pediu, e só o dono, confirma; o botão
 * é de uso único e vence em 2 minutos. O contexto vai com o lugar REAL do clique (DM ou servidor): a política decide pela
 * origem verdadeira. Toda recusa vai para a auditoria (só metadados).
 */
export async function handleMemoriasAdminButton(interaction) {
  const cid = String(interaction.customId ?? '');
  const done = (content) => interaction.update({ content, components: [], allowedMentions: { parse: [] } });
  const privado = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  const ctx = contextFromDiscord({ userId: interaction.user.id, guildId: interaction.guildId ?? null, channelId: interaction.channelId ?? null });
  const registrar = (event, data) => { try { audit(event, ctx, data); } catch { /* a auditoria nunca derruba o botão */ } };

  if (cid.startsWith(CANCEL_PREFIX)) {
    const [requester, token] = cid.slice(CANCEL_PREFIX.length).split('_');
    if (requester !== interaction.user.id) return privado('❌ Só quem pediu pode cancelar.');
    const c = token ? emitidas.get(token) : null;
    if (c && !c.usadaEm) c.usadaEm = relogio(); // cancelado = consumido: o "Confirmar" da mesma mensagem não vale mais
    return done('Cancelado. Nada foi apagado.');
  }

  const req = parseConfirmId(cid);
  if (!req) return privado('❌ Botão inválido.');
  const alvoAudit = { target: req.alvo, item: req.item };
  if (req.requester !== interaction.user.id || ctx.role !== 'OWNER') {
    registrar('memory.admin.wipe_botao_recusado', { ...alvoAudit, motivo: 'nao_e_quem_pediu' });
    return privado('❌ Só quem pediu (o dono) pode confirmar.');
  }
  // Uso único: tudo daqui até marcar como usado é síncrono (nenhum await), então dois cliques quase juntos nunca passam os dois.
  const c = emitidas.get(req.token);
  if (!c || c.requester !== req.requester || c.alvo !== req.alvo || c.item !== (req.item || 0) || c.exp !== req.exp) {
    registrar('memory.admin.wipe_botao_recusado', { ...alvoAudit, motivo: 'nao_emitido_neste_processo' });
    return done('⛔ Este botão não vale mais (a Yui reiniciou depois que ele foi criado). Nada foi apagado; peça de novo.');
  }
  if (c.usadaEm) {
    registrar('memory.admin.wipe_botao_reusado', alvoAudit);
    return privado('⛔ Este botão já foi usado. Nada foi apagado de novo.');
  }
  c.usadaEm = relogio(); // ANTES de qualquer await
  if (Math.floor(c.usadaEm / 1000) > c.exp) {
    registrar('memory.admin.wipe_botao_vencido', alvoAudit);
    return done('⌛ A confirmação expirou. Nada foi apagado; peça de novo.');
  }
  const confirmacao = { alvo: req.alvo, via: 'discord-botao' };
  try {
    if (req.item) {
      const ok = await memory.adminForget(ctx, req.alvo, req.item, { confirmacao });
      return done(ok ? `🗑️ Lembrança #${req.item} de <@${req.alvo}> apagada.` : 'Não encontrei essa lembrança para esse usuário.');
    }
    const n = await memory.adminForgetUser(ctx, req.alvo, { confirmacao });
    return done(`🗑️ ${n} lembrança(s) de <@${req.alvo}> apagada(s).`);
  } catch (err) {
    if (err?.code && err.code === memory.MEMORY_UNAVAILABLE) return done(`🧠 ${memory.MEMORY_UNAVAILABLE_TEXT}`);
    return done(`❌ ${err.message}`);
  }
}
