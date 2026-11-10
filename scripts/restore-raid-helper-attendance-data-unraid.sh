#!/usr/bin/env bash
# Restore the bot's SQLite database on Unraid, from an Appdata Backup archive
# (default: the latest one) or from a plain folder holding bot.sqlite
# (+ bot.sqlite-wal / bot.sqlite-shm if present: they are always kept together).
#
# The source is validated and checkpointed in a scratch folder first
# (integrity_check, then the WAL is folded into a single bot.sqlite), so the
# restored database is one self-contained file.
#
# Dry-run by default: nothing is changed unless --apply is given.
# Runs on the Unraid host as root; from the Mac, without installing anything:
#
#   ssh root@192.168.1.240 'bash -s -- [options]' < scripts/restore-raid-helper-attendance-data-unraid.sh
#
# Options:
#   --backup NAME      Appdata Backup run to restore from (e.g. ab_20261115_040001)
#   --from-dir DIR     restore from a folder containing bot.sqlite instead
#                      (rescue copy, before-restore snapshot...)
#   --apply            really restore (stop bot, snapshot, copy, chown, verify, start)
#   --data-dir DIR     target folder (default: /mnt/user/appdata/raid-helper-attendance-bot/data)
#   --container NAME   bot container (default: raid-helper-attendance-bot)
#   --backup-root DIR  Appdata Backup root (default: /mnt/user/documents/backup-appdata)
#   -h, --help         show this help
set -euo pipefail

DATA_DIR="/mnt/user/appdata/raid-helper-attendance-bot/data"
CONTAINER="raid-helper-attendance-bot"
BACKUP_ROOT="/mnt/user/documents/backup-appdata"
BACKUP=""
FROM_DIR=""
APPLY=0
OWNER="1000:1000"
DB="bot.sqlite"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
usage() {
  cat <<'EOF'
Usage: ssh root@192.168.1.240 'bash -s -- [options]' < scripts/restore-raid-helper-attendance-data-unraid.sh
  --backup NAME | --from-dir DIR   source (default: latest Appdata Backup run)
  --apply                          really restore (default: dry-run)
  --data-dir DIR  --container NAME  --backup-root DIR
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --backup)      BACKUP="${2:?--backup needs a value}"; shift 2 ;;
    --from-dir)    FROM_DIR="${2:?--from-dir needs a value}"; shift 2 ;;
    --data-dir)    DATA_DIR="${2:?--data-dir needs a value}"; shift 2 ;;
    --container)   CONTAINER="${2:?--container needs a value}"; shift 2 ;;
    --backup-root) BACKUP_ROOT="${2:?--backup-root needs a value}"; shift 2 ;;
    --apply)       APPLY=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             die "unknown option: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "must run as root on the Unraid host"
[ -z "$BACKUP" ] || [ -z "$FROM_DIR" ] || die "--backup and --from-dir are mutually exclusive"
command -v docker >/dev/null || die "docker not found"
command -v sqlite3 >/dev/null || die "sqlite3 not found"

WORK="$(mktemp -d /tmp/raid-helper-attendance-restore.XXXXXX)"
STOPPED=0
SNAPSHOT=""
on_exit() {
  local rc=$?
  rm -rf "$WORK"
  if [ "$rc" -ne 0 ] && [ "$STOPPED" -eq 1 ]; then
    log "FAILED after stopping $CONTAINER: it is left stopped."
    [ -z "$SNAPSHOT" ] || log "Data as it was before the restore: $SNAPSHOT"
    log "Check $DATA_DIR, then: docker start $CONTAINER"
  fi
}
trap on_exit EXIT

# ── Resolve the source folder ────────────────────────────────────────────────
if [ -n "$FROM_DIR" ]; then
  [ -d "$FROM_DIR" ] || die "folder not found: $FROM_DIR"
  SRC="$(cd "$FROM_DIR" && pwd)"
  log "Source: folder $SRC"
else
  if [ -z "$BACKUP" ]; then
    # Latest run that actually contains an archive for this container.
    # ab_YYYYMMDD_HHMMSS sorts chronologically; the glob expands in ascending order.
    for run in "$BACKUP_ROOT"/ab_*; do
      [ -f "$run/$CONTAINER.tar.gz" ] && BACKUP="$(basename "$run")"
    done
    [ -n "$BACKUP" ] || die "no Appdata Backup run under $BACKUP_ROOT contains $CONTAINER.tar.gz"
  fi
  ARCHIVE="$BACKUP_ROOT/$BACKUP/$CONTAINER.tar.gz"
  [ -f "$ARCHIVE" ] || die "archive not found: $ARCHIVE"
  log "Source: archive $ARCHIVE"
  mkdir "$WORK/archive"
  tar -xzf "$ARCHIVE" -C "$WORK/archive"
  # The archive layout depends on the plugin: locate the database wherever it is.
  mapfile -t dirs < <(find "$WORK/archive" -type f -name "$DB" -printf '%h\n' | sort -u)
  [ "${#dirs[@]}" -gt 0 ] || die "no $DB in $ARCHIVE"
  [ "${#dirs[@]}" -eq 1 ] || die "$DB found in several folders of the archive: ${dirs[*]}"
  SRC="${dirs[0]}"
  log "Database found in the archive at ${SRC#"$WORK/archive"/}"
fi
[ -f "$SRC/$DB" ] || die "$DB is not in $SRC"

# ── Validate + checkpoint a scratch copy (the source is never modified) ──────
mkdir "$WORK/db"
for f in "$DB" "$DB-wal" "$DB-shm"; do
  [ ! -f "$SRC/$f" ] || cp -p "$SRC/$f" "$WORK/db/$f"
done
[ -f "$WORK/db/$DB-wal" ] && log "WAL present in the source ($(stat -c %s "$WORK/db/$DB-wal") bytes): folding it in"
check="$(sqlite3 "$WORK/db/$DB" 'PRAGMA integrity_check;')"
[ "$check" = "ok" ] || die "integrity_check failed on the source: $check"
sqlite3 "$WORK/db/$DB" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null
sqlite3 "$WORK/db/$DB" 'PRAGMA journal_mode=DELETE;' >/dev/null   # drops the -wal/-shm files
[ ! -e "$WORK/db/$DB-wal" ] || die "WAL still present after checkpoint"
count() { sqlite3 "$1" "SELECT (SELECT count(*) FROM members)||' members, '||(SELECT count(*) FROM events)||' events, '||(SELECT count(*) FROM signups)||' signups, last migration '||(SELECT max(version) FROM schema_migrations);"; }
log "Source OK: $(count "$WORK/db/$DB")"
# The bot switches the file back to WAL mode on its next start (src/db/connection.js).

# ── Plan ─────────────────────────────────────────────────────────────────────
if [ -f "$DATA_DIR/$DB" ]; then
  # Read through a copy: opening the live file could take a lock on the bot's database.
  mkdir "$WORK/cur"
  for f in "$DB" "$DB-wal" "$DB-shm"; do
    [ ! -f "$DATA_DIR/$f" ] || cp -p "$DATA_DIR/$f" "$WORK/cur/$f"
  done
  log "Current: $(count "$WORK/cur/$DB" 2>/dev/null || echo 'unreadable')"
  log "  REPLACE $DATA_DIR/$DB (+ -wal/-shm) with the source"
else
  log "  NEW     $DATA_DIR/$DB"
fi

if [ "$APPLY" -eq 0 ]; then
  log "Dry-run: nothing changed. Re-run with --apply to restore."
  exit 0
fi

# ── Apply ────────────────────────────────────────────────────────────────────
was_running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)"
if [ "$was_running" = "true" ]; then
  log "Stopping $CONTAINER"
  docker stop "$CONTAINER" >/dev/null
  STOPPED=1
fi

mkdir -p "$DATA_DIR"
SNAPSHOT="$DATA_DIR.before-restore-$(date '+%Y%m%d-%H%M%S')"
cp -a "$DATA_DIR" "$SNAPSHOT"
log "Current data saved to $SNAPSHOT"

# Remove the old WAL/SHM first: a stale WAL next to the restored file would be replayed onto it.
rm -f "$DATA_DIR/$DB-wal" "$DATA_DIR/$DB-shm"
cp "$WORK/db/$DB" "$DATA_DIR/$DB.restore-tmp"
mv -f "$DATA_DIR/$DB.restore-tmp" "$DATA_DIR/$DB"
[ "$(md5sum < "$WORK/db/$DB")" = "$(md5sum < "$DATA_DIR/$DB")" ] || die "checksum mismatch after copying $DB"
[ "$(sqlite3 "$DATA_DIR/$DB" 'PRAGMA integrity_check;')" = "ok" ] || die "integrity_check failed on the restored file"
chown -R "$OWNER" "$DATA_DIR"
chmod 755 "$DATA_DIR"
chmod 644 "$DATA_DIR/$DB"
log "Restored $DB, owner $OWNER, checksum and integrity OK"

if [ "$was_running" = "true" ]; then
  log "Starting $CONTAINER"
  docker start "$CONTAINER" >/dev/null
  STOPPED=0
  sleep 5
  docker logs --tail 20 "$CONTAINER" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' >&2
else
  log "$CONTAINER was not running: left stopped"
fi
log "Done. Rollback: same command with --from-dir $SNAPSHOT --apply"
