// Gera o hash seguro (scrypt) da senha do painel da Yui.
//
//   npm run panel:password
//
// Você digita a senha (sem aparecer na tela) e o script imprime a linha pronta
// para colar no .env:   YUI_PANEL_PASSWORD_HASH=scrypt$...
// A senha em si NÃO é salva em lugar nenhum.
import readline from 'node:readline';
import { hashPassword, MIN_PLAIN_PASSWORD } from '../src/core/api/auth.js';

/** Lê uma linha sem ecoar o que é digitado. */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl.output;
    rl._writeToOutput = (text) => {
      // mostra a pergunta, mas não os caracteres digitados
      if (text.startsWith(question)) out.write(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      out.write('\n');
      resolve(answer);
    });
  });
}

console.log('Hash da senha do painel da Yui\n');
const password = await askHidden('Nova senha: ');
if (password.length < MIN_PLAIN_PASSWORD) {
  console.error(`\nA senha precisa ter pelo menos ${MIN_PLAIN_PASSWORD} caracteres.`);
  process.exit(1);
}
const again = await askHidden('Repita a senha: ');
if (again !== password) {
  console.error('\nAs senhas não conferem.');
  process.exit(1);
}

console.log('\nCole estas linhas no seu .env (troque o usuário se quiser):\n');
console.log('YUI_PANEL_USER=admin');
console.log(`YUI_PANEL_PASSWORD_HASH=${hashPassword(password)}`);
console.log('\nDepois reinicie a Yui. Não use YUI_PANEL_PASSWORD junto: o hash tem prioridade.');
