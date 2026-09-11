# Restoring PDM from a backup

A backup nobody has restored is a guess. Do a practice restore while the site
has no contributed content to lose, so the first real restore is not the first
attempt.

## A note on sudo

ops/backup-neo4j.sh sets the backup directory to `root:7474` mode 2775 so that
`neo4j-admin`, which runs as uid 7474 inside the container, can write the dump.
The ubuntu user can list and read backups but NOT write to that directory, so
every command below that creates or removes a file there needs `sudo`:

    cp: cannot create regular file '/home/ubuntu/backups/neo4j.dump':
        Permission denied

## Restore the database

`neo4j-admin database load` needs the database stopped, and it replaces the
whole database - anything written since the dump is gone. Check the timestamp
before starting.

```bash
cd ~/ETS/ProductDevelopmentMaps

# --from-path looks for a file named exactly neo4j.dump. Copy the newest
# stamped dump into place (or name one explicitly).
sudo cp "$(ls -t ~/backups/neo4j-*.dump | head -1)" ~/backups/neo4j.dump

docker compose stop neo4j backend

docker run --rm \
  -v productdevelopmentmaps_neo4j-data:/data \
  -v /home/ubuntu/backups:/backups \
  neo4j:5.19-community \
  neo4j-admin database load neo4j --from-path=/backups --overwrite-destination=true

docker compose start neo4j backend
sleep 15
curl -s localhost:3000/api/health

sudo rm ~/backups/neo4j.dump   # keep the stamped original
```

## Verify the restore actually happened

A load that prints no error may still have been a no-op. Prove it by planting a
marker BEFORE restoring and confirming the restore removes it.

```bash
source .env    # for $NEO4J_PASSWORD

# before: plant a marker, Block count goes 198 -> 199
docker compose exec neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" \
  "CREATE (:Block {name:'RESTORE-TEST'}) RETURN 1;"
curl -s localhost:3000/api/health

# ...run the restore above...

# after: the marker must be gone and the count back to the dump's
docker compose exec neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" \
  "MATCH (b:Block {name:'RESTORE-TEST'}) RETURN count(b);"   # must be 0
```

If that returns 1, the load did not take and the restore path is not
trustworthy. Do not rely on the backups until it returns 0.

## Restore the secrets

```bash
sudo tar xzf ~/backups/secrets-<stamp>.tar.gz -C ~/ETS/ProductDevelopmentMaps
sudo chown -R ubuntu:ubuntu ~/ETS/ProductDevelopmentMaps/secrets
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
7. `certbot renew --dry-run` before walking away. A cert issued in standalone
   mode does not renew once nginx holds port 80; the renewal config needs
   `authenticator = nginx`.

Do NOT run `populate-database.js` as part of a restore. It overwrites
spreadsheet-sourced fields with plain SET and would revert reviewer edits that
the dump preserved.
