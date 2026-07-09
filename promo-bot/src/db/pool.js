// Pool de conexiones a Postgres (Supabase). Lo usan el bot y los scripts.
// Lee DATABASE_URL del entorno (.env local o Variables de Railway).
//
// Nota: las tablas del bot viven en el schema "bot" (ver db/migrations/).
// Las consultas las escribimos siempre calificadas: bot.usuarios, bot.areas, etc.
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'Falta DATABASE_URL. Copiá .env.example a .env y completá la connection string de Supabase.'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase exige SSL. Esto evita problemas de cadena de certificados desde local o Railway.
  ssl: { rejectUnauthorized: false },
});

module.exports = { pool };
