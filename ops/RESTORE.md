# Restoring PDM from a backup

A backup nobody has restored is a guess. Do a practice restore now, while the
site has no contributed content to lose, so the first real restore is not the
first attempt.

## Restore the database

`neo4j-admin database load` refuses to overwrite a database that is running,
and the dump replaces the whole database - contributed content written since
the dump is gone. Check the timestamp before starting.

```bash
cd ~/ETS/ProductDevelopmentMaps
docker compose stop neo4j backend

docker run --rm \
  -v productdevelopmentmaps_neo4j-data:/data \
  -v /home/ubuntu/backups:/backups \
  neo4j:5.19-community \
  neo4j-admin database load neo4j --from-path=/backups --overwrite-destination=true

docker compose start neo4j backend
curl -s localhost:3000/api/health
```

The dump file must be named `neo4j.dump` for `--from-path` to find it, so
rename the date-stamped copy first:

```bash
cp /home/ubuntu/backups/neo4j-2026-09-11-0300.dump /home/ubuntu/backups/neo4j.dump
```

Health should report `connected: true` and the counts from the dump.

## Restore the secrets

```bash
tar xzf /home/ubuntu/backups/secrets-2026-09-11-0300.tar.gz \
  -C ~/ETS/ProductDevelopmentMaps
chmod 700 ~/ETS/ProductDevelopmentMaps/secrets
chmod 600 ~/ETS/ProductDevelopmentMaps/secrets/firebase-service-account.json
docker compose up -d
```

Restoring an OLD root `.env` restores the old `SESSION_SECRET`, which is
usually what you want: a different one invalidates every session cookie and
signs every user out.

## Rebuilding the whole box

1. Provision Ubuntu, install Docker, `ufw allow 22,80,443`.
2. `git clone` the repo, checkout `main`.
3. Restore secrets (above) - this supplies the root `.env`.
4. `docker compose build && docker compose up -d`.
5. Restore the database (above).
6. Install nginx + certbot, re-create the vhost, re-issue the certificate.
   Point DNS at the new IP first or the ACME challenge fails.

Do NOT run `populate-database.js` as part of a restore. It overwrites
spreadsheet-sourced fields with plain SET and would revert reviewer edits that
the dump preserved.
