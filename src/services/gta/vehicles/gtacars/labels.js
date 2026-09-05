/**
 * Labels de metadados do GTACars.
 *
 * Estes mapas (id → nome de exibição) foram extraídos do chunk de frontend
 * do próprio GTACars.net (o arquivo `_nuxt/*.js` que alimenta os filtros do
 * site), cruzados com a resposta real da API `/api/vehicle-search`. A API
 * NÃO expõe esses nomes — ela devolve apenas os slugs/ids curtos
 * (ex.: `_manuf: "karin"`, `_class: "sport"`), então o parser usa estes
 * mapas para montar o nome de exibição correto.
 *
 * IMPORTANTE: estas listas devem ser revisadas ocasionalmente. Quando o
 * GTACars adiciona um novo DLC/fabricante/classe, o id aparece na API com
 * o nome de exibição desconhecido (o parser cai no fallback que devolve o
 * próprio id). Os valores não são "inventados" — são os labels oficiais do
 * site, apenas copiados para módulo próprio.
 */

/** Fabricantes (id GTACars → nome de exibição). */
export const MANUFACTURERS = {
  albany: 'Albany',
  annis: 'Annis',
  benefactor: 'Benefactor',
  bf: 'BF',
  bollokan: 'Bollokan',
  bravado: 'Bravado',
  brute: 'Brute',
  bucking: 'Buckingham',
  canis: 'Canis',
  chariot: 'Chariot',
  cheval: 'Cheval',
  classique: 'Classique',
  coil: 'Coil',
  declasse: 'Declasse',
  dewbauch: 'Dewbauchee',
  dinka: 'Dinka',
  dundrear: 'Dundreary',
  emperor: 'Emperor',
  eberhard: 'Eberhard',
  enus: 'Enus',
  fathom: 'Fathom',
  gallivan: 'Gallivanter',
  grotti: 'Grotti',
  hijak: 'Hijak',
  hvy: 'HVY',
  imponte: 'Imponte',
  inverto: 'Invetero',
  jacksheepe: 'Jack Sheepe',
  jobuilt: 'JoBuilt',
  karin: 'Karin',
  kraken: 'Kraken',
  lampadati: 'Lampadati',
  lcc: 'LCC',
  maibatsu: 'Maibatsu',
  mammoth: 'Mammoth',
  maxwell: 'Maxwell',
  mtl: 'MTL',
  nagasaki: 'Nagasaki',
  obey: 'Obey',
  ocelot: 'Ocelot',
  overflod: 'Overflod',
  pegassi: 'Pegassi',
  pegasus: 'Pegasus',
  penaud: 'Penaud',
  pfister: 'Pfister',
  principl: 'Principe',
  progen: 'Progen',
  rune: 'RUNE',
  schyster: 'Schyster',
  shitzu: 'Shitzu',
  speedoph: 'Speedophile',
  stanley: 'Stanley',
  toundra: 'Toundra',
  truffade: 'Truffade',
  ubermacht: 'Ubermacht',
  vapid: 'Vapid',
  vomfeuer: 'Vom Feuer',
  vulcar: 'Vulcar',
  vysser: 'Vysser',
  weeny: 'Weeny',
  western: 'Western',
  willard: 'Willard',
  zirconiu: 'Zirconium',
  _unknown: 'Unknown',
};
/** DLCs / atualizações (id GTACars → nome do update). */
export const DLC = {
  TitleUpdate: 'Initial Release',
  mpbeach: 'Beach Bum Update',
  mpvalentines: "Valentine's Day Massacre",
  mpbusiness: 'Business',
  mpbusiness2: 'High Life',
  mphipster: "I'm Not A Hipster",
  mpindependence: 'Independence Day',
  mppilot: 'SA Flight School',
  mplts: 'Last Team Standing',
  spupgrade: 'Enhanced Edition',
  mpchristmas2: 'Festive Surprise 2014',
  mpheist: 'Heists',
  mpluxe: 'Ill-Gotten Gains Part 1',
  mpluxe2: 'Ill-Gotten Gains Part 2',
  mpreplay: 'Freemode Events Update',
  mplowrider: 'Lowriders',
  mphalloween: 'Halloween Surprise',
  mpapartment: 'Executives and Other Criminals',
  mpxmas_604490: 'Festive Surprise 2015',
  mpjanuary2016: 'January 2016',
  mpvalentines2: 'Be My Valentine',
  mplowrider2: 'Lowriders: Custom Classics',
  mpexecutive: 'Finance and Felony',
  mpstunt: 'Cunning Stunts',
  mpbiker: 'Bikers',
  mpimportexport: 'Import/Export',
  mpspecialraces: 'Cunning Stunts: SV Circuit',
  mpgunrunning: 'Gunrunning',
  mpsmuggler: "Smuggler's Run",
  mpchristmas2017: 'Doomsday Heist',
  mpassault: 'SSA Super Sport Series',
  mpbattle: 'After Hours',
  mpchristmas2018: 'Arena War',
  mpvinewood: 'Diamond Casino & Resort',
  mpheist3: 'Diamond Casino Heist',
  mpsum: 'Los Santos Summer Special',
  mpheist4: 'Cayo Perico Heist',
  mptuner: 'Los Santos Tuners',
  mpsecurity: 'Contract',
  mpg9ec: 'Expanded & Enhanced Edition',
  mpsum2: 'Criminal Enterprises',
  mpchristmas3: 'Los Santos Drug Wars',
  mp2023_01: 'San Andreas Mercenaries',
  mp2023_02: 'Chop Shop',
  mp2024_01: 'Bottom Dollar Bounties',
  mp2024_02: 'Agents of Sabotage',
  mp2025_01: 'Money Fronts',
  mp2025_02: 'A Safehouse in the Hills',
  mp2026_01: 'Kortz Center Heist',
};

/** Tração (id GTACars → nome de exibição). */
export const DRIVETRAINS = {
  awd: 'All wheel drive',
  fwd: 'Front wheel drive',
  rwd: 'Rear wheel drive',
};

/** Tipo de veículo (id GTACars → nome de exibição). */
export const VEHICLE_TYPES = {
  amphibious_automobile: 'Amphibious Automobile',
  amphibious_quadbike: 'Amphibious Quadbike',
  bicycle: 'Bicycle',
  bike: 'Bike',
  blimp: 'Blimp',
  boat: 'Boat',
  car: 'Car',
  heli: 'Helicopter',
  plane: 'Plane',
  quadbike: 'Quadbike',
  submarine: 'Submarine',
  submarinecar: 'Submersible Car',
  trailer: 'Trailer',
  train: 'Train',
};

/** Classe de corrida GTA (id GTACars → nome de exibição). */
export const CLASSES = {
  boat: 'Boats',
  commercial: 'Commercial',
  compacts: 'Compacts',
  coupe: 'Coupes',
  cycle: 'Cycles',
  emergency: 'Emergency',
  helicopter: 'Helicopters',
  industrial: 'Industrial',
  military: 'Military',
  motorcycle: 'Motorcycles',
  muscle: 'Muscle',
  off_road: 'Off-Road',
  open_wheel: 'Open Wheel',
  plane: 'Planes',
  sedan: 'Sedans',
  service: 'Service',
  sport: 'Sports',
  sport_classic: 'Sports Classics',
  super: 'Supers',
  suv: 'SUVs',
  rail: 'Trains',
  utility: 'Utility',
  van: 'Vans',
};
/** Local de compra/aquisição (id GTACars → nome de exibição). */
export const SOURCES = {
  arenawar: 'Arena War',
  'arenawar-tier': 'Arena War Sponsorship Tier',
  'auto-shop': 'Customer Car (Auto Shop)',
  benny: "Benny's",
  'bike-shop': 'Customer Bike (MC Clubhouse)',
  bunker: 'Bunker',
  career: 'Career Progress',
  'conv-arena': 'Conversion at Arena Workshop',
  'conv-benny': "Conversion at Benny's",
  'conv-hao': "Conversion at Hao's Special Works",
  'conv-moc': 'Conversion at MOC or Avenger',
  docktease: 'Dock Tease',
  elitas: 'Elitas Travel',
  _steal: 'Find on street & steal',
  legendary: 'Legendary Motorsport',
  '_lucky-wheel': 'Lucky Wheel (Casino)',
  misc: 'Misc',
  pedal: 'Pedal And Metal',
  salvageyard: 'Salvage Yard',
  ssasa: 'SSASA',
  trigger: 'Triggered spawn',
  warstock: 'Warstock',
};

/** Placa (id GTACars → nome de exibição). */
export const PLATE_TYPES = {
  back_plates: 'Back plates',
  front_and_back_plates: 'Front and back plates',
  front_plates: 'Front plates',
};

/** Assentos (id GTACars → número; 0 = N/A). */
export const SEATS = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  8: 8,
  9: 9,
  10: 10,
  11: 11,
  16: 16,
  0: null,
};

/**
 * Resolve o label de exibição de um id a partir de um mapa.
 * Se o id não estiver mapeado, retorna o próprio id (fallback seguro —
 * nunca fabrica um label).
 */
export function resolveLabel(map, id, fallback = id ?? null) {
  if (id === null || id === undefined || id === '') return fallback;
  if (!(id in map)) return fallback;
  return map[id];
}