// Testes da Fase 1 do painel (correções de consistência; docs/PAINEL_FASE0_MATRIZ.md, seção 10): o dicionário único da auditoria (R9),
// os valores internos traduzidos (seção 8), um "Sair" só, os textos que apontavam para o lugar errado, a frase do resumo do dia com o
// estado real do Google e a retenção da memória calculada pela própria memória. Execução: npm test (dentro de apps/yui-app).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describeEvent, EVENTOS_CONHECIDOS } from '../src/auditoriaLogic.ts';
import { ROTULOS_DE_VALORES, ROTULOS_DO_AUTOMOD, rotuloDoValor } from '../src/valoresLogic.ts';
import { fraseDoResumoDoDia } from '../src/contasLogic.ts';
import { textoDosLimites, nomeDaUnidade } from '../src/overviewLogic.ts';

const APP = path.resolve(import.meta.dirname, '..');
const RAIZ = path.resolve(APP, '..', '..');
const ler = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const tela = (nome) => ler(APP, 'src', 'screens', nome);

/** Todos os arquivos .js de uma pasta (recursivo). */
function arquivosJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...arquivosJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('auditoria: todo evento que o servidor grava com nome fixo está no dicionário único', () => {
  const nomes = new Set();
  for (const f of arquivosJs(path.join(RAIZ, 'src'))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\b(?:audit|auditar)\(\s*['`]([a-zA-Z0-9_.-]+)['`]/g)) nomes.add(m[1]);
  }
  assert.ok(nomes.size > 40, `achou ${nomes.size} eventos no servidor`);
  const faltam = [...nomes].filter((n) => !EVENTOS_CONHECIDOS.includes(n));
  assert.deepEqual(faltam, [], 'evento novo no servidor: acrescente o nome em português em src/auditoriaLogic.ts');
  for (const n of nomes) assert.equal(describeEvent(n).exato, true, n);
});

test('auditoria: o mesmo nome no Início e na Auditoria; evento antigo ou desconhecido continua legível', () => {
  const admin = tela('AdminScreen.tsx');
  assert.ok(!admin.includes('AUDIT_ACTIONS'), 'a Auditoria não tem mais dicionário próprio');
  assert.match(admin, /import \{ describeEvent \} from '\.\.\/auditoriaLogic\.ts';/);
  assert.match(admin, /const vista = describeEvent\(e\.event\);/);
  assert.match(admin, /vista\.exato \? '' : ` • \$\{String\(e\.event \?\? ''\)\}`/, 'fora do dicionário: o identificador aparece ao lado');
  const inicio = tela('OverviewScreen.tsx');
  assert.ok(!inicio.includes('rotuloAtividade') && !inicio.includes('TIPO_PT'), 'o Início não tem mais tradução própria');
  assert.match(ler(APP, 'src', 'overviewLogic.ts'), /import \{ describeEvent, type EventView \} from '\.\/auditoriaLogic\.ts';/);
  // os nomes que antes divergiam entre as duas telas
  assert.equal(describeEvent('auth.login.ok').label, 'Login no painel');
  assert.equal(describeEvent('memory.admin.list').label, 'Pessoas com memória consultadas');
  assert.equal(describeEvent('admin.ban.add').label, 'Bloqueio aplicado');
  assert.equal(describeEvent('admin.guild.tool').label, 'Função do servidor alterada');
  // nomes antigos do registro continuam legíveis
  assert.equal(describeEvent('login').label, 'Login no painel');
  assert.equal(describeEvent('admin.coisa.antiga').label, 'Ajuste feito no painel');
  assert.equal(describeEvent('admin.coisa.antiga').exato, false);
  assert.equal(describeEvent('chat').label, 'Conversa');
  assert.equal(describeEvent('skill.algo').label, 'Skill');
});

test('valores internos: cada opção do cofre tem nome em português, e a descrição não mostra o valor cru', () => {
  const catalogo = ler(RAIZ, 'src', 'core', 'painelConfig.js');
  const enums = [...catalogo.matchAll(/opcao\(\{ chave: '([A-Z0-9_]+)'[^\n]*?descricao: '((?:[^'\\]|\\.)*)'[^\n]*?opcoes: \[([^\]]*)\]/g)];
  assert.ok(enums.length >= 5, `achou ${enums.length} ajustes de opção`);
  for (const [, chave, descricao, lista] of enums) {
    const opcoes = [...lista.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(ROTULOS_DE_VALORES[chave], `${chave} sem tradução em valoresLogic.ts`);
    for (const o of opcoes) {
      assert.notEqual(rotuloDoValor(chave, o), o, `${chave}=${o} sem nome em português`);
      assert.ok(!descricao.includes(`"${o}"`), `a descrição de ${chave} ainda mostra "${o}"`);
    }
  }
  assert.equal(rotuloDoValor('YUI_PESQUISA_POR_INTENCAO', 'servidor'), 'Só nos servidores');
  assert.equal(rotuloDoValor('YUI_PESQUISA_POR_INTENCAO', 'dono'), 'Nos servidores e na sua DM');
  assert.equal(rotuloDoValor('YUI_AVISOS_FILTRO', 'observar'), 'Só observar');
  assert.equal(rotuloDoValor('OUTRO', 'x'), 'x', 'sem tradução: o próprio valor');
  // a tradução é só visual: o botão continua mandando o valor interno
  const config = tela('AdminConfig.tsx');
  assert.match(config, /<Chip key=\{o\} label=\{rotuloDoValor\(item\.chave, o\)\} on=\{item\.valor === o\} onPress=\{\(\) => save\(o\)\}/);
  // o AutoMod tem o mesmo nome no padrão de todos os servidores e em cada servidor
  assert.equal(ROTULOS_DE_VALORES.YUI_AUTOMOD_MODO_PADRAO, ROTULOS_DO_AUTOMOD);
  assert.match(tela('AdminScreen.tsx'), /label: ROTULOS_DO_AUTOMOD\[mode\]/);
  assert.match(tela('AdminPlanos.tsx'), /rotuloDoValor\('YUI_AVISOS_FILTRO', avisos\.modo\)/);
});

test('um "Sair" só, e ele encerra a sessão no servidor (ou avisa que não conseguiu)', () => {
  const shell = ler(APP, 'src', 'components', 'Shell.tsx');
  assert.ok(!shell.includes('logout') && !shell.includes('onLogout'), 'a barra lateral não tem mais o seu Sair');
  const status = tela('StatusScreen.tsx');
  assert.equal((status.match(/icon="logout"/g) ?? []).length, 1);
  assert.match(status, /<Button testID="btn-logout" label="Sair" /);
  assert.ok(!status.includes('Sair deste dispositivo'));
  const app = ler(APP, 'App.tsx');
  assert.match(app, /const r = await client\.logout\(\);\s*if \(!r\?\.revoked\) aviso = SAIU_SEM_CONFIRMAR;/);
  assert.match(app, /catch \{\s*aviso = SAIU_SEM_CONFIRMAR;/);
  assert.match(app, /setNotice\(aviso\);/);
});

test('textos que apontavam para o lugar errado foram corrigidos', () => {
  const telas = ['AdminScreen.tsx', 'AdminTransparencia.tsx', 'OverviewScreen.tsx'].map(tela).join('\n');
  for (const velho of ['As chaves de IA você gerencia em Configuração e chaves', 'Para mudar, edite o arquivo .env', 'a lista de permitidas ficam em Configuração e chaves', 'ainda não estão ligados']) {
    assert.ok(!telas.includes(velho), velho);
  }
  assert.ok(!ler(APP, 'src', 'transparenciaLogic.ts').includes('(YUI_CONTINUIDADE)'));
  const integracoes = ler(RAIZ, 'src', 'core', 'api', 'integrations.js');
  for (const velho of ["'YUI_MEMORY_ENABLED=false'", "'GTA_WEEKLY_ENABLED=false'", 'retenção de ${env.MEMORY_RETENTION_DAYS']) assert.ok(!integracoes.includes(velho), velho);
});

test('integrações: a retenção vem do cálculo da memória (nada de "retenção de 0 dias" com a memória permanente)', async () => {
  const { buildIntegrations } = await import(new URL('../../../src/core/api/integrations.js', import.meta.url).href);
  const memoria = (o) => buildIntegrations({ env: { MEMORY_RETENTION_DAYS: '0' }, ...o }).groups.flatMap((g) => g.items).find((i) => i.key === 'memory');
  assert.equal(memoria({ retencao: 'permanente' }).detail, 'retenção: permanente');
  assert.equal(memoria({ retencao: '30 dias sem interação' }).detail, 'retenção: 30 dias sem interação');
  assert.equal(memoria({}).detail, 'ligada', 'sem o cálculo da memória, a linha não inventa prazo (antes: "retenção de 0 dias")');
  assert.equal(memoria({ memoryEnabled: false }).detail, 'desligada ("Memória por usuário" em Configuração e chaves)');
  // e o admin passa o cálculo da memória (o mesmo das outras telas)
  assert.match(ler(RAIZ, 'src', 'core', 'api', 'admin.js'), /retencao: safeIsPermanent\(\) \? 'permanente' : safeRetentionDays\(\) \? `\$\{safeRetentionDays\(\)\} dias sem interação` : null,/);
});

test('resumo do dia: a frase do Início segue o estado real do Google', () => {
  const G = (o = {}) => ({ ligado: true, conectado: true, venceEm: null, ultimaRenovacaoEm: null, ultimoErro: null, renovacaoFalhou: false, precisaAutorizar: false, motivoDeAutorizar: null, ...o });
  assert.match(fraseDoResumoDoDia(G()), /agenda e as tarefas de hoje do Google; o e-mail não entra/);
  assert.match(fraseDoResumoDoDia(G({ ligado: false })), /não entra: a integração com o Google está desligada/);
  assert.match(fraseDoResumoDoDia(G({ conectado: false })), /não entra até a autorização do Google ser refeita/);
  assert.doesNotMatch(fraseDoResumoDoDia(null), /Google/, 'sem resposta do servidor, não afirma nada sobre o Google');
  assert.match(tela('OverviewScreen.tsx'), /\{fraseDoResumoDoDia\(google\)\}/);
});

test('RAM e disco do Início: sem regra de porcentagem no app; os limites do alerta explicam as cores', () => {
  const inicio = tela('OverviewScreen.tsx');
  assert.ok(!/levelForFree|percent\(host/.test(inicio), 'o Início não calcula nível por porcentagem');
  assert.match(inicio, /nivelDoServidor\(host\?\.alerta\?\.nivelRam\)/);
  assert.match(inicio, /nivelDoServidor\(host\?\.alerta\?\.nivelDisco\)/);
  assert.match(textoDosLimites({ discoLivreMinGB: 5, ramLivreMinMB: 400 }), /RAM livre abaixo de 400 MB ou disco livre abaixo de 5 GB/);
  // revisão da Liz: o amarelo é atenção PREVENTIVA, não alerta disparado
  assert.match(textoDosLimites({ discoLivreMinGB: 5, ramLivreMinMB: 400, ramMinutos: 5 }), /Amarelo é só atenção preventiva: até o dobro desses limites, sem alerta por DM/);
  assert.match(textoDosLimites({ discoLivreMinGB: 5, ramLivreMinMB: 400, ramMinutos: 5 }), /na RAM, depois de 5 min seguidos/);
  assert.match(textoDosLimites({ discoLivreMinGB: null, ramLivreMinMB: null }), /desligados/);
  assert.match(textoDosLimites(null), /atualize a Yui/);
  assert.equal(nomeDaUnidade('C:\\'), 'C:');
  assert.equal(nomeDaUnidade('d:/'), 'D:');
  assert.equal(nomeDaUnidade('/'), '/');
  assert.equal(nomeDaUnidade(null), null);
  // o alerta por DM e o Início leem a MESMA regra (core/limitesDoComputador.js)
  assert.match(ler(RAIZ, 'src', 'cerebro', 'eventos.js'), /\.\.\.limitesDoComputador\(env\)/);
  assert.match(ler(RAIZ, 'src', 'cerebro', 'eventos.js'), /fs\.statfsSync\(pastaDoDisco\(env\)\)/);
});
