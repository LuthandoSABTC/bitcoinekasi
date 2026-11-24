// Nightly backup: copies the database to BACKUP_DIR and keeps the last 30 days.
"use strict";
const fs = require("node:fs"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const DB_PATH = process.env.DB_PATH || "/var/lib/painted-shacks/painted-shacks.db";
const DIR = process.env.BACKUP_DIR || "/var/backups/painted-shacks";
const KEEP_DAYS = Number(process.env.KEEP_DAYS || 30);
fs.mkdirSync(DIR, { recursive: true });
const file = path.join(DIR, `painted-shacks-${new Date().toISOString().slice(0, 10)}.db`);
if (fs.existsSync(file)) fs.unlinkSync(file);
const db = new DatabaseSync(DB_PATH);
db.exec(`vacuum into '${file.replace(/'/g, "''")}'`);
db.close();
for (const f of fs.readdirSync(DIR)) {
  const full = path.join(DIR, f);
  if (/^painted-shacks-.*\.db$/.test(f) && Date.now() - fs.statSync(full).mtimeMs > KEEP_DAYS * 864e5) fs.unlinkSync(full);
}
console.log("Backup written:", file);
