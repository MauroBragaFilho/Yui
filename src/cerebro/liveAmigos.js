// A live dos amigos no cérebro (etapa 1): o serviço mora aqui; o bot encaminha a frase e o clique pelo canal e devolve só a saída.
// Os métodos só atendem a conexão autenticada do papel bot (o canal confere o segredo e o papel no aperto de mão).
// O serviço sobe SEMPRE (mesmo com YUI_LIVE_AMIGOS desligado): listar, revogar e "apagar meus dados" nunca param. Sem nenhum vínculo, não há arquivo.
import { criarServicoLiveAmigos } from '../core/liveAmigos/servico.js';
import { definirServicoLiveAmigos } from '../core/liveAmigos/porta.js';
import { isOwnerId } from '../core/permissions.js';
import { ownerUserId } from '../core/api/auth.js';

export const RETOMADA_MS = 10 * 60_000;
export const LIMPEZAS_MS = 60_000;

/**
 * @param {{ channel: object, logger?: object, env?: object, opcoes?: object, agendar?: boolean }} o
 */
export function registrarLiveAmigos({ channel, logger = console, env = process.env, opcoes = {}, agendar = true }) {
  const ehDono = (id) => isOwnerId(id) || (Boolean(ownerUserId(env)) && String(id) === String(ownerUserId(env)));
  const servico = criarServicoLiveAmigos({
    env, logger, ehDono,
    avisar: async ({ userId, dono, texto, chave }) => {
      if (!channel.isConnected('bot')) return false;
      const r = await channel.request('bot', 'liveamigos.avisar', { userId, dono, texto, chave }, { idem: chave || undefined, timeoutMs: 30_000 });
      return r?.enviado === true;
    },
    limparDm: async (p) => {
      if (!channel.isConnected('bot')) return { feito: false, motivo: 'bot-desligado' };
      return channel.request('bot', 'liveamigos.limparDm', p, { timeoutMs: 30_000 });
    },
    ...opcoes,
  });
  channel.handle('liveamigos.comando', async (p) => servico.comando({ userId: String(p?.userId ?? ''), texto: String(p?.texto ?? '').slice(0, 400) }), { roles: ['bot'], timeoutMs: 25_000 });
  channel.handle('liveamigos.botao', async (p) => servico.botao({ userId: String(p?.userId ?? ''), customId: String(p?.customId ?? '').slice(0, 100) }), { roles: ['bot'], timeoutMs: 25_000 });
  channel.handle('liveamigos.mensagem', async (p) => servico.mensagemEnviada({
    ref: String(p?.ref ?? '').slice(0, 40), messageId: String(p?.messageId ?? '').slice(0, 25), channelId: String(p?.channelId ?? '').slice(0, 25),
    limpeza: p?.limpeza && typeof p.limpeza === 'object' ? { acao: p.limpeza.acao, emMs: Number(p.limpeza.emMs), texto: typeof p.limpeza.texto === 'string' ? p.limpeza.texto.slice(0, 200) : null } : null,
  }), { roles: ['bot'] });
  definirServicoLiveAmigos(servico);
  const timers = [];
  if (agendar) {
    const rodar = (nome, fn) => fn().catch((err) => logger.warn?.(`[LiveAmigos] ${nome} falhou (${String(err?.code ?? 'erro').slice(0, 40)})`));
    rodar('retomada', servico.retomar);
    timers.push(setInterval(() => rodar('retomada', servico.retomar), RETOMADA_MS));
    timers.push(setInterval(() => rodar('limpezas', servico.rodarLimpezas), LIMPEZAS_MS));
    for (const t of timers) t.unref?.();
  }
  return { servico, parar: () => { for (const t of timers) clearInterval(t); definirServicoLiveAmigos(null); } };
}
