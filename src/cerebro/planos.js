// Os planos com aprovação no cérebro: o bot pede e decide pelo canal; a DM (com os botões) sai pelo bot.
import { iniciarPlanos } from '../core/planos/servico.js';
import { ownerUserId } from '../core/api/auth.js';
import { privadoDeclarado } from '../core/ai/perfis.js';
import { selecionarPerfil } from './seletorPerfil.js';

export const METODO_PEDIR = 'planos.pedir';
export const METODO_DECIDIR = 'planos.decidir';

export function registrarPlanos({ channel, logger, env = process.env, opcoes = {}, tickMs }) {
  const pode = (userId) => String(userId) === String(ownerUserId()) && channel.isConnected('bot');
  const canal = {
    entregarPlano: async (userId, dados) => (pode(userId) ? channel.request('bot', 'discord.plano.send', { userId, ...dados }, { idem: `plano:${dados.id}`, timeoutMs: 30_000 }) : false),
    enviarTexto: async (userId, texto, { idem }) => (pode(userId) ? channel.request('bot', 'discord.dm.send', { userId, text: texto.slice(0, 7900), motivo: 'plano' }, { idem, timeoutMs: 30_000 }) : false),
  };
  // O perfil privado, quando o dono o declarou: a proposta do plano vai pelo mesmo caminho da conversa privada.
  const perfil = privadoDeclarado() ? (texto) => selecionarPerfil({ ponto: 'conversa', privada: true, texto }, { env }) : null;
  const servico = iniciarPlanos({ canal, env, logger, perfil, ...opcoes }, tickMs ? { tickMs } : {});
  channel.handle(METODO_PEDIR, async (p) => servico.rotear({ userId: String(p?.userId ?? ''), texto: String(p?.texto ?? '').slice(0, 2000), digitado: p?.digitado === true }), { roles: ['bot'], timeoutMs: 120_000 });
  channel.handle(METODO_DECIDIR, async (p) => servico.decidir({ userId: String(p?.userId ?? ''), id: String(p?.id ?? ''), versao: Number(p?.versao), hash: String(p?.hash ?? ''), aprovar: p?.aprovar === true }), { roles: ['bot'] });
  return servico;
}
