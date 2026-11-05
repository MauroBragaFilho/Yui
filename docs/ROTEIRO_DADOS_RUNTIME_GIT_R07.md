# Relatório e Roteiro de Remoção de Dados de Runtime do Git (R07)

Este documento atende à recomendação **R07 da Fase 0 da Yui**.
Nenhum comando de remoção de índice (`git rm --cached`) ou deleção de arquivo foi executado de forma autônoma pela Alice/Antigravity, em conformidade com as regras invioláveis de proteção aos dados do projeto.

---

## 1. Inventário de Arquivos Rastreados por Categoria

### A. Bancos de Dados de Runtime (Modificados a cada execução)
Estes arquivos contêm estado local de runtime e tabelas SQLite que a Yui recria e inicializa automaticamente a partir do zero:
- `database/core.db`
- `database/gta-diario.db`
- `database/gta-semanal.db`
- `database/gta-semanal.db.bak`
- `database/newswire.db`
- `database/social-twitch.db`
- `database/social-youtube.db`

*Nota:* `database/memory-*.db` já estão ignorados no gitignore atual.

### B. Logs e Auditorias de Runtime
- `logs/.3a5ac170a539f7655f2b5798968a5ac930d06c0c-audit.json`
- `logs/.ee1b69ad210d37de904350371e2b1b4c743e571e-audit.json`
- `apps/yui-app/logs/.6e11b7e6cd65ce8a6dbec42df26dce2ccaaeea60-audit.json`
- `apps/yui-app/logs/.8508c534f64a471f4ae83d9a53d31b0767c19743-audit.json`
- `apps/yui-app/logs/core-audit.jsonl`

### C. Cookies de Sessão e Dados de Usuários/Runtime em `src/data/`
- `src/engines/gtao/systems/weekly/reddit-cookies-cache.json` ⚠️ *(Contém cookies de sessão do Reddit)*
- `src/data/bans.json`
- `src/data/user_pc_specs.json`
- `src/data/watchedUsers.json`
- `src/data/server_settings.json`
- `src/data/server_tools.json`
- `src/data/accepted_servers.json`
- `src/data/hltb_cache.json`
- `src/data/tunables-decrypted.json`

### D. Itens de Higiene e Duplicações Identificadas
- `.env_example` (duplica o `.env.example` padrão e a regra `*.env.*` causava confusão de exclusão)
- Scripts de migração legada pontuais como `scripts/convert-to-esm.js`

---

## 2. Teste de Bootstrap do Zero (Comprovado)

O teste offline `tests/test-clean-bootstrap.js` comprovou que em um diretório totalmente novo e limpo, sem nenhum banco prévio, a Yui inicializa todas as tabelas e schemas necessários sem erros:
- Criação e inicialização transparente de `core.db`, `newswire.db`, `gta-diario.db`, `gta-semanal.db`, `social-twitch.db` e `social-youtube.db`.

---

## 3. Roteiro para Execução pelo Dono (Após Aprovação)

Quando o dono decidir remover os dados de runtime do índice do Git, deve executar os comandos abaixo no PowerShell da raiz do projeto:

### Passo 1: Atualizar o `.gitignore`
Substituir o conteúdo do `.gitignore` pela proposta testada em `docs/PROPOSTA_GITIGNORE_R07.md`.

### Passo 2: Remover arquivos de runtime do índice Git (sem apagar do disco local)
```powershell
# 1. Bancos de dados
git rm --cached database/core.db database/gta-diario.db database/gta-semanal.db database/gta-semanal.db.bak database/newswire.db database/social-twitch.db database/social-youtube.db

# 2. Logs e auditorias antigas
git rm --cached logs/.*-audit.json apps/yui-app/logs/.*-audit.json apps/yui-app/logs/core-audit.jsonl

# 3. Cookies e dados de runtime
git rm --cached src/engines/gtao/systems/weekly/reddit-cookies-cache.json
git rm --cached src/data/bans.json src/data/user_pc_specs.json src/data/watchedUsers.json src/data/server_settings.json src/data/server_tools.json src/data/accepted_servers.json src/data/hltb_cache.json src/data/tunables-decrypted.json
```

---

## 4. Alertas Críticos de Segurança sobre o Histórico

> [!WARNING] **ATENÇÃO: O HISTÓRICO DO GIT CONTINUA CONTENDO OS ARQUIVOS**
> Remover arquivos com `git rm --cached` apenas impede que novas alterações sejam rastreadas nos próximos commits. Os dados já commitados anteriormente (como os cookies de sessão em `reddit-cookies-cache.json`) continuam presentes no histórico de commits passados do repositório Git.
> 
> **Recomendações:**
> 1. Renovar a sessão / cookies da conta utilizada no Reddit para que o token commitado anteriormente no histórico perca a validade.
> 2. Se o repositório for publicado em remoto público, utilizar ferramentas como `git-filter-repo` ou `BFG Repo-Cleaner` para expurgar definitivamente blobs sensíveis do histórico.
