// O GOOGLE FALSO dos testes da integração (etapa 15): um servidor HTTP em 127.0.0.1 (porta livre) que imita só o que a Yui usa, SEM falar com o Google de verdade:
//   GET  /o/oauth2/v2/auth                   a autorização (confere client_id, redirect_uri de loopback, PKCE S256, escopos, state; responde 302 com o código e o state)
//   POST /token                              authorization_code (confere o PKCE de verdade: sha256(verificador) == desafio) e refresh_token (com os modos de falha)
//   GET  /calendar/v3/calendars/primary/events   a Agenda (filtra por timeMin/timeMax; exige o access token válido)
//   GET  /tasks/v1/lists/@default/tasks      as Tarefas
//   GET  /gmail/v1/users/me/messages[/<id>]  o Gmail (lista e leitura)
// Tudo que chega é REGISTRADO (`pedidos`) para o teste conferir o que a Yui mandou; o servidor nunca escreve nada em disco.
import http from 'node:http';
import crypto from 'node:crypto';

export const CLIENT_ID = 'cliente-falso-123.apps.googleusercontent.com';
export const CLIENT_SECRET = 'segredo-do-cliente-falso-GOCSPX-abc123';
export const REFRESH_TOKEN = '1//refresh-token-falso-ABCDEFGHIJKLMNOP-0123456789';
export const SEGREDO_PLANTADO = 'SEGREDO-PLANTADO-NO-GOOGLE-9f3a1c77';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export async function criarGoogleFalso({ clientId = CLIENT_ID, clientSecret = CLIENT_SECRET, refreshToken = REFRESH_TOKEN } = {}) {
  const estado = {
    refreshValidos: new Set([refreshToken]),
    accessEmitidos: new Set(),
    contadorAccess: 0,
    codigos: new Map(), // código -> { desafio, redirectUri, escopos, clientId }
    modoToken: 'ok', // 'ok' | 'invalid_grant' | 'invalid_client' | 'http500' | 'sem-token' | 'lento' | 'rotaciona'
    modoApi: {}, // { agenda | tarefas | gmail: 'ok' | '401' | '403' | '429' | '500' | 'lento' | 'invalido' }
    eventos: [],
    tarefas: [],
    emails: [],
    corpos: new Map(),
    consentimento: 'ok', // 'ok' | 'negar'
    pedidos: [],
    expiraEmS: 3599,
    escoposDoCodigo: null, // se definido, os escopos que a troca devolve (simula quem desmarcou uma caixa)
    semRefreshNaTroca: false,
    fusoDoCalendarioMin: 0, // o fuso da AGENDA (minutos a leste de UTC) que decide em que dia cai um evento de dia inteiro
    paginasServidas: 0,
    refreshNaTroca: null, // se definido, o refresh token que a próxima troca de código devolve
  };

  /**
   * A projeção do parâmetro `fields` do Google ("nextPageToken,items(summary,attendees(self))"): só os campos pedidos voltam (o que o cliente NÃO pediu não existe para ele).
   * Sem `fields`, volta tudo. Só entende nomes, vírgulas e parênteses (o que a Yui usa).
   */
  function projetar(valor, selecao) {
    if (Array.isArray(valor)) return valor.map((v) => projetar(v, selecao));
    if (!valor || typeof valor !== 'object') return valor;
    const saida = {};
    for (const [nome, sub] of Object.entries(selecao)) if (nome in valor) saida[nome] = sub ? projetar(valor[nome], sub) : valor[nome];
    return saida;
  }
  function lerFields(texto) {
    let i = 0;
    const lista = () => {
      const o = {};
      for (;;) {
        let nome = '';
        while (i < texto.length && !',()'.includes(texto[i])) nome += texto[i++];
        if (nome) o[nome] = texto[i] === '(' ? (i++, lista()) : null;
        if (texto[i] === ',') { i++; continue; }
        if (texto[i] === ')') i++;
        return o;
      }
    };
    return lista();
  }
  /** As páginas do Google: maxResults (padrão 100) e pageToken (aqui, o deslocamento em base64). Devolve { items, nextPageToken? }, já com a projeção de fields. */
  function paginar(itens, q) {
    const tamanho = Math.max(1, Math.min(2500, Number(q.maxResults) || 100));
    let de = 0;
    if (q.pageToken) {
      const n = Number(Buffer.from(String(q.pageToken), 'base64url').toString('utf8').replace(/^pagina:/, ''));
      if (!Number.isInteger(n) || n < 0) return { error: 'token inválido', items: [] };
      de = n;
    }
    estado.paginasServidas = (estado.paginasServidas ?? 0) + 1;
    const fatia = itens.slice(de, de + tamanho);
    const corpo = { items: fatia };
    if (de + tamanho < itens.length) corpo.nextPageToken = Buffer.from(`pagina:${de + tamanho}`).toString('base64url');
    if (!q.fields) return corpo;
    return projetar(corpo, lerFields(q.fields));
  }

  const json = (res, status, corpo) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(corpo));
  };
  const lerCorpo = (req) => new Promise((resolve) => { const partes = []; req.on('data', (c) => partes.push(c)); req.on('end', () => resolve(Buffer.concat(partes).toString('utf8'))); });
  const pendentes = new Set();

  async function token(req, res) {
    const corpo = new URLSearchParams(await lerCorpo(req));
    const reg = { metodo: 'POST', caminho: '/token', campos: Object.fromEntries(corpo.entries()), cabecalhos: { ...req.headers } };
    estado.pedidos.push(reg);
    const tipo = corpo.get('grant_type');
    if (corpo.get('client_id') !== clientId || corpo.get('client_secret') !== clientSecret) return json(res, 401, { error: 'invalid_client', error_description: SEGREDO_PLANTADO });
    if (tipo === 'authorization_code') {
      const c = estado.codigos.get(corpo.get('code'));
      if (!c) return json(res, 400, { error: 'invalid_grant', error_description: 'Bad Request' });
      estado.codigos.delete(corpo.get('code')); // uso único
      const verificador = corpo.get('code_verifier') ?? '';
      if (b64url(crypto.createHash('sha256').update(verificador).digest()) !== c.desafio) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
      if (corpo.get('redirect_uri') !== c.redirectUri) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect' });
      const acesso = `ya29.falso-${++estado.contadorAccess}-${crypto.randomBytes(6).toString('hex')}`;
      estado.accessEmitidos.add(acesso);
      // `refreshNaTroca`: uma nova autorização recebe um refresh token NOVO (como no Google), que passa a valer.
      const refreshDaTroca = estado.refreshNaTroca ?? refreshToken;
      estado.refreshValidos.add(refreshDaTroca);
      return json(res, 200, {
        access_token: acesso, expires_in: estado.expiraEmS, token_type: 'Bearer',
        ...(estado.semRefreshNaTroca ? {} : { refresh_token: refreshDaTroca }), scope: (estado.escoposDoCodigo ?? c.escopos).join(' '),
      });
    }
    if (tipo === 'refresh_token') {
      if (estado.modoToken === 'lento') { pendentes.add(res); return; } // nunca responde: o cliente tem de desistir pelo prazo
      if (estado.modoToken === 'invalid_grant') return json(res, 400, { error: 'invalid_grant', error_description: `Token has been expired or revoked. ${SEGREDO_PLANTADO}` });
      if (estado.modoToken === 'invalid_client') return json(res, 401, { error: 'invalid_client' });
      if (estado.modoToken === 'http500') return json(res, 500, { error: { message: SEGREDO_PLANTADO } });
      if (estado.modoToken === 'sem-token') return json(res, 200, { expires_in: 3600, token_type: 'Bearer' });
      if (!estado.refreshValidos.has(corpo.get('refresh_token'))) return json(res, 400, { error: 'invalid_grant' });
      const acesso = `ya29.falso-${++estado.contadorAccess}-${crypto.randomBytes(6).toString('hex')}`;
      estado.accessEmitidos.add(acesso);
      const out = { access_token: acesso, expires_in: estado.expiraEmS, token_type: 'Bearer', scope: 'x' };
      if (estado.modoToken === 'rotaciona') { const novo = `1//refresh-rotacionado-${crypto.randomBytes(8).toString('hex')}-0123456789`; estado.refreshValidos.add(novo); out.refresh_token = novo; estado.ultimoRotacionado = novo; }
      return json(res, 200, out);
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }

  function autorizacao(req, res, u) {
    const q = Object.fromEntries(u.searchParams.entries());
    estado.pedidos.push({ metodo: 'GET', caminho: u.pathname, query: q });
    const erroDe = (msg) => json(res, 400, { error: 'invalid_request', error_description: msg });
    if (q.client_id !== clientId) return erroDe('client_id');
    if (q.response_type !== 'code') return erroDe('response_type');
    if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? '')) return erroDe('pkce');
    if (!q.state || q.state.length < 16) return erroDe('state');
    if (q.access_type !== 'offline') return erroDe('access_type');
    if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(q.redirect_uri ?? '')) return erroDe('redirect_uri');
    const escopos = String(q.scope ?? '').split(' ').filter(Boolean);
    if (!escopos.length || !escopos.every((e) => /^https:\/\/www\.googleapis\.com\/auth\/[a-z.]+readonly$/.test(e))) return erroDe('escopos');
    const destino = new URL(q.redirect_uri);
    if (estado.consentimento === 'negar') destino.searchParams.set('error', 'access_denied');
    else {
      const codigo = `4/falso-${crypto.randomBytes(16).toString('hex')}`;
      estado.codigos.set(codigo, { desafio: q.code_challenge, redirectUri: q.redirect_uri, escopos, clientId });
      destino.searchParams.set('code', codigo);
    }
    destino.searchParams.set('state', q.state);
    res.writeHead(302, { Location: destino.toString() });
    res.end();
  }

  function api(req, res, u, recurso, montar) {
    const auth = String(req.headers.authorization ?? '');
    const reg = { metodo: 'GET', caminho: u.pathname, query: Object.fromEntries(u.searchParams.entries()), auth: auth.startsWith('Bearer ') && estado.accessEmitidos.has(auth.slice(7)) };
    estado.pedidos.push(reg);
    const modo = estado.modoApi[recurso] ?? 'ok';
    if (modo === 'lento') { pendentes.add(res); return; }
    if (modo === '401' || !reg.auth) return json(res, 401, { error: { code: 401, message: 'Invalid Credentials' } });
    if (modo === '403') return json(res, 403, { error: { code: 403, message: SEGREDO_PLANTADO } });
    if (modo === '429') return json(res, 429, { error: { code: 429 } });
    if (modo === '500') return json(res, 500, { error: { code: 500 } });
    if (modo === 'invalido') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('isto não é json'); }
    return json(res, 200, montar(reg.query));
  }

  const servidor = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && u.pathname === '/o/oauth2/v2/auth') return autorizacao(req, res, u);
      if (req.method === 'POST' && u.pathname === '/token') return await token(req, res);
      if (req.method === 'GET' && u.pathname === '/calendar/v3/calendars/primary/events') {
        return api(req, res, u, 'agenda', (q) => {
          const min = Date.parse(q.timeMin); const max = Date.parse(q.timeMax);
          // Como no Google: o evento de DIA INTEIRO vale no fuso da AGENDA (`fusoDoCalendarioMin`, minutos a leste de UTC; padrão 0), não no fuso da consulta.
          // Uma agenda em Brasília (-180) consultada com a janela de Cuiabá devolve também o evento de dia inteiro do dia vizinho.
          const deslocamento = (estado.fusoDoCalendarioMin ?? 0) * 60_000;
          const dentro = estado.eventos.filter((e) => {
            if (!e || typeof e !== 'object') return true; // item estranho: passa direto (o cliente é que tem de aguentar)
            const ini = e.start?.dateTime ? Date.parse(e.start.dateTime) : Date.parse(`${e.start?.date}T00:00:00Z`) - deslocamento;
            const fim = e.end?.dateTime ? Date.parse(e.end.dateTime) : Date.parse(`${e.end?.date}T00:00:00Z`) - deslocamento;
            return fim > min && ini < max;
          });
          return paginar(dentro, q);
        });
      }
      if (req.method === 'GET' && u.pathname === '/tasks/v1/lists/@default/tasks') return api(req, res, u, 'tarefas', (q) => ({ kind: 'tasks#tasks', ...paginar(estado.tarefas, q) }));
      if (req.method === 'GET' && u.pathname === '/gmail/v1/users/me/messages') return api(req, res, u, 'gmail', () => ({ messages: estado.emails.map((m) => ({ id: m.id })) }));
      const m = /^\/gmail\/v1\/users\/me\/messages\/([0-9a-f]+)$/.exec(u.pathname);
      if (req.method === 'GET' && m) return api(req, res, u, 'gmail', () => estado.emails.find((x) => x.id === m[1]) ?? {});
      res.writeHead(404); res.end();
    } catch { try { res.writeHead(500); res.end(); } catch { /* */ } }
  });
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const porta = servidor.address().port;

  return {
    porta,
    base: `http://127.0.0.1:${porta}`,
    estado,
    get pedidos() { return estado.pedidos; },
    pedidosDe: (caminho) => estado.pedidos.filter((p) => p.caminho === caminho),
    limpar() { estado.pedidos.length = 0; },
    /** Um refresh token novo, válido (para simular "outra autorização"). */
    novoRefresh() { const novo = `1//refresh-novo-${crypto.randomBytes(8).toString('hex')}-0123456789`; estado.refreshValidos.add(novo); return novo; },
    async close() {
      for (const r of pendentes) { try { r.destroy(); } catch { /* */ } }
      servidor.closeAllConnections?.();
      await new Promise((resolve) => servidor.close(resolve));
    },
  };
}
