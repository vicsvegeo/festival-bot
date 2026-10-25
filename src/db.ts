import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    pool = new Pool({ connectionString });
    pool.on("error", (err) => {
      console.error(`[db] unexpected error on idle client: ${err.message}`);
    });
  }
  return pool;
}

export async function testConnection(): Promise<void> {
  const result = await getPool().query("SELECT NOW()");
  console.log(`[db] connected — server time: ${result.rows[0].now}`);
}
