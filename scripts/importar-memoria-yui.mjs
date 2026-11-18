// IMPORTA UM LOTE DE MEMÓRIA para a Yui pela API dela (rota POST /v1/memory), com simulação (dry-run), conferência e como DESFAZER.
// Pedido do Braga (18/11/2026): a Yui passa a conhecer os projetos e o perfil dele. A Yui é a dona da própria memória: este script NUNCA abre o
// banco; só fala com a API, que aplica as regras de sempre (tipo, tamanho, remoção de duplicata, memória pessoal do dono).
//
// Uso (rodar no computador onde a Yui está, com o Node):
//   node scripts/importar-memoria-yui.mjs --lote lote.json [--env C:\Yui\.env] [--url http://127.0.0.1:3939]            (simulação: não grava nada)
//   node scripts/importar-memoria-yui.mjs --lote lote.json --aplicar                                                     (grava o lote)
//   node scripts/importar-memoria-yui.mjs --desfazer [--lote lote.json] --aplicar                                        (apaga só o que tem a etiqueta do lote)
//   node scripts/importar-memoria-yui.mjs --verificar --lote lote.json [--saida mapa.json]                               (SÓ LEITURA: a etiqueta acha exatamente o lote? devolve o id de cada item)
//
// O token: o script lê YUI_API_TOKENS do arquivo .env (formato "token=idDoUsuario,token2=id2") SÓ dentro deste processo, escolhe o token do DONO
// (o que a API responde com memória pessoal e permanente; um token de membro nunca serve) e nunca o mostra, nem em erro. Quem roda este script
// precisa de acesso ao .env. Nenhum segredo vai para a saída; só contagens e o texto do lote (que não leva segredo).
//
// O lote é um JSON: [{ id?, type, content, tags[], importance }]. Tipos: fact, preference, project, decision, summary, note. Cada item leva a
// etiqueta do lote (a última etiqueta de cada item, p. ex. "lote-2026-11-18"): é por ela que o --desfazer acha o que apagar.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (nome) => argv.includes(`--${nome}`);
const valor = (nome, padrao = null) => { const i = argv.indexOf(`--${nome}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : padrao; };

const URL_BASE = String(valor('url', 'http://127.0.0.1:3939')).replace(/\/+$/, '');
const ARQ_ENV = valor('env', 'C:\\Yui\\.env');
const ARQ_LOTE = valor('lote', null);
const APLICAR = flag('aplicar');
const DESFAZER = flag('desfazer');
const TIPOS = new Set(['fact', 'preference', 'project', 'decision', 'summary', 'note']);
const MAX_CONTENT = 2000;

class Falha extends Error {}
// Falha controlada: vira uma exceção tratada no fim do script (sem process.exit: no Windows ele derruba o libuv se ainda há conexão fechando).
const falhar = (msg) => { throw new Falha(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizar = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

// ── O token do dono (nunca impresso) ─────────────────────────────────────────────────────────────────────────────────
function tokensDoEnv(arquivo) {
  let texto;
  try { texto = fs.readFileSync(arquivo, 'utf8'); } catch { falhar(`não consegui ler o arquivo de configuração (${path.basename(arquivo)}). Rode este script onde o .env está, ou passe --env.`); }
  const linha = texto.split(/\r?\n/).find((l) => /^\s*YUI_API_TOKENS\s*=/.test(l));
  if (!linha) falhar('o arquivo de configuração não tem YUI_API_TOKENS.');
  let bruto = linha.slice(linha.indexOf('=') + 1).trim();
  if ((bruto.startsWith('"') && bruto.endsWith('"')) || (bruto.startsWith("'") && bruto.endsWith("'"))) bruto = bruto.slice(1, -1);
  const tokens = [];
  for (const par of bruto.split(',')) {
    const i = par.indexOf('=');
    if (i <= 0) continue;
    const token = par.slice(0, i).trim();
    if (token.length >= 16) tokens.push(token);
  }
  if (!tokens.length) falhar('YUI_API_TOKENS não tem nenhum token válido.');
  return tokens;
}

async function api(token, metodo, rota, corpo) {
  let res;
  try {
    res = await fetch(`${URL_BASE}${rota}`, {
      method: metodo,
      headers: { authorization: `Bearer ${token}`, ...(corpo ? { 'content-type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    falhar(`a API da Yui não respondeu em ${URL_BASE} (${err?.cause?.code ?? err?.code ?? 'sem resposta'}).`);
  }
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function acharDono(tokens) {
  for (const token of tokens) {
    const r = await api(token, 'GET', '/v1/memory');
    // o dono é quem a API trata com a memória PESSOAL (escopo resolvido no servidor pelo id do usuário; o cliente não escolhe)
    if (r.status === 200 && r.json?.scope === 'personal') return { token, memorias: r.json.memories ?? [] };
  }
  falhar('nenhum token do arquivo é do DONO (a API não devolveu a memória pessoal). Nada foi feito.');
}

// ── O lote ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
function lerLote(arquivo) {
  if (!arquivo) falhar('informe o lote com --lote <arquivo.json>.');
  let lote;
  try { lote = JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { falhar('o lote não é um JSON válido ou não pôde ser lido.'); }
  if (!Array.isArray(lote) || !lote.length) falhar('o lote precisa ser uma lista com pelo menos um item.');
  const vistos = new Set();
  lote.forEach((it, i) => {
    const onde = `item ${i + 1}`;
    if (!TIPOS.has(it?.type)) falhar(`${onde}: tipo inválido.`);
    const c = String(it?.content ?? '').trim();
    if (!c || c.length > MAX_CONTENT) falhar(`${onde}: o conteúdo está vazio ou passa de ${MAX_CONTENT} caracteres.`);
    if (!Number.isInteger(it.importance) || it.importance < 1 || it.importance > 5) falhar(`${onde}: importância de 1 a 5.`);
    if (!Array.isArray(it.tags) || it.tags.length < 1 || it.tags.length > 12 || it.tags.some((t) => typeof t !== 'string' || !t.trim() || t.length > 60 || t.includes(','))) falhar(`${onde}: etiquetas inválidas (1 a 12, sem vírgula).`);
    const k = normalizar(c);
    if (vistos.has(k)) falhar(`${onde}: conteúdo repetido no lote.`);
    vistos.add(k);
  });
  return lote;
}
const etiquetaDoLote = (lote) => lote[0].tags.at(-1);
const temEtiqueta = (m, etiqueta) => String(m?.tags ?? '').split(',').map((t) => t.trim()).includes(normalizar(etiqueta));

// ── Execução ────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function principal() {
  const VERIFICAR = flag('verificar');
const modo = VERIFICAR ? 'VERIFICAR' : DESFAZER ? 'DESFAZER' : 'IMPORTAR';
  console.log(`Modo: ${modo} ${VERIFICAR ? '(somente leitura)' : APLICAR ? '(VAI GRAVAR)' : '(simulação: nada será gravado)'} | API: ${URL_BASE}`);
  const { token, memorias } = await acharDono(tokensDoEnv(ARQ_ENV));
  console.log(`Token do dono encontrado (memória pessoal). Lembranças hoje: ${memorias.length}${memorias.length >= 100 ? ' (a API mostra até 100)' : ''}.`);

  if (VERIFICAR) {
    const loteV = lerLote(ARQ_LOTE);
    const etiquetaV = etiquetaDoLote(loteV);
    const doLote = new Map(loteV.map((it) => [normalizar(it.content), it]));
    const porTexto = new Map(memorias.map((m) => [normalizar(m.content), m]));
    const comEtiqueta = memorias.filter((m) => temEtiqueta(m, etiquetaV));
    const etiquetaForaDoLote = comEtiqueta.filter((m) => !doLote.has(normalizar(m.content)));
    const mapa = loteV.map((it) => {
      const m = porTexto.get(normalizar(it.content));
      return { idNoLote: it.id ?? null, idNaYui: m ? Number(m.id) : null, tipo: m ? m.type : null, comEtiqueta: m ? temEtiqueta(m, etiquetaV) : false, atualizadaEm: m ? m.updated_at ?? null : null };
    });
    const presentes = mapa.filter((x) => x.idNaYui !== null).length;
    const semEtiqueta = mapa.filter((x) => x.idNaYui !== null && !x.comEtiqueta).length;
    console.log(`Etiqueta "${etiquetaV}": acha ${comEtiqueta.length} lembrança(s); o lote tem ${loteV.length}.`);
    console.log(`Itens do lote presentes na memória: ${presentes} de ${loteV.length}. Presentes sem a etiqueta: ${semEtiqueta}. Com a etiqueta mas FORA do lote: ${etiquetaForaDoLote.length}.`);
    console.log(`Outras lembranças (sem a etiqueta do lote, anteriores ou posteriores): ${memorias.length - comEtiqueta.length}.`);
    const exato = comEtiqueta.length === loteV.length && presentes === loteV.length && semEtiqueta === 0 && etiquetaForaDoLote.length === 0;
    console.log(exato ? 'RESULTADO: a etiqueta acha EXATAMENTE os itens do lote.' : 'RESULTADO: a etiqueta NÃO bate exatamente com o lote.');
    const saida = valor('saida', null);
    if (saida) { fs.writeFileSync(saida, JSON.stringify({ etiqueta: etiquetaV, verificadoEm: new Date().toISOString(), exato, itens: mapa }, null, 2), 'utf8'); console.log(`Mapa de ids gravado em ${path.basename(saida)}.`); }
    if (!exato) process.exitCode = 1;
    return;
  }

  if (DESFAZER) {
    const etiqueta = ARQ_LOTE ? etiquetaDoLote(lerLote(ARQ_LOTE)) : valor('etiqueta', null);
    if (!etiqueta) falhar('informe --lote <arquivo> ou --etiqueta <etiqueta do lote> para saber o que desfazer.');
    const alvo = memorias.filter((m) => temEtiqueta(m, etiqueta));
    console.log(`Lembranças com a etiqueta "${etiqueta}": ${alvo.length}.`);
    if (!APLICAR) { console.log('Simulação: nada foi apagado. Rode de novo com --aplicar para apagar.'); return; }
    let apagadas = 0;
    for (const m of alvo) {
      const r = await api(token, 'DELETE', `/v1/memory/${Number(m.id)}`);
      if (r.status !== 200 || r.json?.ok !== true) falhar(`não consegui apagar a lembrança ${m.id} (HTTP ${r.status}). Parei aqui.`);
      apagadas += 1;
      await sleep(100);
    }
    console.log(`Apagadas: ${apagadas}.`);
    return;
  }

  const lote = lerLote(ARQ_LOTE);
  const jaTem = new Set(memorias.map((m) => normalizar(m.content)));
  const novos = lote.filter((it) => !jaTem.has(normalizar(it.content)));
  console.log(`Lote: ${lote.length} itens (etiqueta "${etiquetaDoLote(lote)}"). Já estão na memória: ${lote.length - novos.length}. Novos: ${novos.length}.`);
  if (!APLICAR) {
    console.log('Simulação: nada foi gravado. Itens novos:');
    for (const it of novos) console.log(`  - [${it.type}, importância ${it.importance}] ${it.content.slice(0, 90)}${it.content.length > 90 ? '…' : ''}`);
    console.log('Rode de novo com --aplicar para gravar.');
    return;
  }

  let gravados = 0;
  for (const [i, it] of novos.entries()) {
    const r = await api(token, 'POST', '/v1/memory', { type: it.type, content: it.content.trim(), tags: it.tags, importance: it.importance });
    if (r.status !== 201) falhar(`não consegui gravar o item ${i + 1} de ${novos.length} (HTTP ${r.status}). Parei aqui; o que já foi gravado fica (rode --desfazer --aplicar para apagar o lote).`);
    gravados += 1;
    await sleep(150);
  }
  const depois = (await api(token, 'GET', '/v1/memory')).json?.memories ?? [];
  const presentes = new Set(depois.map((m) => normalizar(m.content)));
  const faltando = lote.filter((it) => !presentes.has(normalizar(it.content)));
  console.log(`Gravados agora: ${gravados}. Conferência na memória: ${lote.length - faltando.length} de ${lote.length} presentes${depois.length >= 100 ? ' (a API mostra até 100)' : ''}.`);
  if (faltando.length) falhar(`${faltando.length} item(ns) do lote não apareceram na conferência.`);
  console.log('Pronto. Para desfazer: --desfazer --lote <o mesmo arquivo> --aplicar.');
}

try {
  await principal();
} catch (err) {
  if (!(err instanceof Falha)) throw err;
  console.error(`ERRO: ${err.message}`);
  process.exitCode = 1;
}
