// Testes da resolução de menções (@nome -> <@ID>) sem Discord real.
// Execução: npm run test:mentions
import assert from 'assert';
import { resolveMentions, neutralizeMassMentions, SAFE_ALLOWED_MENTIONS } from '../src/discord/mentions.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };

const member = (id, username, extra = {}) => ({
  id,
  user: { id, username, globalName: extra.globalName ?? null },
  nickname: extra.nickname ?? null,
  displayName: extra.nickname ?? extra.globalName ?? username,
});

function makeGuild(cached = [], searchable = [], { failSearch = false } = {}) {
  const calls = { search: 0 };
  return {
    calls,
    members: {
      cache: new Map(cached.map((m) => [m.id, m])),
      async search({ query }) {
        calls.search++;
        if (failSearch) throw new Error('sem permissão');
        return new Map(searchable.filter((m) => m.user.username.toLowerCase().includes(query.toLowerCase())).map((m) => [m.id, m]));
      },
    },
  };
}

const coelha = member('111111111111111111', 'coelha17', { globalName: 'Coelha' });
const mauro = member('222222222222222222', 'obraga', { nickname: 'Mauro Braga' });
const guild = makeGuild([coelha, mauro]);

console.log('Menções');
await test('usuário exato do cache vira <@ID>', async () => {
  assert.equal(await resolveMentions('oi @coelha17, tudo bem?', guild), 'oi <@111111111111111111>, tudo bem?');
});
await test('não diferencia maiúsculas e aceita nome global e apelido', async () => {
  assert.equal(await resolveMentions('@COELHA17 e @Coelha', guild), '<@111111111111111111> e <@111111111111111111>');
  assert.equal(await resolveMentions('fala @obraga', guild), 'fala <@222222222222222222>');
});
await test('o mesmo usuário citado várias vezes é resolvido em todas', async () => {
  assert.equal(await resolveMentions('@coelha17 @coelha17', guild), '<@111111111111111111> <@111111111111111111>');
});
await test('prefixo único com 4+ caracteres resolve ("@coelha" -> coelha17)', async () => {
  assert.equal(await resolveMentions('@coelha olha isso', guild), '<@111111111111111111> olha isso');
});
await test('prefixo curto (< 4) não resolve: evita marcar a pessoa errada', async () => {
  assert.equal(await resolveMentions('@coe oi', guild), '@coe oi');
});
await test('prefixo ambíguo não resolve', async () => {
  const g = makeGuild([member('1', 'maria01'), member('2', 'maria02')]);
  assert.equal(await resolveMentions('@maria oi', g), '@maria oi');
});
await test('nome desconhecido continua texto', async () => {
  assert.equal(await resolveMentions('@fulano123 oi', guild), '@fulano123 oi');
});
await test('menção já pronta <@ID> não é alterada', async () => {
  assert.equal(await resolveMentions('oi <@111111111111111111> e @coelha17', guild), 'oi <@111111111111111111> e <@111111111111111111>');
});
await test('e-mails e URLs não viram menção', async () => {
  const g = makeGuild([member('9', 'gmail')]);
  assert.equal(await resolveMentions('escreve para teste@gmail.com ou veja https://x.com/@gmail', g), 'escreve para teste@gmail.com ou veja https://x.com/@gmail');
});
await test('trechos de código ficam intactos', async () => {
  assert.equal(
    await resolveMentions('use `@coelha17` ou\n```\n@coelha17\n```\nmas @coelha17 sim', guild),
    'use `@coelha17` ou\n```\n@coelha17\n```\nmas <@111111111111111111> sim'
  );
});
await test('fora do cache, busca na API do servidor', async () => {
  const novo = member('333333333333333333', 'joaozinho');
  const g = makeGuild([], [novo]);
  assert.equal(await resolveMentions('chama o @joaozinho', g), 'chama o <@333333333333333333>');
  assert.equal(g.calls.search, 1);
});
await test('falha na busca (rede/permissão) mantém o texto, sem erro', async () => {
  const g = makeGuild([], [], { failSearch: true });
  assert.equal(await resolveMentions('oi @alguem', g), 'oi @alguem');
});
await test('sem servidor (DM) o texto não muda, exceto neutralizar @everyone', async () => {
  assert.equal(await resolveMentions('oi @coelha17', null), 'oi @coelha17');
});

console.log('Segurança');
await test('@everyone e @here são neutralizados', async () => {
  const out = await resolveMentions('atenção @everyone e @here!', guild);
  assert.ok(!/@everyone|@here/i.test(out), 'não pode sobrar @everyone/@here legíveis pelo Discord');
  assert.equal(neutralizeMassMentions('@EVERYONE'), '@​EVERYONE');
});
await test('allowedMentions só permite usuários (cargos e everyone bloqueados)', () => {
  assert.deepEqual(SAFE_ALLOWED_MENTIONS.parse, ['users']);
});
await test('não marca ninguém quando o servidor tem usuário com o mesmo nome "everyone"', async () => {
  const g = makeGuild([member('7', 'everyone')]);
  assert.ok(!(await resolveMentions('oi @everyone', g)).includes('<@7>'));
});

console.log(`\n${passed} testes OK`);
process.exit(0);
