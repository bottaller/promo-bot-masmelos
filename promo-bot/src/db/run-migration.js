// Aplica un archivo .sql contra la base (Supabase).
// Uso:  node src/db/run-migration.js db/migrations/001_fundaciones.sql
//
// Las migraciones están escritas para ser idempotentes, así que correr una
// dos veces no rompe nada. Alternativa: pegar el .sql en el SQL Editor de Supabase.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

(async () => {
  const file = process.argv[2];
  if (!file) {
    console.error('Uso: node src/db/run-migration.js <ruta-al-.sql>');
    process.exitCode = 1;
    return;
  }

  let sql;
  try {
    sql = fs.readFileSync(path.resolve(file), 'utf8');
  } catch (err) {
    console.error(`❌ No pude leer el archivo ${file}:`, err.message);
    process.exitCode = 1;
    return;
  }

  try {
    await pool.query(sql);
    console.log(`✅ Migración aplicada: ${file}`);
  } catch (err) {
    console.error(`❌ Error aplicando ${file}:`, err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
