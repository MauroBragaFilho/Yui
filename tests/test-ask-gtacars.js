/**
 * Integração do pipeline GTACars com o comando /yui (ask).
 *
 * Valida que o buildVehicleWeaponContext do comando ask:
 *   1. Consulta a fonte GTACars como PRIMÁRIA (prioridade em vez do
 *      dump DurtyFree usado até então);
 *   2. Cobre o cenário de fallback (termo ausente no GTACars → DurtyFree);
 *   3. Não injeta ruído (termos genéricos da frase não preenchem o contexto);
 *   4. Mantém o export do comando intacto após a integração.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildVehicleWeaponContext,
  buildSystemPrompt,
  isGtaTopic,
  askCommand,
} from '../src/discord/commands/ask.js';
import { hasWeaponDataLoaded } from '../src/utils/weaponData.js';
import { config } from '../src/config/index.js';
import os from 'os';
import { getAllVehicles } from '../src/services/gta/vehicles/gtacars/service.js';
import { normalizeName } from '../src/services/gta/vehicles/gtacars/parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('1. Comando /yui exportado (integração não quebrou o módulo):');
assert(askCommand && typeof askCommand.execute === 'function', 'askCommand exportado com execute');
assert(askCommand.data && typeof askCommand.data.toJSON === 'function', 'askCommand.data pronto');
console.log('   OK — askCommand presente e executável.\n');

console.log('2. Pergunta sobre veículo → contexto usa GTACars como fonte primária:');
{
  const context = buildVehicleWeaponContext('qual a velocidade do sultan rs pro drift?');
  assert(context && context.includes('DADOS TÉCNICOS DE VEÍCULOS ENCONTRADOS'), 'seção de veículos presente');
  assert(context.toLowerCase().includes('sultan'), 'resultado menciona Sultan');
  assert(context.includes('gtacars.net/gta5/sultanrs'), 'Sultan RS resolvido com link do GTACars');
  assert(context.includes('fonte: GTACars'), 'rótulo da fonte GTACars presente');
  // A frase contém verbos/partículas ("velocidade", "pro") que não podem virar
  // resultados — valida o filtro de ruído (sem Squalo/Molotok/etc).
  assert(!context.includes('Molotok') && !context.includes('Squalo'), 'sem ruído lexical no contexto');
  console.log('   OK — ' + context.split('\n').slice(1, 4).map((l) => l.trim()).join(' | ').slice(0, 200) + '\n');
}

console.log('3. Termo curto/difícil já resolvido pelo GTACars (10F):');
{
  const context = buildVehicleWeaponContext('o obey 10f vale a pena?');
  assert(context && context.toLowerCase().includes('10f'), 'contexto inclui 10F');
  assert(context.includes('Obey 10F'), '10F resolvido via GTACars');
  console.log('   OK — contexto inclui Obey 10F com dados do GTACars.\n');
}

console.log('4. Fallback: veículo presente só no dump DurtyFree ainda responde:');
{
  // Sinais do cache DurtyFree (fonte antiga): arquivo src/data/vehicles.json.
  const durtyPath = path.join(__dirname, '../src/data/vehicles.json');
  const gtacarsNames = new Set(getAllVehicles().map((v) => normalizeName(v.name)));

  let fallbackVehicle = null;
  if (fs.existsSync(durtyPath)) {
    const durty = JSON.parse(fs.readFileSync(durtyPath, 'utf8'));
    fallbackVehicle = (Array.isArray(durty) ? durty : []).find((v) => {
      const n = normalizeName(v.Name || v.name || '');
      if (!n) return false;
      return !gtacarsNames.has(n) && n.length >= 3;
    });
  }

  if (fallbackVehicle) {
    const nome = fallbackVehicle.displayNamePT || fallbackVehicle.displayNameEN || fallbackVehicle.Name;
    const context = buildVehicleWeaponContext(`o que acha do ${nome}?`);
    assert(
      context && context.toLowerCase().includes(normalizeName(nome).split(' ')[0]),
      `fallback encontrou veículo '${nome}' do dump`
    );
    console.log(`   OK — '${nome}' (ausente no GTACars) resolvido via dump DurtyFree.\n`);
  } else {
    console.log('   (skip) — todos os veículos do dump local também existem no GTACars; fallback não exercitado.\n');
  }
}

console.log('5. Pergunta sem veículo → nenhuma seção de veículos (sem ruído no contexto):');
{
  const context = buildVehicleWeaponContext('qual a melhor comida do brasil?');
  assert(context === null || !context.includes('DADOS TÉCNICOS DE VEÍCULOS'), 'sem seção de veículos');
  console.log('   OK — nenhum dado técnico de veículo injetado para assunto não-veicular.\n');
}

console.log('6. Pergunta que NÃO é de GTA não leva dados do jogo (caso real de 19/11/2026: "qual um bom baixo para tocar?" respondeu o semanal do GTA):');
{
  // "bom" é o começo de "Bombushka" e "para" o de "Paragon": sem palavra de GTA na pergunta só vale o NOME INTEIRO da palavra
  const SEM_GTA = [
    'qual um bom baixo para tocar?',
    'qual a melhor guitarra para tocar rock?',
    'me indica um bom restaurante para jantar',
    'qual a melhor moto para andar na cidade?',
    'qual a melhor faca de cozinha?',
    'qual o melhor destino de turismo no Brasil?',
    'chama um taxi pra mim',
  ];
  const CONTEXTO_GTA = /Dados REAIS e atuais do GTA Online|DADOS DA SEMANA|DADOS DO SEMANAL|DADOS DE HOJE|DADOS TÉCNICOS DE VEÍCULOS|ARMAS ENCONTRADAS/;
  for (const q of SEM_GTA) {
    assert.equal(isGtaTopic(q), false, 'não é assunto de GTA: ' + q);
    assert.equal(buildVehicleWeaponContext(q), null, 'sem dados de veículo/arma em: ' + q);
    // (buildSystemPrompt só mexe no banco do GTA quando o assunto é GTA: aqui o banco nem está iniciado, e não pode ser tocado)
    assert(!CONTEXTO_GTA.test(buildSystemPrompt(q)), 'o prompt não leva o contexto de GTA em: ' + q);
  }
  // o veículo citado pelo nome inteiro continua achado, com ou sem a palavra GTA...
  const banshee = buildVehicleWeaponContext('qual a velocidade do banshee?');
  assert(banshee && banshee.includes('Banshee'), 'veículo de uma palavra inteira continua achado');
  // ...mas, sozinho, não liga os dados do dia e do semanal (o banco do GTA nem é tocado)
  assert(!/Dados REAIS e atuais do GTA Online|DADOS DA SEMANA|DADOS DO SEMANAL/.test(buildSystemPrompt('qual a velocidade do banshee?')), 'veículo sozinho não traz o semanal');
  // a base de conhecimento de GTA só entra com palavra de GTA ou com um veículo citado por 2+ palavras inteiras ("obey 10f"); veículo de uma palavra só não basta
  {
    const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-conhecimento-'));
    fs.writeFileSync(path.join(kb, 'regras-do-jogo-gta.md'), 'MARCADOR-CONHECIMENTO-GTA');
    fs.writeFileSync(path.join(kb, 'geral.md'), 'MARCADOR-CONHECIMENTO-GERAL');
    const antes = config.ai.knowledgeDir;
    config.ai.knowledgeDir = kb;
    try {
      const um = buildSystemPrompt('qual a velocidade do banshee?');
      assert(um.includes('MARCADOR-CONHECIMENTO-GERAL') && !um.includes('MARCADOR-CONHECIMENTO-GTA'), 'veículo de uma palavra só não liga o conhecimento de GTA');
      const dois = buildSystemPrompt('o obey 10f vale a pena?');
      assert(dois.includes('MARCADOR-CONHECIMENTO-GTA'), 'veículo citado por 2+ palavras inteiras liga o conhecimento de GTA');
      const nenhum = buildSystemPrompt('qual um bom baixo para tocar?');
      assert(!nenhum.includes('MARCADOR-CONHECIMENTO-GTA'), 'pergunta comum nunca leva o conhecimento de GTA');
    } finally {
      config.ai.knowledgeDir = antes;
      try { fs.rmSync(kb, { recursive: true, force: true }); } catch { /* o Windows pode segurar o arquivo */ }
    }
  }
  // arma: o nome em português é palavra comum; só entra quando a pergunta fala de GTA
  if (hasWeaponDataLoaded()) {
    assert.equal(buildVehicleWeaponContext('qual a melhor pistola para comprar?'), null, 'arma sem palavra de GTA não entra');
    const comGta = buildVehicleWeaponContext('qual a melhor pistola do gta?');
    assert(comGta && comGta.includes('ARMAS ENCONTRADAS'), 'com palavra de GTA a arma entra');
  }
  // e quando a pergunta É de GTA, o casamento por começo de palavra volta (quem digita "banshe" ou "sultan r")
  assert.equal(isGtaTopic('qual a van de armas hoje?'), true);
  assert.equal(isGtaTopic('qual o bônus semanal do gta?'), true);
  console.log('   OK — nenhuma das ' + SEM_GTA.length + ' perguntas comuns recebeu dados de GTA; veículo e arma de GTA continuam funcionando.\n');
}

console.log('\n✅ test-ask-gtacars: todos os cenários passaram.');
// O import de ask.js carrega a cadeia de módulos do bot (DB/sql.js etc) que
// mantém handles abertos; sai explicitamente para o teste não ficar pendurado.
process.exit(0);