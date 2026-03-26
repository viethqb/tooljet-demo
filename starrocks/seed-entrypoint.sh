#!/bin/bash
# Wait for StarRocks FE to be ready, then run seed SQL
set -e

echo "[Seed] Waiting for StarRocks FE to be ready..."
until mysql -h 127.0.0.1 -P 9030 -u root -e "SELECT 1" &>/dev/null; do
  sleep 3
done
echo "[Seed] StarRocks is ready."

# Check if already seeded
EXISTING=$(mysql -h 127.0.0.1 -P 9030 -u root -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='demo' AND table_name='employees'" 2>/dev/null || echo "0")
if [ "$EXISTING" -gt "0" ]; then
  echo "[Seed] Database 'demo' already seeded, skipping."
else
  echo "[Seed] Running seed.sql..."
  mysql -h 127.0.0.1 -P 9030 -u root < /docker-entrypoint-initdb.d/seed.sql
  echo "[Seed] Done! Tables: employees (20 rows), sales_orders (30 rows)"
fi
