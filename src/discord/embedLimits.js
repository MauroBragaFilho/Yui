/**
 * Limites do Discord e um único ponto para cortar texto e montar embeds/menus sem estourar.
 *
 * Por que existe: os SETTERS do EmbedBuilder (setTitle, setDescription, addFields, setFooter,
 * setAuthor, setURL...) LANÇAM CombinedError na hora, e lançam também para string vazia.
 * O construtor com objeto (new EmbedBuilder(dados)), EmbedBuilder.from() e toJSON() NÃO validam:
 * quem recusa é a API do Discord (400 / 50035) no envio. Por isso o corte precisa acontecer
 * ANTES de montar: makeEmbed() corta tudo e só então constrói pelo construtor com objeto.
 *
 * Contagem: o Discord conta em unidades UTF-16 (o mesmo que String.length do JavaScript),
 * que é o lado seguro. O teto de 6000 caracteres vale por MENSAGEM, somando todos os embeds
 * (title + description + footer.text + author.name + todos os name/value dos campos):
 * use fitEmbeds() quando houver mais de um embed na mesma mensagem.
 *
 * Módulo puro: não abre banco, não cria pastas, não inicia timers e não usa rede.
 */
import { EmbedBuilder, resolveColor } from 'discord.js';

export const LIMITS = Object.freeze({
  content: 2000, title: 256, description: 4096, fieldName: 256, fieldValue: 1024, fields: 25,
  footer: 2048, author: 256, embedTotal: 6000, embedsPerMessage: 10,
  buttonLabel: 80, optionLabel: 100, optionDescription: 100, optionValue: 100, selectOptions: 25,
  placeholder: 150, customId: 100, buttonsPerRow: 5, rowsPerMessage: 5, modalTitle: 45, inputLabel: 45, inputValue: 4000,
});

const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('pt-BR', { granularity: 'grapheme' })
  : null;

const isHighSurrogate = (ch) => ch >= 0xD800 && ch <= 0xDBFF;

/**
 * Corta em no máximo `max` unidades UTF-16 (a conta do Discord), sem partir emoji, ZWJ nem
 * bandeira, e acrescenta "…". Prefere terminar em espaço ou quebra (nos últimos 20%).
 * Texto que já cabe volta idêntico. Nunca lança.
 */
export function clampText(value, max, { ellipsis = '…' } = {}) {
  const s = String(value ?? '');
  const limit = Math.floor(Number(max));
  if (!(limit > 0)) return '';
  if (s.length <= limit) return s;
  if (limit <= ellipsis.length) return s.slice(0, limit);
  const budget = limit - ellipsis.length;
  let cut = budget;
  if (segmenter) {
    let last = 0;
    // 32 unidades de folga bastam para achar o início do próximo grafema; o índice de cada início é exato.
    for (const { index } of segmenter.segment(s.slice(0, budget + 32))) {
      if (index > budget) break;
      last = index;
    }
    cut = last || budget;
  }
  // Rede de segurança (sem Intl.Segmenter, ou cluster maior que o orçamento): nunca deixar meio par substituto.
  if (cut > 0 && isHighSurrogate(s.charCodeAt(cut - 1))) cut -= 1;
  const floor = Math.floor(cut * 0.8);
  for (let i = cut - 1; i > floor; i--) {
    if (/\s/.test(s[i])) { cut = i; break; }
  }
  return s.slice(0, cut).trimEnd() + ellipsis;
}

const filled = (s) => String(s ?? '').trim().length > 0;

/** URL http(s) bem formada, sem espaços e com até 2048 caracteres (a API recusa o resto). */
export function isHttpUrl(u) {
  if (typeof u !== 'string' || u.length > 2048 || !/^https?:\/\/\S+$/i.test(u)) return false;
  try { const p = new URL(u).protocol; return p === 'http:' || p === 'https:'; } catch { return false; }
}

/** Referência a arquivo anexado na mesma mensagem (attachment://nome.png), válida em imagem, miniatura e ícones. */
export function isAttachmentUrl(u) {
  return typeof u === 'string' && u.length <= 300 && /^attachment:\/\/[^\s/\\?#]+$/i.test(u);
}

const isMediaUrl = (u) => isHttpUrl(u) || isAttachmentUrl(u);

/** Soma que o Discord confere no teto de 6000: title + description + footer.text + author.name + campos. */
export function embedLength(embed) {
  const d = embed && typeof embed.toJSON === 'function' ? embed.toJSON() : (embed ?? {});
  let n = (d.title?.length ?? 0) + (d.description?.length ?? 0) + (d.footer?.text?.length ?? 0) + (d.author?.name?.length ?? 0);
  for (const f of d.fields ?? []) n += (f.name?.length ?? 0) + (f.value?.length ?? 0);
  return n;
}

const pick = (v, key) => (v && typeof v === 'object' ? v[key] : v);
const urlOf = (v) => (typeof v === 'string' ? v : v?.url);

/**
 * Monta um EmbedBuilder já dentro dos limites. Entradas ausentes ou vazias são omitidas
 * (a API recusa campo vazio); URL inválida é descartada em vez de derrubar o envio.
 *
 * Entradas aceitas:
 *  - title, description: texto.
 *  - url: link do título (somente http/https).
 *  - color: número, '#RRGGBB' ou nome do discord.js; valor inválido é omitido.
 *  - timestamp: Date, número, texto de data ou true (agora); inválido é omitido.
 *  - footer: texto ou { text, iconURL }. author: texto ou { name, iconURL, url }.
 *  - thumbnail, image: URL http(s), attachment://arquivo, ou { url }.
 *  - fields: [{ name, value, inline }] (campos com nome ou valor vazio são descartados).
 *
 * `total`: teto de caracteres deste embed (6000 vale por MENSAGEM, somando todos os embeds:
 * para vários embeds use fitEmbeds). Estourando, primeiro encolhe a descrição e depois descarta
 * campos do fim; título, rodapé e autor nunca passam de 256 + 2048 + 256.
 */
export function makeEmbed(input = {}, { total = LIMITS.embedTotal } = {}) {
  const { title, description, url, color, timestamp, footer, author, thumbnail, image } = input ?? {};
  const fields = Array.isArray(input?.fields) ? input.fields : [];
  const d = {};
  if (filled(title)) d.title = clampText(String(title).trim(), LIMITS.title);
  if (filled(description)) d.description = clampText(description, LIMITS.description);
  if (isHttpUrl(url)) d.url = url;
  if (color !== undefined && color !== null) {
    try { d.color = resolveColor(color); } catch { /* cor inválida: sem cor */ }
  }
  const when = timestamp === true ? new Date() : (timestamp ? new Date(timestamp) : null);
  if (when && Number.isFinite(when.getTime())) d.timestamp = when.toISOString(); // data inválida lança RangeError
  const footerText = pick(footer, 'text');
  if (filled(footerText)) {
    d.footer = { text: clampText(footerText, LIMITS.footer) };
    const icon = footer && typeof footer === 'object' ? footer.iconURL : null;
    if (isMediaUrl(icon)) d.footer.icon_url = icon;
  }
  const authorName = pick(author, 'name');
  if (filled(authorName)) {
    d.author = { name: clampText(authorName, LIMITS.author) };
    if (author && typeof author === 'object') {
      if (isMediaUrl(author.iconURL)) d.author.icon_url = author.iconURL;
      if (isHttpUrl(author.url)) d.author.url = author.url;
    }
  }
  const thumbUrl = urlOf(thumbnail);
  if (isMediaUrl(thumbUrl)) d.thumbnail = { url: thumbUrl };
  const imageUrl = urlOf(image);
  if (isMediaUrl(imageUrl)) d.image = { url: imageUrl };
  d.fields = fields
    .filter((f) => f && filled(f.name) && filled(f.value))
    .slice(0, LIMITS.fields)
    .map((f) => ({ name: clampText(f.name, LIMITS.fieldName), value: clampText(f.value, LIMITS.fieldValue), inline: Boolean(f.inline) }));
  // Soma: primeiro encolhe a descrição, depois descarta campos do fim.
  while (embedLength(d) > total && d.fields.length) {
    const over = embedLength(d) - total;
    if (d.description && d.description.length > over + 1) { d.description = clampText(d.description, d.description.length - over); break; }
    d.fields.pop();
  }
  if (embedLength(d) > total && d.description) d.description = clampText(d.description, Math.max(1, d.description.length - (embedLength(d) - total)));
  if (!d.fields.length) delete d.fields;
  return new EmbedBuilder(d);
}

/** Vários embeds numa mensagem: no máximo 10 e 6000 caracteres SOMADOS (regra da API por mensagem). */
export function fitEmbeds(embeds, { max = LIMITS.embedsPerMessage, total = LIMITS.embedTotal } = {}) {
  const out = [];
  let used = 0;
  for (const e of (Array.isArray(embeds) ? embeds : []).slice(0, max)) {
    const size = embedLength(e);
    if (used + size > total) break;
    out.push(e);
    used += size;
  }
  return out;
}

/**
 * Opções de menu de seleção: no máximo 25 (ou `max`), rótulo/descrição/valor cortados em 100,
 * valores únicos, sem vazios.
 */
export function clampOptions(options, { max = LIMITS.selectOptions } = {}) {
  const seen = new Set();
  const out = [];
  const cap = Math.min(Math.max(1, Math.floor(Number(max)) || LIMITS.selectOptions), LIMITS.selectOptions);
  for (const o of (Array.isArray(options) ? options : [])) {
    if (!o) continue;
    const value = clampText(o.value, LIMITS.optionValue, { ellipsis: '' });
    if (!filled(o.label) || !filled(value) || seen.has(value)) continue;
    seen.add(value);
    const item = { label: clampText(o.label, LIMITS.optionLabel), value };
    if (filled(o.description)) item.description = clampText(o.description, LIMITS.optionDescription);
    if (o.emoji) item.emoji = o.emoji;
    if (o.default) item.default = true;
    out.push(item);
    if (out.length === cap) break;
  }
  return out;
}

/** Texto de mensagem (content) simples; para respostas longas da IA o divisor de longReply.js continua sendo o caminho. */
export const clampContent = (text) => clampText(text, LIMITS.content);

/** Linhas de uma lista em blocos que cabem em campos de 1024 (sem cortar uma linha no meio). */
export function chunkLines(lines, max = 1000) {
  const chunks = [];
  let cur = '';
  for (const raw of (Array.isArray(lines) ? lines : [])) {
    const line = clampText(raw, max);
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length > max && cur) { chunks.push(cur); cur = line; } else cur = next;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
