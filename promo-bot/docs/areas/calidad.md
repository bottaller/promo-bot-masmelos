# Área Calidad

> Un doc por área. Este cubre **Calidad**: sus comandos, el flujo de datos y los límites conocidos.
> Última actualización: **2026-07-10**.

## Qué hace el rol

La persona de Calidad recorre el depósito buscando productos **próximos a vencer**, los lleva
físicamente a una **zona de ofertas** con descuento, los **da de alta** en el bot, y después los
**da de baja** cuando se venden o se descartan (vencidos). Esa información alimenta los reportes que
ven los **Compradores** (`/reporte`, área Compras): así saben qué productos terminan en oferta o se
tiran, para la próxima comprar menos o pedir descuento al proveedor.

## Comandos

| Comando | Qué hace |
|---------|----------|
| `/alta` | Registra una **camada** puesta en oferta por vencimiento (producto, lote, vencimiento, cantidad, **% de descuento**, motivo). Busca el producto en el maestro (`bot.articulos`) por EAN/código/nombre, o se carga a mano. |
| `/baja` | Cierra una camada abierta: cuántas se vendieron y qué pasó con el remanente (descartado/vencido o devuelto a góndola normal). |
| `/control` | Excel de **todo lo que está en oferta ahora**, ordenado por fecha de vencimiento. Lleva la fecha de generación (ver [convenciones.md](../convenciones.md)). |

## Modelo de datos

Todo vive en `bot.compras_altas` (misma tabla que Compras). **Una fila = una camada.** La baja se
guarda en la **misma fila** (modelo unificado, migración 006):

- `fecha_baja IS NULL` → la camada sigue **en oferta** (abierta).
- `fecha_baja NOT NULL` → cerrada, con `cantidad_vendida`, `cantidad_remanente`, `motivo_baja`.

Flags de avisos (migración 005): `aviso_vencimiento_fecha` (por-vencer) y `aviso_vencido` (una vez).

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

- Cantidad `1.000` (mil, notación argentina) se registra como `1`.
- Si la DB falla justo después de guardar el alta, puede quedar un alta **duplicada**.
- La lista de `/baja` trunca a 15 camadas sin avisar.
- `/reporte` por proveedor mezcla proveedores por coincidencia parcial de nombre.
- Motivos de baja tipeados a mano ("se venció") no cuentan como descarte.
- El mismo producto cargado del maestro y a mano se parte en dos historiales.

**Mejoras propuestas** (no hechas): botón "dar de baja" directo en el aviso, `/porvencer` (lista en
chat por urgencia), recordatorio de vencidas que siguen abiertas, resumen semanal a compradores.
