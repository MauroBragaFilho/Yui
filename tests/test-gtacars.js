/**
 * Teste funcional do pipeline GTACars.net (fonte independente de veículos).
 * Cobre labels.js, parser.js, client.js, cache.js e service.js, usando uma
 * API simulada (adaptador axios). A rede real só é sondada no final e
 * degrada graciosamente. O cache real é preservado (backup + restauração).
 *
 * Uso: node tests/test-gtacars.js
 */

import axios from 'axios';
import fs from 'fs';
import { logger } from '../src/utils/logger.js';
import {
  MANUFACTURERS,
  DLC,
  DRIVETRAINS,
  VEHICLE_TYPES,
  CLASSES,
  SEATS,
  resolveLabel,
} from '../src/services/gta/vehicles/gtacars/labels.js';

// Adapter real do axios (capturado antes do mock) para restaurar no probe
// de rede real (se fizéssemos `delete`, a instância ficaria sem adapter).
const ORIGINAL_ADAPTER = axios.defaults.adapter;

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  ✅ ${label}`);
    passed += 1;
  } else {
    // console.log (não error) para evitar mojibake de stderr no PowerShell.
    console.log(`  ❌ ${label}`);
    failed += 1;
  }
}

/* Fixture: veículos crus no formato da API (subset real com os campos `_`). */
const RAW_TENF = {
  id: 'tenf',
  gtaWiki: '10F',
  dateAdded: '2022-10-06',
  _id: 'tenf',
  _name: '10F',
  _nm: '10F',
  _fullNm: '10F',
  _manuf: 'obey',
  _class: 'sport',
  _type: 'car',
  _seats: 2,
  _seatsText: 'Driver and passenger',
  _priceMp: 1675,
  _topSpeed: 126,
  _lapTime: 63180,
  _dt: 'rwd',
  _dateAdded: 1665014400000,
  _yearAdded: 2022,
  _dlc: 'mpsum2',
  _modelId: 'tenf',
  _handlingId: 'tenf',
  _textureId: 'tenf',
  _hashS: -893984159,
  _hashU: 3400983137,
  _hashH: 'cab6e261',
  images: {
    sc: [{ scId: '10f', type: 'mp-main', image: { _key: 'images/8f6e51fd682edc73229fd8dd65c0f96d' } }],
    model: [{ _key: 'images/87a442566ae869d9411e75de76fa234c' }],
  },
  ownership: {
    prices: [{ mp: 1675, sources: [{ id: 'legendary' }], images: [{ _key: 'images/a75ac1db42d9236a638aaa042bf8a15c' }] }],
  },
};
const RAW_Z190 = {
  id: 'z190',
  gtaWiki: '190z',
  dateAdded: '2018-02-20',
  _id: 'z190',
  _name: '190z',
  _nm: '190z',
  _fullNm: '190z',
  _manuf: 'karin',
  _class: 'sport_classic',
  _type: 'car',
  _seats: 2,
  _priceMp: 900,
  _topSpeed: 110,
  _lapTime: 69887,
  _dt: 'rwd',
  _dateAdded: 1519084800000,
  _yearAdded: 2018,
  _dlc: 'mpchristmas2017',
  _modelId: 'z190',
  _handlingId: 'z190',
  _hashS: 838982985,
  _hashU: 838982985,
  _hashH: '3201dd49',
  images: { sc: [], model: [] },
  ownership: { prices: [] },
};

const RAW_ADDER = {
  ...RAW_TENF,
  id: 'adder',
  _id: 'adder',
  _name: 'Adder',
  _nm: 'Adder',
  _fullNm: 'Adder',
  _manuf: 'truffade',
  _class: 'super',
  _dlc: 'TitleUpdate',
  _priceMp: 1000,
};

/* API simulada via adaptador axios (fail/delay controláveis). */
const FAKE_API = { vehicles: [], count: 0, fail: false, delayMs: 0 };

/** Gera um veículo bruto sintético único (para testes de paginação). */
function makeFakeRaw(i) {
  const idSuffix = String(i).padStart(3, '0');
  return {
    _id: `fake${idSuffix}`,
    _name: `Fake Car ${i}`,
    _fullNm: `Fake Car ${i}`,
    _manuf: 'karin',
    _class: 'sport',
    _type: 'car',
    _seats: 2,
    _priceMp: 100,
    _topSpeed: 100,
    _lapTime: 100000,
    _dt: 'rwd',
    _dateAdded: 1519084800000,
    _yearAdded: 2018,
    _dlc: 'mpchristmas2017',
    _modelId: `fake${idSuffix}`,
    _handlingId: `fake${idSuffix}`,
    _hashS: i,
    _hashU: i,
    _hashH: `f${i}`,
    images: { sc: [], model: [] },
    ownership: { prices: [] },
  };
}

/* Lote grande o suficiente para atravessar +1 página com perPage=24. */
const BIG_LIST = [RAW_TENF, RAW_Z190, RAW_ADDER, ...Array.from({ length: 25 }, (_, i) => makeFakeRaw(i + 4))];

function fakeAdapter(config) {
  if (FAKE_API.fail) {
    const err = new Error('Network Error');
    err.code = 'ECONNRESET';
    return Promise.reject(err);
  }
  const respond = () => {
    const params = config.params || {};
    const page = Number(params.page) || 1;
    const perPage = Number(params.perPage) || 60;
    const slice = FAKE_API.vehicles.slice((page - 1) * perPage, page * perPage);
    return {
      data: {
        success: true,
        payload: { count: FAKE_API.count, page, perPage, vehicles: slice.map((vehicle) => ({ vehicle })) },
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    };
  };
  return FAKE_API.delayMs
    ? new Promise((resolve) => setTimeout(() => resolve(respond()), FAKE_API.delayMs))
    : Promise.resolve(respond());
}
async function run() {
  logger.info('=== [TESTE] PIPELINE GTACARS (labels/parser/client/cache/service) ===');

  console.log('\n1. LABELS (mapas de metadados + resolveLabel):');
  assert(MANUFACTURERS.obey === 'Obey' && MANUFACTURERS.karin === 'Karin', 'mapa de fabricantes');
  assert(DLC.mpsum2 === 'Criminal Enterprises' && DLC.mp2025_02 === 'A Safehouse in the Hills', 'mapa de DLCs');
  assert(CLASSES.sport === 'Sports' && CLASSES.sport_classic === 'Sports Classics', 'mapa de classes');
  assert(VEHICLE_TYPES.car === 'Car', 'mapa de tipos');
  assert(DRIVETRAINS.rwd === 'Rear wheel drive', 'mapa de tração');
  assert(SEATS[2] === 2 && SEATS[0] === null, 'mapa de assentos (0 → null)');
  assert(resolveLabel(MANUFACTURERS, 'obey') === 'Obey', 'resolveLabel resolve id conhecido');
  assert(
    resolveLabel(MANUFACTURERS, 'fabricante-futuro') === 'fabricante-futuro',
    'resolveLabel id desconhecido → fallback'
  );
  assert(
    resolveLabel(MANUFACTURERS, null, 'Desconhecido') === 'Desconhecido',
    'resolveLabel null → fallback explícito'
  );
  assert(resolveLabel(MANUFACTURERS, '') === '', 'resolveLabel id vazio → fallback');

  console.log('\n2. PREPARAÇÃO (cache de teste + API simulada):');
  // IMPORTANTE: aplicar o mock ANTES de importar qualquer módulo do pipeline.
  // cache.js → parser.js → client.js formam uma cadeia de imports; quando o
  // primeiro `axios.create()` roda, ele captura axios.defaults.adapter. Se o
  // mock for aplicado depois, a instância http já nasceu com o adapter real
  // e o teste cairia na rede de verdade.
  axios.defaults.adapter = fakeAdapter;
  const { saveCache, readCache, isValidCache, CACHE_PATH } = await import(
    '../src/services/gta/vehicles/gtacars/cache.js'
  );
  let cacheBackup = null;
  if (fs.existsSync(CACHE_PATH)) cacheBackup = fs.readFileSync(CACHE_PATH, 'utf8');

  const client = await import('../src/services/gta/vehicles/gtacars/client.js');
  const parser = await import('../src/services/gta/vehicles/gtacars/parser.js');
  const { GTACarsApiError, fetchPage, PER_PAGE_OPTIONS, DEFAULT_PER_PAGE, GTACars_API_URL, GTACARS_BASE } = client;
  const { parseVehicle, parseVehicles, normalizeName, slugify, imageUrlFromKey, composeOfficialName } = parser;

  // Grava o cache de teste ANTES de importar o service (ele lê o disco no import).
  const SAMPLE_PARSED = [parseVehicle(RAW_TENF), parseVehicle(RAW_Z190)];
  const sampleCache = saveCache(SAMPLE_PARSED, { updatedAt: '2024-06-01T00:00:00.000Z' });
  assert(sampleCache !== null && sampleCache.count === 2, `cache de teste gravado (count=${sampleCache?.count})`);
  const service = await import('../src/services/gta/vehicles/gtacars/service.js');

  console.log('\n3. PARSER — funções puras:');
assert(normalizeName('Karin Sultán Clássic') === 'karin sultan classic', 'normalizeName remove acentos');
  assert(normalizeName('  10F   Widebody  ') === '10f widebody', 'normalizeName colapsa espaços');
  assert(normalizeName(null) === '', 'normalizeName null → vazio');
  assert(slugify('Karin 190z') === 'karin-190z', 'slugify URL-safe');
  assert(slugify('  Comet SR ** Turbo  ') === 'comet-sr-turbo', 'slugify remove símbolos');
  assert(imageUrlFromKey('images/abc') === 'https://gtacars.net/images/abc', 'imageUrlFromKey key simples');
  assert(imageUrlFromKey('/images/abc') === 'https://gtacars.net/images/abc', 'imageUrlFromKey ignora / inicial');
  assert(imageUrlFromKey('') === null && imageUrlFromKey(null) === null, 'imageUrlFromKey vazio/null → null');
  assert(composeOfficialName('Obey', '10F') === 'Obey 10F', 'nome = fabricante + nome exibido');
  assert(composeOfficialName('Pfister', 'Pfister Comet') === 'Pfister Comet', 'sem prefixo duplicado');
  assert(composeOfficialName('Unknown', '10F') === '10F', '"Unknown" não vira prefixo');
  assert(composeOfficialName('Obey', '') === '', 'nome vazio → vazio');

  console.log('\n4. PARSER — parseVehicle (schema completo):');
  const v = parseVehicle(RAW_TENF);
  assert(v && v.id === 'tenf', 'id preservado');
  assert(v.name === 'Obey 10F', `nome oficial ("${v.name}")`);
  assert(v.shortName === '10F', 'shortName = nome exibido');
  assert(v.normalizedName === 'obey 10f', 'normalizedName pronto para busca');
  assert(v.slug === 'obey-10f', 'slug');
  assert(v.manufacturer === 'Obey' && v.manufacturerId === 'obey', 'fabricante resolvido (id + label)');
  assert(v.class === 'Sports' && v.classId === 'sport', 'classe resolvida');
  assert(v.type === 'Car', 'tipo resolvido');
  assert(v.drivetrain === 'Rear wheel drive', 'tração resolvida');
  assert(v.dlc === 'Criminal Enterprises' && v.dlcId === 'mpsum2', 'DLC resolvida');
  assert(v.seats === 2, 'assentos');
  assert(v.price === 1675000, 'preço em GTA$ (1675k → 1.675.000)');
  assert(v.topSpeed === 126 && v.lapTime === 63180, 'topSpeed/lapTime numéricos');
  assert(v.releaseDate === '2022-10-06', 'releaseDate em YYYY-MM-DD');
  assert(v.year === 2022, 'ano');
  assert(
    v.image === 'https://gtacars.net/images/8f6e51fd682edc73229fd8dd65c0f96d',
    'imagem principal = primeiro screenshot'
  );
  assert(v.images.length === 3, '3 imagens coletadas (sc + model + price)');
  assert(v.url === 'https://gtacars.net/gta5/tenf', 'URL da página do veículo');
  assert(v.source === 'gtacars', 'source = gtacars');
  assert(v.modelId === 'tenf' && v.hashU === 3400983137, 'campos técnicos preservados');

  console.log('\n5. PARSER — casos de borda:');
  assert(parseVehicle(null) === null, 'null → null');
  assert(parseVehicle({}) === null, 'objeto vazio → null');
  assert(parseVehicle({ _fullNm: 'Sem Id' }) === null, 'sem id → null');
  assert(
    parseVehicle({ _id: 'x', _name: 'X', _manuf: 'marca-futura' }).manufacturer === 'marca-futura',
    'fabricante desconhecido → fallback no id'
  );
  const cheap = parseVehicle({ ...RAW_TENF, _priceMp: '2250', _seats: 7 });
  assert(cheap.price === 2250000, 'preço como string numérica é convertido');
  assert(cheap.seats === null, 'assentos fora do mapa → null');
  const weird = parseVehicle({ ...RAW_TENF, _priceMp: 'abc', _topSpeed: 'nao', _lapTime: 'x' });
  assert(weird.price === null && weird.topSpeed === null && weird.lapTime === null, 'valores não numéricos → null');
  assert(parseVehicles([RAW_TENF, null, {}, { _fullNm: 'S' }]).length === 1, 'parseVehicles descarta inválidos');
console.log('\n6. CLIENT — constantes, erro tipado e paginação (API simulada):');
  assert(GTACARS_BASE === 'https://gtacars.net', 'GTACARS_BASE correto');
  assert(GTACars_API_URL === 'https://gtacars.net/api/vehicle-search', 'GTACars_API_URL correto');
  assert(JSON.stringify(PER_PAGE_OPTIONS) === '[24,36,48,60]', 'PER_PAGE_OPTIONS restrito pela API');
  assert(DEFAULT_PER_PAGE === 60, 'default perPage = 60');
  const apiErr = new GTACarsApiError('teste', { status: 429, code: 'RATE_LIMIT', retryable: true });
  assert(apiErr instanceof Error && apiErr.name === 'GTACarsApiError', 'GTACarsApiError estende Error');
  assert(apiErr.status === 429 && apiErr.code === 'RATE_LIMIT' && apiErr.retryable === true, 'metadados no erro');

  FAKE_API.vehicles = BIG_LIST;
  FAKE_API.count = BIG_LIST.length;
  const page1 = await fetchPage({ page: 1, perPage: 24 });
  assert(typeof page1 === 'object', 'fetchPage retorna objeto normalizado');
  assert(page1.vehicles.length === 24, 'página 1 traz 24 veículos (perPage=24)');
  assert(page1.count === BIG_LIST.length, `count total preservado (${BIG_LIST.length})`);
  assert(page1.hasMore === true, 'hasMore=true na página incompleta');
  assert(page1.success === true, 'success=true');
  assert(page1.vehicles[0].vehicle._id === 'tenf', 'payload.vehicles[].vehicle passado p/ veículo cru');

  const page2 = await fetchPage({ page: 2, perPage: 24 });
  assert(
    page2.vehicles.length === BIG_LIST.length - 24 && page2.hasMore === false,
    'página 2 traz o restante e hasMore=false'
  );

  // perPage fora da lista permitida deve falhar rápido (sem chamar a rede).
  let perPageRejected = false;
  try {
    await fetchPage({ page: 1, perPage: 2 });
  } catch (e) {
    perPageRejected = e instanceof GTACarsApiError && e.code === 'INVALID_PER_PAGE';
  }
  assert(perPageRejected === true, 'perPage=2 rejeitado pelo validador (INVALID_PER_PAGE)');

  let err429 = null;
  try {
    FAKE_API.fail = true;
    await fetchPage({ page: 1, perPage: 24 });
  } catch (e) {
    err429 = e;
  } finally {
    FAKE_API.fail = false;
  }
  assert(err429 !== null, 'falha de rede sobe erro (retryable)');
  assert(err429 instanceof GTACarsApiError && err429.retryable === true, 'erro de rede é retryable');

  console.log('\n7. CACHE — leitura/validação/invalidação:');
  assert(isValidCache(readCache()), 'cache de teste é válido');
  assert(readCache().count === 2, 'cache lido tem 2 veículos');
  assert(readCache().updatedAt === '2024-06-01T00:00:00.000Z', 'updatedAt preservado');

  console.log('\n8. SERVICE — dados carregados do cache:');
  assert(service.isLoaded() === true, 'service carregou o cache');
  const status8 = service.getStatus();
  assert(status8.count === 2, 'getStatus().count = 2');
  assert(service.isStale() === true, 'updatedAt 2024-06-01 → stale (>24h)');
  const all = service.getAllVehicles();
  assert(Array.isArray(all) && all.length === 2, 'getAllVehicles → 2 veículos');
console.log('\n9. SERVICE — busca fuzzy (scoreVehicle/findVehicle):');
  const exact = service.findVehicle('Obey 10F');
  assert(exact !== null && exact.id === 'tenf', 'nome exato resolve');
  const curto = service.findVehicle('10F');
  assert(curto !== null && curto.id === 'tenf', 'nome curto resolve');
  const typo = service.findVehicle('obey 10f!');
  assert(typo !== null && typo.id === 'tenf', 'typo/caixa/símbolos tolerados');
  const inexistente = service.findVehicle('Karin Adder');
  assert(inexistente === null, 'busca inexistente → null');
  const resultados = service.searchVehicles('10', 5);
  assert(resultados.length >= 1 && resultados[0].id === 'tenf', 'searchVehicles ordena por score');

  console.log('\n10. CLIENT — paginação completa/falha em lote (fetchAllVehicles):');
  FAKE_API.vehicles = BIG_LIST;
  FAKE_API.count = BIG_LIST.length;
  const tudo = await client.fetchAllVehicles({ perPage: 24 });
  assert(tudo.length === BIG_LIST.length, `fetchAllVehicles varre todas as páginas (${BIG_LIST.length} veículos)`);

  let falhou = false;
  FAKE_API.fail = true;
  try {
    await client.fetchAllVehicles({ perPage: 24 });
  } catch (e) {
    falhou = e instanceof GTACarsApiError;
  } finally {
    FAKE_API.fail = false;
  }
  assert(falhou === true, 'fetchAllVehicles propaga erro tipado');
console.log('\n11. SERVICE — updateVehicles (download, dedupe, guards):');
  FAKE_API.vehicles = [RAW_TENF, RAW_Z190, RAW_ADDER];
  FAKE_API.count = 3;
  const up = await service.updateVehicles({ force: true });
  assert(up.ok === true, 'update ok');
  assert(up.count === 3, `update trouxe 3 veículos (count=${up.count})`);
  assert(up.saved === true, 'cache persistido no disco (saved=true)');
  assert(service.isStale() === false, 'após update, cache não está stale');

  const cacheNow = readCache();
  assert(cacheNow.count === 3, 'cache escrito com 3 veículos');
  assert(cacheNow.vehicles.some((x) => x.id === 'adder' && x.manufacturerId === 'truffade'), 'adder presente e normalizado');
  assert(cacheNow.vehicles.every((x) => x.source === 'gtacars'), 'todos com source=gtacars');
  const idsUnicos = new Set(cacheNow.vehicles.map((x) => x.id)).size;
  assert(idsUnicos === 3, 'sem duplicatas após update');

  console.log('    Guarda réplica:');
  FAKE_API.vehicles = [];
  FAKE_API.count = 0;
  const noData = await service.updateVehicles({ force: true });
  assert(noData.ok === false, 'update sem dados → falha (guarda réplica)');
  assert(noData.reason === 'api-vazia', 'motivo da guarda é "api-vazia"');
  assert(readCache().count === 3, 'cache intacto após falha replicada');

  console.log('    Guarda "resposta parcial":');
  FAKE_API.vehicles = [RAW_TENF]; // 1 de 3 — menos de 50% do cache.
  FAKE_API.count = 1;
  const parcial = await service.updateVehicles({ force: true });
  assert(parcial.ok === false && parcial.reason === 'resposta-parcial', 'resposta parcial preserva a base');

  console.log('    Dedupe:');
  FAKE_API.vehicles = [RAW_TENF, RAW_TENF, RAW_Z190, RAW_Z190];
  FAKE_API.count = 4;
  const dedupe = await service.updateVehicles({ force: true });
  assert(dedupe.ok === true && dedupe.count === 2, 'ids duplicados colapsados (4 raw → 2 únicos)');
  assert(readCache().count === 2, 'cache escrito apenas com veículos únicos');
console.log('\n12. RESTAURAÇÃO + PROBE DE REDE REAL (opcional):');
  // Restaura o cache real (se havia um) ou remove o arquivo de teste.
  try {
    if (cacheBackup !== null) {
      fs.writeFileSync(CACHE_PATH, cacheBackup, 'utf8');
      console.log('   ♻️  Cache real restaurado.');
    } else if (fs.existsSync(CACHE_PATH)) {
      fs.unlinkSync(CACHE_PATH);
      console.log('   🧹 Cache de teste removido (não havia cache real).');
    }
  } catch (err) {
    console.warn('   ⚠️  Falha ao restaurar o cache real:', err.message);
  }

  // Probe de rede real — degrada graciosamente (única parte que toca a internet).
  // O client importado acima já capturou o adapter mock no axios.create();
  // por isso restauramos o adapter real e reimportamos o módulo com
  // cache-busting (?live=1), recriando a instância sem o mock. Se não houver
  // rede, apenas registra e segue.
  let livePing = 'skip (sem internet)';
  try {
    axios.defaults.adapter = ORIGINAL_ADAPTER;
    const liveClient = await import('../src/services/gta/vehicles/gtacars/client.js?live=1');
    const live = await liveClient.fetchPage({ page: 1, perPage: 24 });
    livePing = live.success ? `OK (total=${live.count})` : 'fallback (resposta inválida)';
  } catch (e) {
    livePing = e.retryable ? 'rede indisponível' : e.message;
  }
  console.log(`   🌐 Probe da API real: ${livePing}`);

  console.log('\n====================================');
  console.log(`RESULTADO: ${passed} passaram, ${failed} falharam`);
  console.log('====================================');
  if (failed > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error('❌ Falha no teste:', err);
  process.exitCode = 1;
});