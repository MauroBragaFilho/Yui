// Motor de políticas nas interações do Discord: observe não muda nada; enforce nega/exige o PC.
// Execução: npm run test:discordguard
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-dg-'));
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_OWNER_ID = '111';
delete process.env.YUI_POLICY_MODE;

const { actionForInteraction, guardInteraction } = await import('../src/core/security/discordGuard.js');
const { createPolicyEngine } = await import('../src/core/security/policyEngine.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };
const OWNER = '111';
const MEMBER = '222';
const engine = (mode, readOnly) => createPolicyEngine({ env: { YUI_POLICY_MODE: mode }, readOnly: () => readOnly, auditFn: () => {} });
const slash = (name, sub = null) => ({ kind: 'slash', name, sub });
const comp = (customId) => ({ kind: 'component', customId });

console.log('Tabela');
await test('comandos e botões que mudam algo mapeiam para ações; navegação e comandos de consulta não', () => {
  const cases = [
    [slash('yui-criador', 'banir'), 'admin.ban_user'], [slash('yui-criador', 'desbanir'), 'admin.ban_user'], [slash('yui-criador', 'memorias'), 'memory.admin_inspect'],
    [slash('yui-criador', 'bot_config'), 'admin.bot_config'], [slash('yui-criador', 'automod'), 'admin.guild_configure'], [slash('yui-servidor'), 'admin.guild_configure'],
    [slash('yui-seguir-youtube'), 'admin.follow_social'], [slash('yui-config_ia'), 'admin.ai_configure'], [slash('baixar_video'), 'media.download'],
    [comp('adm_remoteban_user_1'), 'admin.ban_user'], [comp('banlist_unban_user_1'), 'admin.ban_user'], [comp('unban_user_1_2'), 'admin.ban_user'],
    [comp('crtcfg_modal_ban'), 'admin.ban_user'], [comp('cfgpanel_toggle_3_true'), 'admin.bot_config'], [comp('srvcfg_x'), 'admin.guild_configure'],
  ];
  for (const [d, a] of cases) assert.equal(actionForInteraction(d), a, JSON.stringify(d));
  for (const d of [slash('ajuda'), slash('yui-status'), slash('yui-memoria'), comp('cfgpanel_next_1'), comp('banlist_home'), comp('radio_stop'), comp('qualquer')]) assert.equal(actionForInteraction(d), null, JSON.stringify(d));
});

console.log('observe e enforce');
await test('em observe nada é bloqueado', () => {
  for (const d of [slash('yui-criador', 'banir'), comp('adm_remoteban_user_1'), slash('yui-config_ia')]) {
    assert.equal(guardInteraction({ data: d, userId: MEMBER, guildId: '9', engine: engine('observe', true) }), null);
  }
});
await test('enforce + somente leitura: banir e mexer no painel global viram mensagem privada, mesmo para o dono', () => {
  const e = engine('enforce', true);
  for (const d of [slash('yui-criador', 'banir'), comp('banlist_unban_user_1'), comp('cfgpanel_toggle_1_true'), slash('yui-criador', 'bot_config')]) {
    const r = guardInteraction({ data: d, userId: OWNER, guildId: '9', guildAdmin: true, engine: e });
    assert.ok(r?.message, JSON.stringify(d));
  }
});
await test('enforce: membro comum não configura nem baixa nada que a matriz nega; baixar música continua liberado', () => {
  const e = engine('enforce', false);
  assert.ok(guardInteraction({ data: slash('yui-servidor'), userId: MEMBER, guildId: '9', engine: e })?.message);
  assert.ok(guardInteraction({ data: slash('yui-seguir-twitch'), userId: MEMBER, guildId: '9', engine: e })?.message);
  assert.ok(guardInteraction({ data: slash('yui-config_ia'), userId: MEMBER, guildId: '9', engine: e })?.message);
  assert.equal(guardInteraction({ data: slash('baixar_musica'), userId: MEMBER, guildId: '9', engine: e }), null);
});
await test('enforce: o dono banir pelo Discord (DM) é crítico e só vale no PC', () => {
  const r = guardInteraction({ data: slash('yui-criador', 'banir'), userId: OWNER, isDM: true, engine: engine('enforce', false) });
  assert.match(r?.message ?? '', /computador da Yui/);
});
await test('enforce: administrador do servidor segue configurando o próprio servidor', () => {
  const e = engine('enforce', false);
  assert.equal(guardInteraction({ data: slash('yui-servidor'), userId: MEMBER, guildId: '9', guildAdmin: true, engine: e }), null);
});
await test('o guarda nunca lança erro, mesmo com dados inválidos', () => {
  assert.equal(guardInteraction({}), null);
  assert.equal(guardInteraction({ data: null }), null);
});
await test('vigia: o interactionCreate chama o guarda antes dos handlers', () => {
  const src = fs.readFileSync(new URL('../src/events/interactionCreate.js', import.meta.url), 'utf8');
  const g = src.indexOf('guardInteraction({');
  assert.ok(g > 0 && g < src.indexOf("interaction.customId.startsWith('srvcfg_')"), 'guarda antes do despacho');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} testes OK`);
process.exit(0);
