/**
 * Regras da seção "GTA" do Admin (lacunas do painel, item 9 v1; SÓ LEITURA): o que saiu (reset diário, evento semanal, notícia do Newswire), onde saiu e o
 * estado das fontes. O servidor (GET /v1/admin/gta) já manda só um resumo com lista fechada de campos; aqui ele vira texto legível. Sem React e sem rede
 * (testável em Node). Nada é inventado: o que não veio aparece como "—" ou some.
 * Item 9 v2 (entrega E, parte 2): republicar o mais recente de cada tipo num servidor. A tela só oferece os servidores com o canal daquele tipo configurado
 * (`alvos`, que o servidor manda) e sempre confirma antes; o servidor publica no canal configurado (nunca num canal escolhido aqui), 1 vez a cada 10 min.
 */
import type { GtaAlvo, GtaPublicacao, GtaView, TipoDoGta } from './api/client.ts';

export type Tom = 'ok' | 'atencao' | 'neutro' | 'critico';

const dois = (n: number) => String(n).padStart(2, '0');

/** "27/11/2026 às 06:01" (hora local); sem data ou inválida, "—". */
export function dataEHora(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  return `${dois(d.getDate())}/${dois(d.getMonth() + 1)}/${d.getFullYear()} às ${dois(d.getHours())}:${dois(d.getMinutes())}`;
}

/** "2026-11-27" -> "27/11/2026" (é uma data do jogo, sem fuso); outro formato, "—". */
export function dia(v: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}

export interface LinhaDeFonte { chave: string; rotulo: string; texto: string; tom: Tom }

/** O estado de cada fonte em português. O Reddit desligado é "Desligado" (neutro), nunca erro; em espera depois de falhas, atenção com a hora. */
export function linhasDasFontes(f: GtaView['fontes'] | null | undefined): LinhaDeFonte[] {
  if (!f) return [];
  const ligado = (e: string) => e === 'ligado';
  const reinicio = (a: string | null) => (a === 'ligado' ? ' Liga ao reiniciar a Yui.' : a === 'desligado' ? ' Desliga ao reiniciar a Yui.' : '');
  const cada = (min: number | null) => (min ? `, confere a cada ${min} min` : '');
  const reddit = f.reddit?.estado;
  return [
    { chave: 'diario', rotulo: 'Reset diário', texto: `Coleta e publica todo dia às ${f.diario?.horario ?? '06:00 UTC'}.`, tom: 'ok' },
    {
      chave: 'semanal', rotulo: 'Semanal do GTA',
      texto: `${ligado(f.semanal?.estado) ? `Ligado${cada(f.semanal?.intervaloMin ?? null)}.` : 'Desligado: não confere nem publica sozinho (o /gta-semanal continua).'}${reinicio(f.semanal?.aoReiniciar ?? null)}`,
      tom: ligado(f.semanal?.estado) ? 'ok' : 'neutro',
    },
    {
      chave: 'reddit', rotulo: 'Reddit (fonte do semanal)',
      texto: reddit === 'em-espera'
        ? `Em espera depois de ${f.reddit.falhas} falha(s) seguida(s); tenta de novo ${f.reddit.voltaEm ? `em ${dataEHora(f.reddit.voltaEm)}` : 'mais tarde'}.`
        : reddit === 'ligado' ? 'Ligado.' : 'Desligado (o semanal segue pelas outras fontes).',
      tom: reddit === 'em-espera' ? 'atencao' : reddit === 'ligado' ? 'ok' : 'neutro',
    },
    { chave: 'reserva', rotulo: 'GTABase (reserva do semanal)', texto: ligado(f.reserva?.estado) ? 'Ligada: usada quando o Reddit não responde.' : 'Desligada.', tom: ligado(f.reserva?.estado) ? 'ok' : 'neutro' },
    {
      chave: 'newswire', rotulo: 'Notícias da Rockstar (Newswire)',
      texto: `${ligado(f.newswire?.estado) ? `Ligado${cada(f.newswire?.intervaloMin ?? null)}.` : 'Desligado: não publica notícias sozinho (o /gta-noticias continua).'}${reinicio(f.newswire?.aoReiniciar ?? null)}`,
      tom: ligado(f.newswire?.estado) ? 'ok' : 'neutro',
    },
  ];
}

const NOMES_DOS_ERROS: Record<string, string> = { diario: 'o reset diário', semanal: 'o evento semanal', noticia: 'a notícia', canais: 'os canais dos servidores' };
/** Aviso quando algum banco não pôde ser lido (ou null). */
export function avisoDeErros(erros: string[] | null | undefined): string | null {
  const nomes = (Array.isArray(erros) ? erros : []).map((e) => NOMES_DOS_ERROS[e]).filter(Boolean);
  const juntos = nomes.length > 1 ? `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}` : nomes[0];
  return nomes.length ? `Não consegui ler ${juntos} agora. O resto está abaixo.` : null;
}

/** Onde saiu: "Saiu em 2 de 3 servidores com canal: Servidor Um (#gta) em 27/11/2026 às 06:01; ..."; sem canal ou sem publicação, a frase certa. */
export function ondeSaiu(publicado: GtaPublicacao[] | null | undefined, comCanal: number): { resumo: string; linhas: string[] } {
  const lista = Array.isArray(publicado) ? publicado : [];
  const total = Number.isFinite(comCanal) && comCanal > 0 ? Math.floor(comCanal) : 0;
  if (!total && !lista.length) return { resumo: 'Nenhum servidor tem canal para isto.', linhas: [] };
  if (!lista.length) return { resumo: `Ainda não saiu em nenhum dos ${total} servidor(es) com canal.`, linhas: [] };
  const linhas = lista.map((p) => {
    const servidor = p.servidor ?? `servidor ${p.servidorId}`;
    const canal = p.canal ? `#${p.canal}` : p.canalId ? `canal ${p.canalId}` : 'canal desconhecido';
    return `${servidor} (${canal}), ${dataEHora(p.em)}`;
  });
  return { resumo: `Saiu em ${lista.length} de ${Math.max(total, lista.length)} servidor(es) com canal.`, linhas };
}

export interface Bloco { titulo: string; linhas: { rotulo: string; valor: string }[] }

/** O reset diário em linhas: Van de Armas (local e armas com desconto), comerciantes, naufrágio, baús e desafios. */
export function resumoDoDiario(d: GtaView['diario']): Bloco | null {
  if (!d) return null;
  const linhas: { rotulo: string; valor: string }[] = [];
  if (d.vanDeArmas) {
    const armas = d.vanDeArmas.armas.map((a) => (a.desconto ? `${a.nome} (-${a.desconto}%)` : a.nome)).join(', ');
    linhas.push({ rotulo: 'Van de Armas', valor: [d.vanDeArmas.local ?? 'local não informado', armas].filter(Boolean).join(' • ') });
  }
  if (d.comerciantes.length) linhas.push({ rotulo: 'Comerciantes', valor: d.comerciantes.map((c) => (c.produto ? `${c.local} (${c.produto})` : c.local)).join(', ') });
  if (d.naufragio) linhas.push({ rotulo: 'Naufrágio', valor: d.naufragio });
  if (d.baus) linhas.push({ rotulo: 'Baús do tesouro', valor: String(d.baus) });
  if (d.desafios.length) linhas.push({ rotulo: 'Contra o relógio', valor: d.desafios.map((x) => (x.local ? `${x.nome}: ${x.local}` : x.nome)).join(' • ') });
  if (!linhas.length) linhas.push({ rotulo: 'Detalhes', valor: 'O reset foi salvo, mas sem detalhes.' });
  return { titulo: `Reset diário de ${dia(d.data)}`, linhas };
}

const FONTES: Record<string, string> = { reddit: 'Reddit (r/gtaonline)', gtabase: 'GTABase', newswire: 'Notícias da Rockstar (Newswire)', outra: 'outra fonte' };
const multiplicador = (n: number | null) => (n === null ? 'Bônus' : `${String(n).replace('.', ',')}x`);

/** O evento semanal em linhas: período, fonte, bônus ("2x: Corridas, ..."), descontos, pódio e prêmio. */
export function resumoDoSemanal(s: GtaView['semanal']): Bloco | null {
  if (!s) return null;
  const linhas: { rotulo: string; valor: string }[] = [];
  if (s.periodo.inicio || s.periodo.fim) linhas.push({ rotulo: 'Período', valor: `${dia(s.periodo.inicio)} a ${dia(s.periodo.fim)}` });
  linhas.push({ rotulo: 'Fonte', valor: FONTES[s.fonte] ?? FONTES.outra });
  for (const b of s.bonus) linhas.push({ rotulo: multiplicador(b.multiplicador), valor: b.atividades.join(', ') });
  if (s.descontos.length) linhas.push({ rotulo: 'Descontos', valor: s.descontos.join(' • ') });
  if (s.podio) linhas.push({ rotulo: 'Veículo do pódio', valor: s.podio });
  if (s.premio) linhas.push({ rotulo: 'Veículo prêmio', valor: s.premio });
  linhas.push({ rotulo: 'Análise da IA', valor: s.temAnalise ? 'Saiu junto com a publicação' : 'Não foi gerada' });
  return { titulo: s.titulo ?? `Semanal do GTA ${s.semana ?? ''}`.trim(), linhas };
}

/** A notícia em linhas: categoria e data. */
export function resumoDaNoticia(n: GtaView['noticia']): Bloco | null {
  if (!n) return null;
  return { titulo: n.titulo ?? 'Notícia sem título', linhas: [{ rotulo: 'Categoria', valor: n.categoria ?? '—' }, { rotulo: 'Publicada', valor: dataEHora(n.publicadaEm) }] };
}

// ── Republicar (item 9 v2) ──
const O_QUE: Record<TipoDoGta, string> = { diario: 'o reset diário', semanal: 'o evento semanal', noticia: 'a notícia' };
const CANAL_DO_TIPO: Record<TipoDoGta, string> = { diario: 'diário', semanal: 'semanal', noticia: 'de notícias' };

/** "Servidor Um (#gta-diario)"; sem nome, o id. */
export function rotuloDoAlvo(a: GtaAlvo): string {
  return `${a.servidor ?? `servidor ${a.servidorId}`} (${a.canal ? `#${a.canal}` : `canal ${a.canalId}`})`;
}

/** Os servidores em que dá para republicar este tipo (só os com o canal configurado), em ordem de nome. Servidor antigo sem `alvos`: nenhum. */
export function alvosDoTipo(view: GtaView | null | undefined, tipo: TipoDoGta): GtaAlvo[] {
  const lista = view?.alvos?.[tipo];
  return Array.isArray(lista) ? [...lista].sort((x, y) => rotuloDoAlvo(x).localeCompare(rotuloDoAlvo(y))) : [];
}

/** Quando não dá para republicar, o motivo (ou null quando dá). */
export function semRepublicar(view: GtaView | null | undefined, tipo: TipoDoGta): string | null {
  const temConteudo = tipo === 'diario' ? Boolean(view?.diario) : tipo === 'semanal' ? Boolean(view?.semanal) : Boolean(view?.noticia);
  if (!temConteudo) return null; // o card já diz que não há nada salvo
  return alvosDoTipo(view, tipo).length ? null : `Nenhum servidor tem canal ${CANAL_DO_TIPO[tipo]} configurado (escolha em Servidores).`;
}

/** O texto da confirmação: o que sai, onde e que é uma mensagem nova no canal. */
export function confirmacaoDaRepublicacao(tipo: TipoDoGta, alvo: GtaAlvo): { titulo: string; mensagem: string } {
  return {
    titulo: 'Republicar no Discord?',
    mensagem: `Publica de novo ${O_QUE[tipo]} mais recente em ${rotuloDoAlvo(alvo)}. É uma mensagem nova no canal configurado; dá para repetir só depois de 10 minutos.`,
  };
}

/** A frase depois que saiu. */
export function textoDaRepublicacao(tipo: TipoDoGta, alvo: GtaAlvo): string {
  const t = O_QUE[tipo];
  return `${t.charAt(0).toUpperCase()}${t.slice(1)} saiu de novo em ${rotuloDoAlvo(alvo)}.`;
}

export const TEXTO_SEM_DIARIO = 'Nenhum reset diário salvo ainda (a coleta é às 06:00 UTC).';
export const TEXTO_SEM_SEMANAL = 'Nenhum evento semanal válido salvo ainda.';
export const TEXTO_SEM_NOTICIA = 'Nenhuma notícia do Newswire salva ainda.';
