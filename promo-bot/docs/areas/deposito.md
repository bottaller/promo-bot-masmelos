# Área Depósito

> Un doc por área. Este cubre **Depósito**: sus comandos, el flujo de datos y los límites conocidos.
> Última actualización: **2026-07-29**.

## Qué hace el rol

La persona de Depósito puede dejar un **informe en texto libre** sobre un proveedor o un producto,
dirigido a **Calidad** o a **Compras** (uno u otro por informe, nunca ambos a la vez porque el
contenido suele ser distinto para cada área). El informe queda guardado y se avisa automáticamente
a **todos** los que tengan el rol de destino, sin importar de qué proveedor se trate.

También puede pedir **cartelería** (foto de un producto con el precio + tipo de gráfica + tipo de
precio): el bot arma el diseño final automáticamente y Marketing lo verifica antes de imprimir o
pedirlo a la gráfica.

## Comandos

| Comando | Qué hace |
|---------|----------|
| `/informe` | Pregunta el destino (Calidad o Compras), el proveedor o producto (texto libre, **no** se valida contra el maestro de artículos) y el contenido del informe. Guarda todo en `bot.deposito_informes` y avisa por Telegram a todos los que tengan el rol elegido. |
| `/carteleria` | Pide una foto (producto + precio juntos), el tipo de gráfica (**A4**, **A4 Color**, **Cartel simple**, **Gráfica cigüeña**) y el tipo de precio (**corto vencimiento**, **política**, **precio al piso** — las opciones dependen del tipo de gráfica). Para A4 / A4 Color pregunta la cantidad de copias; para corto vencimiento pregunta también la fecha de vencimiento. Genera el diseño automáticamente y se lo manda a Marketing para que lo verifique — ver detalle abajo. |

## Modelo de datos

`bot.deposito_informes` (migración 015):

- `destino_area` — `'calidad'` o `'compras'`.
- `referencia` — proveedor o producto, texto libre tal como lo escribió quien cargó el informe.
- `mensaje` — el contenido del informe.
- `usuario_id` / `usuario_nombre` — quién lo cargó.

`bot.carteleria` (migración 028; ampliada en 029, 030 y 031):

- `foto_file_id` — la foto ORIGINAL que mandó Depósito (se reenvía por `file_id`, no se vuelve a
  descargar salvo para la lectura por IA — ver abajo).
- `tipo` — `'a4'` | `'a4_color'` | `'cartel_simple'` | `'ciguena'`.
- `tipo_precio` — `'corto_vencimiento'` | `'politica'` | `'precio_piso'` (migración 031). A4 / A4
  Color aceptan los tres; Cartel simple / Cigüeña solo `politica` y `precio_piso`.
- `vencimiento` — fecha (`date`), solo cuando `tipo_precio = 'corto_vencimiento'`. `null` en el resto.
- `cantidad_copias` — solo para A4 / A4 Color; cuántas copias hay que imprimir. `null` para Cartel
  simple / Gráfica cigüeña (esos no se imprimen acá).
- `producto` / `precio` — lo que la IA leyó de la foto (o lo que corrigió Marketing). `null` si la
  IA no pudo generar el diseño (flujo viejo, ver más abajo).
- `diseno_file_id` — `file_id` de Telegram del cartel ya armado (se sube una sola vez y se reenvía
  por `file_id` al resto de Marketing y en cada reenvío posterior).
- `verificado_en` — cuándo Marketing aprobó el diseño (`marcarVerificado`, guarda atómica: si dos
  personas de Marketing tocan "Está bien" casi al mismo tiempo, solo una dispara el aviso).
- `usuario_id` / `usuario_nombre` / `usuario_telegram_id` — quién lo pidió.
- `pedido_confirmado_en` — igual que antes (migración 029), solo para Cartel simple / Cigüeña.

## `/carteleria`: cómo se arma el diseño

1. **Depósito carga y termina ahí** — foto, tipo de gráfica, tipo de precio (y fecha de
   vencimiento / cantidad de copias si corresponde). No hay paso de confirmación de Depósito; el
   control de calidad lo hace Marketing (paso 4).
2. **Lectura de la foto por IA** (`src/lib/carteleria-vision.js`) — se descarga la foto de Telegram
   y se le pide a `claude-opus-5` (con salida estructurada, `output_config.format` +
   `json_schema`) que extraiga `{ producto, precio }`. Es un llamado de **solo lectura**: la IA
   nunca dibuja nada, y no tiene herramientas ni necesita pensar (`thinking: disabled`, `effort:
   low`) porque es una extracción simple y acotada.
3. **Composición del cartel** (`src/lib/carteleria-render.js`, con `sharp`) — el precio, el nombre
   del producto y la fecha de vencimiento se superponen por código sobre la plantilla que
   corresponda (`src/lib/carteleria-plantillas.js`, `assets/carteleria/`). **El precio nunca lo
   dibuja un modelo generativo** — lo compone código a partir del número que devolvió la IA, así el
   valor impreso siempre es exacto. El tamaño de letra se ajusta dinámicamente al largo del texto
   para que nunca se desborde de la plantilla.
   - Plantillas A4 / A4 Color (comparten archivo): `a4_precio_piso.jpg`, `a4_politica.jpg`,
     `a4_corto_vencimiento.jpg` (esta última con línea-puntero a la fecha de vencimiento y hueco
     para foto del producto). Nombre del producto en caja oscura → texto blanco.
   - Plantillas Cartel simple / Gráfica cigüeña (comparten archivo): `cartel_precio_piso.jpg`,
     `cartel_politica.jpg`. Nombre del producto en barra blanca → texto oscuro. La **cigüeña se
     renderiza al doble del tamaño de canvas** de la misma plantilla (no es un archivo aparte).
   - Todavía no hay catálogo de imágenes de producto: el hueco de foto en `a4_corto_vencimiento`
     queda vacío por ahora (mejora futura).
4. **Verificación de Marketing** — a cada persona con rol `marketing` le llegan dos mensajes: la
   foto original de Depósito, y el diseño generado con el producto/precio detectados en el pie y
   dos botones:
   - **"✅ Está bien"** (`carteleria_ok:<id>`) — guarda atómica (`verificado_en`) y recién ahí
     dispara el aviso final (impresión o pedido a la gráfica, ver abajo) + le avisa a Depósito que
     su pedido fue verificado.
   - **"✏️ Corregir"** (`carteleria_corregir:<id>`) — abre un wizard (`corregir-carteleria-wizard`)
     donde Marketing tipea el producto y/o el precio correctos (o "igual" para no tocar ese campo).
     El bot **regenera el cartel** con los datos corregidos y se lo vuelve a mandar con los mismos
     dos botones — se puede corregir las veces que haga falta antes de aprobar.
5. **Aviso final a Marketing** (`avisarAMarketingFinal`, mismo helper para el flujo nuevo y el
   viejo) — usa el diseño ya aprobado (o la foto cruda, en el flujo viejo):
   - **A4 / A4 Color**: el cartel con el pie "🖨️ Imprimir A4 — 3 copias." Sin botón — es avisar e
     imprimir, sin loop de vuelta.
   - **Cartel simple / Gráfica cigüeña**: el cartel + dos botones — **"📲 Pedir por WhatsApp"**
     (abre un chat de WhatsApp con el número de la gráfica, `GRAFICA_WHATSAPP_NUMBER` en `.env`, y
     el mensaje ya escrito; Marketing solo adjunta la foto a mano y manda, un link de WhatsApp no
     puede adjuntar archivos automáticamente) y **"✅ Ya pedí los carteles"** (`carteleria_pedido:<id>`,
     migración 029, guarda atómica) — avisa a quien pidió la cartelería.

**Si la IA falla o no está configurada** (`ANTHROPIC_API_KEY` ausente, la API no responde, rechaza
el pedido, etc.) el bot **degrada con gracia**: cae directo al aviso final del paso 5 con la **foto
cruda**, sin diseño ni verificación — el mismo comportamiento que tenía `/carteleria` antes de esta
función. Nunca deja el wizard colgado por un fallo de la IA.

**Ojo con el número argentino:** algunos celulares de Argentina necesitan un `9` extra después del
`54` para que el link `wa.me` abra el chat correcto. Si no abre bien, hay que ajustar
`GRAFICA_WHATSAPP_NUMBER`.

## Avisos

Reutiliza el mismo mecanismo de `src/notificar.js` que usan las promociones: `notificarPorRol(rol,
mensaje)` busca a todos los que tienen ese rol en `bot.usuario_area` (activos) y les manda el
mensaje. No hay mapeo por proveedor ni por persona — es puramente por rol.

## Límites conocidos

- El "proveedor o producto" es texto libre: no se contrasta contra `bot.articulos`, así que puede
  haber variaciones de escritura entre informes del mismo proveedor.
- Todavía no hay un comando para **listar** informes ya cargados (quedan en la base, pero se
  consultan solo por Telegram en el momento en que se mandan).
- `/carteleria` no tiene todavía un catálogo de imágenes de producto: el hueco de foto de la
  plantilla `a4_corto_vencimiento` queda vacío. El precio y el nombre nunca dependen de esto —
  solo la ambientación visual del cartel.
- La tipografía del diseño generado es una sans-serif genérica (no la fuente exacta de la marca);
  el tamaño se ajusta para que nunca se desborde, pero el "look" no es 100% idéntico al diseño a
  mano. La calidad de la lectura de producto/precio depende de que la foto sea legible — por eso
  Marketing siempre la verifica contra la foto original antes de aprobar.
