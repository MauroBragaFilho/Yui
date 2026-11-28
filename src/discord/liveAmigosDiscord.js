// A parte do Discord da live dos amigos, etapa 1 (docs/PLANO_TECNICO_LIVE_AMIGOS_ETAPA1.md §4 e §6). Só ENTRADA E SAÍDA:
//  - Porta A: reconhece a frase numa DM e encaminha ao serviço (pela porta: no processo único é o próprio serviço; separado, o canal com o cérebro);
//  - os botões (prefixo liveamg_): encaminha o clique; a decisão é do serviço, no cérebro (o prefixo fica FORA do discordGuard de propósito, para o
//    bot não gravar a linha policy.evaluate com o ID cru);
//  - as mensagens: troca @@NOME:<id>@@ pelo nome atual (buscado na hora, nunca guardado), manda, edita e apaga as mensagens da própria Yui.
// O texto do pedido nunca vai para log, histórico, IA ou webhook: a Porta A retorna antes de tudo isso.
import crypto from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { reconhecerFrase } from '../core/liveAmigos/frases.js';
import { portaLiveAmigos } from '../core/liveAmigos/porta.js';
import { PREFIXO_BOTAO, TEXTOS } from '../core/liveAmigos/servico.js';
import { isOwnerId } from '../core/permissions.js';
import { ownerUserId } from '../core/api/auth.js';

export const FALHA_FIXA = 'Não consegui agora; tente de novo daqui a pouco.';
const RE_ID = /^\d{17,20}$/;

/** Tira IDs de qualquer texto de erro antes de registrar (o scrubLogText só tira segredos). */
export const semIds = (s) => String(s ?? '').replace(/\d{17,20}/g, '#').replace(/UC[A-Za-z0-9_-]{22}/g, 'UC#').slice(0, 120);

async function trocarNomes(texto, client) {
  const ids = [...new Set([...String(texto).matchAll(/@@NOME:(\d{17,20})@@/g)].map((m) => m[1]))];
  let saida = String(texto);
  for (const id of ids) {
    let nome = 'nome indisponível';
    try {
      const u = await client?.users?.fetch?.(id);
      if (u) nome = u.globalName ? `${u.globalName} (@${u.username})` : `@${u.username}`;
    } catch { /* fica "nome indisponível" */ }
    saida = saida.split(`@@NOME:${id}@@`).join(nome.replace(/@@/g, ''));
  }
  return saida;
}

/** A mensagem do Discord a partir da resposta do serviço (os botões são montados AQUI, a partir de customIds conferidos). */
export async function montarMensagem(resposta, client) {
  const content = (await trocarNomes(resposta?.texto ?? '', client)).slice(0, 1900);
  const botoes = Array.isArray(resposta?.botoes) ? resposta.botoes.filter((b) => typeof b?.customId === 'string' && b.customId.startsWith(PREFIXO_BOTAO) && b.customId.length <= 100) : [];
  const components = botoes.length
    ? [new ActionRowBuilder().addComponents(...botoes.slice(0, 2).map((b) => new ButtonBuilder().setCustomId(b.customId).setLabel(String(b.label ?? 'OK').slice(0, 40)).setStyle(b.estilo === 'perigo' ? ButtonStyle.Danger : ButtonStyle.Secondary)))]
    : [];
  return { content, components, allowedMentions: { parse: [] } };
}

/**
 * Porta A: em messageCreate, ANTES do descarte de DM de terceiros e da checagem de banimento.
 * Do dono: autorizar, listar, revogar, recomeçar. De qualquer pessoa: "apagar meus dados da live". O resto segue o fluxo de sempre.
 * @returns {Promise<boolean>} true quando a mensagem foi tratada (quem chama retorna)
 */
export async function portaA(message, client, { porta = portaLiveAmigos(), ehDono = isOwnerId, logger = null } = {}) {
  if (!porta || message?.guildId || message?.author?.bot) return false;
  const texto = String(message?.content ?? '');
  if (!texto.trim() || (message.attachments?.size ?? 0) > 0 || message.reference) return false;
  const frase = reconhecerFrase(texto);
  if (!frase) return false;
  const dono = ehDono(message.author.id);
  // De quem não é o dono, só o "apagar meus dados". As frases do dono vindas de outra pessoa seguem o fluxo normal da DM.
  if (!dono && frase.acao !== 'apagar_meus_dados') return false;
  let resposta;
  try {
    resposta = await porta.comando({ userId: String(message.author.id), texto, idem: String(message.id ?? '') });
  } catch (err) {
    logger?.warn?.(`[LiveAmigos] pedido sem resposta (${semIds(err?.code ?? 'erro')})`);
    await message.channel?.send?.({ content: FALHA_FIXA, allowedMentions: { parse: [] } }).catch(() => {});
    return true;
  }
  if (!resposta) return false;
  try {
    const enviada = await message.channel.send(await montarMensagem(resposta, client));
    if (resposta.ref && resposta.limpeza && enviada?.id) {
      await porta.mensagemEnviada({ ref: resposta.ref, messageId: String(enviada.id), channelId: String(enviada.channelId ?? message.channelId ?? message.channel?.id ?? ''), limpeza: resposta.limpeza }).catch(() => {});
    }
  } catch (err) {
    logger?.warn?.(`[LiveAmigos] não consegui responder (${semIds(err?.code ?? 'erro')})`);
  }
  return true;
}

/** O clique num botão liveamg_: o serviço decide; aqui só a mensagem muda (sem botões, só o resultado e o código, sem IDs). */
export async function handleLiveAmigosButton(interaction, { porta = portaLiveAmigos() } = {}) {
  const privado = (content) => interaction.reply({ content, ephemeral: true }).catch(() => {});
  if (!porta) return privado('Esses botões não valem mais.');
  if (interaction.guildId) return privado('Esses botões só valem na mensagem privada.');
  await interaction.deferUpdate().catch(() => {});
  let r;
  try {
    r = await porta.botao({ userId: String(interaction.user.id), customId: String(interaction.customId), idem: String(interaction.id ?? '') });
  } catch {
    return interaction.followUp({ content: FALHA_FIXA, ephemeral: true }).catch(() => {});
  }
  if (r?.naoEditar) return interaction.followUp({ content: String(r.texto), ephemeral: true }).catch(() => {});
  return interaction.editReply({ content: String(r?.texto ?? 'Feito.').slice(0, 1900), components: [], allowedMentions: { parse: [] } }).catch(() => {});
}

/**
 * Processo único: o serviço mora neste processo, a porta é ele mesmo e as ações do Discord são chamadas direto.
 * @returns {{ servico: object, parar: Function }}
 */
export async function iniciarLiveAmigosNoProcessoUnico({ getClient, logger = console, env = process.env, agendar = true } = {}) {
  const { criarServicoLiveAmigos } = await import('../core/liveAmigos/servico.js');
  const { definirPortaLiveAmigos, definirServicoLiveAmigos } = await import('../core/liveAmigos/porta.js');
  const acoes = acoesDoDiscord(getClient);
  const ehDono = (id) => isOwnerId(id) || (Boolean(ownerUserId(env)) && String(id) === String(ownerUserId(env)));
  const servico = criarServicoLiveAmigos({ env, logger, ehDono, avisar: acoes.avisar, limparDm: acoes.limparDm });
  definirPortaLiveAmigos(servico);
  definirServicoLiveAmigos(servico);
  const timers = [];
  if (agendar) {
    const rodar = (fn) => fn().catch((err) => logger.warn?.(`[LiveAmigos] rotina falhou (${semIds(err?.code ?? 'erro')})`));
    rodar(servico.retomar);
    timers.push(setInterval(() => rodar(servico.retomar), 10 * 60_000), setInterval(() => rodar(servico.rodarLimpezas), 60_000));
    for (const t of timers) t.unref?.();
  }
  return { servico, parar: () => { for (const t of timers) clearInterval(t); definirPortaLiveAmigos(null); definirServicoLiveAmigos(null); } };
}

/**
 * As ações do Discord que o serviço pede (no processo único chamadas direto; separado, pelos métodos liveamigos.* do canal).
 *  - avisar: só para o dono, ou, para outra pessoa, SÓ o texto fixo do aviso de revogação;
 *  - limparDm: edita ou apaga uma mensagem DA PRÓPRIA YUI numa DM.
 */
export function acoesDoDiscord(getClient, { ehDono = isOwnerId, dono = () => ownerUserId() } = {}) {
  return {
    async avisar({ userId = null, dono: paraDono = false, texto, chave }) {
      const client = getClient();
      if (!client?.isReady?.()) return false;
      const destino = paraDono ? dono() : String(userId ?? '');
      if (!destino || !RE_ID.test(destino)) return false;
      if (!paraDono && !ehDono(destino) && texto !== TEXTOS.avisoAmigoRevogado) {
        const err = new Error('aviso recusado'); err.code = 'FORBIDDEN'; throw err;
      }
      const user = await client.users.fetch(destino);
      // A mesma nonce estável do canalCerebro (nonceDaChave): o Discord devolve a mensagem que já existe em vez de criar outra, por alguns minutos.
      const nonce = chave ? `y${crypto.createHash('sha256').update(`${chave}#0`).digest('base64url').slice(0, 24)}` : null;
      await user.send({ content: String(texto).slice(0, 1900), allowedMentions: { parse: [] }, ...(nonce ? { nonce, enforceNonce: true } : {}) });
      return true;
    },
    async limparDm({ messageId, channelId, acao, texto }) {
      const client = getClient();
      if (!client?.isReady?.()) return { feito: false, motivo: 'discord-offline' };
      try {
        const canal = await client.channels.fetch(String(channelId));
        if (!canal || canal.guildId) return { feito: false, motivo: 'canal' };
        const msg = await canal.messages.fetch(String(messageId));
        if (msg?.author?.id !== client.user?.id) return { feito: false, motivo: 'nao-e-da-yui' };
        if (acao === 'apagar') await msg.delete();
        else await msg.edit({ content: String(texto ?? 'Mensagem encerrada.').slice(0, 1900), components: [] });
        return { feito: true };
      } catch (err) {
        if (err?.code === 10008) return { feito: true }; // a mensagem já não existe: nada a limpar
        return { feito: false, motivo: semIds(err?.code ?? 'erro') };
      }
    },
  };
}
