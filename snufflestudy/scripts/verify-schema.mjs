import { Client } from "pg";
import "dotenv/config";

const client = new Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT ?? 5432),
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  database: process.env.SUPABASE_DB_NAME,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  await client.connect();

  const tables = await client.query(`
    select tablename, rowsecurity
    from pg_tables
    where schemaname = 'public'
    order by tablename;
  `);
  console.log("Tables + RLS enabled:");
  console.table(tables.rows);

  const policies = await client.query(`
    select tablename, policyname, cmd
    from pg_policies
    where schemaname = 'public'
    order by tablename, cmd;
  `);
  console.log(`\nPolicies (${policies.rows.length} total):`);
  console.table(policies.rows);

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
