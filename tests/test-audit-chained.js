import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { audit, verifyAudit, computeEntryHash, getLastAuditState } from '../src/core/audit.js';
import { configureAlerts } from '../src/core/alerts.js';

test('Auditoria com Hash Encadeado (R04)', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-audit-test-'));
  const testAuditFile = path.join(tmpRoot, 'test-audit.jsonl');
  process.env.YUI_AUDIT_FILE = testAuditFile;

  await t.test('grava eventos com seq incremental, prev_hash e hash encadeado', () => {
    const e1 = audit('test.event.one', { userId: 'user-1', role: 'OWNER' }, { action: 'init' });
    assert.equal(e1.seq, 1);
    assert.equal(e1.prev_hash, '0000000000000000000000000000000000000000000000000000000000000000');
    assert(e1.hash && e1.hash.length === 64);

    const e2 = audit('test.event.two', { userId: 'user-1', role: 'OWNER' }, { action: 'step' });
    assert.equal(e2.seq, 2);
    assert.equal(e2.prev_hash, e1.hash);
    assert(e2.hash && e2.hash.length === 64);

    const verify = verifyAudit(testAuditFile);
    assert.equal(verify.ok, true);
    assert.equal(verify.total, 2);
    assert.equal(verify.chained, 2);
    assert.equal(verify.errors.length, 0);
  });

  await t.test('verifyAudit detecta linha adulterada', () => {
    const content = fs.readFileSync(testAuditFile, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const tampered = JSON.parse(lines[0]);
    tampered.action = 'hacked_action';
    // Não atualiza o hash para simular adulteração
    const newContent = [JSON.stringify(tampered), lines[1]].join('\n') + '\n';
    fs.writeFileSync(testAuditFile, newContent);

    const res = verifyAudit(testAuditFile);
    assert.equal(res.ok, false);
    assert(res.errors.some((e) => e.reason.includes('Hash adulterado')));

    // Restaura conteúdo correto para os próximos testes
    fs.writeFileSync(testAuditFile, content);
  });

  await t.test('verifyAudit detecta linha removida na cadeia', () => {
    // Adiciona terceiro evento
    audit('test.event.three', { userId: 'user-1' }, { action: 'finish' });

    const content = fs.readFileSync(testAuditFile, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    assert.equal(lines.length, 3);

    // Remove linha do meio (evento 2)
    const missingMiddle = [lines[0], lines[2]].join('\n') + '\n';
    fs.writeFileSync(testAuditFile, missingMiddle);

    const res = verifyAudit(testAuditFile);
    assert.equal(res.ok, false);
    assert(res.errors.some((e) => e.reason.includes('Quebra de sequência') || e.reason.includes('Elo quebrado')));

    // Restaura
    fs.writeFileSync(testAuditFile, content);
  });

  await t.test('verifyAudit detecta reordenação de linhas', () => {
    const content = fs.readFileSync(testAuditFile, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const reordered = [lines[1], lines[0], lines[2]].join('\n') + '\n';
    fs.writeFileSync(testAuditFile, reordered);

    const res = verifyAudit(testAuditFile);
    assert.equal(res.ok, false);
    assert(res.errors.length > 0);

    // Restaura
    fs.writeFileSync(testAuditFile, content);
  });

  await t.test('linhas antigas sem seq/hash continuam sendo aceitas com compatibilidade', () => {
    const legacyLine = JSON.stringify({
      ts: '2026-01-01T00:00:00.000Z',
      event: 'legacy.action',
      userId: 'old-user',
    });
    const combined = legacyLine + '\n' + fs.readFileSync(testAuditFile, 'utf8');
    fs.writeFileSync(testAuditFile, combined);

    const res = verifyAudit(testAuditFile);
    assert.equal(res.ok, true);
    assert.equal(res.total, 4);
    assert.equal(res.chained, 3);
  });

  await t.test('sanitização não grava conteúdo sensível nem senhas/tokens na auditoria', () => {
    const res = audit('dev.test.sanitize', { userId: 'u1' }, {
      command: 'echo ok',
      password: 'super-secret-password',
      token: 'sk-1234567890abcdef1234567890',
      apiKey: 'secret_api_key',
      safeParam: 'public_value',
    });

    assert.equal(res.command, 'echo ok');
    assert.equal(res.safeParam, 'public_value');
    assert.equal(res.password, undefined);
    assert.equal(res.token, undefined);
    assert.equal(res.apiKey, undefined);
  });

  await t.test('falha na gravação do arquivo dispara alerta ao dono', () => {
    let alertSent = null;
    configureAlerts({
      notify: async (ownerId, text) => {
        alertSent = { ownerId, text };
      },
      ownerId: '987654321',
      env: { YUI_ALERTS: 'true' },
    });

    // Aponta para um caminho inválido (pasta que é um arquivo existente)
    const blockedDir = path.join(tmpRoot, 'file_as_dir');
    fs.writeFileSync(blockedDir, 'blocking');
    process.env.YUI_AUDIT_FILE = path.join(blockedDir, 'cannot_create', 'audit.jsonl');

    audit('fail.event', { userId: 'u1' }, { test: true });

    assert(alertSent !== null, 'Deveria ter alertado o dono sobre a falha de gravação');
    assert(alertSent.text.includes('Falha na gravação da auditoria'));
  });

  // Limpeza
  try {
    delete process.env.YUI_AUDIT_FILE;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});
