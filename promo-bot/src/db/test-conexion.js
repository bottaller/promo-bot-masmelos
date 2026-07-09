// Prueba rápida de conexión a la base. NO es parte del bot, es solo para verificar
// que la connection string anda y que la migración 001 está corrida.
//
// Correr:  node src/db/test-conexion.js
require('dotenv').config();
const { pool } = require('./pool');

(async () => {
  try {
    const { rows } = await pool.query('select codigo, nombre from bot.areas order by id');

    if (rows.length === 0) {
      console.log('⚠️  Conectó a la base, pero no hay áreas cargadas.');
      console.log('    ¿Corriste db/migrations/001_fundaciones.sql en el SQL Editor de Supabase?');
    } else {
      console.log('✅ Conexión OK. Áreas en la base:');
      for (const r of rows) console.log(`   - ${r.codigo} (${r.nombre})`);
      console.log('\nListo: la connection string anda y el schema "bot" es accesible desde acá.');
    }
  } catch (err) {
    console.error('❌ No se pudo conectar o consultar la base.');
    console.error('   Detalle:', err.message);
    console.error('   Revisá: (1) DATABASE_URL en el .env, (2) que hayas corrido la migración 001.');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
