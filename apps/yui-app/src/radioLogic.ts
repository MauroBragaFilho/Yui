/**
 * Regras da seção "Modo Rádio" do Admin (lacunas do painel, item 10, entrega E parte 2, 27/11/2026): iniciar o rádio sem ninguém na call (escolhendo o
 * canal de voz e o de texto do servidor), pular, tocar um gênero ou uma música (com as opções para escolher quando a busca é ambígua) e ver a fila.
 * Sem React e sem rede (testável em Node). O servidor confere tudo de novo (os canais são do servidor e a Yui pode entrar, falar e escrever; a busca;
 * a escolha só pelo número) e nunca manda o link, a capa nem quem pediu uma faixa.
 */
import type { AdminGuild, RadioCanais, RadioFaixa, RadioResultado, RadioSession } from './api/client.ts';

const dois = (n: number) => String(n).padStart(2, '0');

/** Segundos -> "3:05" ou "1:02:03"; sem duração, ''. */
export function duracao(seg: number | null | undefined): string {
  if (typeof seg !== 'number' || !Number.isFinite(seg) || seg < 0) return '';
  const s = Math.round(seg);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${dois(m)}:${dois(s % 60)}` : `${m}:${dois(s % 60)}`;
}

/** "Título — Artista (3:05)"; sem artista ou sem duração, só o que veio. */
export function rotuloDaFaixa(f: RadioFaixa | null | undefined): string {
  if (!f) return '';
  const d = duracao(f.duration);
  return `${f.title || 'Sem título'}${f.artist ? ` — ${f.artist}` : ''}${d ? ` (${d})` : ''}`;
}

/** A fila em linhas ("1. Título (3:05)") e quantas faixas ficam além das mostradas. Servidor antigo sem `upcoming`: nenhuma linha. */
export function linhasDaFila(s: Pick<RadioSession, 'upcoming' | 'queueLength'>): { linhas: string[]; resto: number } {
  const lista = Array.isArray(s.upcoming) ? s.upcoming : [];
  const linhas = lista.map((t, i) => {
    const d = duracao(t.duration);
    return `${i + 1}. ${t.title || 'Sem título'}${d ? ` (${d})` : ''}`;
  });
  const total = Number.isFinite(s.queueLength) ? s.queueLength : lista.length;
  return { linhas, resto: Math.max(0, total - lista.length) };
}

/** A mesma regra do servidor para a busca (gênero, música ou link): 2 a 200 caracteres, numa linha só. Fora disso, null. */
export function buscaValida(q: string | null | undefined): string | null {
  if (typeof q !== 'string') return null;
  const s = q.trim();
  return s.length >= 2 && s.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(s) ? s : null;
}
export const TEXTO_BUSCA_INVALIDA = 'Diga o gênero, a música ou o link (2 a 200 caracteres, numa linha só).';

/** O que o rádio respondeu, em português (para a linha de aviso da tela). */
export function textoDoResultado(r: RadioResultado | null | undefined): string {
  if (!r) return '';
  if (r.iniciado) return 'Rádio ligado. A Yui espera alguém entrar na call por até 10 minutos.';
  const n = Number(r.adicionadas) || 0;
  switch (r.resultado) {
    case 'tocando':
      return r.faixa ? `Tocando agora: ${rotuloDaFaixa(r.faixa)}.` : `${n} faixa(s) na fila; já começou a tocar.`;
    case 'na-fila':
      return r.faixa ? `Na fila: ${rotuloDaFaixa(r.faixa)}.` : `${n} faixa(s) entraram na fila.`;
    case 'nao-encontrado':
      return 'Não achei nada com essa busca. Tente outro nome ou um link.';
    case 'escolher':
      return `Achei ${Array.isArray(r.opcoes) ? r.opcoes.length : 0} opções: escolha uma (vale por 5 minutos).`;
    case 'fim-da-fila':
      return 'Não há próxima faixa na fila.';
    default:
      return '';
  }
}

/** Pular só faz sentido com algo tocando ou na fila. */
export function podePular(s: Pick<RadioSession, 'current' | 'queueLength'>): boolean {
  return Boolean(s.current) || (Number(s.queueLength) || 0) > 0;
}

/** Os servidores em que dá para iniciar: os que ainda não têm rádio ligado, em ordem de nome. */
export function servidoresParaIniciar(guilds: AdminGuild[] | null | undefined, sessions: RadioSession[] | null | undefined): AdminGuild[] {
  const ativos = new Set((sessions ?? []).map((s) => s.guildId));
  return (guilds ?? []).filter((g) => !ativos.has(g.id)).sort((a, b) => a.name.localeCompare(b.name));
}

const MOTIVO: Record<string, string> = { 'sem-permissao': 'sem permissão', cheio: 'cheio' };

/**
 * Os canais para escolher: os de voz e de texto em que a Yui pode entrar e falar / escrever (com quantas pessoas estão na call) e, à parte, os que não
 * dá para usar e o porquê.
 */
export function canaisParaEscolher(c: RadioCanais | null | undefined): { voz: { id: string; rotulo: string }[]; texto: { id: string; rotulo: string }[]; indisponiveis: string | null } {
  if (!c) return { voz: [], texto: [], indisponiveis: null };
  const voz = c.voz.filter((v) => v.pode).map((v) => ({ id: v.id, rotulo: `${v.nome} · ${v.pessoas ? `${v.pessoas} na call` : 'vazia'}` }));
  const texto = c.texto.filter((t) => t.pode).map((t) => ({ id: t.id, rotulo: `#${t.nome}` }));
  const fora = [
    ...c.voz.filter((v) => !v.pode).map((v) => `${v.nome} (${MOTIVO[v.motivo ?? ''] ?? 'indisponível'})`),
    ...c.texto.filter((t) => !t.pode).map((t) => `#${t.nome} (${MOTIVO[t.motivo ?? ''] ?? 'indisponível'})`),
  ];
  return { voz, texto, indisponiveis: fora.length ? `Não dá para usar: ${fora.join(', ')}.` : null };
}

/** Dá para iniciar com os canais escolhidos? Só com um de voz e um de texto da lista dos que a Yui pode usar. */
export function podeIniciar(c: RadioCanais | null | undefined, vozId: string | null, textoId: string | null): boolean {
  if (!c || !vozId || !textoId) return false;
  return c.voz.some((v) => v.id === vozId && v.pode) && c.texto.some((t) => t.id === textoId && t.pode);
}
