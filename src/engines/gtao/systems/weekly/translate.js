import { logger } from '../../../../utils/logger.js';

/**
 * Tradução PT-BR para o conteúdo semanal do r/gtaonline.
 *
 * Traduz frases/expressões comuns em inglês presentes no embed enxuto
 * (atividades de bônus, descrições, rótulos, descontos...), **mantendo
 * nomes de veículos e prédios intactos** (padrão da comunidade BR).
 */

// ── Glossário de frases/expressões ──────────────────────────────────────
// Ordem importa: as mais específicas primeiro (para não perder precisão).
// Nomes de veículos e prédios NÃO entram aqui — eles são preservados.
const PHRASE_TRANSLATIONS = [
  // ══ Sentenças longas / desafios (devem vir ANTES das regras genéricas) ══
  [/\bearn\s+(gta\$\s*[\d.,]+)\s+from\s+selling\s+special\s+cargo\b/gi, (m, p1) => `Ganhe ${p1} vendendo Carga Especial`],
  [/\bcomplete\s+(?:at least\s+)?one\s+weekly\s+challenge\b/gi, () => 'Complete pelo menos um Desafio Semanal'],
  [/\bto\s+get\s+the\b/gi, () => 'para obter o'],
  [/\band\s+a\s+(\d+X)\s+reward\s+of\s+(gta\$\s*[\d.,]+)\b/gi, (m, p1, p2) => `e uma recompensa ${p1} de ${p2}`],
  [/\bget started down the executive path\b/gi, () => 'Comece o caminho Executivo'],
  [/\bby\s+claiming\s+the\b/gi, () => 'ao reivindicar o'],
  [/\band\s+arm\s+your\s+new\s+organization\s+with\s+some\s+muscle\s+while\s+you\b/gi, () => 'e arme sua nova Organização com mais reforço enquanto você'],
  [/\bby\s+recruit(?:ing)?\s+associates\b/gi, () => 'recrutando Associados'],
  [/\brecruit(?:ing)?\s+associates\b/gi, () => 'recrutar Associados'],
  [/\bsource and sell\b/gi, () => 'buscar e vender mercadorias'],
  [/\bthis\s+month\s+to\s+earn\s+a\s+whopping\s+10X\s+prize\b/gi, () => 'este mês para ganhar um prêmio 10X'],
  [/\bplus\s+rare,\s+branded\s+in-game\s+gear,\s+and\b/gi, () => 'além de itens exclusivos e raros, e'],
  [/\bwhen\s+you\s+play\s+between\b/gi, () => 'ao jogar entre'],
  [/\bclaim\s+(?:a|an)\b/gi, () => 'receba um'],

  // ══ Descontos / percentuais ══
  [/^(\d{1,3})%\s*off$/gi, (m, p1) => `${p1}% de desconto`],
  [/^free$/gi, () => 'Grátis'],
  [/\b(\d{1,3})%\s*off\b/gi, (m, p1) => `${p1}% de desconto`],
  [/\bfor\s+free\b/gi, () => 'de graça'],
  [/\bfree\s+(.+?)(?=[,.\n]|$)/gi, (m, p1) => `${p1} de graça`],
  [/\bfree\b/gi, () => 'Grátis'],
  [/\bfor\s+gta\+\s+members\b/gi, () => 'para Membros GTA+'],
  [/\bgta\+\s+members\b/gi, () => 'Membros GTA+'],
  [/\bdouble\s+(?:gta\$\s*(?:&|and)\s*rp|xp)\b/gi, () => 'GTA$ & RP em dobro'],
  [/\btriple\s+(?:gta\$\s*(?:&|and)\s*rp|xp)\b/gi, () => 'GTA$ & RP em triplo'],

  // ══ Atividades / modos recorrentes ══
  [/\bcommunity\s+mission\s*ser(?:ies|ie)\b/gi, () => 'Série de Missões da Comunidade'],
  [/\bcommunity\s+series\b/gi, () => 'Série da Comunidade'],
  [/\brandom\s+transform\s+races?\b/gi, () => 'Corridas de Transformação Aleatórias'],
  [/\btransform\s+races?\b/gi, () => 'Corridas de Transformação'],
  [/\bdrift\s+races?\b/gi, () => 'Corridas de Drift'],
  [/\bgang\s+termination\s+contracts?\b/gi, () => 'Contratos de Extermínio de Gangues'],
  [/\bterm(?:ination)?\s+contracts?\b/gi, () => 'Contratos de Extermínio'],
  [/\bagency\s+contract\b/gi, () => 'Contrato de Agência'],
  [/\bthe\s+lost\s+contract\b/gi, () => 'Contrato da Lost'],
  [/\bexport\s+mixed\s+goods\s+missions?\b/gi, () => 'Missões de Exportação de Mercadorias Mistas'],
  [/\bmixed\s+goods\b/gi, () => 'Mercadorias Mistas'],
  [/\bmadrazo\s+hits\b/gi, () => 'Contratos de Madrazo'],
  [/\bdiamond\s+adversary\s+ser(?:ies|ie)\b/gi, () => 'Série Adversária Diamond'],
  [/\bstaff\s+sourcing\s+special\s+cargo\b/gi, () => 'Compra de Carga Especial (Equipe)'],
  [/\bsourcing\s+special\s+cargo\b/gi, () => 'Compra de Carga Especial'],
  [/\bspecial\s+vehicle\s+work\b/gi, () => 'Trabalhos de Veículos Especiais'],
  [/\bsalvage\s+yard\s+robberies?\b/gi, () => 'Roubos no Ferro-Velho'],
  [/\bmost\s+wanted\b/gi, () => 'Procurados'],
  [/\bfib\s+priority\s+file\b/gi, () => 'Arquivo Prioritário FIB'],
  [/\bheist\s+primary\s+targets\b/gi, () => 'Alvos Principais do Assalto'],
  [/\bheists?\b/gi, () => 'Assaltos'],
  [/\bhsw\s+time\s+trial\b/gi, () => 'Desafio Contra o Relógio HSW'],
  [/\btime\s+trial\b/gi, () => 'Desafio Contra o Relógio'],
  [/\bpremium\s+race\b/gi, () => 'Corrida Premium'],
  [/\bpremium\s+test\s+ride\b/gi, () => 'Teste de Condução Premium'],
  [/\btest\s+ride\b/gi, () => 'Teste de Condução'],
  [/\bprize\s+ride\s+challenge\b/gi, () => 'Desafio do Carro Premiado'],
  [/\bprize\s+ride\s+vehicle\b/gi, () => 'Carro Premiado'],
  [/\bprize\s+ride\b/gi, () => 'Carro Premiado'],
  [/\bpodium\s+vehicle\b/gi, () => 'Veículo do Pódio'],
  [/\bpodium\b/gi, () => 'Pódio'],
  [/\bgun\s+van\b/gi, () => 'Van de Armas'],
  [/\bspecial\s+cargo\b/gi, () => 'Carga Especial'],
  [/\bweekly\s+challenges?\b/gi, () => 'Desafios Semanais'],
  [/\bthis\s+week'?s?\s+challenge\b/gi, () => 'Desafio da Semana'],
  [/\breward\b/gi, () => 'Recompensa'],

  // ══ Datas (meses) — aparecem em frases de contexto ══
  [/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\s*[-–—]\s*(\d{1,2})(?:st|nd|rd|th)?\b/gi, (m, p1, p2, p3) => {
    const pt = MONTHS_PT[p1.toLowerCase()];
    return pt ? `${p2} a ${p3} de ${pt}` : m;
  }],
  [/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi, (m, p1, p2) => {
    const pt = MONTHS_PT[p1.toLowerCase()];
    return pt ? `${p2} de ${pt}` : m;
  }],

  // ══ Armas (Van de Armas) ══
  [/\bprecision rifle\b/gi, () => 'Rifle de Precisão'],
  [/\bsniper rifle\b/gi, () => 'Rifle de Atirador'],
  [/\bstun gun\b/gi, () => 'Pistola de Choque'],
  [/\brailgun\b/gi, () => 'Railgun'],
  [/\bgrenade launcher\b/gi, () => 'Lançador de Granadas'],
  [/\bflare gun\b/gi, () => 'Pistola Sinalizadora'],
  [/\bflashlight\b/gi, () => 'Lanterna'],
  [/\bcombat mg\b/gi, () => 'Metralhadora de Combate'],
  [/\bpump shotgun\b/gi, () => 'Escopeta de Bombeamento'],
  [/\bassault shotgun\b/gi, () => 'Escopeta de Assalto'],
  [/\bsmg\b/gi, () => 'Submetralhadora'],
  [/\bassault rifle\b/gi, () => 'Fuzil de Assalto'],
  [/\btear gas\b/gi, () => 'Gás Lacrimogêneo'],
  [/\bsticky bombs?\b/gi, () => 'Bombas Grudentas'],
  [/\bmolotovs?\b/gi, () => 'Coquetéis Molotov'],
  [/\bknife\b/gi, () => 'Faca'],
];
// ── Meses (usado na tradução do título) ──
const MONTHS_PT = {
  january: 'janeiro', february: 'fevereiro', march: 'março', april: 'abril',
  may: 'maio', june: 'junho', july: 'julho', august: 'agosto',
  september: 'setembro', october: 'outubro', november: 'novembro', december: 'dezembro',
};
// ── Função principal ────────────────────────────────────────────────────

/**
 * Traduz um texto (atividade de bônus, descrição, desconto, rótulo) para PT-BR,
 * mantendo nomes de veículos/prédios intactos.
 * @param {string} text
 * @returns {string}
 */
export function translateText(text) {
  if (!text || typeof text !== 'string') return text;

  let out = text;
  for (const [re, repl] of PHRASE_TRANSLATIONS) {
    out = out.replace(re, (match, ...args) =>
      typeof repl === 'function' ? repl(match, ...args) : repl
    );
  }

  if (out !== text) {
    logger.debug(`[Weekly][Translate] "${text}" → "${out}"`);
  }
  return out;
}

/**
 * Traduz uma lista de itens (atividades, descontos, armas...).
 */
export function translateItems(items) {
  if (!Array.isArray(items)) return items;
  return items.map((it) => translateText(it));
}

/**
 * Traduz um desconto no formato "Vehicle - X% Off" (mantendo o nome do
 * veículo e traduzindo apenas o percentual).
 * @param {string} discount — ex: "Karin 190z - 30% Off"
 */
export function translateDiscount(discount) {
  if (!discount || typeof discount !== 'string') return discount;

  const m = discount.match(/^(.+)\s*[-–—]\s*(.+)$/);
  if (m) {
    const name = m[1].trim();
    const pct = m[2].trim();
    return `${name} — ${translateText(pct)}`;
  }
  return translateText(discount);
}

/**
 * Traduz um item de Gun Van, ex: "Precision Rifle (50% off)" → "Rifle de
 * Precisão (50% de desconto)".
 */
export function translateGunVanItem(item) {
  if (!item || typeof item !== 'string') return item;

  const m = item.match(/^(.+?)\s*\((-?\d{1,3}%\s+off[^)]*)\)$/i);
  if (m) {
    const name = m[1].trim();
    const pct = m[2].trim();
    return `${translateText(name)} (${translateText(pct)})`;
  }
  return translateText(item);
}

/**
 * Traduz o título do post semanal. Padrões típicos:
 *   "Weekly Bonuses and Discounts - September 3rd to September 10th"
 *   "Weekly Bonuses, Discounts and Events - June 5 to June 11"
 * Mantém nomes de veículos/prédios intactos (ex: Arcadius Business Center).
 * @param {string} title
 * @returns {string}
 */
export function translateTitle(title) {
  if (!title || typeof title !== 'string') return title;

  let out = title;

  // Padrão de cabeçalho mais comum
  out = out.replace(
    /^weekly\s+bonuses?\s+and\s+discounts?\b/gi,
    'Bônus e Descontos da Semana'
  );
  out = out.replace(
    /^weekly\s+bonuses?,\s+discounts?\s+and\s+events?\b/gi,
    'Bônus, Descontos e Eventos da Semana'
  );
  out = out.replace(
    /^weekly\s+bonuses?\s+and\s+events?\b/gi,
    'Bônus e Eventos da Semana'
  );
  out = out.replace(
    /^weekly\s+update\b/gi,
    'Atualização Semanal'
  );

  // "&" normalizado
  out = out.replace(/bonuses?\s*&\s*discounts?/gi, 'Bônus e Descontos da Semana');
  out = out.replace(/bonuses?\s*&\s*events?/gi, 'Bônus e Eventos da Semana');

  // "- September 3rd to September 10th" → "- 3 de setembro a 10 de setembro"
  out = out.replace(
    /([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(?:to|through|until|-)\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?/gi,
    (match, m1, d1, m2, d2) => {
      const m1Pt = MONTHS_PT[m1.toLowerCase()] || m1;
      const m2Pt = MONTHS_PT[m2.toLowerCase()] || m2;
      return `${d1} de ${m1Pt} a ${d2} de ${m2Pt}`;
    }
  );

  // Meses isolados (ex: "et on September 3rd" → "et em 3 de setembro")
  out = out.replace(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi, (match, m, d) => {
    const mPt = MONTHS_PT[m.toLowerCase()];
    if (!mPt) return match;
    return `${d} de ${mPt}`;
  });

  // " ~5am ET on" → " ~5h ET em"
  out = out.replace(/\bon\s+(\d{1,2})\s+de\b/gi, 'em $1 de');

  // Se contém "not live", deixa claro em PT:
  out = out.replace(/\bnot\s+live\s+until\b/gi, 'disponível a partir de');

  return out.trim();
}

export default {
  translateText,
  translateTitle,
  translateItems,
  translateDiscount,
  translateGunVanItem,
};

