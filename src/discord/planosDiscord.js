// A parte dos planos que é do Discord: a DM com os botões Aprovar e Recusar (montados AQUI, nunca recebidos de fora) e o clique.
// Plano aprovado automaticamente ("auto"): a mesma mensagem, sem botões.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { isOwnerId } from '../core/permissions.js';
import { portaDePlanos } from '../core/planos/porta.js';

const ID_RE = /^[a-f0-9]{12}$/;
const HASH_RE = /^[a-f0-9]{16}$/;
const CID_RE = /^plano_(ok|no)_([a-f0-9]{12})_(\d{1,3})_([a-f0-9]{16})$/;

export function mensagemDoPlano({ texto, id, versao, hash, auto = false }) {
  if (!ID_RE.test(String(id)) || !Number.isInteger(versao) || versao < 1 || versao > 999 || !HASH_RE.test(String(hash)) || !String(texto ?? '').trim()) throw new Error('plano inválido');
  const sufixo = `${id}_${versao}_${hash}`;
  const base = { content: String(texto).slice(0, 1900), allowedMentions: { parse: [] } };
  if (auto === true) return { ...base, components: [] };
  return {
    ...base,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`plano_ok_${sufixo}`).setLabel('Aprovar').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`plano_no_${sufixo}`).setLabel('Recusar').setStyle(ButtonStyle.Secondary),
    )],
  };
}

export async function handlePlanoButton(interaction, { porta = portaDePlanos(), ehDono = isOwnerId } = {}) {
  const privado = (content) => interaction.reply({ content, ephemeral: true }).catch(() => {});
  const m = CID_RE.exec(String(interaction.customId));
  if (!m || !porta) return privado('Esses botões não valem mais.');
  if (interaction.guildId || !ehDono(interaction.user.id)) return privado('Só o dono decide, e só na mensagem privada.');
  await interaction.deferUpdate().catch(() => {});
  let r;
  try {
    r = await porta.decidir({ userId: interaction.user.id, id: m[2], versao: Number(m[3]), hash: m[4], aprovar: m[1] === 'ok' });
  } catch {
    r = { final: false, text: 'Não consegui falar com os planos agora; toque de novo em instantes.' };
  }
  if (r?.final) await interaction.editReply({ components: [] }).catch(() => {});
  return interaction.followUp({ content: String(r?.text ?? 'Feito.') }).catch(() => {});
}
