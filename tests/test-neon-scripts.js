// Scripts do Neon (backup puxado + reserva fria): sintaxe e parametros dos .ps1, a DECISAO de ativar (recusa se o notebook responde), o selo do manifesto e a
// escolha do ultimo backup completo. Nao faz rede, nao toca git e nao inicia nada: so le os .ps1 e roda funcoes puras no powershell.exe local (Windows). Execucao: npm run test:neonscripts
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const raiz = path.resolve(import.meta.dirname, '..');
const scripts = path.join(raiz, 'scripts');
const ARQUIVOS = ['neon-comum.ps1', 'neon-backup-puxar.ps1', 'neon-instalar-tarefa-backup.ps1', 'neon-reserva-fria.ps1'];

let passed = 0;
let failed = 0;
const test = (nome, fn) => {
  try { fn(); passed += 1; console.log(`  ok   ${nome}`); } catch (e) { failed += 1; console.log(`  FALHA ${nome}\n        ${String(e?.stack ?? e).split('\n').slice(0, 6).join('\n        ')}`); }
};

if (process.platform !== 'win32') {
  console.log('Pulado: os scripts do Neon sao PowerShell do Windows.');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-test-neon-'));
const ps = (arquivo) => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', arquivo], { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`powershell saiu ${r.status}: ${(r.stderr || r.stdout).slice(0, 600)}`);
  return r.stdout;
};

// ── 1. sintaxe, ASCII e parametros ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const analisador = path.join(tmp, 'analisar.ps1');
fs.writeFileSync(analisador, `
$saida = @{}
foreach ($nome in '${ARQUIVOS.join("','")}') {
  $erros = $null; $tokens = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path '${scripts.replace(/\\/g, '\\\\')}' $nome), [ref]$tokens, [ref]$erros)
  $params = @()
  if ($ast.ParamBlock) { $params = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }) }
  $funcs = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | ForEach-Object { $_.Name })
  $saida[$nome] = @{ erros = @($erros | ForEach-Object { $_.Message }); params = $params; funcs = $funcs }
}
$saida | ConvertTo-Json -Depth 5 -Compress
`);
const analise = JSON.parse(ps(analisador));

test('os 4 scripts .ps1 existem, sao so ASCII e nao tem erro de sintaxe', () => {
  for (const nome of ARQUIVOS) {
    const buf = fs.readFileSync(path.join(scripts, nome));
    assert.ok(!buf.some((b) => b > 127), `${nome} tem caractere nao ASCII (PowerShell 5.1 le sem BOM como ANSI)`);
    const erros = [].concat(analise[nome].erros ?? []);
    assert.deepEqual(erros, [], `${nome}: ${erros.join(' | ')}`);
  }
});

test('parametros esperados em cada script', () => {
  const tem = (nome, lista) => { for (const p of lista) assert.ok([].concat(analise[nome].params).includes(p), `${nome} sem -${p}`); };
  tem('neon-backup-puxar.ps1', ['Destino', 'RepoUrl', 'ChaveSsh', 'Log', 'AlertaHoras']);
  tem('neon-instalar-tarefa-backup.ps1', ['Remover', 'Agora', 'Hora', 'Destino', 'ChaveSsh', 'Log']);
  tem('neon-reserva-fria.ps1', ['Preparar', 'Ativar', 'Desativar', 'Status', 'Reserva', 'BackupRepo', 'ArquivoChave', 'ArquivoEnv', 'NotebookUrl', 'NotebookNome', 'ForcarNotebookLigado']);
});

test('o script da reserva nunca encerra processo por PID e nao guarda a chave', () => {
  const t = fs.readFileSync(path.join(scripts, 'neon-reserva-fria.ps1'), 'utf8');
  assert.ok(!/Stop-Process|taskkill|\.Kill\(\)|Get-Process/i.test(t), 'nao pode matar processo');
  assert.ok(t.includes('supervisor.parar'), 'a parada usa o arquivo supervisor.parar');
  assert.ok(!/Set-Content[^\n]*ArquivoChave|Copy-Item\s+\$ArquivoChave/i.test(t), 'a chave nao pode ser copiada nem gravada');
  assert.ok(t.includes('ATIVAR RESERVA'), 'pede confirmacao digitada');
});

// ── 2. decisao de ativar, selo do manifesto e escolha do backup (funcoes puras de neon-comum.ps1) ──────────────────────────────────────────
const lote = path.join(tmp, 'repo', 'backups');
const nomeLote = (d) => `backup-${d.toISOString().replace(/[:.]/g, '-')}`;
const mkLote = (nome, manifesto, enc = ['memory-personal.db.enc']) => {
  const dir = path.join(lote, nome);
  fs.mkdirSync(dir, { recursive: true });
  if (manifesto) fs.writeFileSync(path.join(dir, 'manifest.json.enc'), manifesto);
  for (const e of enc) fs.writeFileSync(path.join(dir, e), 'x');
};
const cifrado = crypto.randomBytes(120);
const v2 = (conteudo) => Buffer.concat([Buffer.from('YUI_MANIFEST_V2\n'), Buffer.from(crypto.createHash('sha256').update(conteudo).digest('hex')), Buffer.from('\n'), conteudo]);
const bom = v2(cifrado);
const adulterado = Buffer.from(bom); adulterado[adulterado.length - 3] ^= 0xff;
const truncado = bom.subarray(0, bom.length - 10);
fs.mkdirSync(path.join(tmp, 'm'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'm', 'bom.bin'), bom);
fs.writeFileSync(path.join(tmp, 'm', 'adulterado.bin'), adulterado);
fs.writeFileSync(path.join(tmp, 'm', 'truncado.bin'), truncado);
fs.writeFileSync(path.join(tmp, 'm', 'v1.bin'), crypto.randomBytes(200));
fs.writeFileSync(path.join(tmp, 'm', 'curto.bin'), Buffer.from('abc'));
fs.writeFileSync(path.join(tmp, 'm', 'vazio.bin'), Buffer.alloc(0));

const velho = nomeLote(new Date('2026-11-01T05:30:00.123Z'));
const meio = nomeLote(new Date('2026-11-20T05:30:00.456Z'));
const novoSemManifesto = nomeLote(new Date('2026-11-27T05:30:00.789Z'));
const novoAdulterado = nomeLote(new Date('2026-11-28T05:30:00.001Z'));
mkLote(velho, bom);
mkLote(meio, bom);
mkLote(novoSemManifesto, null);
mkLote(novoAdulterado, adulterado);
fs.mkdirSync(path.join(lote, 'qualquer-pasta'), { recursive: true });

const funcoes = path.join(tmp, 'funcoes.ps1');
fs.writeFileSync(funcoes, `
. '${path.join(scripts, 'neon-comum.ps1').replace(/'/g, "''")}'
$r = @{}
foreach ($n in 'bom','adulterado','truncado','v1','curto','vazio') { $r['selo_' + $n] = Test-ManifestoSelo -Bytes ([System.IO.File]::ReadAllBytes('${path.join(tmp, 'm').replace(/\\/g, '\\\\')}\\' + $n + '.bin')) }
$r['decisoes'] = @(
  (Resolve-DecisaoAtivar -NotebookRespondeu 'sim' -TailscaleLocalOk $true -NotebookNaRede 'nao'),
  (Resolve-DecisaoAtivar -NotebookRespondeu 'sim' -TailscaleLocalOk $true -NotebookNaRede 'nao' -Forcar $true),
  (Resolve-DecisaoAtivar -NotebookRespondeu 'nao' -TailscaleLocalOk $false -NotebookNaRede 'nao'),
  (Resolve-DecisaoAtivar -NotebookRespondeu 'desconhecido' -TailscaleLocalOk $true -NotebookNaRede 'nao'),
  (Resolve-DecisaoAtivar -NotebookRespondeu 'nao' -TailscaleLocalOk $true -NotebookNaRede 'sim'),
  (Resolve-DecisaoAtivar -NotebookRespondeu 'nao' -TailscaleLocalOk $true -NotebookNaRede 'sim' -Forcar $true),
  (Resolve-DecisaoAtivar -NotebookRespondeu 'nao' -TailscaleLocalOk $true -NotebookNaRede 'desconhecido'),
  (Resolve-DecisaoAtivar -NotebookRespondeu 'nao' -TailscaleLocalOk $true -NotebookNaRede 'nao'),
  (Resolve-DecisaoAtivar -NotebookRespondeu 'nao' -TailscaleLocalOk $true -NotebookNaRede 'desconhecido' -Forcar $true)
) | ForEach-Object { @{ permitir = [bool]$_.Permitir; motivo = $_.Motivo } }
$r['lotes'] = @(Get-BackupsDoRepositorio -PastaBackups '${lote.replace(/\\/g, '\\\\')}') | ForEach-Object { @{ nome = $_.Nome; completo = $_.Completo; motivo = $_.Motivo; arquivos = $_.Arquivos; utc = $_.QuandoUtc.ToString('o') } }
$r['semUrl'] = Test-RespondeSaude -Url ''
$r | ConvertTo-Json -Depth 6 -Compress
`);
const f = JSON.parse(ps(funcoes));

test('selo do manifesto v2: so o integro passa (adulterado, truncado e vazio recusados; v1 aceito so pela forma)', () => {
  assert.equal(f.selo_bom.Ok, true);
  assert.equal(f.selo_bom.Versao, 2);
  assert.equal(f.selo_adulterado.Ok, false);
  assert.match(f.selo_adulterado.Motivo, /selo/);
  assert.equal(f.selo_truncado.Ok, false);
  assert.equal(f.selo_vazio.Ok, false);
  assert.equal(f.selo_curto.Ok, false);
  assert.equal(f.selo_v1.Ok, true);
  assert.equal(f.selo_v1.Versao, 1);
});

test('decisao de ativar: RECUSA se o notebook responde, mesmo com -Forcar', () => {
  assert.equal(f.decisoes[0].permitir, false);
  assert.match(f.decisoes[0].motivo, /RESPONDE/);
  assert.equal(f.decisoes[1].permitir, false, 'Forcar nao vence um notebook que responde');
});

test('decisao de ativar: sem Tailscale local ou sem endereco, nao prova nada e recusa', () => {
  assert.equal(f.decisoes[2].permitir, false);
  assert.match(f.decisoes[2].motivo, /Tailscale/);
  assert.equal(f.decisoes[3].permitir, false);
  assert.equal(f.semUrl, 'desconhecido');
});

test('decisao de ativar: notebook ligado no Tailscale so com -Forcar; fora de verdade libera', () => {
  assert.equal(f.decisoes[4].permitir, false);
  assert.equal(f.decisoes[5].permitir, true);
  assert.equal(f.decisoes[6].permitir, false, 'sem confirmar que esta fora, recusa');
  assert.equal(f.decisoes[7].permitir, true);
  assert.equal(f.decisoes[8].permitir, true);
});

test('escolha do backup: do mais novo ao mais antigo; incompleto e adulterado nao valem; pasta de nome estranho e ignorada', () => {
  const nomes = f.lotes.map((l) => l.nome);
  assert.deepEqual(nomes, [novoAdulterado, novoSemManifesto, meio, velho]);
  const completos = f.lotes.filter((l) => l.completo).map((l) => l.nome);
  assert.deepEqual(completos, [meio, velho]);
  assert.match(f.lotes[1].motivo, /sem manifesto/);
  assert.equal(f.lotes[2].arquivos, 1);
  assert.equal(f.lotes[2].utc.slice(0, 19), '2026-11-20T05:30:00');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} testes OK${failed ? `, ${failed} FALHARAM` : ''}`);
process.exit(failed ? 1 : 0);
