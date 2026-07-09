# Arquitectura — Bot Más Melos

> Documento de diseño y decisiones. Es la fuente de verdad de "hacia dónde va esto y por qué".
> Última actualización: **2026-07-08**.

---

## 1. Qué es el sistema

Un **bot de Telegram único para toda la empresa**, que funciona como **hub de datos multi-área**.
Cada área (Compras, Ventas, Calidad, Tesorería) ve y usa **solo sus comandos**. El bot recibe
datos por varias vías, los procesa (con scripts) y devuelve **reportes digeridos** (Excel/HTML)
por el mismo chat.

Hoy arranca cubriendo **Compras** (promociones por vencimiento, lo que ya existe) y **Tesorería**
(arqueo). Las demás áreas se enchufan después, sin rehacer nada.

---

## 2. De dónde venimos (estado actual)

- Bot de Telegram en **Node.js + telegraf v4**, desplegado en **Railway**.
- Datos en **Google Sheets** (pestañas `ALTAS` / `BAJAS`), sin base de datos.
- Comandos `/alta`, `/baja`, `/reporte` para promociones por vencimiento.
- **Sin control de acceso**: hoy cualquiera que encuentre el bot puede usarlo y ver los datos.
  → Es el problema que resuelve la **Fase 1** (ver §12).

Ver la revisión de código del bot actual para los bugs conocidos (tasa de descarte inflada,
reporte por proveedor case-sensitive, etc.). Esos se corrigen durante la migración por fases.

---

## 3. Decisiones tomadas (y por qué)

| # | Decisión | Por qué |
|---|----------|---------|
| D1 | **El bot se queda en Node.js** (no se reescribe a Python) | Funciona y es lo que se mantiene hoy. Reescribir no elimina ningún puente real. |
| D2 | **Los scripts pesados van en Python**, llamados por el bot | Ya existe el script de arqueo en Python (pandas/openpyxl). El bot Node lo ejecuta por debajo. |
| D3 | **Base de datos: Supabase (Postgres)**, **compartida con la landing** pero en un **schema `bot` propio** (no expuesto en la API) | No quedaban proyectos gratis. El schema `bot` aísla los datos del bot: la `anon key` pública de la web no lo puede ver. La landing queda en `public`. Bonus: como la landing está siempre activa, el proyecto no se pausa por inactividad. |
| D4 | **Salida = archivo por el chat** (Excel/HTML) | Cero infraestructura extra. La web de reportes queda como opción futura. |
| D5 | **Hosting: Railway**, sin PC en la oficina (por ahora) | Las fuentes de datos actuales (Excel subido + futuro BigQuery) se alcanzan desde la nube. |
| D6 | **Identidad de usuario = `telegram_id`** | Estable (el username cambia). Allowlist = fila activa en `usuarios`. |
| D7 | **Cola de trabajos (`jobs`) sí**, pero se usa recién cuando haga falta | Serializa corridas (protege el snapshot del arqueo) y habilita el worker on-prem del futuro. |
| D8 | **Google Sheets se retira** | Con Supabase deja de ser necesario. Para "mirar los datos con el ojo" queda el editor de tablas de Supabase (o la web futura). |
| D9 | **Sin roles finos al inicio**: solo pertenencia a área | YAGNI. Hoy hay 2 áreas reales. Los roles se agregan cuando un caso concreto lo pida. |
| D10 | **Mantenimiento técnico: Renzo** | Stack elegido a conciencia para que lo sostenga 1 persona técnica. |

**Diferido a futuro (documentado, no construido):** conexión a **BigQuery**, **scraping de la app de
escritorio (Sigma)**, y **web de reportes**. Cada uno se suma como una pata nueva sin romper lo anterior.

---

## 4. Stack

- **Bot:** Node.js 20 + telegraf v4 (CommonJS).
- **Base:** Supabase / PostgreSQL, accedido con `pg` (node-postgres) y SQL directo (sin ORM pesado).
- **Scripts:** Python 3.11 (pandas, openpyxl, …) ejecutados como proceso aparte desde el bot.
- **Hosting:** Railway, imagen con **Node + Python juntos** (Dockerfile con ambos runtimes).
- **Cola:** tabla `jobs` en el mismo Postgres (nada de Redis).

---

## 5. Fuentes de datos

El bot es un hub: los datos entran por tres vías (dos futuras).

1. 📤 **Excel subido por el usuario** — *camino principal hoy.*
   Ej: semanal, el **maestro de artículos**; puntual, el export del arqueo.
   Alguien exporta del sistema y le manda el `.xlsx` al bot por Telegram.
2. 🔷 **BigQuery** — *futuro.* Parte de los datos ya viven ahí; se consultarán en modo lectura.
3. 🖥️ **Scraping de la app de escritorio (Sigma)** — *futuro / worst case.*
   Requiere worker on-prem + cola de jobs. Mientras tanto, el dato entra como Excel a mano (vía 1).

---

## 6. Flujo del `/arqueo` (Tesorería)

**El sistema (Sigma) es una app de escritorio offline.** El bot no puede sacar el dato solo:
un humano exporta de Sigma el reporte *"Diario de movimientos contables"* y le manda el `.xlsx`.

```
Humano exporta "Diario de movimientos" de Sigma
        │  (manda el .xlsx al bot, área Tesorería)
        ▼
Bot Node: descarga el archivo → encola un job "arqueo"
        ▼
Worker: python -m masmelos.update_arqueo <ruta.xlsx>
        ▼
Script: genera arqueo_<ventana>.xlsx (7 hojas) + flujo_<ventana>.html
        y actualiza el snapshot acumulado (diario_contable.parquet)
        ▼
Bot: agarra esos 2 archivos y los manda por el chat
```

**Contrato con el script (a agregar):** el script hoy imprime texto para humano. Se le suma
**una línea final en JSON** con las rutas generadas, p.ej.
`{"ok": true, "excel": "reports/arqueo/2026-07/arqueo_...xlsx", "flujo": "...html"}`,
para que el bot agarre los archivos exactos sin parsear el texto. El `stdout` legible queda igual.

### ⚠️ Estado persistente (importante)

El script tiene **memoria**: el snapshot `diario_contable.parquet` y los logs acumulativos
(`diferencias_log.csv`, `revision_log.csv`). **Railway borra el disco en cada redeploy/reinicio.**
Sin persistencia, el arqueo pierde su historia.

- **Solución v1:** **volumen persistente de Railway** montado en `data/` y `reports/`. El script queda igual.
- **Solución futura:** mover el snapshot a una tabla de Postgres (los movimientos contables pasan a
  ser parte de la base real, consultables y con backup).

La cola de jobs (D7) hace que los arqueos corran **de a uno**, evitando que dos corridas pisen el snapshot.

---

## 7. Modelo de datos

Las tablas del bot viven en el schema **`bot`** (separado de `public`, que es de la landing). El
schema `bot` **no** está en la lista de "Exposed schemas" de Supabase → la API pública / `anon key`
de la web no lo ve. El bot se conecta por **conexión directa de Postgres** (`pg` + connection string),
que sí llega a `bot`. **No** usamos la API REST / `supabase-js` para el bot (eso reexpondría el schema).

**Fase 1 — núcleo (lo que se crea ahora, ver `db/migrations/001_fundaciones.sql`):**

```
bot.areas          (id, codigo, nombre, activa, creado_en)
bot.usuarios       (id, telegram_id, nombre, activo, es_admin, creado_en, actualizado_en)
bot.usuario_area   (usuario_id, area_id, creado_en)      -- N:N, sin rol todavía
```

**Futuro (se define cuando toque cada fase):**

```
jobs           -- la cola: (id, tipo, area_id, solicitante, params, estado, resultado, ...)
compras_*      -- promociones (migra ALTAS/BAJAS), proveedores, compradores
tesoreria_*    -- registro de arqueos
ventas_* / calidad_*   -- NO se crean hasta tener un comando real
```

> El diseño detallado de las tablas de dominio se hace en su fase. "DB structure lo vemos después."

---

## 8. Multi-área y permisos

Un proceso, un `BOT_TOKEN`, ruteo interno. **Solo se chequea pertenencia a área** (sin roles finos).

- **Middleware de identidad** (corre antes de todo): busca el `telegram_id` en `usuarios`.
  Si no existe o está inactivo → *"No tenés acceso, pedile el alta al admin"* y corta.
- **Autorización por comando:** cada comando declara su área (`requiereArea('tesoreria')`).
  `/arqueo` solo para Tesorería; `/alta` `/baja` `/reporte` solo para Compras.
- **Menú dinámico:** cada usuario ve **solo los comandos de sus áreas**.
- **Comando admin `/usuarios`** (para Renzo): dar de alta gente y asignar áreas sin tocar código ni la base.
- **Registro por carpeta:** agregar un área = agregar una carpeta en `src/areas/`, sin tocar el núcleo.

---

## 9. Ejecución de scripts Python (el puente Node → Python)

- El bot lanza el script como proceso aparte (`child_process.spawn`), con **timeout** y captura de `stdout`.
- Le pasa el input por argumento (p.ej. la ruta del Excel descargado).
- El script escribe su salida en archivos y **cierra con una línea JSON** con las rutas (ver §6).
- El bot lee esa línea, agarra los archivos y los manda; si el script sale con código ≠ 0, avisa el error.
- En Railway, Node y Python conviven en la misma imagen (Dockerfile) con `pip install -r requirements.txt`.

---

## 10. Hosting

- **Railway** corre el bot Node + los scripts Python en una sola imagen.
- **Volumen persistente** para el estado del arqueo (§6).
- Variables sensibles (connection string de Postgres, `service_role key`, `BOT_TOKEN`) en las
  **Variables de Railway** y en `.env` local — **nunca** commiteadas (`.env` está en `.gitignore`).
- **Futuro (solo si se activa el scraping de Sigma):** un **worker on-prem** en una PC/VM de la
  oficina que hace *polling* de la tabla `jobs` (solo conexión **saliente**, sin abrir puertos),
  corre el scraping por la LAN y sube el resultado. El bot sigue en Railway.

---

## 11. Cola de trabajos (`jobs`) — qué es y cuándo se usa

Una tabla que es una **lista de tareas pendientes**. En vez de hacer el trabajo pesado en el momento,
el bot anota el pedido y responde *"lo preparo y te aviso"*; un **worker** toma el pendiente, lo
resuelve, guarda el resultado y lo marca listo. Sirve para: (a) no colgar el bot, (b) reintentar sin
perder el pedido, (c) que el worker pueda correr en **otra máquina** (la PC de la oficina, en el futuro).

- **Hoy:** subir Excel y consultar BigQuery son de segundos → se pueden hacer **sincrónicos**.
- **La cola se justifica** para el arqueo (serializa corridas por el snapshot) y para el scraping on-prem futuro.

---

## 12. Plan por fases

Cada fase deja el bot andando. Sin big-bang. La secuencia prioriza:
**cerrar el agujero de seguridad → migrar datos → sumar features**.

- **Fase 0 — Andamiaje.** Reordenar carpetas al layout objetivo, crear el proyecto Supabase, esqueleto de `docs/`.
- **Fase 1 — Control de acceso + áreas.** ⬅ *empezamos acá.* Tablas `usuarios`/`areas`/`usuario_area`,
  middleware de identidad y autorización, comando `/usuarios`, sembrar el admin. El bot deja de estar abierto.
  Los datos siguen en Sheets/PC — nada se rompe.
- **Fase 2 — Migrar Compras a Postgres.** Tablas de promociones + proveedores; import de las pestañas actuales.
  Corregir de paso los bugs de la revisión. (Opcional: doble escritura Sheets+Postgres un tiempo.)
- **Fase 3 — Cola + `/arqueo` real.** Tabla `jobs`, wrapper del script Python con contrato JSON, volumen
  persistente, entrega de los dos archivos por el chat. Validar que el arqueo **no venga vacío**.
- **Fase 4 — Áreas nuevas.** Ventas / Calidad cuando tengan procesos definidos.
- **Fase 5 — Fuentes futuras.** BigQuery (lectura) y, si hace falta, el worker on-prem para Sigma.
- **Fase 6 — Endurecer.** Heartbeat/alertas del worker, backups verificados, session store persistente si escala.

---

## 13. Decisiones pendientes

- **Ofertas de la landing vs. promociones del bot: son datos DISTINTOS** (resuelto).
  La landing (schema `public`) tiene contenido de marketing (`promociones`, `banners`,
  `productos_seleccion`…: título, imagen, orden). El bot maneja lo operativo (SKU, proveedor, vencimiento).
  **Oportunidad futura:** como comparten base, el bot podría **publicar** un producto en promoción a la
  web (insertar en `public.banners` / `public.promociones`) cuando se pasa a góndola. Se evalúa más adelante.
- **Detalle de las tablas de dominio** (compras, tesorería): se define en cada fase.
- **BigQuery:** qué datos viven ahí y cómo se dividen con lo que se sube por Excel (a definir cuando se encare la Fase 5).
