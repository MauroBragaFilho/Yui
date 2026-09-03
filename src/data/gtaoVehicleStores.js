/**
 * Catálogo estático de veículos do GTA Online → loja oficial.
 *
 * O post semanal do r/gtaonline lista descontos agrupados por percentual
 * ("70% Off" + veículos), mas NÃO informa em qual concessionária cada
 * veículo é vendido. Para exibir essa informação no embed (Página 2),
 * mantemos aqui um mapeamento manual veículo → loja, cobrindo os veículos
 * mais comuns que aparecem nas rotações semanais de desconto.
 *
 * A função getVehicleStore() faz match fuzzy (por palavra-chave) para
 * tolerar pequenas variações de nome vindas do post. Para veículos não
 * catalogados, retorna null (o embed decide como exibir).
 */

export const STORE_NAMES = {
  legendary: 'Legendary Motorsport',
  docktease: 'Dock Tease',
  warstock: 'Warstock Cache & Carry',
  ssa: 'Southern San Andreas Super Autos',
  premium: 'Premium Deluxe Motorsport',
  bennys: "Benny's Original Motor Works",
  elitastravel: "Elitás Travel",
  pedalmetal: 'Pedal & Metal',
  mazebank: 'Maze Bank Foreclosures',
};

// Mapeamento veículo -> chave da loja. A chave referenceia STORE_NAMES.
// Nomes são normalizados (minúsculas, sem pontuação extra) na comparação.
const STORE_BY_VEHICLE = {
  // ── Legendary Motorsport ─────────────────────────────────────────
  'coil cyclone': 'legendary',
  'coil cyclone ii': 'legendary',
  'coil raiden': 'legendary',
  'coil voltic': 'legendary',
  'grotti itali gto': 'legendary',
  'grotti itali gto stinger tt': 'legendary',
  'grotti itali rsx': 'legendary',
  'grotti turismo r': 'legendary',
  'grotti visione': 'legendary',
  'grotti x80 proto': 'legendary',
  'grotti furia': 'legendary',
  'grotti carbonizzare': 'legendary',
  'pegassi reaper': 'legendary',
  'pegassi tempesta': 'legendary',
  'pegassi tezeract': 'legendary',
  'pegassi zentorno': 'legendary',
  'pegassi torero': 'legendary',
  'pegassi ignus': 'legendary',
  'pegassi infernus': 'legendary',
  'pegassi vacca': 'legendary',
  'truffade adder': 'legendary',
  'truffade zentorno': 'legendary',
  'truffade nemesis': 'legendary',
  'truffade thrax': 'legendary',
  'truffade nero': 'legendary',
  'lampadati novak': 'legendary',
  'lampadati viseris': 'legendary',
  'lampadati felon': 'legendary',
  'lampadati pigalle': 'legendary',
  'lampadati cypher': 'legendary',
  'lampadati komoda': 'legendary',
  'ocelot jugular': 'legendary',
  'ocelot pariah': 'legendary',
  'ocelot lynx': 'legendary',
  'ocelot xa-21': 'legendary',
  'ocelot virtue': 'legendary',
  'pfister 811': 'legendary',
  'pfister comet sr': 'legendary',
  'pfister comet s2': 'legendary',
  'pfister neon': 'legendary',
  'progen itali gtb': 'legendary',
  'progen t20': 'legendary',
  'progen emerus': 'legendary',
  'progen tyrus': 'legendary',
  'dewbauchee vagner': 'legendary',
  // ── Dock Tease / Warstock / Southern San Andreas ─────────────────
  'seabreeze': 'docktease',
  'shitzu vortex': 'docktease',
  'speedophile seashark': 'docktease',
  'declasse toreador': 'warstock',
  'vapid imperator': 'warstock',
  'vapid caracara': 'warstock',
  'bf bifta': 'warstock',
  'bf dune buggy': 'warstock',
  'karin technical': 'warstock',
  'hvys nightshark': 'warstock',
  'hvys insurgent': 'warstock',
  'hvys apc': 'warstock',
  'mammoth patriot': 'warstock',
  'mammoth squaddie': 'warstock',
  'oppressor mk ii': 'warstock',
  'scramjet': 'warstock',
  'deluxo': 'warstock',
  'khanjali': 'warstock',
  'karin 190z': 'ssa',
  'karin sultan': 'ssa',
  'karin kuruma': 'ssa',
  'karin futo': 'ssa',
  'karin calico gtf': 'ssa',
  'dinka jester': 'ssa',
  'dinka blista': 'ssa',
  'dinka kanjo': 'ssa',
  'dinka sugoi': 'ssa',
  'dinka rtk3000': 'ssa',
  'vapid dominator': 'ssa',
  'vapid dominator gtx': 'ssa',
  'vapid dominator asp': 'ssa',
  'bollokan prairie': 'ssa',
  'canis mesa': 'ssa',
  'canis seminole': 'ssa',
  'canis kamacho': 'ssa',
  'declasse vamos': 'ssa',
  'declasse saber turbo': 'ssa',
  'declasse virgo': 'ssa',
  'declasse tornado': 'ssa',
  'declasse vigero': 'ssa',
  'declasse vigero zx': 'ssa',
  'declasse mamba': 'ssa',
  'declasse impaler': 'ssa',
  'declasse impaler sz': 'ssa',
  'declasse granger': 'ssa',
  'declasse phoenix': 'ssa',
  'declasse stallion': 'ssa',
  'invetero coquette': 'ssa',
  'schyster fusilade': 'ssa',
  'schyster deviant': 'ssa',
  'obey tailgater': 'ssa',
  'obey 8f drafter': 'ssa',
  'obey omnis': 'ssa',
  'ubermacht zion': 'ssa',
  'ubermacht sentinel': 'ssa',
  'ubermacht rebla gts': 'ssa',
  'bravado banshee': 'ssa',
  'bravado gauntlet': 'ssa',
  'bravado buffalo': 'ssa',
  'bravado youga': 'ssa',

  'krieger': 'legendary',
  // ── Premium Deluxe Motorsport (Simeon) ────────────────────────────
  'premium deluxe': 'premium',
  'grotti stinger': 'premium',
  'pegassi monroe': 'premium',
  'pegassi cheetah classic': 'premium',
  'pegassi torero xo': 'premium',
  'truffade ztype': 'premium',
  'dewbauchee rapid gt': 'premium',
  'dewbauchee massacro': 'premium',
  'dewbauchee seven-70': 'premium',
  'dewbauchee specter': 'premium',
  'lampadati casco': 'premium',
  'lampadati michelli gt': 'premium',
  'lampadati tropos rallye': 'premium',
  'ocelot f620': 'premium',
  'ocelot swinger': 'premium',
  'pfister comet': 'premium',
  'grotti bestia gts': 'premium',
  'dinka jester classic': 'premium',

  // ── Benny's Original Motor Works ──────────────────────────────────
  'banshee 900r': 'bennys',
  'sultan rs': 'bennys',
  'comet retro custom': 'bennys',
  'itali gtb custom': 'bennys',
  'jester classic': 'bennys',
  'sabre turbo custom': 'bennys',
  'voodoo custom': 'bennys',
  'moonbeam custom': 'bennys',
  'virgo classic custom': 'bennys',

  // ── Elitás Travel (aeronaves) ─────────────────────────────────────
  'mammoth luxor': 'elitastravel',
  'mammoth dodo': 'elitastravel',
  'mammoth nimbus': 'elitastravel',
  'nimbus': 'elitastravel',
  'luxor': 'elitastravel',
  'dodo': 'elitastravel',
  'vestra': 'elitastravel',

  // ── Pedal & Metal (bicicletas) ────────────────────────────────────
  'scorcher': 'pedalmetal',
  'tribike': 'pedalmetal',
  'bmx': 'pedalmetal',

  // ── Maze Bank Foreclosures (propriedades) ─────────────────────────
  'arcadius business center': 'mazebank',
  'executive office': 'mazebank',
  'lombank west': 'mazebank',
  'maze bank west': 'mazebank',
  'maze bank tower': 'mazebank',
};

/**
 * Retorna o nome da loja de um veículo, ou null se não estiver no catálogo.
 * Faz match por palavra-chave para tolerar variações de formatação vindas
 * do post do Reddit. Ex.: getVehicleStore('Declasse Impaler SZ') ->
 * { key: 'ssa', name: 'Southern San Andreas Super Autos' }.
 */
export function getVehicleStore(vehicleName) {
  if (!vehicleName) return null;
  const normalized = vehicleName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 1) Match exato primeiro.
  if (STORE_BY_VEHICLE[normalized]) {
    const key = STORE_BY_VEHICLE[normalized];
    return { key, name: STORE_NAMES[key] };
  }

  // 2) Match por palavra-chave: encaixa o nome do veículo em uma entrada
  //    do catálogo, escolhendo a entrada mais específica (mais longa).
  let bestKey = null;
  let bestLen = 0;
  for (const [veh, storeKey] of Object.entries(STORE_BY_VEHICLE)) {
    if (normalized.includes(veh) && veh.length > bestLen) {
      bestKey = storeKey;
      bestLen = veh.length;
    } else if (veh.includes(normalized) && normalized.length > bestLen && normalized.length >= 3) {
      bestKey = storeKey;
      bestLen = normalized.length;
    }
  }

  return bestKey ? { key: bestKey, name: STORE_NAMES[bestKey] } : null;
}

/**
 * Agrupa os descontos (strings do parser, ex: "Coil Cyclone II - 70%")
 * por loja. Retorna um array de { store, vehicles } com a loja traduzida
 * e os veículos agrupados. Veículos sem loja conhecida vão para 'Outros'.
 */
export function groupDiscountsByStore(discounts) {
  const groups = new Map(); // key -> { storeName, vehicles: [] }

  for (const raw of discounts || []) {
    // Separa nome do veículo do percentual: "VEÍCULO - 70%" / "VEÍCULO (50%)"
    let name = raw;
    let pct = null;
    const pctMatch = raw.match(/(\d{1,3}\s*%)/i);
    if (pctMatch) {
      pct = pctMatch[1].trim();
      // Remove tudo após o percentual; limpa separadores e parênteses residuais.
      name = raw
        .split(pctMatch[1])[0]
        .replace(/[-–—]\s*$/, '')
        .replace(/\(\s*$/, '')
        .replace(/[*_`>\]]/g, '')
        .trim();
    }

    const store = getVehicleStore(name);
    const storeName = store ? store.name : 'Outros';
    const display = pct ? `${name} (${pct})` : name;

    if (!groups.has(storeName)) {
      groups.set(storeName, { store: store, vehicles: [] });
    }
    groups.get(storeName).vehicles.push(display);
  }

  return [...groups.entries()].map(([storeName, g]) => ({
    store: storeName,
    vehicles: g.vehicles,
  }));
}

