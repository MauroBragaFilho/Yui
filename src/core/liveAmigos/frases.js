// AS FRASES da Yui na live dos amigos, etapa 1 (docs/PLANO_TECNICO_LIVE_AMIGOS_ETAPA1.md §4). PURA: só reconhece o texto, não decide nada.
//
// Do dono: autorizar, listar, revogar e recomeçar (arquivo ilegível). De qualquer pessoa: "apagar meus dados da live".
// Os IDs só são aceitos no formato imutável: Discord (17 a 20 dígitos, ou a menção <@id>) e canal do YouTube (UC + 22, ou o link /channel/UC...).
// @handle e link de vídeo são recusados (resolvê-los exigiria chamar o YouTube, o que a etapa 1 não faz).

export const RE_DISCORD_ID = /^\d{17,20}$/;
export const RE_CANAL_ID = /^UC[A-Za-z0-9_-]{22}$/;
export const RE_CODIGO = /^amigo-[a-z2-9]{16}$/;

const limpar = (texto) => String(texto ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const PADROES = [
  ['autorizar', /^autoriz(?:a|ar|e)\s+(?:o\s+|a\s+)?amig[oa]\s+da\s+live\b\s*(.*)$/],
  ['listar', /^(?:lista|listar|liste|mostra|mostrar|mostre)\s+(?:os\s+|as\s+)?amig[oa]s\s+da\s+live$/],
  ['revogar', /^revog(?:a|ar|ue)\s+(?:o\s+|a\s+)?amig[oa]\b(?:\s+da\s+live)?\s*(.*)$/],
  ['recomecar', /^recome[cç](?:a|ar|e)\s+(?:os\s+)?vinculos\s+da\s+live$/],
  ['apagar_meus_dados', /^(?:apag(?:a|ar|ue)|exclu(?:i|ir|a))\s+(?:os\s+)?meus\s+dados\s+da\s+live$/],
];

/** O ID do Discord de um trecho: "123..." ou "<@123...>" / "<@!123...>". */
export function idDoDiscord(trecho) {
  const t = String(trecho ?? '').trim();
  const m = /^<@!?(\d{17,20})>$/.exec(t);
  if (m) return m[1];
  return RE_DISCORD_ID.test(t) ? t : null;
}

/** O ID do canal de um trecho: "UC..." ou o link youtube.com/channel/UC... (com ou sem https/www). Qualquer outro link: null. */
export function idDoCanal(trecho) {
  const t = String(trecho ?? '').trim();
  if (RE_CANAL_ID.test(t)) return t;
  const m = /^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})\/?(?:[?#].*)?$/i.exec(t);
  return m && RE_CANAL_ID.test(m[1]) ? m[1] : null;
}

/**
 * Reconhece uma frase. Devolve null quando o texto não é uma frase da live dos amigos (a conversa segue normal).
 * @returns {null | { acao: string, discordId?: string|null, canalId?: string|null, codigo?: string|null, formatoInvalido?: boolean }}
 */
export function reconhecerFrase(texto) {
  const original = limpar(texto);
  if (!original || original.length > 300) return null;
  const chave = semAcento(original);
  for (const [acao, re] of PADROES) {
    const m = re.exec(chave);
    if (!m) continue;
    // O resto da frase é lido do ORIGINAL (o ID do canal diferencia maiúsculas), na mesma posição.
    const resto = m[1] !== undefined ? original.slice(original.length - m[1].length).trim() : '';
    if (acao === 'autorizar') {
      const p = /^(\S+)\s+(?:(?:no\s+|o\s+)?canal\s+)?(\S+)$/i.exec(resto);
      const discordId = p ? idDoDiscord(p[1]) : null;
      const canalId = p ? idDoCanal(p[2]) : null;
      return { acao, discordId, canalId, formatoInvalido: !discordId || !canalId };
    }
    if (acao === 'revogar') {
      const alvo = resto.split(' ')[0] ?? '';
      const codigo = RE_CODIGO.test(alvo.toLowerCase()) ? alvo.toLowerCase() : null;
      const discordId = codigo ? null : idDoDiscord(alvo);
      return { acao, codigo, discordId, formatoInvalido: !codigo && !discordId };
    }
    return { acao };
  }
  return null;
}
