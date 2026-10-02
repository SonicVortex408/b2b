/** Applies supabase/migrations/*.sql in order using SUPABASE_DB_URL (Connect → connection string). */
import { readdirSync, readFileSync } from "node:fs";
import postgres from "postgres";

async function main() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("Set SUPABASE_DB_URL (Supabase → Connect → connection string, with your DB password).");
  const sql = postgres(url, { prepare: false, ssl: "require", max: 1 });
  const dir = "supabase/migrations";
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    process.stdout.write(`applying ${f}… `);
    await sql.unsafe(readFileSync(`${dir}/${f}`, "utf8"));
    console.log("ok");
  }
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
