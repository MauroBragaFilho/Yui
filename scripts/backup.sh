#!/bin/bash
# Script de backup com rotação diária e semanal do banco SQLite

DB_PATH="/opt/yui/data/yui.db"
BACKUP_DIR="/opt/yui/backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="$BACKUP_DIR/backup_$TIMESTAMP.db"

mkdir -p "$BACKUP_DIR"

if [ -f "$DB_PATH" ]; then
    # Usar sqlite3 online backup (.backup) para manter integridade com WAL ativo
    sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"
    gzip -f "$BACKUP_FILE"
    echo "[$(date)] Backup criado com sucesso: $BACKUP_FILE.gz"

    # Manter últimos 7 backups diários
    find "$BACKUP_DIR" -type f -name "backup_*.db.gz" -mtime +7 -exec rm {} \;
else
    echo "[$(date)] Banco de dados não encontrado em $DB_PATH"
fi
