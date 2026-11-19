// OS ENDEREÇOS DO GOOGLE (etapa 15). Este é o ÚNICO arquivo da Yui com os endereços reais do Google (autorização, token, Agenda, Tarefas e Gmail) e com os
// identificadores dos escopos. Todo o resto (o cliente do token, a Agenda, as Tarefas, o Gmail, o script de autorização) recebe os endereços daqui:
//  - o bloqueio de integração externa dos testes e o teste de cobertura (tests/test-google-unidade.js) conferem que nenhum outro arquivo de src/ ou scripts/
//    escreve um endereço do Google;
//  - nenhum teste fala com o Google de verdade: cada teste abre um Google FALSO em 127.0.0.1 e troca os endereços por `definirHostsParaTeste` (só com NODE_ENV=test).
// Só LEITURA: os escopos pedidos são todos "readonly". Nada aqui cria, altera, apaga nem envia nada na conta do Google.

/** Os endereços reais. */
export const HOSTS_REAIS = Object.freeze({
  autorizacao: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  agenda: 'https://www.googleapis.com/calendar/v3',
  tarefas: 'https://tasks.googleapis.com/tasks/v1',
  gmail: 'https://gmail.googleapis.com/gmail/v1',
});

/**
 * Os escopos (todos somente leitura). A Agenda usa `calendar.events.readonly` (só os eventos, o mais estreito que a leitura de eventos aceita; a Yui também
 * aceita `calendar.readonly` se ele já estiver na autorização). Se o Google classifica cada um como sensível ou restrito NÃO foi confirmado: quem autoriza
 * confere na tela de consentimento.
 */
export const ESCOPOS = Object.freeze({
  agenda: 'https://www.googleapis.com/auth/calendar.events.readonly',
  tarefas: 'https://www.googleapis.com/auth/tasks.readonly',
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
});

/** Escopos que valem para cada recurso (a autorização pode ter o mais amplo). */
export const ESCOPOS_ACEITOS = Object.freeze({
  agenda: Object.freeze([
    'https://www.googleapis.com/auth/calendar.events.readonly',
    'https://www.googleapis.com/auth/calendar.readonly',
  ]),
  tarefas: Object.freeze(['https://www.googleapis.com/auth/tasks.readonly']),
  gmail: Object.freeze(['https://www.googleapis.com/auth/gmail.readonly']),
});

const ESCOPO_RE = /^https:\/\/www\.googleapis\.com\/auth\/[A-Za-z0-9._/-]{1,120}$/;
/** O texto tem a forma de um identificador de escopo do Google? */
export function ehEscopoDoGoogle(texto) {
  return typeof texto === 'string' && ESCOPO_RE.test(texto);
}

/** A autorização guardada tem um escopo que vale para este recurso? `escopos` ausente (arquivo antigo) = não dá para saber: vale (o Google decide, com 403). */
export function temEscopo(escopos, recurso) {
  if (!Array.isArray(escopos)) return true;
  const aceitos = ESCOPOS_ACEITOS[recurso] ?? [];
  return escopos.some((e) => aceitos.includes(String(e)));
}

const LOOPBACK_HTTP_RE = /^http:\/\/(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\]):\d{1,5}(?:\/[^\s?#]*)?$/i;

/** Os endereços de um Google FALSO numa base local ("http://127.0.0.1:PORTA"). Só aceita loopback por HTTP: nunca aponta para fora do computador. */
export function hostsDeBaseLocal(base) {
  const b = String(base ?? '').trim().replace(/\/+$/, '');
  if (!LOOPBACK_HTTP_RE.test(b)) throw new Error('a base do Google falso precisa ser http://127.0.0.1:<porta> (só loopback).');
  return Object.freeze({
    autorizacao: `${b}/o/oauth2/v2/auth`,
    token: `${b}/token`,
    agenda: `${b}/calendar/v3`,
    tarefas: `${b}/tasks/v1`,
    gmail: `${b}/gmail/v1`,
  });
}

let hostsDeTeste = null;

/** Só para teste (NODE_ENV=test): troca os endereços por os de um Google falso em loopback. `null` volta aos reais. */
export function definirHostsParaTeste(hosts) {
  if (hosts === null || hosts === undefined) { hostsDeTeste = null; return; }
  if (String(process.env.NODE_ENV ?? '').trim().toLowerCase() !== 'test') throw new Error('definirHostsParaTeste só vale com NODE_ENV=test.');
  for (const [k, v] of Object.entries(hosts)) {
    if (!LOOPBACK_HTTP_RE.test(String(v))) throw new Error(`endereço de teste "${k}" fora do loopback.`);
  }
  hostsDeTeste = Object.freeze({ ...hosts });
}

/** Os endereços em uso agora: os reais, ou (só em teste) os do Google falso. */
export function hostsDoGoogle() {
  return hostsDeTeste ?? HOSTS_REAIS;
}
