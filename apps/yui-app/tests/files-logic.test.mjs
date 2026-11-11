// Testes da lógica da tela "Arquivos" (sem React e sem rede). Execução: npm test (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/api/client.ts';
import { TABS, tabVisible } from '../src/tabs.ts';
import { sepOf, joinPath, parentPath, baseName, breadcrumbs, formatBytes, formatWhen, previewKind, iconFor, normalizeItems, sortItems, nameProblem, diskUsage, formatUptime, describeBdsStatus, describeBdsAudit } from '../src/filesLogic.ts';

const ROOT = 'C:\\BDS-Dados';

test('caminhos do Windows: juntar, pai e nome', () => {
  assert.equal(sepOf('C:\\a'), '\\');
  assert.equal(sepOf('/mnt/a'), '/');
  assert.equal(joinPath(ROOT + '\\Filmes', 'Acao'), 'C:\\BDS-Dados\\Filmes\\Acao');
  assert.equal(joinPath(ROOT + '\\Filmes\\', '\\Acao'), 'C:\\BDS-Dados\\Filmes\\Acao', 'não duplica barra');
  assert.equal(joinPath('/mnt/x', 'y'), '/mnt/x/y');
  assert.equal(parentPath('C:\\BDS-Dados\\Filmes\\a.mp4'), 'C:\\BDS-Dados\\Filmes');
  assert.equal(parentPath('C:\\BDS-Dados'), 'C:\\');
  assert.equal(parentPath('C:\\'), 'C:\\');
  assert.equal(baseName('C:\\BDS-Dados\\Filmes\\a.mp4'), 'a.mp4');
  assert.equal(baseName('C:\\BDS-Dados\\Filmes\\'), 'Filmes');
});

test('trilha de pastas a partir da raiz do servidor', () => {
  const c = breadcrumbs('C:\\BDS-Dados\\Filmes\\Acao', [ROOT]);
  assert.deepEqual(c.map((x) => x.label), ['Arquivos', 'Filmes', 'Acao']);
  assert.deepEqual(c.map((x) => x.path), [ROOT, 'C:\\BDS-Dados\\Filmes', 'C:\\BDS-Dados\\Filmes\\Acao']);
  assert.deepEqual(breadcrumbs(ROOT, [ROOT]).map((x) => x.label), ['Arquivos']);
  assert.deepEqual(breadcrumbs('c:\\bds-dados\\Series', [ROOT]).map((x) => x.label), ['Arquivos', 'Series'], 'sem diferenciar maiúsculas (Windows)');
  assert.equal(breadcrumbs('D:\\outra', [ROOT]).length, 1, 'fora das raízes: só o caminho');
  assert.equal(breadcrumbs('C:\\BDS-Dados-Outro\\x', [ROOT]).length, 1, 'prefixo parecido não é a mesma raiz');
});

test('tamanhos e datas', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1,5 KB');
  assert.equal(formatBytes(3 * 1024 ** 3), '3,0 GB');
  assert.equal(formatBytes(null), '—');
  assert.equal(formatBytes(-1), '—');
  assert.equal(formatBytes(Number.NaN), '—');
  assert.equal(formatWhen(null), '—');
  assert.equal(formatWhen('lixo'), '—');
  assert.match(formatWhen('2026-11-07T13:50:00.000Z'), /^\d{2}\/\d{2}\/2026 \d{2}:\d{2}$/);
});

test('o que o navegador toca e o ícone de cada tipo', () => {
  assert.equal(previewKind('Filme.MP4'), 'video');
  assert.equal(previewKind('musica.flac'), 'audio');
  assert.equal(previewKind('foto.jpeg'), 'image');
  assert.equal(previewKind('livro.pdf'), 'pdf');
  assert.equal(previewKind('Filme.mkv'), null, 'mkv só baixa (use o HomeFlix)');
  assert.equal(previewKind('semextensao'), null);
  assert.equal(iconFor('Acao', 'dir'), 'folder');
  assert.equal(iconFor('a.mkv', 'arquivo'), 'movie');
  assert.equal(iconFor('a.srt', 'arquivo'), 'subtitles');
  assert.equal(iconFor('a.zip', 'arquivo'), 'folder_zip');
  assert.equal(iconFor('a.xyz', 'arquivo'), 'draft');
});

test('itens do BDS Server: normaliza, ordena pastas primeiro e monta o caminho', () => {
  const raw = { caminho: ROOT, itens: [
    { nome: 'b.mp4', tipo: 'arquivo', tamanho: 10, modificado: '2026-11-07T13:50:00.000Z' },
    { nome: 'Filmes', tipo: 'dir', tamanho: null, modificado: null },
    { nome: 'a.txt', tipo: 'arquivo', tamanho: 5 },
    { tipo: 'arquivo' }, null,
  ] };
  const items = sortItems(normalizeItems(raw, ROOT));
  assert.deepEqual(items.map((i) => i.name), ['Filmes', 'a.txt', 'b.mp4']);
  assert.equal(items[0].isDir, true);
  assert.equal(items[0].path, 'C:\\BDS-Dados\\Filmes');
  assert.equal(items[2].size, 10);
  assert.deepEqual(normalizeItems(null, ROOT), []);
  assert.deepEqual(normalizeItems({ itens: 'x' }, ROOT), []);
  assert.equal(normalizeItems([{ nome: 'x', tipo: 'arquivo', caminho: 'C:\\onde\\x' }], ROOT)[0].path, 'C:\\onde\\x', 'usa o caminho que o servidor deu');
});

test('nome válido para criar e renomear', () => {
  assert.equal(nameProblem('Filmes 2026'), null);
  assert.equal(nameProblem('  '), 'Digite um nome.');
  assert.match(nameProblem('a/b'), /não pode ter/);
  assert.match(nameProblem('a:b'), /não pode ter/);
  assert.equal(nameProblem('..'), 'Nome inválido.');
  assert.match(nameProblem('x'.repeat(201)), /longo demais/);
});

test('espaço do disco', () => {
  const d = diskUsage([{ caminho: ROOT, totalBytes: 464.91 * 1024 ** 3, livreBytes: 421.17 * 1024 ** 3 }]);
  assert.equal(d.freePercent, 91);
  assert.ok(d.used > 0 && d.total > d.used);
  assert.equal(diskUsage([{ totalBytes: null, livreBytes: null }]), null);
  assert.equal(diskUsage(null), null);
  assert.equal(diskUsage([{ totalBytes: 0, livreBytes: 0 }]), null);
});

test('a aba Arquivos existe e só o dono vê', () => {
  assert.ok(TABS.some((x) => x.key === 'files' && x.label === 'Arquivos'));
  assert.equal(tabVisible('files', { showAdmin: false }), false);
  assert.equal(tabVisible('files', { showAdmin: true }), true);
});

test('cliente: chamadas ao BDS pela API da Yui (rotas, corpo, confirmação e link absoluto)', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : null, auth: init?.headers?.Authorization });
    return new Response(JSON.stringify(String(url).endsWith('/link') ? { url: '/v1/bds/get/abc123' } : { ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const c = createClient({ baseUrl: 'http://yui.local:3939', token: 'tok-1234567890123456', fetchImpl });
  const BS = String.fromCharCode(92);
  const win = (s) => s.split('/').join(BS); // 'C:/x/a' -> caminho do Windows

  await c.bds.list(win('C:/BDS-Dados/Filmes'));
  assert.equal(calls.at(-1).url, 'http://yui.local:3939/v1/admin/bds/list?caminho=C%3A%5CBDS-Dados%5CFilmes');
  assert.equal(calls.at(-1).auth, 'Bearer tok-1234567890123456');
  await c.bds.remove(win('C:/x/a.mp4'));
  assert.deepEqual(calls.at(-1).body, { caminho: win('C:/x/a.mp4'), confirmar: true }, 'apagar sempre manda a confirmação');
  assert.equal(calls.at(-1).method, 'POST');
  await c.bds.purge(win('C:/lixeira/a'));
  assert.equal(calls.at(-1).body.confirmar, true);
  await c.bds.rename(win('C:/a'), win('C:/b'));
  assert.deepEqual(calls.at(-1).body, { de: win('C:/a'), para: win('C:/b') });
  await c.bds.mkdir(win('C:/n'));
  assert.equal(calls.at(-1).url, 'http://yui.local:3939/v1/admin/bds/mkdir');
  const url = await c.bds.link(win('C:/f.mp4'), true);
  assert.equal(url, 'http://yui.local:3939/v1/bds/get/abc123', 'o link vem absoluto, com o endereço da Yui');
  assert.deepEqual(calls.at(-1).body, { caminho: win('C:/f.mp4'), inline: true });
  await c.bds.search('matrix reloaded');
  assert.equal(calls.at(-1).url, 'http://yui.local:3939/v1/admin/bds/search?q=matrix%20reloaded');
});

test('estado e auditoria do BDS Server em português, sem inventar campo', () => {
  const rows = describeBdsStatus({ hostname: 'DESKTOP-7U30K95', so: 'Windows_NT 10.0.19045', versao: '0.1.0', node: 'v24.14.0', cpuPercent: 12, ramTotalGB: 3.89, ramLivreGB: 1.06, processoMB: 59, uptimeSegundos: 93784, servidorDesde: '2026-11-11T12:00:00.000Z' });
  const m = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(m['Computador'], 'DESKTOP-7U30K95');
  assert.equal(m['Uso da CPU'], '12%');
  assert.equal(m['Memória RAM livre'], '1,1 GB de 3,9 GB');
  assert.equal(m['Computador ligado há'], '1d 2h');
  assert.equal(m['Memória do BDS Server'], '59 MB');
  assert.deepEqual(describeBdsStatus(null), []);
  assert.deepEqual(describeBdsStatus({}), [], 'sem campos: sem linhas');
  assert.equal(formatUptime(90), '1min');
  assert.equal(formatUptime(null), '—');
  assert.deepEqual(describeBdsAudit({ module: 'files', action: 'upload', user: 'anonimo', result: 'ok' }), { text: 'Enviou', who: null, failed: false });
  assert.deepEqual(describeBdsAudit({ module: 'files', action: 'delete', user: 'mauro', result: 'ok' }), { text: 'Apagou (lixeira)', who: 'mauro', failed: false });
  assert.equal(describeBdsAudit({ action: 'upload', result: 'negado' }).failed, true);
  assert.equal(describeBdsAudit({ module: 'x', action: 'coisa' }).text, 'x · coisa');
  assert.equal(describeBdsAudit(null).text, 'Evento');
});
