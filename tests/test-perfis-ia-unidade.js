// Etapa 9: os PERFIS DE IA do Motor 0, as peças puras (docs/RELATORIO_ETAPA9_PERFIS_IA.md), num processo só, sem rede (nenhuma chamada de IA, de buscador ou de serviço):
//  A. a configuração dos perfis (YUI_IA_PERFIS e/ou arquivo): validada, com a privacidade explícita, o privado completo, nada de "agente" no perfil e o auto/chaos recusado;
//  B. os DOIS leitores do cabeçalho X-OmniRoute-Decision: o TOLERANTE (só diagnóstico: nunca lança, nunca devolve um segredo) e o ESTRITO (a decisão de segurança do privado);
//  C. o SELETOR determinístico do cérebro (qual perfil em cada ponto de chamada, a escalada para raciocínio, a imagem, a privacidade) e o limite de tokens efetivo;
//  D. o MOTOR do agente: YUI_MOTOR_AGENTE=mastra é recusado e o cérebro segue no nativo; o contrato (a ferramenta pedida por qualquer motor passa pelo guardToolCall e pelo motor de políticas);
//  E. o DIAGNÓSTICO dos perfis e do motor (lista de permitidos: nenhum segredo, chave, cabeçalho, prompt ou conteúdo), e a PRESERVAÇÃO (sem perfil configurado, a chamada de IA é idêntica).
// A conversa de ponta a ponta com o OmniRoute falso está no test:perfisiarota, e com processos de verdade no test:perfisiaprocessos.
// Execução: npm run test:perfisiaunidade   (node tests/test-perfis-ia-unidade.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-perfis-unidade-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const GUILD = '444444444444444444';

Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'), YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false',
  YUI_GATEWAY_IN_CHAIN: 'false', LOG_LEVEL: 'error', YUI_CONTEXT_ENABLED: 'false', YUI_POLICY_MODE: 'observe',
});
for (const k of ['GROQ_API_KEY', 'GROQ_API_KEYS', 'GEMINI_API_KEYS', 'GEMINI_API_KEY', 'HF_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'OPENROUTER_API_KEY', 'TOGETHER_API_KEY',
  'LM_STUDIO_API_KEY', 'AI_API_KEY', 'AI_BASE_URL', 'LOCAL_LLM_URL', 'AI_BACKEND', 'AI_MAX_TOKENS', 'YUI_MAX_TOKENS_TETO', 'YUI_IA_PERFIS', 'YUI_IA_PERFIS_ARQUIVO', 'YUI_IA_ESCALADA',
  'YUI_IA_ESCALADA_CONTEXTO_CHARS', 'YUI_MOTOR_AGENTE', 'YUI_GATEWAY_CUSTOM', 'YUI_PRIVATE_CHANNEL_IDS', 'YUI_TRUSTED_IDS', 'AI_PRIVATE_LOCAL_ONLY']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
process.chdir(tmp);

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
// Nenhuma chamada de rede neste teste: fetch e axios falham na hora (as peças daqui nem deveriam chamá-los).
const { default: axios } = await import('axios');
let redeTentada = 0;
axios.post = axios.get = async () => { redeTentada += 1; throw new Error('offline (teste)'); };
globalThis.fetch = async () => { redeTentada += 1; throw new Error('fetch bloqueado no teste'); };
const { logger } = await imp('src/utils/logger.js');
for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = () => {};
const realConsole = { log: console.log };
const say = (s) => realConsole.log(s);
console.log = console.warn = console.error = () => {};

const perfis = await imp('src/core/ai/perfis.js');
const dec = await imp('src/core/ai/decisaoOmniRoute.js');
const seletor = await imp('src/cerebro/seletorPerfil.js');
const motor = await imp('src/core/ai/motorAgente.js');
const diag = await imp('src/core/diagnostico.js');
const rota = await imp('src/core/ai/rotaPerfil.js');
const manager = await imp('src/core/ai/manager.js');
const conversa = await imp('src/cerebro/conversa.js');
const { createPolicyEngine } = await imp('src/core/security/policyEngine.js');
const { guardToolCall } = await imp('src/core/security/discordGuard.js');

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed += 1; say(`  ok   ${name}`); } catch (err) {
    failures.push(name);
    say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 8).join('\n        ')}`);
  }
};
const section = (t) => say(`\n${t}`);
const chaves = (o) => Object.keys(o).sort();
const SEGREDO = 'sk-SEGREDO-PLANTADO-9f8e7d6c5b4a39281706';

/** A configuração de exemplo (o mapeamento PROPOSTO da Liz, só no teste: nunca ligado por padrão). */
const EXEMPLO = () => ({
  conversa: { modelo: 'auto', maxTokens: 1024, privacidade: 'geral' },
  rapido: { modelo: 'auto/fast', maxTokens: 256, privacidade: 'geral' },
  pesquisa: { modelo: 'auto/smart', maxTokens: 2048, privacidade: 'geral' },
  raciocinio: { modelo: 'auto/smart', maxTokens: 4096, privacidade: 'geral' },
  privado: { modelo: 'combo-privado', maxTokens: 1024, privacidade: 'privada', provedor: 'omniroute-privado', chaveVinculada: true, provedoresPermitidos: ['groq', 'gemini-pago'], decisao: { formato: 'pares', campoProvedor: 'provider' } },
  visao: { modelo: 'combo-visao', maxTokens: 1024, privacidade: 'geral' },
  local: { modelo: 'local-fake', maxTokens: 512, privacidade: 'geral', habilitado: false },
});
const comEnv = (obj, fn) => {
  const antes = process.env.YUI_IA_PERFIS;
  process.env.YUI_IA_PERFIS = JSON.stringify(obj);
  try { return fn(); } finally { if (antes === undefined) delete process.env.YUI_IA_PERFIS; else process.env.YUI_IA_PERFIS = antes; perfis.esquecerConfigDePerfisParaTeste(); }
};
const codigos = (r) => r.erros.map((e) => e.codigo);

try {
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A. A configuração dos perfis: validada, a privacidade explícita, nada de agente, auto/chaos recusado');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('sem nenhuma configuração: nada configurado, nenhum perfil ativo e nenhum acesso ao disco', () => {
    perfis.esquecerConfigDePerfisParaTeste();
    const cfg = perfis.carregarPerfis({});
    assert.equal(cfg.temConfig, false);
    assert.deepEqual(perfis.perfisAtivos({}), {});
    assert.equal(perfis.privadoDeclarado({}), false);
    assert.equal(cfg.origem, 'nenhuma');
  });

  await test('a configuração de exemplo (o mapeamento proposto) é válida: os 6 perfis ativos; o `local` fica reservado e desligado', () => {
    const v = perfis.validarPerfis(EXEMPLO());
    assert.deepEqual(v.erros, []);
    assert.deepEqual(chaves(v.perfis), ['conversa', 'local', 'pesquisa', 'privado', 'rapido', 'raciocinio', 'visao'].sort());
    comEnv(EXEMPLO(), () => {
      const ativos = perfis.perfisAtivos(process.env);
      assert.deepEqual(chaves(ativos), ['conversa', 'pesquisa', 'privado', 'rapido', 'raciocinio', 'visao'].sort(), 'o local nunca fica ativo');
      assert.equal(perfis.privadoDeclarado(process.env), true);
    });
    assert.deepEqual(perfis.NOMES_DE_PERFIL, ['conversa', 'rapido', 'pesquisa', 'raciocinio', 'privado', 'visao', 'local']);
  });

  await test('a privacidade é EXPLÍCITA: ausente, inválida ou incoerente com o perfil é recusada', () => {
    const base = { modelo: 'auto', maxTokens: 512 };
    assert.deepEqual(codigos(perfis.validarPerfis({ conversa: { ...base } })), ['privacidade-ausente']);
    assert.deepEqual(codigos(perfis.validarPerfis({ conversa: { ...base, privacidade: 'publica' } })), ['privacidade-invalida']);
    assert.deepEqual(codigos(perfis.validarPerfis({ conversa: { ...base, privacidade: 'privada' } })), ['privacidade-incoerente'], 'só o perfil privado é "privada"');
    const p = EXEMPLO().privado;
    assert.ok(codigos(perfis.validarPerfis({ privado: { ...p, privacidade: 'geral' } })).includes('privacidade-incoerente'), 'o privado precisa ser "privada"');
  });

  await test('perfil é modalidade de execução, NÃO agente: persona, memória, permissão, ferramentas e prompt são recusados', () => {
    for (const campo of ['persona', 'memoria', 'permissoes', 'ferramentas', 'system', 'prompt', 'papel', 'tools', 'identidade']) {
      const r = perfis.validarPerfis({ conversa: { modelo: 'auto', maxTokens: 512, privacidade: 'geral', [campo]: 'x' } });
      assert.deepEqual(codigos(r), ['campo-de-agente'], `${campo} deveria ser recusado como campo de agente`);
      assert.deepEqual(r.perfis, {}, 'o perfil com campo de agente não vale');
    }
    assert.deepEqual(codigos(perfis.validarPerfis({ conversa: { modelo: 'auto', maxTokens: 512, privacidade: 'geral', cor: 'azul' } })), ['campo-desconhecido']);
    assert.deepEqual(codigos(perfis.validarPerfis({ conversa: { modelo: 'auto', maxTokens: 512, privacidade: 'geral', chaveVinculada: true } })), ['campo-so-do-privado']);
    assert.deepEqual(codigos(perfis.validarPerfis({ robo: { modelo: 'auto', maxTokens: 512, privacidade: 'geral' } })), ['perfil-desconhecido']);
  });

  await test('auto/chaos NUNCA: recusado em qualquer perfil, com qualquer caixa e em qualquer posição; os outros perfis seguem valendo', () => {
    for (const modelo of ['auto/chaos', 'AUTO/CHAOS', 'Auto/Chaos', 'chaos', 'meu/chaos-combo']) {
      const r = perfis.validarPerfis({ conversa: { modelo, maxTokens: 512, privacidade: 'geral' }, rapido: { modelo: 'auto/fast', maxTokens: 256, privacidade: 'geral' } });
      assert.deepEqual(codigos(r), ['modelo-chaos'], modelo);
      assert.deepEqual(chaves(r.perfis), ['rapido'], 'o perfil inválido sai; o outro segue');
    }
    assert.equal(perfis.ehModeloChaos('auto/fast'), false);
    // o privado também (a ordem das regras não deixa passar)
    const p = EXEMPLO().privado;
    assert.ok(codigos(perfis.validarPerfis({ privado: { ...p, modelo: 'auto/chaos' } })).includes('modelo-chaos'));
  });

  await test('maxTokens: inteiro de 64 a 8192; fora disso, texto ou decimal é recusado', () => {
    for (const bad of [63, 8193, 0, -5, '1000', 1.5, null, undefined, NaN]) {
      assert.deepEqual(codigos(perfis.validarPerfis({ conversa: { modelo: 'auto', maxTokens: bad, privacidade: 'geral' } })), ['max-tokens-invalido'], String(bad));
    }
    for (const ok of [64, 4096, 8192]) assert.deepEqual(perfis.validarPerfis({ conversa: { modelo: 'auto', maxTokens: ok, privacidade: 'geral' } }).erros, []);
  });

  await test('modelo: obrigatório e com caracteres válidos', () => {
    assert.deepEqual(codigos(perfis.validarPerfis({ conversa: { maxTokens: 512, privacidade: 'geral' } })), ['modelo-ausente']);
    assert.deepEqual(codigos(perfis.validarPerfis({ conversa: { modelo: '  ', maxTokens: 512, privacidade: 'geral' } })), ['modelo-ausente']);
    assert.deepEqual(codigos(perfis.validarPerfis({ conversa: { modelo: 'auto fast!', maxTokens: 512, privacidade: 'geral' } })), ['modelo-invalido']);
    assert.deepEqual(codigos(perfis.validarPerfis({ conversa: { modelo: 'x'.repeat(130), maxTokens: 512, privacidade: 'geral' } })), ['modelo-invalido']);
  });

  await test('o perfil PRIVADO exige o combo próprio (nunca "auto"), a chave vinculada declarada, a lista de provedores e valida o formato da decisão', () => {
    const p = EXEMPLO().privado;
    for (const modelo of ['auto', 'auto/fast', 'AUTO/smart']) assert.ok(codigos(perfis.validarPerfis({ privado: { ...p, modelo } })).includes('modelo-virtual-no-privado'), modelo);
    const { chaveVinculada, ...semChave } = p;
    assert.ok(codigos(perfis.validarPerfis({ privado: semChave })).includes('chave-vinculada-ausente'));
    assert.ok(codigos(perfis.validarPerfis({ privado: { ...p, chaveVinculada: 'sim' } })).includes('chave-vinculada-ausente'), 'só o booleano true vale');
    assert.ok(codigos(perfis.validarPerfis({ privado: { ...p, provedoresPermitidos: [] } })).includes('provedores-permitidos-ausente'));
    const { provedoresPermitidos, ...semLista } = p;
    assert.ok(codigos(perfis.validarPerfis({ privado: semLista })).includes('provedores-permitidos-ausente'));
    assert.ok(codigos(perfis.validarPerfis({ privado: { ...p, provedoresPermitidos: ['Groq Cloud!'] } })).includes('provedores-permitidos-invalidos'));
    assert.ok(codigos(perfis.validarPerfis({ privado: { ...p, decisao: { formato: 'xml', campoProvedor: 'provider' } } })).includes('decisao-invalida'));
    // sem `decisao` o perfil é válido, mas a rota NÃO habilita: formato não definido (o esperado até o Braga confirmar o formato no OmniRoute real)
    const { decisao, ...semFormato } = p;
    const v = perfis.validarPerfis({ privado: semFormato });
    assert.deepEqual(v.erros, []);
    assert.equal(v.perfis.privado.decisao, null);
    comEnv({ privado: semFormato }, () => {
      const a = perfis.avaliarConfigDoPrivado(process.env);
      assert.equal(a.ok, false);
      assert.ok(a.motivos.includes('formato-nao-definido'), a.motivos.join(','));
    });
  });

  await test('privado: o provedor da Yui precisa estar cadastrado, NÃO ser anônimo e ter chave (senão a configuração é incompleta)', () => {
    const cadastro = (extra) => JSON.stringify([{ id: 'omniroute-privado', baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: 'CHAVE_FALSA_PRIVADA', models: ['combo-privado'], ...extra }]);
    const antes = { custom: process.env.YUI_GATEWAY_CUSTOM, chave: process.env.CHAVE_FALSA_PRIVADA };
    try {
      comEnv({ privado: EXEMPLO().privado }, () => {
        delete process.env.YUI_GATEWAY_CUSTOM;
        assert.ok(perfis.avaliarConfigDoPrivado(process.env).motivos.includes('provedor-nao-cadastrado'), 'provedor ausente');
        process.env.YUI_GATEWAY_CUSTOM = cadastro({ anonymous: true });
        process.env.CHAVE_FALSA_PRIVADA = 'chave-de-teste-1234567890';
        assert.ok(perfis.avaliarConfigDoPrivado(process.env).motivos.includes('provedor-anonimo'), 'provedor anônimo');
        process.env.YUI_GATEWAY_CUSTOM = cadastro({ anonymous: false });
        delete process.env.CHAVE_FALSA_PRIVADA;
        assert.ok(perfis.avaliarConfigDoPrivado(process.env).motivos.includes('provedor-nao-cadastrado'), 'sem chave o cadastro nem entra (o Gateway ignora o provedor não anônimo sem chave)');
        process.env.CHAVE_FALSA_PRIVADA = 'chave-de-teste-1234567890';
        const ok = perfis.avaliarConfigDoPrivado(process.env);
        assert.equal(ok.ok, true, ok.motivos.join(','));
        assert.equal(ok.provedor.anonimo, false);
      });
    } finally {
      if (antes.custom === undefined) delete process.env.YUI_GATEWAY_CUSTOM; else process.env.YUI_GATEWAY_CUSTOM = antes.custom;
      if (antes.chave === undefined) delete process.env.CHAVE_FALSA_PRIVADA; else process.env.CHAVE_FALSA_PRIVADA = antes.chave;
    }
  });

  await test('o perfil `local` é reservado: aceito na configuração, nunca ativo; ligá-lo é recusado', () => {
    const r = perfis.validarPerfis({ local: { modelo: 'x', maxTokens: 256, privacidade: 'geral', habilitado: true } });
    assert.deepEqual(codigos(r), ['local-reservado']);
    const ok = perfis.validarPerfis({ local: { modelo: 'x', maxTokens: 256, privacidade: 'geral' } });
    assert.equal(ok.perfis.local.habilitado, false);
    comEnv({ local: { modelo: 'x', maxTokens: 256, privacidade: 'geral' }, conversa: EXEMPLO().conversa }, () => assert.deepEqual(chaves(perfis.perfisAtivos(process.env)), ['conversa']));
  });

  await test('JSON inválido ou fora do formato: erro registrado, nada ativo (o fluxo de hoje)', () => {
    for (const bruto of ['{isto não é json', '[1,2]', '"texto"', '42']) {
      process.env.YUI_IA_PERFIS = bruto;
      perfis.esquecerConfigDePerfisParaTeste();
      const cfg = perfis.carregarPerfis(process.env);
      assert.equal(cfg.temConfig, true);
      assert.deepEqual(perfis.perfisAtivos(process.env), {}, bruto);
      assert.ok(cfg.erros.length >= 1 && ['json-invalido', 'config-invalida'].includes(cfg.erros[0].codigo), bruto);
    }
    delete process.env.YUI_IA_PERFIS;
    perfis.esquecerConfigDePerfisParaTeste();
  });

  await test('arquivo e variável: a variável vence o arquivo, perfil por perfil; o arquivo trocado é relido; arquivo ilegível vira um erro (a variável segue)', () => {
    const arq = path.join(tmp, 'perfis.json');
    fs.writeFileSync(arq, JSON.stringify({ conversa: { modelo: 'auto', maxTokens: 512, privacidade: 'geral' }, rapido: { modelo: 'auto/fast', maxTokens: 128, privacidade: 'geral' } }));
    process.env.YUI_IA_PERFIS_ARQUIVO = arq;
    process.env.YUI_IA_PERFIS = JSON.stringify({ rapido: { modelo: 'auto/fast', maxTokens: 300, privacidade: 'geral' } });
    perfis.esquecerConfigDePerfisParaTeste();
    let cfg = perfis.carregarPerfis(process.env);
    assert.equal(cfg.origem, 'arquivo+ambiente');
    assert.equal(cfg.perfis.conversa.maxTokens, 512, 'só no arquivo');
    assert.equal(cfg.perfis.rapido.maxTokens, 300, 'a variável vence');
    const assinatura1 = cfg.assinatura;
    // o arquivo trocado (outro tamanho/data) é relido sozinho
    fs.writeFileSync(arq, JSON.stringify({ conversa: { modelo: 'auto', maxTokens: 777, privacidade: 'geral' } }) + ' ');
    cfg = perfis.carregarPerfis(process.env);
    assert.equal(cfg.perfis.conversa.maxTokens, 777);
    assert.notEqual(cfg.assinatura, assinatura1, 'a assinatura muda quando a configuração muda');
    // arquivo ilegível
    fs.writeFileSync(arq, '{ quebrado');
    cfg = perfis.carregarPerfis(process.env);
    assert.ok(codigos(cfg).includes('json-invalido'));
    assert.deepEqual(chaves(cfg.perfis), ['rapido'], 'a variável segue valendo');
    fs.rmSync(arq);
    cfg = perfis.carregarPerfis(process.env);
    assert.ok(codigos(cfg).includes('arquivo-ilegivel'));
    delete process.env.YUI_IA_PERFIS_ARQUIVO;
    delete process.env.YUI_IA_PERFIS;
    perfis.esquecerConfigDePerfisParaTeste();
  });

  await test('REINÍCIO: a configuração recuperada do arquivo é a mesma (os mesmos perfis e a mesma assinatura)', () => {
    const arq = path.join(tmp, 'perfis-reinicio.json');
    fs.writeFileSync(arq, JSON.stringify(EXEMPLO(), null, 2));
    process.env.YUI_IA_PERFIS_ARQUIVO = arq;
    perfis.esquecerConfigDePerfisParaTeste();
    const antes = perfis.carregarPerfis(process.env);
    perfis.esquecerConfigDePerfisParaTeste(); // "o processo reiniciou": nada em memória
    const depois = perfis.carregarPerfis(process.env);
    assert.deepEqual(depois.perfis, antes.perfis);
    assert.equal(depois.assinatura, antes.assinatura);
    assert.equal(depois.origem, 'arquivo');
    assert.equal(perfis.privadoDeclarado(process.env), true);
    delete process.env.YUI_IA_PERFIS_ARQUIVO;
    perfis.esquecerConfigDePerfisParaTeste();
  });

  await test('`privado` declarado mas inválido continua "declarado" (a conversa privada nunca escapa por outro caminho); `habilitado: false` desliga de propósito', () => {
    comEnv({ privado: { modelo: 'auto', maxTokens: 512, privacidade: 'privada' } }, () => {
      assert.equal(perfis.carregarPerfis(process.env).perfis.privado, undefined, 'inválido: não vale como perfil');
      assert.equal(perfis.privadoDeclarado(process.env), true, 'mas foi pedido');
    });
    comEnv({ privado: { modelo: 'auto', maxTokens: 512, privacidade: 'privada', habilitado: false } }, () => assert.equal(perfis.privadoDeclarado(process.env), false, 'desligado de propósito, mesmo inválido'));
    comEnv({ privado: { ...EXEMPLO().privado, habilitado: false } }, () => assert.equal(perfis.privadoDeclarado(process.env), false));
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('B. Os dois leitores do cabeçalho de decisão: o tolerante (só diagnóstico) e o estrito (a decisão do privado)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('TOLERANTE: pares, JSON e texto livre; guarda só palavras permitidas e números', () => {
    const pares = dec.lerDecisaoTolerante('provider=groq;strategy=priority;latency=42');
    assert.deepEqual(pares, { formato: 'pares', confirmada: true, provedor: 'groq', estrategia: 'priority', latenciaMs: 42 });
    const virgula = dec.lerDecisaoTolerante('strategy: round-robin, provider: Gemini-Pago, latency_ms=1.5s');
    assert.deepEqual([virgula.provedor, virgula.estrategia, virgula.latenciaMs], ['gemini-pago', 'round-robin', 1500]);
    const json = dec.lerDecisaoTolerante('{"provider":"groq","strategy":"priority","latency_ms":42}');
    assert.deepEqual(json, { formato: 'json', confirmada: true, provedor: 'groq', estrategia: 'priority', latenciaMs: 42 });
    const aninhado = dec.lerDecisaoTolerante('{"decision":{"selected":{"provider":{"id":"groq"}},"routing":"priority"},"elapsed_ms":"88"}');
    assert.deepEqual([aninhado.provedor, aninhado.estrategia, aninhado.latenciaMs], ['groq', 'priority', 88]);
    const livre = dec.lerDecisaoTolerante('served by groq via priority in 42ms');
    assert.deepEqual([livre.formato, livre.provedor, livre.estrategia], ['texto', 'groq', 'priority']);
    const extra = dec.lerDecisaoTolerante('atendido por meu-provedor-novo com round-robin', { conhecidos: ['meu-provedor-novo'] });
    assert.deepEqual([extra.provedor, extra.estrategia], ['meu-provedor-novo', 'round-robin'], 'os provedores da lista do dono também são reconhecidos');
  });

  await test('TOLERANTE: ausente, estranho ou sem provedor = "não confirmado" (nunca lança, nunca inventa um provedor)', () => {
    assert.deepEqual(dec.lerDecisaoTolerante(null), { formato: 'ausente', confirmada: false, provedor: null, estrategia: null, latenciaMs: null });
    assert.equal(dec.lerDecisaoTolerante('').formato, 'ausente');
    assert.equal(dec.lerDecisaoTolerante('   ').formato, 'ausente');
    for (const estranho of ['<<< ??? ### o melhor foi escolhido >>>', 'xyz', '{ quebrado', '{"a":1}', 'strategy=priority', ';;;===;;;']) {
      const r = dec.lerDecisaoTolerante(estranho);
      assert.equal(r.provedor, null, estranho);
      assert.equal(r.confirmada, false, estranho);
    }
    // nunca lança, com qualquer entrada
    for (const entrada of [undefined, 42, {}, [], () => 1, Symbol.iterator, 'x'.repeat(100_000), '\u0000\u0001\u0002', '{'.repeat(5000), '=,'.repeat(5000)]) {
      assert.doesNotThrow(() => dec.lerDecisaoTolerante(entrada));
    }
  });

  await test('TOLERANTE: um SEGREDO plantado no cabeçalho nunca sai (nem como provedor, nem como estratégia, nem como texto)', () => {
    const casos = [
      `provider=groq;strategy=priority;api_key=${SEGREDO};latency=7;nota=Bearer ${SEGREDO}`,
      `provider=${SEGREDO};strategy=priority`,
      `strategy=${SEGREDO};provider=groq`,
      JSON.stringify({ provider: 'groq', token: SEGREDO, strategy: SEGREDO, latency_ms: 5 }),
      JSON.stringify({ provider: SEGREDO }),
      `served by groq with ${SEGREDO}`,
      `Authorization: Bearer ${SEGREDO} provider=groq`,
    ];
    for (const c of casos) {
      const r = dec.lerDecisaoTolerante(c);
      const texto = JSON.stringify(r);
      assert.ok(!texto.includes(SEGREDO) && !texto.includes('SEGREDO'), `vazou em: ${c.slice(0, 60)} -> ${texto}`);
    }
    assert.equal(dec.lerDecisaoTolerante(`provider=${SEGREDO};strategy=priority`).provedor, null);
    assert.equal(dec.lerDecisaoTolerante(`provider=groq;strategy=${SEGREDO}`).estrategia, null);
    assert.equal(dec.pareceSegredo('groq'), false);
    assert.equal(dec.pareceSegredo('gemini-pago'), false);
    assert.equal(dec.pareceSegredo('sk-abc'), true);
    assert.equal(dec.pareceSegredo('a'.repeat(30)), true, 'texto longo sem separador parece segredo');
  });

  await test('ESTRITO: só lê o formato DECLARADO ("pares" com o campo, ou "json" com o caminho do campo)', () => {
    const pares = dec.validarFormatoEstrito({ formato: 'pares', campoProvedor: 'provider' }).formato;
    assert.deepEqual(dec.lerDecisaoEstrita('provider=groq;strategy=priority;latency=42', pares), { ok: true, provedor: 'groq' });
    assert.deepEqual(dec.lerDecisaoEstrita('Strategy=priority;PROVIDER=Groq', pares), { ok: true, provedor: 'groq' }, 'chave e valor sem diferenciar caixa');
    const barra = dec.validarFormatoEstrito({ formato: 'pares', campoProvedor: 'p', separador: '|' }).formato;
    assert.deepEqual(dec.lerDecisaoEstrita('s=priority|p=groq', barra), { ok: true, provedor: 'groq' });
    const json = dec.validarFormatoEstrito({ formato: 'json', campoProvedor: 'decision.provider' }).formato;
    assert.deepEqual(dec.lerDecisaoEstrita('{"decision":{"provider":"groq"}}', json), { ok: true, provedor: 'groq' });
  });

  await test('ESTRITO: ausente, inválido, em formato desconhecido ou sem o campo = NÃO vale (cada um com o seu motivo)', () => {
    const pares = dec.validarFormatoEstrito({ formato: 'pares', campoProvedor: 'provider' }).formato;
    const json = dec.validarFormatoEstrito({ formato: 'json', campoProvedor: 'provider' }).formato;
    const m = (valor, f) => dec.lerDecisaoEstrita(valor, f).motivo;
    assert.equal(m(null, pares), 'cabecalho-ausente');
    assert.equal(m(undefined, pares), 'cabecalho-ausente');
    assert.equal(m('   ', pares), 'cabecalho-ausente');
    assert.equal(m('x'.repeat(3000), pares), 'cabecalho-invalido');
    assert.equal(m('provider=groq\u0000', pares), 'cabecalho-invalido');
    assert.equal(m(12345, pares), 'cabecalho-invalido');
    assert.equal(m('<<< ??? >>>', pares), 'formato-desconhecido');
    assert.equal(m('served by groq via priority', pares), 'formato-desconhecido', 'o que o tolerante entende, o estrito NÃO aceita');
    assert.equal(m('provider=groq;;strategy=priority', pares), 'formato-desconhecido', 'segmento vazio');
    assert.equal(m('provider=groq;provider=anonimo-x', pares), 'formato-desconhecido', 'campo repetido');
    assert.equal(m('provider = groq', pares), 'formato-desconhecido', 'espaço dentro do par');
    assert.equal(m('strategy=priority;latency=42', pares), 'campo-ausente');
    assert.equal(m('provider=sk-SEGREDO-PLANTADO-9f8e7d6c5b4a39281706', pares), 'provedor-invalido', 'segredo no campo do provedor');
    assert.equal(m('provider=Groq Cloud', pares), 'formato-desconhecido');
    assert.equal(m('provider=groq', json), 'formato-desconhecido', 'o formato declarado é JSON');
    assert.equal(m('{ quebrado', json), 'formato-desconhecido');
    assert.equal(m('["groq"]', json), 'formato-desconhecido');
    assert.equal(m('{"strategy":"priority"}', json), 'campo-ausente');
    assert.equal(m('{"provider":42}', json), 'provedor-invalido');
    assert.equal(m('{"provider":"sk-SEGREDO-PLANTADO-9f8e7d6c5b4a39281706"}', json), 'provedor-invalido');
    assert.equal(m('provider=groq', null), 'formato-nao-definido', 'sem a definição do formato o leitor estrito não lê nada');
    for (const entrada of [undefined, {}, [], 'x'.repeat(100_000), '{'.repeat(5000)]) assert.doesNotThrow(() => dec.lerDecisaoEstrita(entrada, pares));
  });

  await test('ESTRITO: a definição do formato é fechada (só "pares" ou "json", chaves conhecidas); sem definição = não definido', () => {
    assert.equal(dec.validarFormatoEstrito(undefined).codigo, 'formato-nao-definido');
    assert.equal(dec.validarFormatoEstrito(null).codigo, 'formato-nao-definido');
    for (const ruim of [[], 'pares', { formato: 'xml', campoProvedor: 'p' }, { formato: 'pares' }, { formato: 'pares', campoProvedor: '1x' }, { formato: 'pares', campoProvedor: 'p', separador: '&' },
      { formato: 'json', campoProvedor: 'p', separador: ';' }, { formato: 'pares', campoProvedor: 'p', extra: 1 }, { formato: 'pares', campoProvedor: 'p', cabecalho: 'X Invalido' }]) {
      assert.equal(dec.validarFormatoEstrito(ruim).codigo, 'formato-invalido', JSON.stringify(ruim));
    }
    const ok = dec.validarFormatoEstrito({ formato: 'pares', campoProvedor: 'provider' });
    assert.deepEqual(ok.formato, { cabecalho: 'x-omniroute-decision', formato: 'pares', campoProvedor: 'provider', separador: ';' });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('C. O seletor de perfil do cérebro (determinístico) e o limite de tokens efetivo');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const ATIVOS = () => Object.fromEntries(Object.entries(perfis.validarPerfis(EXEMPLO()).perfis).filter(([n, p]) => p.habilitado && n !== 'local'));
  const sel = (t, o = {}) => seletor.selecionarPerfil(t, { env: {}, ativos: ATIVOS(), privado: true, ...o });
  const nome = (r) => r?.nome ?? null;

  await test('SEM nenhum perfil configurado o seletor devolve null em TODOS os pontos (o fluxo de hoje: nenhum campo novo vai à chamada de IA)', () => {
    for (const ponto of seletor.PONTOS_DE_CHAMADA) {
      for (const privada of [false, true]) {
        for (const imagem of [false, true]) {
          assert.equal(seletor.selecionarPerfil({ ponto, privada, imagem, texto: 'function f() { return 1; }' }, { env: {}, ativos: {}, privado: false }), null, `${ponto}/${privada}/${imagem}`);
        }
      }
    }
    // e pelo ambiente de verdade (sem YUI_IA_PERFIS)
    assert.equal(seletor.selecionarPerfil({ ponto: 'conversa', texto: 'oi' }), null);
    assert.deepEqual(seletor.campoPerfil(null), {});
    assert.deepEqual(seletor.campoPerfil(undefined), {});
    assert.deepEqual(seletor.campoPerfil({ nome: 'conversa' }), { perfil: { nome: 'conversa' } });
  });

  await test('o perfil de cada ponto de chamada: a conversa, a síntese da pesquisa, os comentários, o otimizador da busca, a voz', () => {
    assert.equal(nome(sel({ ponto: 'conversa', texto: 'oi, tudo bem?' })), 'conversa');
    assert.equal(nome(sel({ ponto: 'sintese-pesquisa' })), 'pesquisa');
    assert.equal(nome(sel({ ponto: 'comentario' })), 'rapido');
    assert.equal(nome(sel({ ponto: 'otimizador-busca' })), 'rapido');
    assert.equal(nome(sel({ ponto: 'conversa-voz', texto: 'oi' })), 'rapido');
    assert.equal(nome(sel({ ponto: 'ponto-que-nao-existe', texto: 'oi' })), 'conversa', 'ponto desconhecido: a conversa');
    // o ponto e o motivo seguem na resposta (para o diagnóstico)
    assert.deepEqual(sel({ ponto: 'comentario' }), { nome: 'rapido', ponto: 'comentario', motivo: 'comentario' });
  });

  await test('imagem anexada: o perfil visão (mas só quando está configurado)', () => {
    assert.equal(nome(sel({ ponto: 'conversa', imagem: true, texto: 'olha isso' })), 'visao');
    const semVisao = ATIVOS();
    delete semVisao.visao;
    assert.equal(nome(sel({ ponto: 'conversa', imagem: true, texto: 'olha isso' }, { ativos: semVisao })), 'conversa', 'sem o perfil visão, segue a regra do ponto');
    // o marcador do bloco de visão que o bot põe no prompt (messageCreate.js) é reconhecido, e o texto existe no código do bot
    assert.ok(seletor.MARCADOR_DE_IMAGEM.test('Descrição da(s) 2 imagem(ns) anexada(s), feita por um modelo de visão'));
    assert.ok(fs.readFileSync(path.join(repoRoot, 'src/events/messageCreate.js'), 'utf8').includes('Descrição da(s) ${vision.count} imagem(ns) anexada(s)'), 'o texto que o seletor reconhece mudou no bot');
  });

  await test('conversa privada: o perfil `privado` vence tudo (imagem, escalada, ponto); sem o perfil privado declarado, null (o fluxo de hoje)', () => {
    for (const ponto of seletor.PONTOS_DE_CHAMADA) assert.equal(nome(sel({ ponto, privada: true, texto: 'function a() { return 1; }', imagem: true })), 'privado', ponto);
    assert.equal(sel({ ponto: 'conversa', privada: true }, { privado: false }), null);
    // `privado` declarado mas inválido: ainda é o `privado` (a chamada falha fechada lá na rota, nunca escapa para outro perfil)
    assert.equal(nome(sel({ ponto: 'conversa', privada: true }, { ativos: {}, privado: true })), 'privado');
    // com só o privado configurado, a chamada PÚBLICA não usa perfil (null)
    assert.equal(sel({ ponto: 'conversa', privada: false }, { ativos: { privado: ATIVOS().privado }, privado: true }), null);
  });

  await test('ESCALADA para raciocínio: código, planejamento e contexto longo; conversa curta e comum não escala', () => {
    const conv = (texto, extra = {}) => sel({ ponto: 'conversa', texto, ...extra });
    assert.equal(nome(conv('oi, tudo bem com você hoje?')), 'conversa');
    assert.equal(nome(conv('qual a capital da França?')), 'conversa');
    // código
    assert.equal(nome(conv('olha esse erro:\n```\nTypeError: x is undefined\n```')), 'raciocinio');
    assert.equal(nome(conv('Uncaught ReferenceError: foo is not defined')), 'raciocinio');
    assert.equal(nome(conv('const a = 1; function f() { return a; } export default f;')), 'raciocinio', 'palavras e símbolos de código');
    assert.equal(nome(conv('o que significa const em português?')), 'conversa', 'uma palavra solta não basta');
    // planejamento
    assert.equal(nome(conv('Monte um plano de ação para eu estudar para o concurso nos próximos três meses')), 'raciocinio');
    assert.equal(nome(conv('compare as vantagens e desvantagens de cada arquitetura possível aqui')), 'raciocinio');
    assert.equal(nome(conv('plano de')), 'conversa', 'frase curta demais');
    // contexto longo
    assert.equal(nome(conv('e agora?', { historicoChars: 9000 })), 'raciocinio');
    assert.equal(nome(conv('e agora?', { historicoChars: 100 })), 'conversa');
    // o motivo diz por quê
    assert.match(conv('olha esse erro:\n```\nx\n```').motivo, /^escalada:codigo/);
    assert.match(conv('e agora?', { historicoChars: 9000 }).motivo, /^escalada:contexto/);
    // a escalada só vale para a CONVERSA: o comentário e a síntese não escalam
    assert.equal(nome(sel({ ponto: 'comentario', texto: '```código```' })), 'rapido');
    assert.equal(nome(sel({ ponto: 'sintese-pesquisa', texto: '```código```' })), 'pesquisa');
  });

  await test('a escalada é AJUSTÁVEL: YUI_IA_ESCALADA (off ou lista de sinais) e YUI_IA_ESCALADA_CONTEXTO_CHARS', () => {
    const conv = (texto, env, extra = {}) => sel({ ponto: 'conversa', texto, ...extra }, { env });
    assert.equal(nome(conv('```x```', { YUI_IA_ESCALADA: 'off' })), 'conversa');
    assert.equal(nome(conv('```x```', { YUI_IA_ESCALADA: 'false' })), 'conversa');
    assert.equal(nome(conv('```x```', { YUI_IA_ESCALADA: 'on' })), 'raciocinio');
    assert.equal(nome(conv('```x```', { YUI_IA_ESCALADA: 'planejamento,contexto' })), 'conversa', 'sem o sinal "codigo"');
    assert.equal(nome(conv('```x```', { YUI_IA_ESCALADA: 'codigo' })), 'raciocinio');
    assert.equal(nome(conv('e agora?', {}, { historicoChars: 3000 })), 'conversa');
    assert.equal(nome(conv('e agora?', { YUI_IA_ESCALADA_CONTEXTO_CHARS: '2000' }, { historicoChars: 3000 })), 'raciocinio');
    assert.equal(nome(conv('e agora?', { YUI_IA_ESCALADA_CONTEXTO_CHARS: '100' }, { historicoChars: 3000 })), 'conversa', 'valor abaixo de 500 volta ao padrão (8000)');
    assert.deepEqual(seletor.sinaisDeEscalada({ texto: '```x```' }, { YUI_IA_ESCALADA: 'off' }), []);
  });

  await test('perfil não configurado: rapido, pesquisa e raciocinio descem para a conversa; sem a conversa, null (o fluxo de hoje)', () => {
    const so = (...nomes) => Object.fromEntries(nomes.map((n) => [n, ATIVOS()[n]]));
    assert.equal(nome(sel({ ponto: 'comentario' }, { ativos: so('conversa') })), 'conversa');
    assert.equal(sel({ ponto: 'comentario' }, { ativos: so('conversa') }).motivo, 'comentario+sem-rapido');
    assert.equal(nome(sel({ ponto: 'sintese-pesquisa' }, { ativos: so('conversa', 'rapido') })), 'conversa');
    assert.equal(nome(sel({ ponto: 'conversa', texto: '```x```' }, { ativos: so('conversa') })), 'conversa', 'sem raciocínio, a conversa atende');
    assert.equal(sel({ ponto: 'conversa', texto: 'oi' }, { ativos: so('rapido') }), null, 'só o rápido configurado: a conversa fica como hoje');
    assert.equal(nome(sel({ ponto: 'comentario' }, { ativos: so('rapido') })), 'rapido');
  });

  await test('DETERMINISMO e ISOLAMENTO: o mesmo pedido dá sempre o mesmo perfil, e um pedido nunca é afetado por outros (nenhum estado entre chamadas)', () => {
    const braga = { ponto: 'conversa', privada: true, texto: 'minha senha do banco é sigilosa' };
    const membro = { ponto: 'conversa', privada: false, texto: 'qual o melhor carro do GTA?' };
    const ref = { braga: sel(braga), membro: sel(membro) };
    assert.equal(nome(ref.braga), 'privado');
    assert.equal(nome(ref.membro), 'conversa');
    for (let i = 0; i < 200; i += 1) {
      // intercalado, em ordens diferentes: o resultado de cada um só depende dos próprios dados
      if (i % 2) { assert.deepEqual(sel(membro), ref.membro); assert.deepEqual(sel(braga), ref.braga); } else { assert.deepEqual(sel(braga), ref.braga); assert.deepEqual(sel(membro), ref.membro); }
    }
    // a função não toca disco, rede nem processo (sem estado e sem efeito colateral): o corpo não importa nada além do perfis.js
    const fonte = fs.readFileSync(path.join(repoRoot, 'src/cerebro/seletorPerfil.js'), 'utf8');
    assert.deepEqual([...fonte.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]), ['../core/ai/perfis.js']);
    assert.equal(redeTentada, 0);
  });

  await test('LIMITE DE TOKENS: o menor entre o maxTokens do perfil, a capacidade CONHECIDA e o teto (nunca passa de 4096); capacidade desconhecida não se inventa', () => {
    const p = (maxTokens) => ({ nome: 'conversa', modelo: 'auto', maxTokens, privacidade: 'geral', provedor: 'omniroute', habilitado: true });
    const desconhecido = { id: 'omniroute', maxTokens: null };
    assert.deepEqual(perfis.limiteDoPerfil(p(1024), desconhecido, {}), { efetivo: 1024, doPerfil: 1024, capacidade: null, teto: 4096 }, 'capacidade desconhecida: fica fora da conta');
    assert.equal(perfis.limiteDoPerfil(p(8192), desconhecido, {}).efetivo, 4096, 'o teto de 4096 corta');
    assert.equal(perfis.limiteDoPerfil(p(4096), desconhecido, {}).efetivo, 4096);
    assert.equal(perfis.limiteDoPerfil(p(8192), desconhecido, { YUI_MAX_TOKENS_TETO: '8192' }).efetivo, 4096, 'mesmo com o teto global em 8192, o perfil nunca passa de 4096');
    assert.equal(perfis.limiteDoPerfil(p(2048), desconhecido, { YUI_MAX_TOKENS_TETO: '512' }).efetivo, 512, 'o teto global menor vale');
    assert.equal(perfis.limiteDoPerfil(p(2048), { id: 'omniroute', maxTokens: 700 }, {}).efetivo, 700, 'a capacidade declarada corta');
    assert.equal(perfis.limiteDoPerfil(p(2048), { id: 'omniroute', maxTokens: 700 }, {}).capacidade, 700);
    assert.equal(perfis.limiteDoPerfil(p(8192), { id: 'groq', maxTokens: null }, {}).capacidade, 8192, 'capacidade da tabela da Yui para um provedor que ela conhece');
    assert.equal(perfis.limiteDoPerfil(p(8192), { id: 'cloudflare', maxTokens: null }, {}).efetivo, 2048, 'a capacidade da tabela (2048) corta');
    assert.equal(perfis.capacidadeConhecida({ id: 'omniroute' }), null);
    assert.equal(perfis.TETO_DO_PERFIL, 4096);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('D. O motor do agente: o Mastra não está implementado; o contrato (a ferramenta de qualquer motor passa pelo guardToolCall e pelo motor de políticas)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('YUI_MOTOR_AGENTE: o padrão é "nativo"; "mastra" e qualquer outro valor são RECUSADOS e o motor ativo continua sendo o nativo', () => {
    assert.deepEqual(motor.lerMotorAgente({}), { pedido: 'nativo', ativo: 'nativo', recusado: false, motivo: null });
    assert.deepEqual(motor.lerMotorAgente({ YUI_MOTOR_AGENTE: ' NATIVO ' }), { pedido: 'nativo', ativo: 'nativo', recusado: false, motivo: null });
    assert.deepEqual(motor.lerMotorAgente({ YUI_MOTOR_AGENTE: 'mastra' }), { pedido: 'mastra', ativo: 'nativo', recusado: true, motivo: 'motor-nao-implementado' });
    assert.deepEqual(motor.lerMotorAgente({ YUI_MOTOR_AGENTE: 'MASTRA' }), { pedido: 'mastra', ativo: 'nativo', recusado: true, motivo: 'motor-nao-implementado' });
    assert.equal(motor.lerMotorAgente({ YUI_MOTOR_AGENTE: 'openclaw' }).motivo, 'motor-desconhecido');
    assert.deepEqual(motor.lerMotorAgente({ YUI_MOTOR_AGENTE: '$(rm -rf /)' }), { pedido: 'invalido', ativo: 'nativo', recusado: true, motivo: 'motor-desconhecido' });
    assert.equal(motor.MOTORES.mastra.implementado, false);
    assert.equal(motor.MOTORES.nativo.implementado, true);
  });

  await test('o cérebro RECUSA o Mastra, REGISTRA (log e auditoria) e continua no nativo; o diagnóstico mostra o pedido recusado', () => {
    const linhas = [];
    const eventos = [];
    const r = motor.escolherMotorAgente({ YUI_MOTOR_AGENTE: 'mastra' }, { logger: { warn: (m) => linhas.push(m) }, auditFn: (ev, _c, d) => eventos.push([ev, d]) });
    assert.equal(r.ativo, 'nativo');
    assert.equal(r.recusado, true);
    assert.equal(linhas.length, 1);
    assert.match(linhas[0], /YUI_MOTOR_AGENTE="mastra" foi recusado.*segue no motor nativo/);
    assert.deepEqual(eventos, [['ia.motor_recusado', { pedido: 'mastra', motivo: 'motor-nao-implementado', ativo: 'nativo' }]]);
    assert.deepEqual(motor.estadoDoMotor(), { pedido: 'mastra', ativo: 'nativo', recusado: true, motivo: 'motor-nao-implementado', implementados: { nativo: true, mastra: false } });
    const d = diag.montarDiagnostico({ fontes: { motor: () => motor.estadoDoMotor(), bancos: () => [], erros: () => ({ errors: 0 }) } });
    assert.deepEqual(d.motorAgente, { pedido: 'mastra', ativo: 'nativo', recusado: true, motivo: 'motor-nao-implementado', implementados: { nativo: true, mastra: false } });
    assert.ok(d.motivos.some((m) => m.codigo === 'motor-recusado'));
    // o motor padrão limpa o estado (e não registra nada)
    const limpo = [];
    motor.escolherMotorAgente({}, { logger: { warn: (m) => limpo.push(m) }, auditFn: () => limpo.push('audit') });
    assert.deepEqual(limpo, []);
    assert.equal(motor.estadoDoMotor().recusado, false);
    // sem o import do Mastra em lugar nenhum do código
    const src = fs.readFileSync(path.join(repoRoot, 'src/core/ai/motorAgente.js'), 'utf8');
    assert.ok(!/from\s+['"]@?mastra/i.test(src) && !/import\(['"]@?mastra/i.test(src), 'o motor não importa o Mastra');
  });

  await test('MOTOR FALSO pedindo ferramenta: o guardToolCall e o motor de políticas continuam OBRIGATÓRIOS (enforce nega; o executor nem é chamado)', async () => {
    const eventos = [];
    // o dono APERTOU a categoria de mídia (POLICY_MEDIA_AUTONOMY=DENY): em enforce o motor de políticas nega o download
    const engine = createPolicyEngine({ env: { YUI_POLICY_MODE: 'enforce', POLICY_MEDIA_AUTONOMY: 'DENY' }, auditFn: () => {} });
    const guard = (args) => guardToolCall({ ...args, engine, auditFn: (ev, _c, d) => eventos.push([ev, d]) });
    const chamadas = [];
    const executor = async (ferramenta, argumentos) => { chamadas.push([ferramenta, argumentos]); return 'baixei'; };
    const falso = { nome: 'motor-falso', async executar() { return { texto: 'vou baixar', pedidos: [{ ferramenta: 'download_audio', argumentos: { url: 'https://exemplo.test/a' } }] }; } };
    const r = await motor.rodarMotor(falso, { mensagem: 'baixa isso' }, { userId: MEMBER, guildId: GUILD, channelId: '555555555555555555' }, { executor, guard, auditFn: () => {} });
    assert.deepEqual(chamadas, [], 'o executor NÃO foi chamado: o motor de políticas negou');
    assert.equal(r.resultados.length, 1);
    assert.equal(r.resultados[0].ok, false);
    assert.equal(r.resultados[0].bloqueado, true);
    assert.match(r.resultados[0].mensagem, /não é permitido pela política/);
    assert.equal(eventos.length, 1, 'a decisão do motor de políticas foi auditada');
    assert.equal(eventos[0][0], 'policy.interaction_blocked');
    assert.equal(eventos[0][1].tool, 'download_audio');
  });

  await test('MOTOR FALSO: com a política liberando, o pedido passa pelo MESMO executor, uma vez, depois do guarda (e o guarda foi consultado antes)', async () => {
    const ordem = [];
    const guard = (args) => { ordem.push(['guard', args.tool, args.userId]); return null; };
    const executor = async (ferramenta, argumentos) => { ordem.push(['executor', ferramenta, argumentos]); return 'ok'; };
    // o motor chama pedirFerramenta durante a execução E devolve outro pedido: o limite padrão é UM pedido por turno
    const falso = { nome: 'motor-falso', async executar(_entrada, api) { await api.pedirFerramenta({ ferramenta: 'search_web', argumentos: { q: 'x' } }); return { pedidos: [{ ferramenta: 'search_web', argumentos: { q: 'y' } }] }; } };
    const r = await motor.rodarMotor(falso, {}, { userId: OWNER, isDM: true }, { executor, guard, auditFn: () => {} });
    assert.deepEqual(ordem, [['guard', 'search_web', OWNER], ['executor', 'search_web', { q: 'x' }]], 'guarda ANTES do executor, e só um pedido');
    assert.equal(r.resultados.length, 2);
    assert.equal(r.resultados[0].ok, true);
    assert.deepEqual([r.resultados[1].ok, r.resultados[1].motivo], [false, 'limite-de-pedidos']);
    // com maxPedidos 2, os dois passam (cada um pelo guarda)
    ordem.length = 0;
    await motor.rodarMotor(falso, {}, { userId: OWNER, isDM: true }, { executor, guard, auditFn: () => {}, maxPedidos: 2 });
    assert.deepEqual(ordem.map((x) => x[0]), ['guard', 'executor', 'guard', 'executor']);
  });

  await test('o motor só recebe `pedirFerramenta` (nunca o executor), o pedido é só dado e o guarda que falha vale como BLOQUEIO', async () => {
    let visto = null;
    const executorChamado = [];
    const executor = async (f) => { executorChamado.push(f); return 1; };
    const falso = { nome: 'm', async executar(_e, api) { visto = Object.keys(api); try { api.executor = () => 1; } catch { /* congelado */ } return { pedidos: [
      { ferramenta: 'search_web', argumentos: { funcao: () => 'x' } },     // função dentro dos argumentos
      { ferramenta: 'nome inválido!', argumentos: {} },                    // nome estranho
      { ferramenta: 'search_web', argumentos: ['lista'] },                 // argumentos que não são um objeto
      { ferramenta: 'search_web', argumentos: { texto: 'a'.repeat(30_000) } }, // enorme
      { executar: () => 1 },                                               // um pedido que traz código
      'search_web',                                                        // texto, não um pedido
    ] }; } };
    const r = await motor.rodarMotor(falso, {}, { userId: OWNER }, { executor, guard: () => null, auditFn: () => {}, maxPedidos: 10 });
    assert.deepEqual(visto, ['pedirFerramenta'], 'só o caminho guardado');
    assert.deepEqual(executorChamado, [], 'nenhum pedido inválido chegou ao executor');
    assert.equal(r.resultados.length, 6);
    assert.ok(r.resultados.every((x) => x.ok === false && x.motivo === 'pedido-invalido'));
    // o guarda que lança é BLOQUEIO
    const r2 = await motor.pedirFerramenta({ ferramenta: 'search_web', argumentos: {} }, { userId: OWNER }, { executor, guard: () => { throw new Error('quebrou'); }, auditFn: () => {} });
    assert.deepEqual([r2.ok, r2.bloqueado], [false, true]);
    assert.deepEqual(executorChamado, []);
    // sem executor: nada roda
    assert.equal((await motor.pedirFerramenta({ ferramenta: 'search_web' }, { userId: OWNER }, { guard: () => null, auditFn: () => {} })).motivo, 'sem-executor');
    // motor inválido
    assert.equal((await motor.rodarMotor({ nome: 'x' }, {}, {}, { executor, auditFn: () => {} })).resultados[0].motivo, 'motor-invalido');
  });

  await test('o MODELO escolhido (o perfil) NÃO concede permissão: o guardToolCall decide igual para qualquer perfil configurado', () => {
    const engine = createPolicyEngine({ env: { YUI_POLICY_MODE: 'enforce', POLICY_MEDIA_AUTONOMY: 'DENY' }, auditFn: () => {} });
    const decidir = () => guardToolCall({ tool: 'download_audio', userId: MEMBER, guildId: GUILD, channelId: '555555555555555555', engine, auditFn: () => {} });
    const semPerfil = decidir();
    assert.ok(semPerfil, 'com a categoria apertada pelo dono a ferramenta é negada');
    for (const nomeDoPerfil of ['conversa', 'rapido', 'pesquisa', 'raciocinio', 'privado', 'visao']) {
      comEnv({ [nomeDoPerfil]: nomeDoPerfil === 'privado' ? EXEMPLO().privado : { modelo: 'auto', maxTokens: 256, privacidade: 'geral' } }, () => assert.deepEqual(decidir(), semPerfil, nomeDoPerfil));
    }
    // o módulo dos perfis nem importa o guarda nem as permissões
    const fonte = fs.readFileSync(path.join(repoRoot, 'src/core/ai/perfis.js'), 'utf8');
    assert.ok(!/permissions|discordGuard|policyEngine|permissionMatrix/.test([...fonte.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).join(' ')));
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('E. O diagnóstico dos perfis (lista de permitidos) e a preservação (sem perfil, a chamada é idêntica)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const fontesBase = { bancos: () => [], erros: () => ({ errors: 0 }) };

  await test('o FORMATO fixo: as chaves das seções novas são exatamente as documentadas; sem perfis, tudo "desligada" e o estado geral é ok', () => {
    const d = diag.montarDiagnostico({ fontes: { ...fontesBase, perfisIa: () => rota.estadoDosPerfis({}), motor: () => motor.estadoDoMotor() } });
    assert.deepEqual(chaves(d.perfisDeIa), ['configurado', 'errosDeConfiguracao', 'origem', 'perfis', 'rotaPrivada', 'totais', 'ultimas']);
    assert.deepEqual(chaves(d.perfisDeIa.rotaPrivada), ['estado', 'falhasRecentes', 'falhasSeguidas', 'formatoDefinido', 'motivo', 'motivos', 'sondaSozinhaPausada', 'sondas', 'sondasValidas', 'ultimaSondaHaSegundos', 'violacoes']);
    assert.deepEqual(chaves(d.perfisDeIa.totais), ['chamadas', 'erros', 'fallbacks', 'fechadas', 'ok', 'recusadasPorPrivacidade']);
    assert.deepEqual(chaves(d.motorAgente), ['ativo', 'implementados', 'motivo', 'pedido', 'recusado']);
    assert.equal(d.perfisDeIa.configurado, false);
    assert.equal(d.perfisDeIa.rotaPrivada.estado, 'desligada');
    assert.equal(d.estado, 'ok', JSON.stringify(d.motivos));
  });

  await test('uma fonte ENVENENADA (segredo, chave, cabeçalho, prompt, ids) não vaza: só palavras da lista, nomes filtrados e números', () => {
    const veneno = {
      configurado: true, origem: `${SEGREDO}`, errosDeConfiguracao: [{ perfil: SEGREDO, codigo: SEGREDO }, { perfil: 'conversa', codigo: 'modelo-chaos' }],
      perfis: [
        { nome: 'conversa', habilitado: true, privacidade: 'geral', combo: 'auto', provedorDaYui: 'omniroute', provedorCadastrado: true, maxTokens: 1024, limiteEfetivo: 1024, capacidadeConhecida: null, chamadas: 3, ok: 2, erros: 1, fallbacks: 1, fechadas: 0, recusadasPorPrivacidade: 0, chave: SEGREDO, prompt: SEGREDO },
        { nome: SEGREDO, combo: SEGREDO },
        { nome: 'privado', habilitado: true, privacidade: 'privada', combo: `combo ${SEGREDO}`, provedorDaYui: `${OWNER}${OWNER}`, chamadas: 1 },
      ],
      totais: { chamadas: 4, texto: SEGREDO },
      ultimas: [
        { quando: new Date().toISOString(), ponto: 'conversa', perfil: 'conversa', combo: 'auto', provedor: 'groq', estrategia: 'priority', fallback: false, limiteTokens: 1024, latenciaMs: 40, resultado: 'ok', decisao: 'confirmada', motivo: null, cabecalho: `provider=groq;api_key=${SEGREDO}`, prompt: SEGREDO },
        { quando: SEGREDO, ponto: SEGREDO, perfil: SEGREDO, combo: SEGREDO, provedor: SEGREDO, estrategia: `strategy=${SEGREDO}`, fallback: 'sim', limiteTokens: SEGREDO, latenciaMs: SEGREDO, resultado: SEGREDO, decisao: SEGREDO, motivo: SEGREDO },
      ],
      rotaPrivada: { estado: SEGREDO, motivo: SEGREDO, motivos: [SEGREDO, 'config-ok'], formatoDefinido: SEGREDO, sondas: SEGREDO, violacoes: 2, ultimaSondaHaSegundos: 5, cabecalho: SEGREDO },
    };
    const d = diag.montarDiagnostico({ fontes: { ...fontesBase, perfisIa: () => veneno, motor: () => ({ pedido: SEGREDO, ativo: SEGREDO, recusado: 'sim', motivo: SEGREDO }) } });
    const texto = JSON.stringify(d);
    assert.ok(!texto.includes(SEGREDO) && !texto.includes('SEGREDO'), 'o segredo plantado saiu no diagnóstico');
    assert.ok(!texto.includes(OWNER), 'nenhum id de pessoa');
    assert.ok(!/provider=|api_key|Bearer/.test(texto), 'nada do cabeçalho');
    assert.equal(d.perfisDeIa.perfis.length, 2, 'o perfil com nome inválido some');
    assert.deepEqual(d.perfisDeIa.perfis[0], { nome: 'conversa', habilitado: true, privacidade: 'geral', combo: 'auto', provedorDaYui: 'omniroute', provedorCadastrado: true, maxTokens: 1024, limiteEfetivo: 1024, capacidadeConhecida: null, chamadas: 3, ok: 2, erros: 1, fallbacks: 1, fechadas: 0, recusadasPorPrivacidade: 0 });
    assert.equal(d.perfisDeIa.ultimas[0].provedorQueRespondeu, 'groq');
    assert.equal(d.perfisDeIa.ultimas[1].provedorQueRespondeu, null);
    assert.equal(d.perfisDeIa.rotaPrivada.estado, 'desligada', 'um estado fora da lista vira "desligada"');
    assert.deepEqual(d.perfisDeIa.rotaPrivada.motivos, ['config-ok']);
    assert.equal(d.motorAgente.pedido, 'nativo');
    assert.equal(d.motorAgente.recusado, false);
  });

  await test('o estado geral: rota privada BLOQUEADA é "problema"; não validada, perfis com erro e motor recusado são "atenção"', () => {
    const de = (rotaPrivada, extra = {}) => diag.montarDiagnostico({ fontes: { ...fontesBase, perfisIa: () => ({ configurado: true, origem: 'ambiente', perfis: [], rotaPrivada, ...extra }) } });
    const bloqueada = de({ estado: 'bloqueada', motivo: 'provedor-fora-da-lista', violacoes: 1 });
    assert.equal(bloqueada.estado, 'problema');
    assert.ok(bloqueada.motivos.some((m) => m.codigo === 'rota-privada-bloqueada'));
    for (const e of ['nao-validada', 'incompleta', 'nao-verificada']) {
      const d = de({ estado: e, motivo: 'formato-nao-definido' });
      assert.equal(d.estado, 'atencao', e);
      assert.ok(d.motivos.some((m) => m.codigo === 'rota-privada-nao-validada'), e);
    }
    assert.equal(de({ estado: 'validada' }).estado, 'ok');
    assert.equal(de({ estado: 'desligada' }, { errosDeConfiguracao: [{ perfil: 'conversa', codigo: 'modelo-chaos' }] }).motivos[0].codigo, 'perfis-com-erro');
  });

  await test('PRESERVAÇÃO: sem perfil configurado o cérebro chama a IA com EXATAMENTE os mesmos argumentos de antes (nenhum campo novo), e o ai.chat repassa ao backend o de sempre', async () => {
    const vistos = [];
    const ai = { listBackends: () => [{ name: 'falsa', active: true }], chat: async (a) => { vistos.push(a); return 'resposta'; }, isolatedChat: async (a) => { vistos.push(a); return 'resposta'; } };
    const brain = conversa.createChatBrain({ ai, context: { enabled: () => false }, memoryBlock: async () => '', persona: () => 'PERSONA', tools: () => [] });
    const turno = (id) => ({ turn: { id, at: Date.now() - 100 }, ctx: { platform: 'discord', userId: MEMBER, guildId: GUILD, channelId: '555555555555555555', isDM: false }, call: { entry: 'fila', type: 'mention', mentionsBot: true }, prompt: 'oi', ownText: 'oi', channel: {}, options: { main: true, persona: true } });
    await brain.turn(turno('turno-p1'), { role: 'bot' });
    assert.equal(vistos.length, 1);
    assert.deepEqual(chaves(vistos[0]), ['ctx', 'history', 'memoryBlock', 'prompt', 'sensitive', 'system', 'tokensPorProvedor'], 'o conjunto de campos de sempre, sem `perfil`');
    assert.ok(!Object.hasOwn(vistos[0], 'perfil'));
    // o AI Manager sem `perfil`: o backend recebe o de sempre
    const recebidos = [];
    manager.registerBackend({ name: 'teste-preservacao', local: false, chat: async (a) => { recebidos.push(a); return 'texto'; } }, { activate: true });
    await manager.chat({ prompt: 'p', system: 'S', history: [], ctx: { userId: MEMBER }, memoryBlock: '', tokensPorProvedor: true });
    assert.deepEqual(chaves(recebidos[0]), ['ctx', 'history', 'memoryBlock', 'prompt', 'system', 'tokensPorProvedor']);
    // com o `perfil` pedido mas NENHUMA configuração: também vai ao backend, sem rota por perfil
    await manager.chat({ prompt: 'p', system: 'S', history: [], ctx: { userId: MEMBER }, memoryBlock: '', perfil: { nome: 'conversa', ponto: 'conversa' } });
    assert.equal(recebidos.length, 2, 'sem configuração, o perfil pedido é ignorado e o backend atende');
    assert.ok(!Object.hasOwn(recebidos[1], 'perfil'), 'o backend nunca recebe o `perfil`');
    assert.equal(redeTentada, 0);
  });

  await test('com os perfis configurados e o seletor injetado, o cérebro passa o perfil escolhido à chamada de IA (e só ele)', async () => {
    const vistos = [];
    const ai = { listBackends: () => [{ name: 'falsa', active: true }], chat: async (a) => { vistos.push(a); return 'resposta'; } };
    const escolhas = [];
    const selecionarPerfil = (t) => { escolhas.push(t); return { nome: 'conversa', ponto: t.ponto, motivo: 'conversa' }; };
    const brain = conversa.createChatBrain({ ai, selecionarPerfil, context: { enabled: () => false }, memoryBlock: async () => '', persona: () => 'PERSONA', tools: () => [] });
    await brain.turn({ turn: { id: 'turno-p2', at: Date.now() - 100 }, ctx: { platform: 'discord', userId: MEMBER, guildId: GUILD, channelId: '555555555555555555', isDM: false }, call: { entry: 'fila', type: 'mention', mentionsBot: true }, prompt: 'oi', ownText: 'oi', channel: {}, options: { main: true } }, { role: 'bot' });
    assert.deepEqual(vistos[0].perfil, { nome: 'conversa', ponto: 'conversa', motivo: 'conversa' });
    assert.equal(escolhas[0].ponto, 'conversa');
    assert.equal(escolhas[0].privada, false, 'conversa pública sem memória: não privada');
    assert.equal(escolhas[0].texto, 'oi');
    assert.deepEqual(chaves(escolhas[0]), ['historicoChars', 'imagem', 'ponto', 'privada', 'texto'], 'o seletor recebe só fatos da chamada: nenhum id de pessoa');
  });

  await test('nenhuma rede foi tentada em todo o teste', () => assert.equal(redeTentada, 0));

  console.log = realConsole.log;
  say(`\n${passed} testes OK${failures.length ? `; ${failures.length} FALHARAM: ${failures.join(' | ')}` : ''}`);
} finally {
  try { process.chdir(repoRoot); } catch { /* */ }
  try { (await imp('src/database/db.js')).closeAllDatabases?.(); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* */ }
}
process.exit(failures.length ? 1 : 0);
