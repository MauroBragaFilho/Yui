// GTA no painel (lacunas do painel, entrega D, item 9 v1, 27/11/2026): o que saiu (o último reset diário, o último semanal VÁLIDO e a última notícia do
// Newswire), onde cada um foi publicado e o estado das fontes. A leitura (lerGtaDoBot) não coleta, não publica e não grava nada.
// Item 9 v2 (entrega E, parte 2): republicarGtaNoBot publica de novo o diário, o semanal ou a notícia MAIS RECENTES num servidor, no canal daquele tipo
// configurado nele, pelas MESMAS funções do agendador (src/discord/publisher.js); nada de coletar de novo, chamar a IA nem montar texto aqui.
//
// Mora no lado do bot de propósito: os bancos do GTA (gta-diario, gta-semanal, newswire e core) são do processo do bot (src/database/owners.js) e o estado
// do Reddit (o recuo depois de falhas) vive na memória dele. Com o cérebro separado, o painel pede pelo canal (panel.admin 'gta'); no processo único, a
// ponte do painel (src/discord/painelServidor.js) chama direto. Devolve o dado CRU, no MESMO processo: quem monta a resposta é a vista com lista fechada
// de campos (src/core/api/leiturasDoPainel.js: montarVistaDoGta), então o texto inteiro do semanal, a análise da IA e o resto nunca saem daqui.
import { config } from '../config/index.js';
import { dailyRepository } from '../database/repositories/dailyRepo.js';
import { weeklyRepository } from '../database/repositories/weeklyRepo.js';
import { newsRepository } from '../database/repositories/newsRepo.js';
import { publicationRepository } from '../database/repositories/publicationRepo.js';
import { guildRepository } from '../database/repositories/guildRepo.js';
import { redditGuard } from '../engines/gtao/systems/weekly/redditGuard.js';
import { descreverItem } from '../core/painelConfig.js';

const REPOS = Object.freeze({ daily: dailyRepository, weekly: weeklyRepository, news: newsRepository, publication: publicationRepository, guild: guildRepository });

/**
 * As chaves com que o publicador registra cada publicação (src/discord/publisher.js): o diário pela data; o semanal pela semana (Newswire) ou pelo id do
 * post com o prefixo da fonte (Reddit ou GTABase); a notícia pelo id do artigo.
 */
export function chavesDoSemanal(linha) {
  const id = linha?.data?.id;
  const chaves = [linha?.event_week];
  if (id !== undefined && id !== null && String(id)) chaves.push(`reddit:${id}`, `gtabase:${id}`);
  return chaves.filter((c) => typeof c === 'string' && c);
}

/**
 * O dado cru do GTA para o painel. Cada leitura falha sozinha (vira um item de `erros`, sem derrubar as outras). Tudo injetável para teste.
 * @returns {{ fontes: object, diario: object|null, semanal: object|null, noticia: object|null, publicacoes: object, canais: object, erros: string[] }}
 */
export function lerGtaDoBot({ repos = REPOS, cfg = config, env = process.env, guarda = redditGuard, salvo = descreverItem } = {}) {
  const erros = [];
  const ler = (nome, fn) => {
    try { return fn(); } catch { erros.push(nome); return null; }
  };
  const diario = ler('diario', () => repos.daily.getLatestDaily());
  const semanal = ler('semanal', () => repos.weekly.getLatestValidWeekly());
  const noticia = ler('noticia', () => repos.news.getLatest(1)?.[0] ?? null);
  const guilds = ler('canais', () => repos.guild.getAll()) ?? [];

  // Onde saiu: em cada servidor com o canal do tipo configurado, a publicação registrada (canal e hora). Sem canal, o servidor nem entra na conta.
  const ondeSaiu = (tipo, coluna, chaves) => {
    if (!chaves.length) return [];
    const out = [];
    for (const g of guilds) {
      if (!g?.[coluna]) continue;
      for (const chave of chaves) {
        let p = null;
        try { p = repos.publication.getPublished(tipo, chave, g.guild_id); } catch { p = null; }
        if (p) { out.push({ guildId: g.guild_id, channelId: p.channel_id, em: p.published_at }); break; }
      }
    }
    return out;
  };
  const conta = (coluna) => guilds.filter((g) => g?.[coluna]).length;
  const salvoDe = (chave) => { try { return salvo(chave)?.valor ?? null; } catch { return null; } };
  let espera = { ok: true, retryInMs: 0 };
  try { espera = guarda.canTry(); } catch { /* sem o guarda: segue como ligado */ }

  return {
    fontes: {
      semanal: cfg?.weekly?.enabled === true,
      newswire: cfg?.newswire?.enabled === true,
      reserva: cfg?.weekly?.gtabaseFallback === true,
      intervaloSemanal: cfg?.weekly?.intervalMinutes ?? null,
      intervaloNewswire: cfg?.newswire?.intervalMinutes ?? null,
      redditModo: String(env?.REDDIT_FETCH_MODE ?? 'browser'),
      redditEspera: { ok: espera?.ok !== false, retryInMs: Number(espera?.retryInMs) || 0 },
      redditFalhas: Number(guarda?.failures) || 0,
      salvoSemanal: salvoDe('GTA_WEEKLY_ENABLED'),
      salvoNewswire: salvoDe('NEWSWIRE_ENABLED'),
    },
    diario: diario ? { resetDate: diario.reset_date, criadoEm: diario.created_at, data: diario.data } : null,
    semanal: semanal ? { eventWeek: semanal.event_week, criadoEm: semanal.created_at, data: semanal.data } : null,
    noticia: noticia ? { id: noticia.id, title: noticia.title, url: noticia.url, category: noticia.category, publishedAt: noticia.published_at } : null,
    publicacoes: {
      diario: diario ? ondeSaiu('daily', 'daily_channel_id', [diario.reset_date, diario.data?.date].filter(Boolean)) : [],
      semanal: semanal ? ondeSaiu('weekly', 'weekly_channel_id', chavesDoSemanal(semanal)) : [],
      noticia: noticia ? ondeSaiu('news', 'news_channel_id', [noticia.id].filter(Boolean)) : [],
    },
    canais: { diario: conta('daily_channel_id'), semanal: conta('weekly_channel_id'), noticias: conta('news_channel_id') },
    // Onde dá para republicar (item 9 v2): os servidores com o canal do tipo configurado, e qual é esse canal.
    alvos: { diario: alvosDe(guilds, 'diario'), semanal: alvosDe(guilds, 'semanal'), noticia: alvosDe(guilds, 'noticia') },
    erros,
  };
}

/** A coluna do canal de cada tipo no banco `core` (guild_settings), a mesma que o publicador usa. */
export const COLUNA_DO_TIPO = Object.freeze({ diario: 'daily_channel_id', semanal: 'weekly_channel_id', noticia: 'news_channel_id' });
const alvosDe = (guilds, tipo) => guilds.filter((g) => g?.[COLUNA_DO_TIPO[tipo]]).map((g) => ({ guildId: g.guild_id, channelId: g[COLUNA_DO_TIPO[tipo]] }));

/**
 * A chave com que o publicador registra o semanal: Reddit e GTABase pelo id do post com o prefixo da fonte (publishWeeklyReddit); o resto (o artigo do
 * Newswire) pela semana (publishWeekly). Assim a republicação aparece em "onde saiu" como as outras.
 */
export function chaveDaRepublicacaoDoSemanal(linha) {
  const d = linha?.data ?? {};
  const id = d?.id;
  if ((d?.source === 'reddit' || d?.source === 'gtabase') && id !== undefined && id !== null && String(id)) return `${d.source}:${id}`;
  return typeof linha?.event_week === 'string' && linha.event_week ? linha.event_week : null;
}

/**
 * Republica (item 9 v2) o diário, o semanal ou a notícia MAIS RECENTES num servidor. Só o canal daquele tipo configurado no servidor (o mesmo do agendador):
 * o painel nunca escolhe nem digita um canal. Usa as funções do agendador com `{ guildId, republicar: true }`; o diário e o semanal saem do que já está salvo
 * (o semanal pelo publishWeekly, com a análise da IA já guardada: sem coletar de novo nem chamar a IA), a notícia pelo publishNews.
 * `publicador` e `repos` são injetáveis para teste (o publicador de verdade só é carregado aqui, na hora).
 * @returns {Promise<{ situacao: 'ok'|'sem-canal'|'sem-conteudo'|'e-o-semanal'|'falhou', canalId: string|null }>}
 */
export async function republicarGtaNoBot({ tipo, guildId, client, publicador = null, repos = REPOS } = {}) {
  const coluna = COLUNA_DO_TIPO[tipo];
  if (!coluna) throw new Error('tipo de publicação desconhecido');
  const g = repos.guild.get(String(guildId ?? ''));
  const canalId = g?.[coluna] ? String(g[coluna]) : null;
  if (!canalId) return { situacao: 'sem-canal', canalId: null };
  const pub = publicador ?? (await import('./publisher.js')).discordPublisher;
  const opcoes = { guildId: String(guildId), republicar: true };
  let enviadas = 0;
  if (tipo === 'diario') {
    const linha = repos.daily.getLatestDaily();
    if (!linha?.data) return { situacao: 'sem-conteudo', canalId };
    enviadas = await pub.publishDaily(client, { ...linha.data, date: linha.data.date || linha.reset_date }, opcoes);
  } else if (tipo === 'semanal') {
    const linha = repos.weekly.getLatestValidWeekly();
    const chave = chaveDaRepublicacaoDoSemanal(linha);
    if (!linha?.data || !chave) return { situacao: 'sem-conteudo', canalId };
    enviadas = await pub.publishWeekly(client, linha.data, chave, opcoes);
  } else {
    const n = repos.news.getLatest(1)?.[0] ?? null;
    if (!n?.id) return { situacao: 'sem-conteudo', canalId };
    // O publishNews pula de propósito o artigo que é o próprio evento semanal (ele sai pelo semanal): diz isso em vez de parecer falha do Discord.
    let urlDoSemanal = null;
    try { urlDoSemanal = repos.weekly.getLatestWeekly?.()?.data?.url ?? null; } catch { urlDoSemanal = null; }
    if (urlDoSemanal && n.url === urlDoSemanal) return { situacao: 'e-o-semanal', canalId };
    // o mesmo formato que o motor do Newswire entrega ao publicador (o que newsRepository.insertMany recebe)
    const artigo = { id: n.id, title: n.title, url: n.url, category: n.category, thumbnailUrl: n.thumbnail_url, publishedAt: n.published_at };
    enviadas = await pub.publishNews(client, [artigo], opcoes);
  }
  return { situacao: Number(enviadas) > 0 ? 'ok' : 'falhou', canalId };
}
