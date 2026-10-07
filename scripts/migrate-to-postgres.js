import { resolve } from "node:path";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";

if (!process.env.DATABASE_URL) {
  throw new Error("Set DATABASE_URL to the empty managed PostgreSQL database before migrating.");
}

const sourceDirectory = resolve(process.env.DATA_DIR || "data");
const sourcePath = resolve(sourceDirectory, "simons-arc.sqlite");
if (!existsSync(sourcePath)) {
  throw new Error(`The local SQLite database was not found at ${sourcePath}.`);
}
const source = new Database(sourcePath, { readonly: true });
const { db } = await import("../database.js");
const sourceTables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
const tables = ["users", "sessions", "login_attempts", "oauth_identities", "oauth_states", "entries", "sheet_state"];
const columns = {
  users: ["id", "name", "email", "studio_role", "account_role", "password_hash", "created_at"],
  sessions: ["token_hash", "user_id", "expires_at"],
  login_attempts: ["address_hash", "failed_count", "reset_at"],
  oauth_identities: ["provider", "subject", "user_id", "created_at"],
  oauth_states: ["state_hash", "provider", "nonce", "code_verifier", "expires_at"],
  entries: ["id", "date", "project", "client", "work_item", "category", "hours", "status"],
  sheet_state: ["id", "version"]
};

try {
  await db.initialize();
  for (const table of tables) {
    const existing = Number((await db.get(`SELECT COUNT(*) AS count FROM ${table}`)).count);
    const isInitialSheetState = table === "sheet_state"
      && existing === 1
      && (await db.get("SELECT version FROM sheet_state WHERE id = 1"))?.version === 0;
    if (existing !== 0 && !isInitialSheetState) {
      throw new Error(`The PostgreSQL ${table} table is not empty. Migration stopped without copying data.`);
    }
  }

  await db.transaction(async (transaction) => {
    for (const table of tables) {
      if (!sourceTables.has(table)) {
        if (table === "login_attempts") continue;
        throw new Error(`The local SQLite database is missing the ${table} table.`);
      }
      const tableRows = source.prepare(`SELECT ${columns[table].join(", ")} FROM ${table}`).all();
      if (tableRows.length === 0) continue;
      if (table === "sheet_state") {
        await transaction.run("UPDATE sheet_state SET version = ? WHERE id = 1", tableRows[0].version);
        console.log("Copied sheet state.");
        continue;
      }
      const placeholders = columns[table].map(() => "?").join(", ");
      const insert = `INSERT INTO ${table} (${columns[table].join(", ")}) VALUES (${placeholders})`;
      for (const row of tableRows) {
        await transaction.run(insert, ...columns[table].map((column) => row[column]));
      }
      console.log(`Copied ${tableRows.length} ${table} row(s).`);
    }
    await transaction.exec(`
      SELECT setval(pg_get_serial_sequence('users', 'id'), COALESCE(MAX(id), 1), COUNT(*) > 0) FROM users;
      SELECT setval(pg_get_serial_sequence('entries', 'id'), COALESCE(MAX(id), 1), COUNT(*) > 0) FROM entries;
    `);
  });

  console.log("SQLite data migration completed. The source database was not modified.");
} finally {
  source.close();
  await db.close();
}
