// Coerência entre package.json, .env_example, a documentação e o código (sem rede, sem banco, só leitura de arquivos).
// Garante que: todo script de teste aponta para um arquivo que existe; toda variável nova está como linha COMENTADA no
// .env_example, na tabela do ENVIRONMENT.md e em algum arquivo de src/ (ninguém documenta o que o código não lê);
// o padrão escrito no .env_example é o padrão do código; os links internos dos docs apontam para títulos que existem; e
// nenhum texto desatualizado (anexo .txt, 25 MB, "termina a frase atual"...) voltou aos docs.
// Execução: npm run test:docssync
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    failures.push(name);
    console.log(`  FALHA - ${name}\n      ${String(err?.stack || err).split('\n').slice(0, 5).join('\n      ')}`);
  }
}

// Variáveis de ambiente desta rodada: [nome, padrão escrito no .env_example (null = sem padrão fixo)].
const NEW_VARS = [
  ['YUI_UPLOAD_LIMIT_MB', '10'],
  ['YUI_AUDIO_REENCODE', 'true'],
  ['YUI_AUDIO_FIT_TIMEOUT_S', '120'],
  ['YUI_DL_MAX_CONCURRENT', '3'],
  ['YUI_SEARCH_PARSE_TIMEOUT_MS', '1500'],
  ['YUI_SEARCH_MAX_HTML_TAGS', '20000'],
  ['YUI_SEARCH_MAX_HTML_CHARS', '300000'],
  ['YUI_AI_DEADLINE_SECONDS', '240'],
  ['YUI_SPOTDL_BITRATE', '192k'],
  ['YUI_SPOTDL_LOG_LEVEL', 'WARNING'],
  ['YUI_SPOTDL_MAX_PARALLEL', '2'],
  ['SPOTDL_PATH', null],
  ['YUI_REPLY_ATTACH_EXT', 'md'],
  ['YUI_REPLY_MAX_PARTS', '4'],
  ['YUI_ASK_MAX_CHARS', '4000'],
  ['YUI_READ_TEXT_ATTACHMENTS', 'true'],
  ['YUI_ATTACH_TEXT_MAX_KB', '100'],
  ['YUI_ATTACH_TEXT_MAX_CHARS', '12000'],
  ['YUI_SUMMARY_MAX_CHARS', '20000'],
  ['YUI_SUMMARY_PER_MESSAGE', '600'],
  ['YUI_QUEUE_MAX', '30'],
  ['YUI_QUEUE_MAX_PER_USER', '2'],
  ['YUI_HISTORY_MAX_CHANNELS', '500'],
];

// Scripts novos desta rodada e o arquivo de teste de cada um.
const NEW_SCRIPTS = {
  'test:spotdl': 'tests/test-spotdl.js',
  'test:embedlimits': 'tests/test-embed-limits.js',
  'test:uploadlimit': 'tests/test-upload-limit.js',
  'test:inputlimits': 'tests/test-input-limits.js',
  'test:searchlimits': 'tests/test-search-limits.js',
  'test:longreplylimits': 'tests/test-longreply-limits.js',
  'test:dbatomic': 'tests/test-db-atomic.js',
  'test:http413': 'tests/test-http-413.js',
  'test:textinputs': 'tests/test-text-inputs.js',
  'test:embedpanels': 'tests/test-embed-panels.js',
  'test:embedpublish': 'tests/test-embed-publish.js',
  'test:audiofit': 'tests/test-audio-fit.js',
  'test:llmlimits': 'tests/test-llm-limits.js',
  'test:interactionlimits': 'tests/test-interaction-limits.js',
  'test:binaries-spotdl': 'tests/test-binaries-spotdl.js',
  'test:docssync': 'tests/test-docs-sync.js',
};

// Arquivos tests/test-*.js que de propósito NÃO têm script: diagnóstico, rede real ou suíte antiga já documentada à mão.
const UNLISTED_TESTS = new Set([
  'tests/test-binaries.js', // roteiro de diagnóstico (pode baixar ferramentas)
  'tests/test-weekly-e2e-real.js', // acessa o Reddit de verdade
  'tests/test-weekly-embed-ptbr.js', // documentado como "node tests/..." no README_TESTES.md
  'tests/test-weekly-combined-embed.js',
  'tests/test-weekly-translate.js',
  'tests/test-weekly-ai-translate.js',
]);

// Nomes que o código lê mas que não são configuração de operação (internos, de teste ou de outro dono).
const INTERNAL_ENV = new Set(['YUI_SAPI_VOICE', 'YUI_SAPI_RATE', 'YUI_LOG_DIR', 'YUI_ROOT_DIR']);

const pkg = JSON.parse(read('package.json'));
const scripts = pkg.scripts || {};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.venv')) continue;
      walk(full, out);
    } else if (/\.(js|mjs|py)$/.test(entry.name)) out.push(full);
  }
  return out;
}

console.log('1. package.json');

await test('package.json é JSON válido, sem BOM, e os scripts de teste desta rodada existem com o comando certo', () => {
  assert.notStrictEqual(read('package.json').charCodeAt(0), 0xfeff, 'BOM no package.json');
  assert.ok(Object.keys(scripts).length > 40);
  for (const [name, file] of Object.entries(NEW_SCRIPTS)) {
    assert.strictEqual(scripts[name], `node ${file}`, `script ${name}`);
  }
});

await test('todo comando "node <arquivo>" de um script aponta para um arquivo que existe', () => {
  for (const [name, command] of Object.entries(scripts)) {
    for (const segment of String(command).split('&&')) {
      const match = /^\s*node\s+(?:--[a-z-]+\s+)*"?([^"\s-][^"\s]*)"?/.exec(segment);
      if (!match || match[1].includes('*')) continue;
      assert.ok(exists(match[1]), `${name}: ${match[1]} não existe`);
    }
  }
});

await test('todo tests/test-*.js tem script no package.json (ou está na lista de exceções, com motivo)', () => {
  const referenced = new Set();
  for (const command of Object.values(scripts)) {
    for (const m of String(command).matchAll(/tests\/[A-Za-z0-9._-]+\.(?:js|mjs)/g)) referenced.add(m[0]);
  }
  const missing = fs.readdirSync(path.join(root, 'tests'))
    .filter((f) => /^test-.*\.js$/.test(f))
    .map((f) => `tests/${f}`)
    .filter((f) => !referenced.has(f) && !UNLISTED_TESTS.has(f));
  assert.deepStrictEqual(missing, [], `sem script: ${missing.join(', ')}`);
  for (const f of UNLISTED_TESTS) assert.ok(exists(f), `a lista de exceções cita um arquivo que sumiu: ${f}`);
});

await test('todo script test:* aparece no README_TESTES.md', () => {
  const readme = read('README_TESTES.md');
  const missing = Object.keys(scripts).filter((name) => name.startsWith('test:') && !readme.includes(name));
  assert.deepStrictEqual(missing, [], `README_TESTES.md não cita: ${missing.join(', ')}`);
});

console.log('2. Variáveis de ambiente');

await test('cada variável nova está no .env_example como linha COMENTADA (nunca ativa) e com o padrão certo', () => {
  const lines = read('.env_example').split(/\r?\n/);
  for (const [name, def] of NEW_VARS) {
    const active = lines.filter((l) => new RegExp(`^${name}=`).test(l));
    assert.deepStrictEqual(active, [], `${name} está ATIVA no .env_example (copiar o arquivo ligaria o recurso)`);
    const commented = lines.filter((l) => new RegExp(`^# ${name}=`).test(l));
    assert.strictEqual(commented.length, 1, `${name}: esperava 1 linha comentada, achei ${commented.length}`);
    if (def !== null) assert.strictEqual(commented[0].slice(`# ${name}=`.length).trim(), def, `${name}: padrão escrito`);
  }
});

await test('cada variável nova está na documentação (ENVIRONMENT.md) e é lida por algum arquivo de src/', () => {
  const env = read('docs/content_pt/ENVIRONMENT.md');
  const sources = walk(path.join(root, 'src')).map((f) => fs.readFileSync(f, 'utf8'));
  for (const [name] of NEW_VARS) {
    assert.ok(env.includes(`\`${name}\``), `${name} não está no ENVIRONMENT.md`);
    assert.ok(sources.some((s) => s.includes(name)), `${name} não é lida por nenhum arquivo de src/`);
  }
});

await test('toda variável YUI_*/SPOTDL_* lida pelo código está no ENVIRONMENT.md (menos as internas)', () => {
  const env = read('docs/content_pt/ENVIRONMENT.md');
  const found = new Set();
  for (const file of walk(path.join(root, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:process\.env|env\??)\.((?:YUI|SPOTDL)_[A-Z0-9_]+)\b/g)) found.add(m[1]);
    for (const m of text.matchAll(/(?:process\.env|env\??)\[['"]((?:YUI|SPOTDL)_[A-Z0-9_]+)['"]\]/g)) found.add(m[1]);
  }
  const missing = [...found].filter((n) => !INTERNAL_ENV.has(n) && !env.includes(n)).sort();
  assert.deepStrictEqual(missing, [], `lidas pelo código e ausentes do ENVIRONMENT.md: ${missing.join(', ')}`);
});

await test('os padrões documentados são os do código (módulos puros importados de verdade)', async () => {
  const upload = await import(new URL('../src/utils/uploadLimit.js', import.meta.url));
  assert.strictEqual(upload.DEFAULT_UPLOAD_LIMIT_MB, 10);
  assert.strictEqual(upload.getUploadLimitBytes(null, {}), Math.floor(10 * 1024 * 1024 * 0.95), 'base de 10 MB com 95% de folga');
  assert.strictEqual(upload.getUploadLimitBytes({ premiumTier: 2 }, {}), Math.floor(50 * 1024 * 1024 * 0.95));
  assert.strictEqual(upload.getUploadLimitBytes({ premiumTier: 3 }, {}), Math.floor(100 * 1024 * 1024 * 0.95));
  assert.strictEqual(upload.getUploadLimitBytes(null, { YUI_UPLOAD_LIMIT_MB: '25' }), Math.floor(25 * 1024 * 1024 * 0.95));
  assert.strictEqual(upload.getUploadLimitBytes({ premiumTier: 2 }, { YUI_UPLOAD_LIMIT_MB: '25' }), Math.floor(50 * 1024 * 1024 * 0.95), 'o nível 2 nunca fica abaixo de 50');

  const fit = await import(new URL('../src/utils/audioFit.js', import.meta.url));
  assert.deepStrictEqual(fit.readAudioFitConfig({}), { reencode: true, timeoutMs: 120000 });
  assert.strictEqual(fit.readAudioFitConfig({ YUI_AUDIO_REENCODE: 'false' }).reencode, false);
  assert.deepStrictEqual([...fit.FIT_BITRATES], [192, 128, 96]);
  assert.strictEqual(fit.FIT_MAX_PARALLEL, 2);

  const media = await import(new URL('../src/utils/mediaUrls.js', import.meta.url));
  assert.strictEqual(media.readMaxConcurrentDownloads({}), 3);
  assert.deepStrictEqual(media.readDownloadLimits({}), { maxMinutes: 20, maxFilesizeMB: 200, timeoutMs: 300000 });

  const spot = await import(new URL('../src/utils/spotdlTools.js', import.meta.url));
  assert.strictEqual(spot.readSpotdlBitrate({}), '192k');
  assert.strictEqual(spot.readSpotdlBitrate({ YUI_SPOTDL_BITRATE: '999k' }), '192k', 'fora de 64k a 320k volta ao padrão');
  assert.strictEqual(spot.readSpotdlLogLevel({}), 'WARNING');
  assert.strictEqual(spot.readSpotdlMaxParallel({}), 2);
  assert.strictEqual(spot.readSpotdlMaxParallel({ YUI_SPOTDL_MAX_PARALLEL: '9' }), 4, 'máximo 4');

  const reply = await import(new URL('../src/discord/longReply.js', import.meta.url));
  assert.strictEqual(reply.parseMaxParts({}), 4);
  assert.strictEqual(reply.parseAttachExt({}), 'md');
  assert.strictEqual(reply.parseAttachExt({ YUI_REPLY_ATTACH_EXT: 'txt' }), 'txt');
  assert.strictEqual(reply.parseAttachExt({ YUI_REPLY_ATTACH_EXT: 'exe' }), 'md', 'extensão desconhecida volta ao .md');
  assert.strictEqual(reply.MAX_REPLY_CHARS, 20000);
});

await test('os padrões que ficam em módulos pesados batem com o texto dos docs (conferidos no código-fonte)', () => {
  const must = (file, pattern, what) => assert.ok(pattern.test(read(file)), `${what} (${file})`);
  must('src/discord/commands/ask.js', /DEFAULT_ASK_MAX_CHARS = 4000/, 'YUI_ASK_MAX_CHARS padrão 4000');
  must('src/events/messageCreate.js', /'YUI_ATTACH_TEXT_MAX_KB', 100, 1, 1024/, 'YUI_ATTACH_TEXT_MAX_KB 100 (1 a 1024)');
  must('src/events/messageCreate.js', /'YUI_ATTACH_TEXT_MAX_CHARS', 12000, 500, 50000/, 'YUI_ATTACH_TEXT_MAX_CHARS 12000 (500 a 50000)');
  must('src/events/messageCreate.js', /ATTACH_READ_MAX_FILES = 3/, '3 arquivos lidos por mensagem');
  must('src/events/messageCreate.js', /cdn\.discordapp\.com/, 'host do CDN');
  must('src/utils/promptBudget.js', /'YUI_SUMMARY_MAX_CHARS', 20000, 1000, 200000/, 'YUI_SUMMARY_MAX_CHARS');
  must('src/utils/promptBudget.js', /'YUI_SUMMARY_PER_MESSAGE', 600, 50, 4000/, 'YUI_SUMMARY_PER_MESSAGE');
  must('src/handlers/llmHandler.js', /YUI_QUEUE_MAX, 30, 1, 1000/, 'YUI_QUEUE_MAX 30 (1 a 1000)');
  must('src/handlers/llmHandler.js', /YUI_QUEUE_MAX_PER_USER, 2, 1, 100/, 'YUI_QUEUE_MAX_PER_USER 2 (1 a 100)');
  must('src/handlers/llmHandler.js', /return 240_000/, 'YUI_AI_DEADLINE_SECONDS padrão 240');
  must('src/handlers/llmHandler.js', /DEFAULT_MAX_HISTORY_KEYS = 500/, 'YUI_HISTORY_MAX_CHANNELS padrão 500');
  must('src/search/safeFetch.js', /DEFAULT_PARSE_TIMEOUT_MS = 1500/, 'YUI_SEARCH_PARSE_TIMEOUT_MS padrão 1500');
  must('src/search/parseWorker.js', /DEFAULT_MAX_HTML_TAGS = 20000/, 'YUI_SEARCH_MAX_HTML_TAGS padrão 20000');
  must('src/search/parseWorker.js', /DEFAULT_MAX_HTML_CHARS = 300000/, 'YUI_SEARCH_MAX_HTML_CHARS padrão 300000');
});

console.log('3. Texto dos docs');

const DOCS = fs.readdirSync(path.join(root, 'docs/content_pt')).filter((f) => f.endsWith('.md')).map((f) => `docs/content_pt/${f}`);
const READ_DOCS = [...DOCS, 'README_TESTES.md', '.env_example'];

await test('nenhum texto desatualizado voltou (anexo .txt, 25 MB, frase atual, 948 verificações, origem avisada...)', () => {
  const stale = [
    [/anexo `\.txt`(?! ou `\.md`|\/`\.md`|, `\.md`)|em anexo \(\.txt\)|como arquivo `\.txt`|anexo \.txt(?! ou \.md)/, 'a resposta longa agora vai em anexo .md'],
    [/\b25 ?MB\b/, 'o limite de upload do servidor é 10 MB'],
    [/termina a frase atual/, 'desligar o TTS corta a fala na hora'],
    [/e o `spotdl` nem está instalado/, 'o spotdl está instalado em .venv-spotdl'],
    [/948 verifica/, 'o TTS tem 974 verificações'],
    [/avisa(?: no chat)? que a fonte foi outra/, 'o aviso do plano B não diz a fonte'],
    [/baixei do YouTube/, 'nenhum aviso entregue cita a origem'],
    [/pode ficar "dentro da pasta do projeto"|Precisa ficar dentro da pasta do projeto/, 'YUI_PERSONA_VOICE_FILE só vale dentro de persona/'],
    [/mesmas regras de AutoMod/, 'em voz o gatilho só alerta o dono'],
  ];
  for (const rel of READ_DOCS) {
    const text = read(rel);
    for (const [re, why] of stale) assert.ok(!re.test(text), `${rel}: texto desatualizado (${why}): ${re}`);
  }
});

await test('os pontos corrigidos estão escritos nos docs certos', () => {
  const has = (rel, re, what) => assert.ok(re.test(read(rel)), `${rel}: falta ${what}`);
  has('docs/content_pt/ENVIRONMENT.md', /Precisa ficar dentro da pasta `persona\/`/, 'YUI_PERSONA_VOICE_FILE só dentro de persona/');
  has('docs/content_pt/ENVIRONMENT.md', /Citados no arquivo/, 'a linha "Citados no arquivo"');
  has('docs/content_pt/ENVIRONMENT.md', /\.venv-spotdl/, 'o ambiente do spotdl');
  has('docs/content_pt/ENVIRONMENT.md', /não vale\*\* para o Spotify|nem para o Spotify/, 'YUI_DL_MAX_MINUTES não vale para o Spotify');
  has('docs/content_pt/ENVIRONMENT.md', /\*\*começar com `\.`\*\*[^\n]*terminar com `\.`, `\*` ou `\$`/, 'a regra da pasta temporária do spotdl');
  has('docs/content_pt/ENVIRONMENT.md', /relógio/i, 'o relógio do PC');
  has('docs/content_pt/ENVIRONMENT.md', /versão diferente/, 'a versão diferente da faixa');
  has('docs/content_pt/ENVIRONMENT.md', /só se o `spotdl` estiver \*\*ausente\*\*/, 'o fallback para o yt-dlp só com o spotdl ausente');
  has('docs/content_pt/OPERACAO.md', /cortada na hora/, 'a fala cortada na hora');
  has('docs/content_pt/MODERATION.md', /só alerta o dono/, 'o gatilho de voz só alerta o dono');
  has('docs/content_pt/MODERATION.md', /não bane sozinho/, 'o gatilho de voz não bane');
  has('docs/content_pt/FEATURES.md', /974 verifica/, 'a contagem do TTS');
  has('docs/content_pt/ASSISTENTE_PESSOAL.md', /974 verifica/, 'a contagem do TTS');
  has('docs/content_pt/COMMANDS.md', /anexo `\.md`/, 'a resposta longa em .md');
  has('docs/content_pt/GET_STARTED.md', /py -3\.12 -m venv \.venv-spotdl/, 'a instalação do spotdl');
  has('README_TESTES.md', /test:tts-e2e/, 'o teste ponta a ponta do TTS');
  has('README_TESTES.md', /test:spotdl/, 'o teste do spotdl');
});

await test('as mensagens que os docs citam entre aspas existem no código (recusas, avisos e rótulos)', () => {
  const has = (rel, text) => assert.ok(read(rel).includes(text), `${rel} não tem: ${text}`);
  has('src/discord/longReply.js', 'Citados no arquivo');
  has('src/discord/longReply.js', 'Faltaram');
  has('src/discord/longReply.js', 'Anexar arquivos');
  has('src/discord/commands/ask.js', 'Texto grande demais');
  has('src/handlers/llmHandler.js', 'Você já tem pedidos na fila, ou a fila está cheia');
  has('src/utils/mediaUrls.js', 'a qualidade desta faixa pode ser menor que a original');
  has('src/utils/mediaUrls.js', 'O arquivo ficou maior que o limite de envio do Discord');
  has('src/events/interactionCreate.js', 'Há muitos downloads acontecendo ao mesmo tempo');
});

console.log('4. Estrutura dos arquivos de documentação');

await test('nenhum arquivo de documentação tem fim de linha misto (CRLF e LF juntos)', () => {
  for (const rel of [...READ_DOCS, 'package.json']) {
    const buf = fs.readFileSync(path.join(root, rel));
    let cr = 0;
    let lf = 0;
    for (const b of buf) {
      if (b === 13) cr++;
      else if (b === 10) lf++;
    }
    assert.ok(cr === 0 || cr === lf, `${rel}: CR ${cr}, LF ${lf} (fim de linha misto)`);
  }
});

function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}
function headingsOf(rel) {
  const set = new Set();
  let fenced = false;
  for (const line of read(rel).split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) set.add(slug(m[1]));
  }
  return set;
}

await test('os links internos para um título (arquivo.md#ancora) apontam para títulos que existem', () => {
  const broken = [];
  const cache = new Map();
  for (const rel of [...DOCS, 'README_TESTES.md']) {
    const dir = path.dirname(rel);
    for (const m of read(rel).matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = m[1];
      if (/^(https?:|mailto:)/.test(href) || !href.includes('#')) continue;
      const [file, anchor] = href.split('#');
      const targetRel = file ? path.posix.normalize(path.posix.join(dir.split(path.sep).join('/'), file)) : rel.split(path.sep).join('/');
      if (!targetRel.endsWith('.md') || !exists(targetRel)) continue;
      if (!cache.has(targetRel)) cache.set(targetRel, headingsOf(targetRel));
      if (!cache.get(targetRel).has(decodeURIComponent(anchor))) broken.push(`${rel} -> ${href}`);
    }
  }
  assert.deepStrictEqual(broken, [], `links quebrados:\n        ${broken.join('\n        ')}`);
});

console.log(failed ? `\nFALHA: ${passed} teste(s) passaram, ${failed} falharam.\nFalharam: ${failures.join(' | ')}` : `\n${passed} teste(s) passaram, 0 falharam.`);
process.exit(failed ? 1 : 0);
