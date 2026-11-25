// Nightly backup: copies the database to BACKUP_DIR and keeps the last 30 days.
// Inspection photos are mirrored to BACKUP_DIR/photos and lesson pictures to BACKUP_DIR/lesson-pictures
// (new files only, so it stays quick).
"use strict";
const fs = require("node:fs"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const DB_PATH = process.env.DB_PATH || "/var/lib/painted-shacks/painted-shacks.db";
const DIR = process.env.BACKUP_DIR || "/var/backups/painted-shacks";
const PHOTO_DIR = process.env.PHOTO_DIR || path.join(path.dirname(DB_PATH), "photos");
const PIC_DIR = process.env.LESSON_PIC_DIR || path.join(path.dirname(DB_PATH), "lesson-pictures");
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

// Photos: copy any photo not yet in the backup. Photos are never changed after upload.
let copied = 0;
if (fs.existsSync(PHOTO_DIR)) {
  for (const month of fs.readdirSync(PHOTO_DIR)) {
    const src = path.join(PHOTO_DIR, month);
    if (!fs.statSync(src).isDirectory()) continue;
    const dst = path.join(DIR, "photos", month);
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      if (!f.endsWith(".jpg") || fs.existsSync(path.join(dst, f))) continue;
      fs.copyFileSync(path.join(src, f), path.join(dst, f)); copied++;
    }
  }
}
console.log("Photos copied to backup:", copied);

// Lesson pictures: same idea, one flat folder.
let pics = 0;
if (fs.existsSync(PIC_DIR)) {
  const dst = path.join(DIR, "lesson-pictures");
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(PIC_DIR)) {
    if (!f.endsWith(".jpg") || fs.existsSync(path.join(dst, f))) continue;
    fs.copyFileSync(path.join(PIC_DIR, f), path.join(dst, f)); pics++;
  }
}
console.log("Lesson pictures copied to backup:", pics);
