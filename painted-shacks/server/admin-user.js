// Manage admin accounts from the server's command line.
//   node admin-user.js add  <email> "<Full name>" [admin|inspector]   -> prints a new random password
//   node admin-user.js reset <email>                                   -> prints a new random password, signs them out
//   node admin-user.js disable <email>
//   node admin-user.js list
"use strict";
process.env.PS_CLI = "1";
const crypto = require("node:crypto");
const { db, hashPassword } = require("./server");
const [cmd, email, name, role = "admin"] = process.argv.slice(2);
const newPw = () => crypto.randomBytes(12).toString("base64url");
function done(msg) { console.log(msg); process.exit(0); }
function fail(msg) { console.error(msg); process.exit(1); }

if (cmd === "list") {
  for (const r of db.prepare("select email, full_name, role, disabled, created_at from staff order by created_at").all())
    console.log(`${r.disabled ? "DISABLED " : ""}${r.email}  ${r.full_name}  (${r.role})`);
  process.exit(0);
}
if (!email) fail("Usage: node admin-user.js add|reset|disable|list <email> [\"Full name\"] [admin|inspector]");
if (cmd === "add") {
  if (!name) fail("Give a full name in quotes.");
  if (!["admin", "inspector"].includes(role)) fail("Role must be admin or inspector.");
  if (db.prepare("select 1 from staff where email = ?").get(email)) fail("That email already has an account. Use reset.");
  const pw = newPw();
  db.prepare("insert into staff(id, email, full_name, role, pw_hash) values (?,?,?,?,?)").run(crypto.randomUUID(), email, name, role, hashPassword(pw));
  done(`Account created for ${email}\nPassword: ${pw}\nSign in, then change it under "Change password".`);
}
if (cmd === "reset") {
  const u = db.prepare("select id from staff where email = ?").get(email); if (!u) fail("No account with that email.");
  const pw = newPw();
  db.prepare("update staff set pw_hash = ?, disabled = 0 where id = ?").run(hashPassword(pw), u.id);
  db.prepare("delete from sessions where staff_id = ?").run(u.id);
  done(`New password for ${email}: ${pw}`);
}
if (cmd === "disable") {
  const r = db.prepare("update staff set disabled = 1 where email = ?").run(email);
  db.prepare("delete from sessions where staff_id in (select id from staff where email = ?)").run(email);
  r.changes ? done(`${email} can no longer sign in.`) : fail("No account with that email.");
}
fail("Unknown command.");
