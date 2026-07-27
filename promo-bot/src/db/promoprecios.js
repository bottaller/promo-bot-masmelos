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

// Cuando Marketing manda varias fotos "juntas", Telegram las entrega como mensajes separados que
// pueden procesarse casi en simultáneo. Sin lock, dos inserts concurrentes pueden leer el mismo
// max(orden) antes de que ninguno commitee, y las dos fotos quedan con el mismo número. El
// SELECT ... FOR UPDATE sobre la fila padre serializa los inserts de la MISMA carga entre sí.
async function agregarImagenPromo({ promoprecioId, fileId }) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select id from bot.promoprecios where id = $1 for update', [promoprecioId]);
    const { rows } = await client.query(
      `insert into bot.promoprecios_imagenes (promoprecio_id, file_id, orden)
       values ($1, $2, (select coalesce(max(orden), 0) + 1 from bot.promoprecios_imagenes where promoprecio_id = $1))
       returning *`,
      [promoprecioId, fileId]
    );
    await client.query('commit');
    return rows[0];
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
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

// --- Validación por imagen individual (migración 025) ---
// Cada imagen recorre su propio camino: pendiente -> (revisar -> pendiente)* -> compras_ok ->
// enviada. Nunca espera a las demás imágenes del mismo ciclo.

// Compras valida UNA imagen puntual. null si ya no estaba pendiente (evita doble-envío si el
// botón se toca dos veces, o si llegó a validarse por otra vía mientras tanto).
async function validarImagenCompras(imagenId) {
  const { rows } = await pool.query(
    `update bot.promoprecios_imagenes set estado = 'compras_ok', compras_ok_en = now()
      where id = $1 and estado = 'pendiente'
      returning *`,
    [imagenId]
  );
  return rows[0] || null;
}

// Compras marca una imagen para corregir, con el comentario de qué está mal.
async function marcarImagenRevisar(imagenId, comentario) {
  const { rows } = await pool.query(
    `update bot.promoprecios_imagenes
        set estado = 'revisar', revisar_comentario = $2, revisar_en = now()
      where id = $1 and estado = 'pendiente'
      returning *`,
    [imagenId, comentario]
  );
  return rows[0] || null;
}

// Marketing manda la corrección: reemplaza el file_id y la vuelve a poner "pendiente" (así vuelve
// a pasar por Compras). null si esa imagen no estaba en "revisar" (ya se resolvió, doble-envío, etc).
async function reemplazarImagenRevisar(imagenId, nuevoFileId) {
  const { rows } = await pool.query(
    `update bot.promoprecios_imagenes
        set file_id = $2, estado = 'pendiente', revisar_comentario = null, revisar_en = null
      where id = $1 and estado = 'revisar'
      returning *`,
    [imagenId, nuevoFileId]
  );
  return rows[0] || null;
}

// La imagen "revisar" más vieja todavía sin corregir, para el ciclo activo (Marketing corrige de
// a una por vez con /imagenes).
async function imagenRevisarPendiente(promoprecioId) {
  const { rows } = await pool.query(
    `select * from bot.promoprecios_imagenes
      where promoprecio_id = $1 and estado = 'revisar'
      order by revisar_en asc
      limit 1`,
    [promoprecioId]
  );
  return rows[0] || null;
}

// El dueño valida UNA imagen ya aprobada por Compras. Dispara directo a "enviada": esta
// validación ES lo que la manda a Ventas y Depósito (atómico, no en un paso aparte).
async function validarImagenAdmin(imagenId) {
  const { rows } = await pool.query(
    `update bot.promoprecios_imagenes set estado = 'enviada', admin_ok_en = now(), enviada_en = now()
      where id = $1 and estado = 'compras_ok'
      returning *`,
    [imagenId]
  );
  return rows[0] || null;
}

// true si ya no queda ninguna imagen del ciclo sin llegar a "enviada" (o sea, el dueño terminó de
// validarlas todas). Se usa para disparar el aviso de impresión a Marketing.
async function todasLasImagenesEnviadas(promoprecioId) {
  const { rows } = await pool.query(
    `select count(*)::int as pendientes from bot.promoprecios_imagenes
      where promoprecio_id = $1 and estado <> 'enviada'`,
    [promoprecioId]
  );
  return rows[0].pendientes === 0;
}

// Guarda atómica: solo la devuelve (no null) la primera vez, para no mandar el aviso de
// impresión dos veces si dos validaciones casi simultáneas ven "ya no queda nada pendiente".
async function marcarAvisoImpresionEnviado(promoprecioId) {
  const { rows } = await pool.query(
    `update bot.promoprecios set aviso_impresion_en = now()
      where id = $1 and aviso_impresion_en is null
      returning *`,
    [promoprecioId]
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
  validarImagenCompras,
  marcarImagenRevisar,
  reemplazarImagenRevisar,
  imagenRevisarPendiente,
  validarImagenAdmin,
  todasLasImagenesEnviadas,
  marcarAvisoImpresionEnviado,
};
