// STEAM FALSA para o teste de ponta a ponta do /steam_jogo (tests/test-steam-jogo-processos.js, etapa 8). NUNCA vale em produção.
//
// Só liga com as TRÊS condições: YUI_TESTE_STEAM_FALSA=true, NODE_ENV=test e o Discord falso (o index.js só chama isto no ramo do Discord falso, que
// por sua vez só liga em NODE_ENV=test com o cérebro separado). Fora disso a variável é ignorada e o bot avisa no log (o mesmo padrão da IA falsa).
//
// Sem rede: troca o `axios.get` do processo para as DUAS rotas da loja da Steam que o steamHandler usa (a busca por nome e os detalhes do app) e
// responde a partir do próprio nome pedido; qualquer outro endereço segue para o axios de verdade (que, nos testes, o bloqueio de integração
// externa derruba). O jogo "inexistente" (qualquer nome com a palavra `inexistente`) volta sem resultados. O nome do jogo devolvido é
// "Jogo <o que foi pedido>", para o teste conferir que o texto pedido pela pessoa NUNCA vai parar em log, telemetria nem mensagem de erro (a Steam
// de verdade devolve o nome do jogo, que é dado de terceiros, mas aqui ele carrega o marcador do teste).
import crypto from 'node:crypto';

/** 'on', 'off' (variável ausente) ou 'refused' (ligada fora de NODE_ENV=test). */
export function steamFalsaMode(env = process.env) {
  const wanted = String(env.YUI_TESTE_STEAM_FALSA ?? '').trim().toLowerCase() === 'true';
  if (!wanted) return 'off';
  return String(env.NODE_ENV ?? '').trim().toLowerCase() === 'test' ? 'on' : 'refused';
}

const idDoTermo = (termo) => 100_000 + (crypto.createHash('sha256').update(String(termo)).digest().readUInt32BE(0) % 800_000);

/** Os dois endpoints da Steam, respondidos a partir do que foi pedido. `termos`: appId -> o termo da busca (só neste processo). */
export function criarSteamFalsa() {
  const termos = new Map();
  return {
    async get(url) {
      const u = new URL(String(url));
      if (u.hostname !== 'store.steampowered.com') return null; // não é da Steam: segue para o axios de verdade
      if (u.pathname === '/api/storesearch/' || u.pathname === '/api/storesearch') {
        const termo = u.searchParams.get('term') ?? '';
        if (/inexistente/i.test(termo)) return { data: { total: 0, items: [] } };
        const id = idDoTermo(termo);
        termos.set(String(id), termo);
        return { data: { total: 1, items: [{ id, name: `Jogo ${termo}` }] } };
      }
      if (u.pathname === '/api/appdetails') {
        const id = String(u.searchParams.get('appids') ?? '');
        const termo = termos.get(id);
        if (termo === undefined) return { data: { [id]: { success: false } } };
        return {
          data: {
            [id]: {
              success: true,
              data: {
                name: `Jogo ${termo}`, short_description: 'Descrição curta do jogo de teste (Steam falsa).',
                price_overview: { final_formatted: 'R$ 46,99', initial_formatted: '', initial: 4699, final: 4699, discount_percent: 0 },
                header_image: 'https://exemplo.invalid/capa.jpg', developers: ['Estúdio de Teste'], publishers: ['Editora de Teste'],
                release_date: { date: '1 jan. 2026' }, metacritic: { score: 88 },
              },
            },
          },
        };
      }
      return null;
    },
  };
}

/**
 * Liga a Steam falsa no axios deste processo se (e só se) o modo for 'on'. Devolve o modo.
 * @param {{ axios: { get: Function }, env?: object, logger?: object|null }} o
 */
export function ativarSteamFalsa({ axios, env = process.env, logger = null } = {}) {
  const mode = steamFalsaMode(env);
  if (mode === 'on') {
    const falsa = criarSteamFalsa();
    const original = axios.get.bind(axios);
    axios.get = async (url, ...resto) => (await falsa.get(url)) ?? original(url, ...resto);
    logger?.warn?.('[Bootstrap] STEAM FALSA ligada (só teste, NODE_ENV=test): a loja da Steam responde pelo dublê, nenhuma rede.');
  } else if (mode === 'refused') {
    logger?.error?.('[Bootstrap] YUI_TESTE_STEAM_FALSA=true ignorado: a Steam falsa só liga com NODE_ENV=test.');
  }
  return mode;
}
