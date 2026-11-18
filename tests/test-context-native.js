// A suíte do contexto por horas (tests/test-context.js) com os DOIS bancos de contexto no motor nativo (node:sqlite, WAL).
// Os testes são os mesmos do modo padrão (sql.js). Onde o motor muda o que se confere (texto que fica no -wal, leitura do
// banco aberto, quarentena com o arquivo aberto), o próprio test-context.js segue o motor pedido em YUI_DB_NATIVE.
// Execução: node tests/test-context-native.js
process.env.YUI_DB_NATIVE = 'memory-context,memory-context-personal';
// O node:sqlite ainda avisa "experimental" no Node 24; o teste abre vários processos filhos e cada um repetiria o aviso.
process.env.NODE_NO_WARNINGS ??= '1';
await import('./test-context.js');
