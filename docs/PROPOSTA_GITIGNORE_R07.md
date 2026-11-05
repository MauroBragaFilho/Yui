# Proposta de .gitignore (Higienização R07)
# Resolve as contradições existentes:
# - Não ignora *.bat globalmente (para manter setup.bat, Yui.bat, scripts/*.bat)
# - Não ignora *.txt globalmente (para manter requirements-*.txt)
# - Não ignora .env.example (especificando apenas .env real e .env.* locais/privados)
# - Remove do rastreamento bancos e dados mutáveis de runtime

# Dependencies
node_modules/
apps/**/node_modules/

# Python: ambientes virtuais
.venv*/
.venv-deemix/
.venv-spotdl/

# Logs e arquivos de auditoria de runtime
logs/
apps/**/logs/
*.log
*.tmp

# Bancos de dados SQLite (runtime e memórias privadas)
database/*.db
database/*.db.bak
database/memory-*.db
database/dev-history/
database/dev-index/
database/listas/

# Segredos, chaves e credenciais de ambiente
.env
.env.local
.env.production
*.pem
secrets/

# Dados e caches mutáveis de runtime
src/engines/gtao/systems/weekly/reddit-cookies-cache.json
src/data/bans.json
src/data/user_pc_specs.json
src/data/watchedUsers.json
src/data/server_settings.json
src/data/server_tools.json
src/data/accepted_servers.json
src/data/hltb_cache.json
src/data/tunables-decrypted.json
src/data/temp_audio/
src/data/temp_video*/
src/data/temp_spotify/
src/data/temp_images/
src/music/data/temp_radio_audio/

# Backups de memória gerados fora ou dentro da raiz
yui-backups/
*.Backup/

# Build outputs e editores
dist/
build/
apps/**/dist/
apps/**/.expo/
.vscode/
.idea/
