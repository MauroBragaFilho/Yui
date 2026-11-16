// Perfil temporário do Chrome: criar, remover, varrer perfis velhos e reconhecer o EBUSY de limpeza. Execução: node tests/test-chrome-profile.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChromeProfile, removeChromeProfile, sweepStaleChromeProfiles, isChromeProfileCleanupError } from '../src/utils/chromeProfile.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-cp-test-'));

const p = createChromeProfile({ tmp });
assert.ok(fs.existsSync(p.dir) && path.basename(p.dir).startsWith('yui-chrome-'));
fs.writeFileSync(path.join(p.dir, 'lockfile'), 'x');
assert.equal(await removeChromeProfile(p.dir, { tries: 2, delayMs: 10 }), true);
assert.equal(fs.existsSync(p.dir), false);
assert.equal(await removeChromeProfile(null), true);

// varredura: só pastas do Chrome e só as velhas
const old = path.join(tmp, 'puppeteer_dev_chrome_profile-AAA');
const young = path.join(tmp, 'yui-chrome-NEW');
const other = path.join(tmp, 'outra-coisa');
for (const d of [old, young, other]) fs.mkdirSync(d);
const longAgo = new Date(Date.now() - 3 * 3600 * 1000);
fs.utimesSync(old, longAgo, longAgo);
fs.utimesSync(other, longAgo, longAgo);
assert.equal(sweepStaleChromeProfiles({ tmp }), 1);
assert.equal(fs.existsSync(old), false);
assert.equal(fs.existsSync(young), true, 'perfil recente (pode estar em uso) fica');
assert.equal(fs.existsSync(other), true, 'nada fora do padrão é tocado');

// filtro do alerta
const ebusy = Object.assign(new Error("EBUSY: resource busy or locked, unlink 'C:\\Windows\\TEMP\\puppeteer_dev_chrome_profile-Oqd4AJ\\lockfile'"), { code: 'EBUSY' });
assert.equal(isChromeProfileCleanupError(ebusy), true);
assert.equal(isChromeProfileCleanupError(new Error("EBUSY: resource busy or locked, unlink 'C:\\dados\\yui.db'")), false, 'EBUSY em arquivo da Yui continua alertando');
assert.equal(isChromeProfileCleanupError('texto'), false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('test-chrome-profile: ok');
process.exit(0);
