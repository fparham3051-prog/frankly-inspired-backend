#!/usr/bin/env node
"use strict";
// Restore one app's tables from a full-system backup (GET /api/admin/backup-all,
// saved nightly to Google Drive) into a Postgres database.
//
//   DATABASE_URL=postgres://... node scripts/restore-backup.js backup.json website [--replace]
//   (the second argument is the section: operations or website)
//
// Start the app once against the new database first so its tables exist.
// Without --replace this refuses to write into tables that already have
// rows. With --replace each table in the backup is emptied first.
const fs = require("fs");
const { Pool } = require("pg");

(async () => {
  const [file, section = "website"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const replace = process.argv.includes("--replace");
  if (!file || !process.env.DATABASE_URL) {
    console.error("Usage: DATABASE_URL=... node scripts/restore-backup.js backup.json [operations|website] [--replace]");
    process.exit(1);
  }
  const bundle = JSON.parse(fs.readFileSync(file, "utf8"));
  const data = bundle[section] || (bundle.tables ? bundle : null);
  if (!data || !data.tables) { console.error(`No "${section}" section in ${file}`); process.exit(1); }
  const ssl = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const [table, rows] of Object.entries(data.tables)) {
      const exists = await client.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1", [table]);
      if (!exists.rows.length) { console.log(`skip ${table} (not in this database)`); continue; }
      const have = (await client.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n;
      if (have && !replace) throw new Error(`${table} already has ${have} rows; pass --replace to overwrite`);
      if (replace) await client.query(`DELETE FROM "${table}"`);
      const colTypes = Object.fromEntries((await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1", [table])).rows.map((r) => [r.column_name, r.data_type]));
      for (const row of rows) {
        const cols = Object.keys(row).filter((c) => c in colTypes);
        const vals = cols.map((c) => (row[c] !== null && typeof row[c] === "object" && /json/.test(colTypes[c]) ? JSON.stringify(row[c]) : row[c]));
        await client.query(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")})`, vals);
      }
      if (colTypes.id && /integer|bigint/.test(colTypes.id)) {
        const seq = (await client.query(`SELECT pg_get_serial_sequence('"${table}"', 'id') AS s`)).rows[0].s;
        if (seq) await client.query(`SELECT setval($1, GREATEST((SELECT COALESCE(MAX(id), 0) FROM "${table}"), 1))`, [seq]);
      }
      console.log(`${table}: ${rows.length} rows`);
    }
    await client.query("COMMIT");
    console.log("restore complete");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("restore failed, nothing changed:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
