// O Open-Meteo FALSO dos testes do clima (etapa 11): um servidor HTTP em 127.0.0.1, aberto pelo PRÓPRIO teste, com a mesma forma de resposta da geocodificação
// (GET /v1/search) e da previsão (GET /v1/forecast). Nada de rede de verdade: o teste aponta o cliente para este endereço (`urls`) e o bloqueio de integração
// externa continua valendo (só a porta aberta pelo teste passa).
//
// Guarda CADA pedido que recebeu (`pedidos`: método, caminho, parâmetros e cabeçalhos): é assim que os testes provam que só o NOME DO LOCAL (e as coordenadas
// devolvidas) saiu, nunca o texto da conversa. O `controle` simula o serviço lento (`atrasoMs`), fora do ar (`status`), com limite (`status: 429`),
// resposta estranha (`lixo`) e valores fora da faixa (`foraDaFaixa`).
import http from 'node:http';

const sem = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

const CIDADES = {
  cuiaba: [
    { name: 'Cuiabá', latitude: -15.5989, longitude: -56.0949, country_code: 'BR', country: 'Brasil', admin1: 'Mato Grosso', timezone: 'America/Cuiaba' },
    { name: 'Cuiabá', latitude: -2.9, longitude: -52.1, country_code: 'BR', country: 'Brasil', admin1: 'Pará', timezone: 'America/Belem' },
  ],
  manaus: [{ name: 'Manaus', latitude: -3.1019, longitude: -60.025, country_code: 'BR', country: 'Brasil', admin1: 'Amazonas', timezone: 'America/Manaus' }],
  'sao paulo': [
    { name: 'São Paulo', latitude: -23.5475, longitude: -46.6361, country_code: 'BR', country: 'Brasil', admin1: 'São Paulo', timezone: 'America/Sao_Paulo' },
  ],
  curitiba: [{ name: 'Curitiba', latitude: -25.4278, longitude: -49.2731, country_code: 'BR', country: 'Brasil', admin1: 'Paraná', timezone: 'America/Sao_Paulo' }],
  recife: [{ name: 'Recife', latitude: -8.0539, longitude: -34.8811, country_code: 'BR', country: 'Brasil', admin1: 'Pernambuco', timezone: 'America/Recife' }],
  'foz do iguacu': [{ name: 'Foz do Iguaçu', latitude: -25.5478, longitude: -54.5882, country_code: 'BR', country: 'Brasil', admin1: 'Paraná', timezone: 'America/Sao_Paulo' }],
  'santa cruz': [
    { name: 'Santa Cruz', latitude: -6.2292, longitude: -36.0233, country_code: 'BR', country: 'Brasil', admin1: 'Rio Grande do Norte', timezone: 'America/Fortaleza' },
    { name: 'Santa Cruz', latitude: -7.2072, longitude: -36.5314, country_code: 'BR', country: 'Brasil', admin1: 'Paraíba', timezone: 'America/Fortaleza' },
    { name: 'Santa Cruz', latitude: -8.2333, longitude: -36.0, country_code: 'BR', country: 'Brasil', admin1: 'Pernambuco', timezone: 'America/Recife' },
  ],
  brasilia: [{ name: 'Brasília', latitude: -15.7801, longitude: -47.9292, country_code: 'BR', country: 'Brasil', admin1: 'Distrito Federal', timezone: 'America/Sao_Paulo' }],
};

const CODIGOS = [0, 2, 61, 95, 3, 80, 1];
const CHANCES = [10, 20, 80, 90, 30, 60, 0];
const CHUVAS = [0, 0.4, 5.2, 12.64, 0, 2.1, 0];

function addDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** A previsão falsa: valores determinísticos que mudam com a latitude (cada cidade tem os seus). */
export function previsaoFalsa(lat, lon, hoje, { foraDaFaixa = false } = {}) {
  const base = Math.round(Math.abs(Number(lat))) % 10;
  const time = [0, 1, 2, 3, 4, 5, 6].map((i) => addDias(hoje, i));
  return {
    latitude: Number(lat), longitude: Number(lon), timezone: 'America/Cuiaba',
    current: { time: `${hoje}T14:00`, interval: 900, temperature_2m: 30.4 + base, apparent_temperature: foraDaFaixa ? 999 : 33.6 + base, relative_humidity_2m: 41.2, wind_speed_10m: 12.4, precipitation: 0, weather_code: 0 },
    daily: {
      time,
      weather_code: time.map((_, i) => CODIGOS[i]),
      temperature_2m_max: time.map((_, i) => 31.4 + base + (i % 3)),
      temperature_2m_min: time.map(() => 20.2 + base),
      precipitation_probability_max: time.map((_, i) => CHANCES[i]),
      precipitation_sum: time.map((_, i) => CHUVAS[i]),
    },
  };
}

/**
 * Abre o servidor falso. `hoje`: a data local da previsão (AAAA-MM-DD).
 * @returns {Promise<{ url: string, porta: number, urls: { geocodificacao: string, previsao: string }, pedidos: object[], controle: (c: object) => void, limpar: () => void, fechar: () => Promise<void> }>}
 */
export async function abrirClimaFalso({ hoje = '2026-11-18' } = {}) {
  const pedidos = [];
  let ctl = {};
  const aguardando = new Set();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const params = Object.fromEntries(u.searchParams.entries());
    pedidos.push({ metodo: req.method, caminho: u.pathname, params, headers: { ...req.headers }, crus: req.url });
    const responder = () => {
      if (ctl.status && ctl.status !== 200) {
        res.writeHead(ctl.status, { 'content-type': 'application/json' });
        // o Open-Meteo responde HTTP 400 com {error:true, reason}; os outros erros (429, 500...) aqui vão sem corpo de JSON
        res.end(ctl.status === 400 ? JSON.stringify({ error: true, reason: 'parâmetro inválido (teste)' }) : 'erro do servidor (teste)');
        return;
      }
      if (ctl.lixo) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('isto não é json {'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (u.pathname === '/v1/search') {
        const lista = CIDADES[sem(params.name)];
        res.end(JSON.stringify(lista ? { results: lista, generationtime_ms: 0.4 } : { generationtime_ms: 0.4 }));
        return;
      }
      if (u.pathname === '/v1/forecast') {
        res.end(JSON.stringify(previsaoFalsa(params.latitude, params.longitude, hoje, { foraDaFaixa: ctl.foraDaFaixa === true })));
        return;
      }
      res.writeHead(404); res.end('{}');
    };
    if (ctl.atrasoMs) { const t = setTimeout(responder, ctl.atrasoMs); aguardando.add(t); req.on('close', () => { clearTimeout(t); aguardando.delete(t); }); } else responder();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const porta = server.address().port;
  const url = `http://127.0.0.1:${porta}`;
  return {
    url, porta,
    urls: { geocodificacao: `${url}/v1/search`, previsao: `${url}/v1/forecast` },
    pedidos,
    controle: (c) => { ctl = { ...c }; },
    limpar: () => { pedidos.length = 0; },
    async fechar() {
      for (const t of aguardando) clearTimeout(t);
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
