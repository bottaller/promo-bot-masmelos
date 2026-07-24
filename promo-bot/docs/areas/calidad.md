# Área Calidad

> Un doc por área. Este cubre **Calidad**: sus comandos, el flujo de datos y los límites conocidos.
> Última actualización: **2026-07-23**.

## Qué hace el rol

La persona de Calidad recorre el depósito buscando productos **próximos a vencer**, los lleva
físicamente a una **zona de ofertas** con descuento, los **da de alta** en el bot, y después los
**da de baja** cuando se venden o se descartan (vencidos). Esa información alimenta los reportes que
ven los **Compradores** (`/reporte`, área Compras): así saben qué productos terminan en oferta o se
tiran, para la próxima comprar menos o pedir descuento al proveedor.

## Comandos

| Comando | Qué hace |
|---------|----------|
| `/alta` | Registra una **camada** puesta en oferta por vencimiento (producto, vencimiento, cantidad, motivo). Para la promoción, pregunta si es por **% de descuento** o por **precio promocional** (una cosa o la otra, nunca las dos). Busca el producto en el maestro (`bot.articulos`) por EAN/código/nombre, o se carga a mano. **Nota:** por ahora no pide lote (ver más abajo). |
| `/reposicion` | Suma cantidad a una camada **ya abierta** del mismo producto con la **misma fecha de vencimiento**, en vez de crear otra alta. Si no hay ninguna camada abierta que matchee, avisa y sugiere `/alta`. |
| `/cambiopromocion` | Cambia la promoción de una camada **vigente** — % de descuento o precio promocional, y se puede pasar de una a la otra. Arranca mostrando un **menú con todas las promociones abiertas** (sin pedir código/SKU) para elegir directo sobre cuál; después pregunta qué tipo de promoción nueva aplica, su valor, y a cuántas unidades de las actuales se le aplica. Por diferencia, cierra la camada vieja marcando lo no alcanzado como vendido con la promo vieja, y abre una camada nueva con las unidades restantes con la promo nueva. |
| `/baja` | Cierra una camada abierta: cuántas se vendieron y qué pasó con el remanente (descartado/vencido o devuelto a góndola normal). |
| `/control` | Excel de **todo lo que está en oferta ahora**, ordenado por fecha de vencimiento (incluye columnas de % de descuento y precio promocional). Lleva la fecha de generación (ver [convenciones.md](../convenciones.md)). |
| `/ajuste` | Sube un archivo de ajustes que le llega **solo al dueño del bot** (no a "los admins" — ver más abajo). El dueño lo revisa afuera del bot y toca "✅ Ajuste realizado" cuando lo hizo; ahí se le avisa a quien lo subió. |
| `/promoprecios` | Sube el archivo final de promociones y precios. Arranca una cadena: dueño valida → Compras (rol `compras_promo`) y Marketing → Marketing entrega imágenes (`/imagenes`, área Marketing) → Compras valida las imágenes → dueño valida → se reenvían a Ventas y Depósito. Ver "El ciclo de `/promoprecios`" más abajo. |

## Modelo de datos

Todo vive en `bot.compras_altas` (misma tabla que Compras). **Una fila = una camada.** La baja se
guarda en la **misma fila** (modelo unificado, migración 006):

- `fecha_baja IS NULL` → la camada sigue **en oferta** (abierta).
- `fecha_baja NOT NULL` → cerrada, con `cantidad_vendida`, `cantidad_remanente`, `motivo_baja`.

Flags de avisos (migración 005): `aviso_vencimiento_fecha` (por-vencer) y `aviso_vencido` (una vez).

**Lote:** la columna existe en la tabla pero por ahora `/alta` no la pide (queda `NULL`). Se puede
retomar más adelante sin migración nueva.

**Reposición:** `/reposicion` busca una alta abierta con el mismo producto (por `articulo_codigo` si
existe, si no por nombre exacto) y la misma `vencimiento`, y le suma la cantidad con un
`UPDATE ... SET cantidad = cantidad + X` — no inserta una fila nueva. Como `/baja` lee la `cantidad`
de esa misma fila, el cierre ya refleja el total acumulado sin ningún cambio adicional.

**Precio promocional:** alternativa al % de descuento (migración 018, columna `precio_promocional`).
Son excluyentes por diseño (se valida en el código, no con una constraint) — una camada tiene **uno
de los dos**, nunca ambos. El reporte de proveedor y el Excel de Compras muestran los dos tipos de
dato.

**Cambio de promoción:** el modelo no permite dos resultados en la misma fila (una fila = un solo
resultado final), así que `/cambiopromocion` **divide la alta en dos** dentro de una transacción (con
`SELECT … FOR UPDATE`, y aborta si otra operación cambió la cantidad entremedio): cierra la alta vieja
(`fecha_baja`, `cantidad` y `cantidad_vendida` = la diferencia, `cantidad_remanente` = 0, `motivo_baja`
= `'Cambio de promoción'` para no contarla como descarte real) y crea una alta nueva —mismo
producto/proveedor/vencimiento/motivo— con las unidades restantes y la promo nueva (`descuento_pct` o
`precio_promocional`, según lo que se haya elegido — puede ser distinto tipo al de la vieja). **Ojo:**
la `cantidad` de la vieja se reduce a la diferencia (no queda en el total original); si no, las
unidades que siguen en promoción se contarían dos veces en "unidades puestas" y diluirían la
efectividad del reporte. El histórico del producto queda con dos altas: una cerrada (lo de la promo
vieja) y otra que se cierra después con el resultado de la promo nueva.

**Aviso al equipo de Compras:** solo se avisa cuando se hace **`/baja`** (no en `/alta`,
`/reposicion` ni `/cambiopromocion`). No manda el resultado puntual de esa baja: manda el **reporte
completo del proveedor** (histórico, el mismo texto que arma `/reporte`, ver
`src/lib/reporte-proveedor.js`), ya actualizado con la baja recién hecha. Va a **todos los usuarios
con el rol `compras`** (sin importar de qué proveedor se trate — no hay mapeo por proveedor). Sale de
`telegramIdsPorRol('compras')`, la misma tabla `bot.usuario_area` que usa todo lo demás; agregar o
sacar gente es un `/usuarios agregar` / `/usuarios quitar`, sin tocar código ni archivos de config.

## El ciclo de `/ajuste` y `/promoprecios`

Estos dos comandos no tocan `bot.compras_altas`: viven en tablas propias (`bot.calidad_ajustes`,
`bot.promoprecios`, `bot.promoprecios_imagenes`, migración 024) y arman una cadena de reenvíos por
botón, no un wizard de punta a punta. La lógica de los botones vive en `src/acciones-calidad.js`
(se registra una sola vez en `src/index.js`, aparte de los wizards).

**El "dueño del bot"** (`OWNER_TELEGRAM_ID` en `.env`) es quien recibe ambos archivos y valida en los
pasos clave — **no es lo mismo que "admin real"**: puede haber varios admins (hoy los hay), pero esto
es exclusivo de una sola persona. `src/lib/owner.js` (`esDueno`) es el único chequeo que lo usa.

**`/ajuste`:** José sube el archivo → le llega al dueño con un botón. El dueño lo revisa afuera del
bot; cuando toca "✅ Ajuste realizado", se le avisa a José (por su `telegram_id`, guardado en la fila
al subirlo — sin necesidad de join contra `bot.usuarios`).

**`/promoprecios`**, en cadena:
1. José sube el archivo → le llega al dueño con botón "✅ Validar".
2. El dueño lo toca → el bot le pregunta cuántas imágenes tiene que hacer Marketing (wizard corto,
   `validar-promoprecios-wizard`, entra vía `ctx.session.promoIdParaValidar` — no vía el estado de
   la escena, para no depender de cómo Telegraf pasa el segundo argumento de `scene.enter`).
3. Se reparte: **Compras** (rol `compras_promo`, no el `compras` general — si no, le llegaría a todo
   el equipo de compras en vez de al responsable puntual que designe el dueño) con botón "✅ Ya hice
   mi parte"; **Marketing** con la cantidad pedida.
4. Marketing entrega con `/imagenes` (área Marketing): exige la cantidad exacta, de a una imagen por
   vez; "reiniciar" borra el progreso y arranca de nuevo. Al llegar a la cantidad pedida, **se
   dispara solo** — no hace falta que confirme nada — y avisa al dueño de que terminó.
5. Las imágenes van a Compras (`compras_promo`) con botón "✅ Validar imágenes".
6. Al validarlas, van al dueño con el mismo botón.
7. Al validarlas el dueño, se reenvían automáticamente a **Ventas** y **Depósito** (roles `ventas` y
   `deposito`, sin botón — ahí termina la cadena).

Como hay como mucho un ciclo de `/promoprecios` por semana, `/imagenes` y el wizard de validar no
necesitan elegir "cuál" — siempre operan sobre el único activo (`promoPreciosActivo()`: el más
reciente ya validado por el dueño que todavía no se terminó de reenviar).

**Roles nuevos** (migración 024): `marketing`, `ventas`, `compras_promo`. Ninguno tiene gente
asignada por defecto — se asignan con `/usuarios agregar <telegram_id> <rol>` cuando se decida quién.

## Avisos de vencimiento

Scheduler diario a las **9:00 hora Argentina**. Avisa a Calidad de lo que **vence mañana/hoy**, y al
**creador del alta + admins** de lo **ya vencido**. Detalle completo y garantías de robustez en la
**§14 de [arquitectura.md](../arquitectura.md)**.

## Robustez (revisión 2026-07-10)

Una revisión adversarial encontró y se corrigieron los críticos:

- **Validación de fecha en `/alta`.** Una fecha imparseable ya no se guarda: dejaba el producto
  invisible para los avisos **para siempre**. Ahora se repregunta y se normaliza a `DD/MM/AAAA`.
- **Anti doble-tap.** Los wizards ya no avanzan dos pasos ni se pierden un alta/baja por un doble
  toque en un botón (el arreglo está en `src/lib/wizard.js` y sirve a los tres wizards).
- **Sugerencia de reporte correcta.** El `/reporte` ya no dice "reducí la compra en X%" con una cuenta
  mal aplicada; ahora explica qué significa el % de descarte.
- **Avisos que no se pierden.** Reintento si falla el envío, mensajes largos partidos, recuperación al
  reiniciar, y fecha en calendario argentino.

## Limitaciones conocidas (pendientes)

Del review quedaron **medios** sin resolver (registrados en la memoria del proyecto):

- Si la DB falla justo después de guardar el alta, puede quedar un alta **duplicada**.
- La lista de `/baja` trunca a 15 camadas sin avisar.
- Motivos de baja tipeados a mano ("se venció") no cuentan como descarte.
- El mismo producto cargado del maestro y a mano se parte en dos historiales.

**Mejoras propuestas** (no hechas): botón "dar de baja" directo en el aviso, `/porvencer` (lista en
chat por urgencia), recordatorio de vencidas que siguen abiertas, resumen semanal a compradores.
