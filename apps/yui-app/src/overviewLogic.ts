/**
 * Regras da tela "Visão Geral", sem React e sem rede (testáveis em Node): saudação, tempo ligada, nível de RAM/disco,
 * texto de "há quanto tempo" e como cada evento do registro de auditoria aparece para o dono.
 * Nada aqui inventa número: o que a API não trouxe vira null e a tela mostra "—".
 */

export type Level = 'ok' | 'warn' | 'danger' | 'unknown';

/** "Bom dia" (5h às 11h59), "Boa tarde" (12h às 17h59) e "Boa noite" (o resto). */
export function greetingFor(hour: number): string {
  if (!Number.isFinite(hour)) return 'Olá';
  if (hour >= 5 && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

/** 93784 s -> "1d 2h"; 5400 -> "1h 30min"; 90 -> "1min"; inválido -> "—". */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}min` : `${m}min`;
}

/** Percentual inteiro de `part` em `total`; null se não der para calcular. */
export function percent(part: number | null | undefined, total: number | null | undefined): number | null {
  if (part === null || part === undefined || total === null || total === undefined) return null;
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((part / total) * 100)));
}

/** Quanto MENOS livre, pior: abaixo de 15% livre é atenção, abaixo de 8% é crítico. */
export function levelForFree(freePercent: number | null): Level {
  if (freePercent === null) return 'unknown';
  if (freePercent < 8) return 'danger';
  if (freePercent < 15) return 'warn';
  return 'ok';
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "agora", "há 5 min", "há 3 h", "há 2 d"; sem data legível, "—". */
export function relativeTime(ts: string | null | undefined, now: number = Date.now()): string {
  if (!ts) return '—';
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return '—';
  const diff = Math.max(0, now - t);
  if (diff < MIN) return 'agora';
  if (diff < HOUR) return `há ${Math.floor(diff / MIN)} min`;
  if (diff < DAY) return `há ${Math.floor(diff / HOUR)} h`;
  return `há ${Math.floor(diff / DAY)} d`;
}

export interface EventView { label: string; icon: string; tone: 'normal' | 'good' | 'bad' }

const EXACT: Record<string, EventView> = {
  'api.chat': { label: 'Conversa pelo app', icon: 'chat_bubble', tone: 'normal' },
  'memory.write': { label: 'Memória atualizada', icon: 'psychology', tone: 'normal' },
  'memory.read': { label: 'Memória consultada', icon: 'psychology', tone: 'normal' },
  'memory.forget': { label: 'Lembrança apagada', icon: 'delete', tone: 'normal' },
  'memory.forgetAll': { label: 'Memória apagada', icon: 'delete', tone: 'normal' },
  'context.forgetAll': { label: 'Contexto das conversas apagado', icon: 'delete', tone: 'normal' },
  'agent.tool.ok': { label: 'Ferramenta executada', icon: 'build', tone: 'good' },
  'agent.tool.error': { label: 'Ferramenta com erro', icon: 'warning', tone: 'bad' },
  'agent.tool.denied': { label: 'Ferramenta negada', icon: 'lock', tone: 'bad' },
  'agent.tool.pending': { label: 'Ferramenta aguardando aprovação', icon: 'schedule', tone: 'normal' },
  'agent.tool.cancelled': { label: 'Ferramenta cancelada', icon: 'cancel', tone: 'normal' },
  'agent.tool.badargs': { label: 'Ferramenta com argumentos inválidos', icon: 'warning', tone: 'bad' },
  'agent.skill': { label: 'Habilidade usada', icon: 'bolt', tone: 'normal' },
  'auth.login.ok': { label: 'Login no painel', icon: 'lock', tone: 'good' },
  'auth.login.fail': { label: 'Tentativa de login recusada', icon: 'lock', tone: 'bad' },
  'auth.logout': { label: 'Saída do painel', icon: 'logout', tone: 'normal' },
  'alert.sent': { label: 'Alerta enviado ao dono', icon: 'notifications', tone: 'normal' },
  'alert.fail': { label: 'Falha ao enviar alerta', icon: 'warning', tone: 'bad' },
  'admin.restart': { label: 'Yui reiniciada pelo painel', icon: 'refresh', tone: 'normal' },
  'admin.follow.youtube.liveMode': { label: 'Modo das lives alterado', icon: 'tune', tone: 'normal' },
  'admin.follow.youtube.add': { label: 'Canal do YouTube adicionado', icon: 'hub', tone: 'normal' },
  'admin.follow.youtube.remove': { label: 'Canal do YouTube removido', icon: 'hub', tone: 'normal' },
  'admin.follow.twitch.add': { label: 'Streamer da Twitch adicionado', icon: 'hub', tone: 'normal' },
  'admin.follow.twitch.remove': { label: 'Streamer da Twitch removido', icon: 'hub', tone: 'normal' },
  'admin.ban.add': { label: 'Bloqueio aplicado', icon: 'lock', tone: 'normal' },
  'admin.ban.remove': { label: 'Bloqueio removido', icon: 'lock', tone: 'normal' },
};

const PREFIX: [string, EventView][] = [
  ['auth.discord', { label: 'Entrada pelo Discord', icon: 'lock', tone: 'normal' }],
  ['memory.admin', { label: 'Administração de memória', icon: 'psychology', tone: 'normal' }],
  ['dev.', { label: 'Módulo de código', icon: 'code', tone: 'normal' }],
  ['admin.', { label: 'Ajuste feito no painel', icon: 'tune', tone: 'normal' }],
];

/** Como um evento da auditoria aparece na lista: texto simples, ícone e tom. Evento desconhecido mostra o próprio nome. */
export function describeEvent(event: string): EventView {
  const key = String(event ?? '');
  if (EXACT[key]) return EXACT[key];
  for (const [prefix, view] of PREFIX) if (key.startsWith(prefix)) return view;
  return { label: key || 'Evento', icon: 'history', tone: 'normal' };
}

export interface GroupedEvent extends EventView { ts: string | null; count: number }

/** Junta eventos iguais seguidos ("Módulo de código" ×5) e mantém a hora do mais recente. Entrada: do mais novo para o mais antigo. */
export function groupEvents(events: { ts: string | null; event: string }[]): GroupedEvent[] {
  const out: GroupedEvent[] = [];
  for (const e of events) {
    const view = describeEvent(e.event);
    const last = out[out.length - 1];
    if (last && last.label === view.label) last.count += 1;
    else out.push({ ...view, ts: e.ts, count: 1 });
  }
  return out;
}

export interface SummaryInput { discordOnline: boolean; aiOk: boolean | null; hostLevel: Level }

/** Frase do cartão de saudação: diz a verdade sobre o estado, sem prometer "tudo certo" quando não está. */
export function systemSummary({ discordOnline, aiOk, hostLevel }: SummaryInput): { text: string; ok: boolean } {
  const problems: string[] = [];
  if (!discordOnline) problems.push('o Discord está desconectado');
  if (aiOk === false) problems.push('nenhum provedor de IA está disponível');
  if (hostLevel === 'danger') problems.push('o computador está com pouca memória ou disco');
  if (problems.length === 0) {
    const watch = hostLevel === 'warn' ? ' O computador está apertado em memória ou disco; vale ficar de olho.' : '';
    return { ok: true, text: `Estou funcionando normalmente. Todos os sistemas principais estão operacionais.${watch}` };
  }
  const joined = problems.length === 1 ? problems[0] : `${problems.slice(0, -1).join(', ')} e ${problems[problems.length - 1]}`;
  return { ok: false, text: `Preciso de atenção: ${joined}.` };
}
