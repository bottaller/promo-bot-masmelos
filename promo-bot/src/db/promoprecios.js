// Acceso a datos de /promoprecios (Calidad -> dueño -> Compras/Marketing -> Ventas/Depósito).
const { pool } = require('./pool');

async function crearPromoPrecios({ archivoFileId, archivoNombre, usuarioId, usuarioNombre, usuarioTelegramId }) {
  const { rows } = await pool.query(
    `insert into bot.promoprecios
       (archivo_file_id, archivo_nombre, usuario_id, usuario_nombre, usuario_telegram_id)
     values ($1,$2,$3,$4,$5)
     returning id`,
    [archivoFileId, archivoNombre ?? null, usuarioId ?? null, usuarioNombre ?? null, usuarioTelegramId]
  );
  return rows[0].id;
}

async function promoPreciosPorId(id) {
  const { rows } = await pool.query('select * from bot.promoprecios where id = $1', [id]);
  return rows[0] || null;
}

// El ciclo activo: el más reciente que el dueño ya validó (tiene imagenes_requeridas) y todavía
// no se terminó de reenviar. Como hay a lo sumo uno por semana, alcanza con "el más reciente".
async function promoPreciosActivo() {
  const { rows } = await pool.query(
    `select * from bot.promoprecios
      where validado_en is not null and enviado_en is null
      order by fecha desc
      limit 1`
  );
  return rows[0] || null;
}

// El dueño valida el archivo y fija cuántas imágenes tiene que mandar Marketing.
// Devuelve null si ya estaba validado (evita re-repartir por un doble-tap).
async function validarPromoPrecios(id, { imagenesRequeridas }) {
  const { rows } = await pool.query(
    `update bot.promoprecios set imagenes_requeridas = $2, validado_en = now()
      where id = $1 and validado_en is null
      returning *`,
    [id, imagenesRequeridas]
  );
  return rows[0] || null;
}

async function marcarComprasArchivoOk(id) {
  const { rows } = await pool.query(
    `update bot.promoprecios set compras_archivo_ok = true, compras_archivo_ok_en = now()
      where id = $1 and compras_archivo_ok = false
      returning *`,
    [id]
  );
  return rows[0] || null;
}

async function agregarImagenPromo({ promoprecioId, fileId }) {
  const { rows } = await pool.query(
    `insert into bot.promoprecios_imagenes (promoprecio_id, file_id, orden)
     values ($1, $2, (select coalesce(max(orden), 0) + 1 from bot.promoprecios_imagenes where promoprecio_id = $1))
     returning *`,
    [promoprecioId, fileId]
  );
  return rows[0];
}

async function imagenesDePromo(promoprecioId) {
  const { rows } = await pool.query(
    'select * from bot.promoprecios_imagenes where promoprecio_id = $1 order by orden',
    [promoprecioId]
  );
  return rows;
}

async function reiniciarImagenesPromo(promoprecioId) {
  await pool.query('delete from bot.promoprecios_imagenes where promoprecio_id = $1', [promoprecioId]);
}

async function marcarMarketingCompletado(id) {
  const { rows } = await pool.query(
    `update bot.promoprecios set marketing_completado_en = now()
      where id = $1 and marketing_completado_en is null
      returning *`,
    [id]
  );
  return rows[0] || null;
}

async function marcarComprasImagenesOk(id) {
  const { rows } = await pool.query(
    `update bot.promoprecios set compras_imagenes_ok = true, compras_imagenes_ok_en = now()
      where id = $1 and compras_imagenes_ok = false
      returning *`,
    [id]
  );
  return rows[0] || null;
}

// Última validación: la del dueño. Marca también enviado_en, porque esta validación ES lo que
// dispara el reenvío a Ventas y Depósito (se hace atómico con el UPDATE, no en un paso aparte).
async function marcarAdminImagenesOk(id) {
  const { rows } = await pool.query(
    `update bot.promoprecios set admin_imagenes_ok = true, admin_imagenes_ok_en = now(), enviado_en = now()
      where id = $1 and admin_imagenes_ok = false
      returning *`,
    [id]
  );
  return rows[0] || null;
}

module.exports = {
  crearPromoPrecios,
  promoPreciosPorId,
  promoPreciosActivo,
  validarPromoPrecios,
  marcarComprasArchivoOk,
  agregarImagenPromo,
  imagenesDePromo,
  reiniciarImagenesPromo,
  marcarMarketingCompletado,
  marcarComprasImagenesOk,
  marcarAdminImagenesOk,
};
