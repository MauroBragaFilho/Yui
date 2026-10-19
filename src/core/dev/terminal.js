import { spawn } from 'child_process';

/**
 * Executa um comando dentro da pasta do projeto.
 *
 * Correções em relação ao Jarvis: usava exec() com buffer padrão (estourava em
 * saídas grandes), o timeout matava só o shell e deixava processos filhos vivos,
 * e o comando herdava TODAS as variáveis de ambiente (chaves de API incluídas).
 * Aqui: spawn com limite de saída, encerramento da árvore de processos no timeout
 * e ambiente sem variáveis sensíveis.
 */

const SENSITIVE_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|ARL|AUTH)/i;

function safeEnv(env = process.env) {
  const clean = {};
  for (const [name, value] of Object.entries(env)) {
    if (!SENSITIVE_ENV.test(name)) clean[name] = value;
  }
  return clean;
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* já encerrou */ }
  }
}

/**
 * @param {string} command
 * @param {{ cwd: string, timeoutMs?: number, maxOutput?: number, env?: object, signal?: AbortSignal }} options
 * @returns {Promise<{ success: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean, truncated: boolean, aborted: boolean }>}
 */
function runCommand(command, { cwd, timeoutMs = 60_000, maxOutput = 20_000, env = process.env, signal = null } = {}) {
  return new Promise((resolve) => {
    if (!cwd) {
      resolve({ success: false, code: null, stdout: '', stderr: 'Nenhum projeto aberto.', timedOut: false, truncated: false, aborted: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let finished = false;

    const child = spawn(String(command), {
      cwd,
      env: safeEnv(env),
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (next.length > maxOutput) {
        truncated = true;
        return next.slice(0, maxOutput);
      }
      return next;
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const done = (code, extraError = '') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        success: code === 0 && !timedOut && !aborted,
        code,
        stdout,
        stderr: extraError ? `${stderr}${stderr ? '\n' : ''}${extraError}` : stderr,
        timedOut,
        truncated,
        aborted,
      });
    };
    child.on('error', (err) => done(null, `Falha ao iniciar o comando: ${err.message}`));
    child.on('close', (code) => done(code));
  });
}

export { runCommand, safeEnv };
