# Área Depósito

> Un doc por área. Este cubre **Depósito**: sus comandos, el flujo de datos y los límites conocidos.
> Última actualización: **2026-07-30**.

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
| `/carteleria` | Pide una foto (producto + precio juntos, salvo "nuevo ingreso" — ver abajo), el tipo de gráfica (**A4**, **A4 Color**, **Cartel simple**, **Gráfica cigüeña**) y el tipo de precio (**corto vencimiento**, **política**, **precio al piso**, **nuevo ingreso** — las opciones dependen del tipo de gráfica). Para A4 / A4 Color pregunta la cantidad de copias; para corto vencimiento pregunta también la fecha de vencimiento. Genera el diseño automáticamente y se lo manda a Marketing para que lo verifique — ver detalle abajo. |

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
- `tipo_precio` — `'corto_vencimiento'` | `'politica'` | `'precio_piso'` | `'nuevo_ingreso'`
  (migración 031). A4 / A4 Color aceptan los cuatro; Cartel simple / Cigüeña solo `politica` y
  `precio_piso`. `nuevo_ingreso` no es un precio de verdad — es un aviso de producto nuevo sin
  precio (ver abajo).
- `vencimiento` — fecha (`date`), solo cuando `tipo_precio = 'corto_vencimiento'`. `null` en el resto.
- `cantidad_copias` — solo para A4 / A4 Color; cuántas copias hay que imprimir. `null` para Cartel
  simple / Gráfica cigüeña (esos no se imprimen acá).
- `producto` — lo que la IA leyó de la foto (o lo que corrigió Marketing). `null` si la IA no pudo
  generar el diseño (flujo viejo, ver más abajo).
- `precio` — igual, pero además queda `null` cuando `tipo_precio = 'nuevo_ingreso'` (esa plantilla
  no tiene campo de precio).
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
   `json_schema`) que extraiga `{ producto, precio }` (`precio` es *nullable*: si la foto no
   muestra un precio — el caso de "nuevo ingreso" — la IA devuelve `null` en vez de inventar un
   número). Es un llamado de **solo lectura**: la IA nunca dibuja nada, y no tiene herramientas ni
   necesita pensar (`thinking: disabled`, `effort: low`) porque es una extracción simple y acotada.
   Para cualquier `tipo_precio` que sí necesite precio, si la IA no lo pudo leer se trata como una
   extracción fallida (cae al flujo viejo — nunca se muestra "$0").
3. **Composición del cartel** (`src/lib/carteleria-render.js`, con **satori** + `sharp`) — satori
   arma todo el layout (plantilla de fondo, textos, foto de producto) como si fuera HTML/flexbox y
   mide el texto de verdad con `opentype.js` (nombre de producto: hasta 2 líneas, se corta con "…"
   si no entra — nunca se desborda de la plantilla, sea cual sea el largo); `sharp` solo rasteriza
   el SVG final a JPEG. **El precio nunca lo dibuja un modelo generativo** — lo compone código a
   partir del número que devolvió la IA, así el valor impreso siempre es exacto.
   - Plantillas A4 / A4 Color (comparten archivo): `a4_precio_piso.jpg`, `a4_politica.jpg`,
     `a4_corto_vencimiento.jpg` (línea-puntero a la fecha de vencimiento + hueco para foto de
     producto), `a4_nuevo_ingreso.jpg` (banner "¡Nuevo ingreso!" fijo, **sin campo de precio**).
     Nombre del producto en caja oscura → texto blanco.
   - Plantillas Cartel simple / Gráfica cigüeña (comparten archivo): `cartel_precio_piso.jpg`,
     `cartel_politica.jpg`. Nombre del producto en barra blanca → texto oscuro. La **cigüeña se
     renderiza al doble del tamaño de canvas** de la misma plantilla (no es un archivo aparte).
   - **La foto que sube Depósito NUNCA se compone en el cartel** — solo sirve para que la IA
     identifique el producto (paso 2). Las plantillas con hueco de imagen (`nuevo_ingreso`,
     `corto_vencimiento`) usan la foto **ya limpia** del catálogo (`assets/productos/`,
     `src/lib/carteleria-catalogo.js`), matcheada por el nombre que leyó la IA (por palabras en
     común entre ese nombre y el nombre del archivo — no hace falta que sea exacto). Si ningún
     archivo del catálogo matchea, el cartel queda **sin foto** (nunca se usa la foto cruda de
     Depósito como respaldo — se probó recortarle el fondo automáticamente y el resultado no
     convenció, quedaban restos semi-transparentes del fondo real; ese código sigue en
     `src/lib/carteleria-fondo.js` pero no está conectado al flujo).
4. **Verificación de Marketing** — a cada persona con rol `marketing` le llegan dos mensajes: la
   foto original de Depósito, y el diseño generado con el producto/precio detectados en el pie y
   dos botones:
   - **"✅ Está bien"** (`carteleria_ok:<id>`) — guarda atómica (`verificado_en`) y recién ahí
     dispara el aviso final (impresión o pedido a la gráfica, ver abajo) + le avisa a Depósito que
     su pedido fue verificado.
   - **"✏️ Corregir"** (`carteleria_corregir:<id>`) — abre un wizard (`corregir-carteleria-wizard`)
     donde Marketing tipea el producto y/o el precio correctos (o "igual" para no tocar ese campo);
     para `nuevo_ingreso` no pregunta precio (no existe ese campo). El bot **regenera el cartel**
     con los datos corregidos — si cambió el nombre del producto, vuelve a buscar en el catálogo con
     el nombre nuevo — y se lo vuelve a mandar con los mismos dos botones — se puede corregir las
     veces que haga falta antes de aprobar.
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
- El catálogo de fotos (`assets/productos/`) todavía está vacío — hasta que se suban archivos ahí
  (ver `assets/productos/README.md`), **ningún** cartel con hueco de imagen (`nuevo_ingreso`,
  `corto_vencimiento`) va a tener foto, sea cual sea el producto. El precio y el nombre nunca
  dependen de esto — solo la ambientación visual del cartel.
- El matcheo del catálogo es por palabras en común entre el nombre del producto y el nombre del
  archivo (`carteleria-catalogo.js`) — no es IA, es determinístico. Con un catálogo grande y nombres
  parecidos entre sí (p.ej. "Coca Cola 500ml" vs "Coca Cola Zero 500ml") puede matchear el que no es;
  por eso Marketing siempre verifica el diseño contra la foto original antes de aprobar.
- La tipografía del diseño generado es **Anton** (`@fontsource/anton`, subset `latin` — cubre
  acentos/ñ), no la fuente exacta de la marca pero del mismo estilo condensado/bold; satori mide el
  texto real así que nunca se desborda. La calidad de la lectura de producto/precio depende de que
  la foto sea legible — por eso Marketing siempre la verifica contra la foto original antes de
  aprobar.
- `src/lib/carteleria-fondo.js` (recorte automático de fondo con `@imgly/background-removal-node`)
  quedó en el repo pero **sin usarse** — se probó como alternativa al catálogo y el resultado no
  convenció (quedaban restos semi-transparentes del fondo real de la foto). Si se retoma más
  adelante, recordar que es una dependencia pesada (~130MB, modelo ONNX) y tarda varios segundos
  por foto.
