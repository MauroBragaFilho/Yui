// IA FALSA para os testes de ponta a ponta do cérebro separado (tests/test-separacao.js). NUNCA vale em produção.
//
// Só liga com as DUAS condições: YUI_TESTE_IA_FALSA=true E NODE_ENV=test. Com NODE_ENV=production (ou sem NODE_ENV=test) a
// variável é ignorada e o cérebro avisa no log. Não usa rede: responde um texto fixo que diz o que recebeu (sem repetir o
// conteúdo da memória), para o teste conferir que a persona e a memória chegaram ao backend.
//
// Etapa 5 (tests/test-chat-turn.js): a resposta também diz quais marcas `tok-...` estavam no HISTÓRICO recebido (`vistos=[...]`) e no
// pedido (`tokens=[...]`), se o prompt de sistema tinha a identidade, as ferramentas e o bloco de voz, e se a chamada foi marcada como
// sensível. Assim o teste confere, sem IA de verdade, que cada conversa recebeu só o próprio histórico. O arquivo JSON de
// YUI_TESTE_IA_FALSA_CONTROLE (relido a cada chamada) simula a IA lenta ({ "atrasoMs": 3000 }) ou fora do ar ({ "falhar": true }).
// Etapa 6 (tests/test-pesquisa-cerebro.js): { "ferramentaJson": "{...}" } faz a IA pedir uma ferramenta quando o prompt as oferece (a síntese
// da pesquisa, sem ferramentas, continua com o texto de sempre), e o otimizador da busca automática recebe "SIM: <a entrada>".
// Ajustes da Liz (etapa 6, §11): { "atrasoSinteseMs": 6000 } deixa lenta SÓ a síntese da pesquisa (o prompt com "[PERGUNTA DO USUÁRIO]:"), para
// o teste derrubar o cérebro DURANTE a síntese, com a busca e as páginas já guardadas no diário da retomada.
import fs from 'node:fs';
import crypto from 'node:crypto';

export const FAKE_AI_BACKEND = 'teste-ia-falsa';

/** 'on' (ligar), 'off' (variável ausente) ou 'refused' (variável ligada fora de NODE_ENV=test). */
export function fakeAiMode(env = process.env) {
  const wanted = String(env.YUI_TESTE_IA_FALSA ?? '').trim().toLowerCase() === 'true';
  if (!wanted) return 'off';
  return String(env.NODE_ENV ?? '').trim().toLowerCase() === 'test' ? 'on' : 'refused';
}

/** As marcas `tok-...` de um texto, na ordem, sem repetir. */
function tokensIn(text) {
  return [...new Set(String(text).match(/\btok-[A-Za-z0-9]+\b/g) ?? [])];
}

/** O arquivo de controle do teste (relido a cada chamada; ausente ou ilegível = nada). */
function fakeAiControl(env = process.env) {
  const file = String(env.YUI_TESTE_IA_FALSA_CONTROLE ?? '').trim();
  if (!file) return {};
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    return {
      atrasoMs: Math.max(0, Math.min(60_000, Number(c.atrasoMs) || 0)), falhar: c.falhar === true,
      atrasoSinteseMs: Math.max(0, Math.min(60_000, Number(c.atrasoSinteseMs) || 0)),
      // etapa 6: quando o prompt OFERECE ferramentas, a IA falsa responde este JSON (simula o modelo pedindo uma ferramenta, ex. search_web)
      ferramentaJson: typeof c.ferramentaJson === 'string' ? c.ferramentaJson.slice(0, 2000) : null,
    };
  } catch {
    return {};
  }
}

/** Backend falso (contrato do AI Manager). */
export function createFakeAiBackend() {
  return {
    name: FAKE_AI_BACKEND,
    local: false,
    async chat({ prompt, system = '', memoryBlock = '', history = [], sensitive = false } = {}) {
      const ctl = fakeAiControl();
      if (ctl.atrasoMs) {
        // Só teste: avisa que a chamada COMEÇOU (e vai demorar), para o teste derrubar o cérebro com o pedido de fato em andamento,
        // em vez de dormir um tempo fixo (numa máquina lenta, como o notebook, o pedido ainda nem tinha chegado quando o tempo acabava).
        try { process.stdout.write('[IA falsa] chamada em andamento (atraso de teste)' + String.fromCharCode(10)); } catch { /* */ }
        await new Promise((r) => setTimeout(r, ctl.atrasoMs));
      }
      if (ctl.atrasoSinteseMs && String(prompt ?? '').includes('[PERGUNTA DO USUÁRIO]:')) await new Promise((r) => setTimeout(r, ctl.atrasoSinteseMs));
      if (ctl.falhar) throw new Error('IA falsa fora do ar (teste)');
      const sys = String(system);
      // Etapa 6: o otimizador da busca automática recebe "SIM: <a entrada>"; com ferramentas no prompt e o controle pedindo, o JSON da ferramenta.
      if (sys === 'Responda apenas com o comando solicitado.') {
        const m = /ENTRADA: "([^"]*)"/.exec(String(prompt ?? ''));
        return `SIM: ${m ? m[1] : 'consulta de teste'}`;
      }
      if (ctl.ferramentaJson && sys.includes('--- FERRAMENTAS DISPONÍVEIS ---')) return ctl.ferramentaJson;
      const persona = /horário de Brasília/.test(sys) ? 'sim' : 'nao';
      const hash = crypto.createHash('sha256').update(sys).digest('hex').slice(0, 12);
      const memoria = String(memoryBlock || '').trim() || sys.includes('[MEMÓRIA SOBRE ESTE USUÁRIO') ? 'sim' : 'nao';
      const list = Array.isArray(history) ? history : [];
      const vistos = tokensIn(list.map((h) => String(h?.content ?? '')).join(' '));
      const tokens = tokensIn(String(prompt ?? ''));
      const sim = (b) => (b ? 'sim' : 'nao');
      const pergunta = String(prompt ?? '').replace(/\s+/g, ' ').trim().slice(-120);
      return `IA-FALSA persona=${persona} persona_hash=${hash} memoria=${memoria} historico=${list.length} vistos=[${vistos.join(',')}] tokens=[${tokens.join(',')}] identidade=${sim(sys.includes('[IDENTIDADE'))} ferramentas=${sim(sys.includes('--- FERRAMENTAS DISPONÍVEIS ---'))} voz=${sim(sys.includes('[MODO VOZ]'))} sensivel=${sim(sensitive === true)} clima=${sim(String(prompt ?? '').includes('[DADOS DO CLIMA'))} web=${sim(String(prompt ?? '').includes('[CONTEXTO OBTIDO NA WEB]'))} pergunta="${pergunta}"`;
    },
  };
}

/**
 * Liga a IA falsa no manager deste processo se (e só se) o modo for 'on'. Devolve o modo.
 * @param {{registerBackend: Function}} ai  o AI Manager (src/core/ai/manager.js)
 */
export function activateFakeAi(ai, { env = process.env, logger = null } = {}) {
  const mode = fakeAiMode(env);
  if (mode === 'on') {
    ai.registerBackend(createFakeAiBackend(), { activate: true });
    logger?.warn?.(`[Cérebro] IA FALSA ligada (${FAKE_AI_BACKEND}): só para teste (NODE_ENV=test). Nenhuma resposta real de IA.`);
  } else if (mode === 'refused') {
    logger?.error?.('[Cérebro] YUI_TESTE_IA_FALSA=true ignorado: a IA falsa só liga com NODE_ENV=test.');
  }
  return mode;
}
