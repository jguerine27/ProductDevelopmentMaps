#!/usr/bin/env bash
#
# Nightly Neo4j backup for the PDM deployment.
#
# Community edition has no online backup, so the database must be stopped for
# `neo4j-admin database dump` to run. The stop/dump/start cycle below is the
# whole reason this runs at 03:00: the API answers 503 from /api/health while
# Neo4j is down, and the backend stays up throughout (restart: unless-stopped
# does not kill it for a failing healthcheck).
#
# Install:
#   sudo install -m 750 ops/backup-neo4j.sh /usr/local/bin/pdm-backup
#   sudo crontab -e
#     0 3 * * * /usr/local/bin/pdm-backup >> /var/log/pdm-backup.log 2>&1
#
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/home/ubuntu/ETS/ProductDevelopmentMaps}"
BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu/backups}"
VOLUME="${VOLUME:-productdevelopmentmaps_neo4j-data}"
NEO4J_IMAGE="${NEO4J_IMAGE:-neo4j:5.19-community}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
# Optional off-site push. Configure an rclone remote first
# (`rclone config`, e.g. an OVH Object Storage s3 remote) then set:
#   RCLONE_REMOTE=ovh:pdm-backups
RCLONE_REMOTE="${RCLONE_REMOTE:-}"

STAMP="$(date +%F-%H%M)"
mkdir -p "$BACKUP_DIR"

# neo4j-admin runs as uid/gid 7474 inside the container and writes the dump to
# this directory. Created by root it is root-owned and the dump fails with
# "AccessDeniedException: /backups" - the same uid 7474 trap that makes a bind
# mount of the data directory fail. Give group 7474 write access, setgid so the
# dump file inherits the group, and leave o+rx so the ubuntu user can still
# list and read its own backups without sudo.
chgrp 7474 "$BACKUP_DIR"
chmod 2775 "$BACKUP_DIR"

log() { echo "[$(date +%FT%T)] $*"; }

# Always restart Neo4j, even if the dump fails part way. Leaving the database
# stopped because a disk filled up would turn a failed backup into an outage.
cleanup() {
    log "ensuring neo4j is running"
    docker compose -f "$COMPOSE_DIR/docker-compose.yml" start neo4j >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "stopping neo4j"
docker compose -f "$COMPOSE_DIR/docker-compose.yml" stop neo4j

log "dumping database"
docker run --rm \
    -v "$VOLUME:/data" \
    -v "$BACKUP_DIR:/backups" \
    "$NEO4J_IMAGE" \
    neo4j-admin database dump neo4j --to-path=/backups --overwrite-destination=true

# neo4j-admin writes neo4j.dump; date-stamp it so runs do not overwrite.
mv "$BACKUP_DIR/neo4j.dump" "$BACKUP_DIR/neo4j-$STAMP.dump"
log "wrote neo4j-$STAMP.dump ($(du -h "$BACKUP_DIR/neo4j-$STAMP.dump" | cut -f1))"

log "starting neo4j"
docker compose -f "$COMPOSE_DIR/docker-compose.yml" start neo4j

# ── Secrets. Neither the root .env nor secrets/ is in git, and losing
# SESSION_SECRET signs every user out. 600 because this tarball holds the
# Firebase private key and the ORCID client secret.
SECRETS_TAR="$BACKUP_DIR/secrets-$STAMP.tar.gz"
tar czf "$SECRETS_TAR" -C "$COMPOSE_DIR" .env secrets/
chmod 600 "$SECRETS_TAR"
log "wrote $(basename "$SECRETS_TAR")"

# ── Retention. The VPS has 40 GB; unbounded dumps fill it and then Neo4j
# cannot start, which is a worse failure than having no backup.
find "$BACKUP_DIR" -name 'neo4j-*.dump'      -mtime "+$RETAIN_DAYS" -delete
find "$BACKUP_DIR" -name 'secrets-*.tar.gz'  -mtime "+$RETAIN_DAYS" -delete

# ── Off-site. A backup on the same disk as the database is not a backup.
if [ -n "$RCLONE_REMOTE" ]; then
    log "syncing to $RCLONE_REMOTE"
    rclone copy "$BACKUP_DIR" "$RCLONE_REMOTE" --include 'neo4j-*.dump' --include 'secrets-*.tar.gz'
else
    log "WARNING: RCLONE_REMOTE unset - backups are only on this VPS"
fi

log "done"
