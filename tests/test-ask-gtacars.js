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
  askCommand,
} from '../src/discord/commands/ask.js';
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

console.log('\n✅ test-ask-gtacars: todos os cenários passaram.');
// O import de ask.js carrega a cadeia de módulos do bot (DB/sql.js etc) que
// mantém handles abertos; sai explicitamente para o teste não ficar pendurado.
process.exit(0);