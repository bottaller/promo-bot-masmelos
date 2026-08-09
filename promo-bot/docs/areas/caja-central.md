# Área Caja Central

> Un doc por área. Este cubre **Caja Central**: un **rol de notificación sin comando propio**.
> Recibe el **arqueo automático de cobros** (Mercado Pago + Talo) de las 08:00 y el resumen semanal.
> Última actualización: **2026-07-25**.

## Qué es

Caja Central es el rol operativo que controla que **lo que cobraron las plataformas (Mercado Pago,
Talo) sea exactamente lo que quedó asentado en el sistema**, venta por venta. Es un control de la
plata que entra: si una plataforma cobró algo que nadie registró, acá salta.

**Ya no tiene comando propio.** Hasta el 17/07/2026 este control se corría a mano con `/mp`. Después
se rediseñó: el arqueo de cobros dejó de ser un comando y pasó a ser **automático**. Caja Central hoy
es solo un **canal de aviso** (`bot.areas.codigo = 'cajacentral'`, migración **014**): el destino al
que se entregan los reportes del arqueo, vía `telegramIdsPorRol('cajacentral')`.

## Cómo funciona el arqueo (automático)

No hay nada que apretar. El flujo es:

1. **De noche — `/carga` (admin, área Tesorería).** El admin sube los documentos del día: el **libro
   diario** de Sigma y la **liquidación** de Mercado Pago (Talo se baja sola por API a las 21:00).
   El bot reconoce cada archivo solo. Las liquidaciones quedan **en espera** (`bot.liquidaciones_pendientes`, migración **022**);
   el libro se archiva. Ver [tesoreria.md](tesoreria.md).
2. **21:30 ART (`src/aviso-libro.js`).** Si a esa hora falta alguno de los documentos del día (el
   libro o alguna liquidación), el bot les reclama **a los admins** qué falta.
3. **08:00 ART (`src/entrega-arqueo.js`).** Un barrido cruza las liquidaciones en espera contra el
   libro del día, arma **un PDF por plataforma** (MP y Talo por separado) más un texto, y se los
   manda a los grupos **Tesorería + Caja Central**. Guarda el resultado en `bot.mp_conciliacion` y
   borra las liquidaciones ya procesadas. Si falta el libro, no arquea y avisa a los admins.

Lo que recibe Caja Central a la mañana, entonces, son **el texto del arqueo + dos PDFs** (uno de MP,
uno de Talo), con el veredicto de cada plataforma y el detalle de lo que no cerró.

**Qué marca cada arqueo:** 🔴 lo que la plataforma cobró y no está asentado (y al revés). Las
diferencias de centavos por **redondeo** se resumen en una línea; los avisos de **hora** (asiento
cargado lejos del cobro) se listan. Point y las filas sin identificar quedan aparte como "fuera de
alcance"; las **salidas de dinero** no se muestran (no son ventas por QR). El **detalle completo**
(alcance validado, cómo aparea, tolerancias, el huso horario, el rastreo del contramovimiento) está
en [conciliacion-mp.md](../conciliacion-mp.md).

## Resumen semanal automático

Cada arqueo **guarda cómo salió el control del día** en `bot.mp_conciliacion` (migración **018**, con
columna `plataforma` desde la **021**): veredicto, totales, diferencia y las huérfanas con su rastreo,
una fila por plataforma. Re-arquear el día pisa esas filas (la última corrida es la verdad).

**Los lunes a las 8:00 (hora Argentina)**, el bot arma un **resumen de la semana pasada** (lunes a
domingo) de MP + Talo y se lo manda a los **admins + al rol Caja Central** (`src/aviso-mp-semanal.js`).
Día por día: si cerró, si tuvo diferencias (con el importe y dónde apareció) o **si no se arqueó** —
un día sin arqueo es en sí un hallazgo. Hora configurable con `RESUMEN_MP_HORA_UTC` (default `11` UTC
= 8:00 ART). La parte que arma el texto (`src/lib/resumen-mp-semanal.js`) es pura y testeada
(`test/resumen-mp-semanal.test.js`).

## Acceso (el rol)

Caja Central es un rol como cualquier otro de `bot.usuarios` / `bot.usuario_area`. Para que alguien
reciba los avisos del arqueo:

```
/usuarios agregar <telegram_id> cajacentral
```

El rol se siembra con la **migración 014** (`db/migrations/014_caja_central.sql`) — hay que correrla en
Supabase antes de poder asignarlo.

> Como el rol ya **no tiene comando**, no hay menú `/` que actualizar ni hace falta reiniciar el bot
> después de asignarlo: alcanza con que el `telegram_id` tenga el rol antes de la próxima corrida de
> las 08:00. Si nadie tiene el rol Tesorería/Caja Central, el arqueo **cae a los admins** para que al
> menos alguien lo vea (`src/entrega-arqueo.js`).

## Por qué dejó de ser un comando

`/mp` obligaba a que **alguien se acordara de correrlo** todos los días con los dos archivos a mano.
Con dos plataformas (MP y Talo) y el reporte de **Cobros (collection)** de MP disponible el mismo día,
convenía que el arqueo saliera solo: el admin ya sube el libro de noche para `/cierre`, así que
sumarle las liquidaciones a esa misma carga (`/carga`) y dejar que el barrido de las 08:00 haga el
cruce elimina el paso manual. El resultado le llega igual a Caja Central, pero sin que nadie tenga que
disparar nada.
