# Área Depósito

> Un doc por área. Este cubre **Depósito**: sus comandos, el flujo de datos y los límites conocidos.
> Última actualización: **2026-07-30**.

## Qué hace el rol

La persona de Depósito puede dejar un **informe en texto libre** sobre un proveedor o un producto,
dirigido a **Calidad** o a **Compras** (uno u otro por informe, nunca ambos a la vez porque el
contenido suele ser distinto para cada área). El informe queda guardado y se avisa automáticamente
a **todos** los que tengan el rol de destino, sin importar de qué proveedor se trate.

También puede pedir **cartelería** (código de barras del producto — o el código/nombre a mano —
+ tipo de gráfica + tipo de precio + precio + vencimiento si corresponde): el bot arma el diseño
final automáticamente y Marketing lo verifica antes de imprimir o pedirlo a la gráfica.

## Comandos

| Comando | Qué hace |
|---------|----------|
| `/informe` | Pregunta el destino (Calidad o Compras), el proveedor o producto (texto libre, **no** se valida contra el maestro de artículos) y el contenido del informe. Guarda todo en `bot.deposito_informes` y avisa por Telegram a todos los que tengan el rol elegido. |
| `/carteleria` | Pide una foto del código de barras del producto (o el código/nombre a mano — ver abajo), el tipo de gráfica (**A4**, **A4 Color**, **Cartel simple**, **Gráfica cigüeña**), el tipo de precio (**corto vencimiento**, **política**, **precio al piso**, **nuevo ingreso** — las opciones dependen del tipo de gráfica), el precio (salvo "nuevo ingreso", que no lleva) y, para A4/A4 Color, la cantidad de copias (más la fecha de vencimiento si es "corto vencimiento"). Genera el diseño automáticamente y se lo manda a Marketing para que lo verifique — ver detalle abajo. |
| `/carteleria_prueba` | El mismo wizard que `/carteleria`, pero **solo para el dueño del bot** (`OWNER_TELEGRAM_ID`, ver `middleware/authz.js` → `requiereDueno`) y sin tocar a Marketing: el diseño generado, los botones "✅ Está bien" / "✏️ Corregir" y el aviso final vuelven todos a quien lo probó (`bot.carteleria.es_prueba = true`, ver `carteleria-mensajes.js`). Pensado para probar cambios de diseño sin mandarle nada a Marketing real. No aparece en `/menu` — se tipea directo. |

## Modelo de datos

`bot.deposito_informes` (migración 015):

- `destino_area` — `'calidad'` o `'compras'`.
- `referencia` — proveedor o producto, texto libre tal como lo escribió quien cargó el informe.
- `mensaje` — el contenido del informe.
- `usuario_id` / `usuario_nombre` — quién lo cargó.

`bot.carteleria` (migración 028; ampliada en 029, 030, 031, 032 y 033):

- `foto_file_id` — la foto del código de barras que escaneó Depósito, si mandó una (migración 033:
  ahora es **opcional** — puede ser `null` si el producto se cargó a mano, código o nombre).
- `tipo` — `'a4'` | `'a4_color'` | `'cartel_simple'` | `'ciguena'`.
- `tipo_precio` — `'corto_vencimiento'` | `'politica'` | `'precio_piso'` | `'nuevo_ingreso'`
  (migración 031). A4 / A4 Color aceptan los cuatro; Cartel simple / Cigüeña solo `politica` y
  `precio_piso`. `nuevo_ingreso` no es un precio de verdad — es un aviso de producto nuevo sin
  precio (ver abajo).
- `vencimiento` — fecha (`date`), solo cuando `tipo_precio = 'corto_vencimiento'`. `null` en el resto.
- `cantidad_copias` — solo para A4 / A4 Color; cuántas copias hay que imprimir. `null` para Cartel
  simple / Gráfica cigüeña (esos no se imprimen acá).
- `producto` — el nombre confirmado por Depósito (del maestro `bot.articulos`, o tipeado a mano si
  no matcheó ningún producto).
- `precio` — el que tipeó Depósito. `null` solo cuando `tipo_precio = 'nuevo_ingreso'` (esa
  plantilla no tiene campo de precio).
- `diseno_file_id` — `file_id` de Telegram del cartel ya armado (se sube una sola vez y se reenvía
  por `file_id` al resto de Marketing y en cada reenvío posterior).
- `verificado_en` — cuándo Marketing aprobó el diseño (`marcarVerificado`, guarda atómica: si dos
  personas de Marketing tocan "Está bien" casi al mismo tiempo, solo una dispara el aviso).
- `usuario_id` / `usuario_nombre` / `usuario_telegram_id` — quién lo pidió.
- `pedido_confirmado_en` — igual que antes (migración 029), solo para Cartel simple / Cigüeña.
- `es_prueba` (migración 032) — `true` si vino de `/carteleria_prueba` (ver tabla de comandos
  arriba). El diseño y la verificación de un pedido de prueba vuelven todos a quien lo probó,
  nunca a Marketing real.

## `/carteleria`: cómo se arma el diseño

1. **Identificación del producto — SIN IA** (`src/lib/carteleria-codigo-barras.js` +
   `src/db/articulos.js`) — Depósito manda una foto del código de barras (EAN-13/EAN-8/UPC-A/UPC-E)
   y se decodifica **local**, con `zxing-wasm` (WebAssembly, corre en el mismo proceso del bot; el
   `.wasm` se carga de `node_modules` una sola vez, nunca de un CDN ni de ningún servicio externo —
   cero costo, cero dependencia de red). El código leído (o lo que haya escrito a mano si mandó
   texto en vez de foto) se busca contra el maestro `bot.articulos` (`buscarArticulos` — EAN, código
   exacto o nombre parcial, el mismo buscador que usa `/alta`). Si hay resultados, se muestran
   numerados para confirmar cuál es; si no matchea ninguno (o Depósito no pudo sacarle una foto
   legible al código), se carga el nombre a mano. Si la foto no tiene un código de barras legible,
   se le pide reintentar (mejor luz/enfoque) o escribirlo/nombrarlo a mano — nunca deja el wizard
   colgado.
2. **Depósito completa el resto a mano** — tipo de gráfica, tipo de precio, precio (salvo "nuevo
   ingreso", que no lleva) y fecha de vencimiento / cantidad de copias si corresponde. No hay paso
   de confirmación aparte; el control de calidad lo hace Marketing (paso 4).
3. **Composición del cartel** (`src/lib/carteleria-render.js`, con **satori** + `sharp`) — satori
   arma todo el layout (plantilla de fondo, textos, foto de producto) como si fuera HTML/flexbox y
   mide el texto de verdad con `opentype.js` (nombre de producto: hasta 2 líneas, se corta con "…"
   si no entra — nunca se desborda de la plantilla, sea cual sea el largo); `sharp` solo rasteriza
   el SVG final a JPEG. El precio siempre es el que tipeó Depósito (validado con `parsePrecio` al
   cargarlo), nunca inventado ni leído por IA.
   - **Nombre del producto**: si entra en 1 sola línea o necesita 2, el reparto es *balanceado*
     (prueba cada punto de corte posible y elige el que minimiza el ancho de la línea más larga,
     en vez de amontonar todo en la línea 1) y el bloque completo (1 o 2 líneas) se centra
     verticalmente con flexbox dentro de todo el hueco de nombre de la plantilla — así un nombre
     corto de 1 línea no queda pegado arriba con un hueco vacío debajo.
   - **Color del precio**: cada plantilla define `colorPrecio` en `carteleria-plantillas.js` para
     que el precio que dibuja el código calce con el color real del "$"/"FINAL" ya impresos en esa
     plantilla (blanco en las A4, negro en las de Cartel/Cigüeña) — no es un color único global.
   - Plantillas A4 / A4 Color (comparten archivo): `a4_precio_piso.jpg`, `a4_politica.jpg`,
     `a4_corto_vencimiento.jpg` (línea-puntero a la fecha de vencimiento + hueco para foto de
     producto), `a4_nuevo_ingreso.jpg` (banner "¡Nuevo ingreso!" fijo, **sin campo de precio**).
     Nombre del producto en caja oscura → texto blanco.
   - Plantillas Cartel simple / Gráfica cigüeña (comparten archivo): `cartel_precio_piso.jpg`,
     `cartel_politica.jpg`. Nombre del producto en barra blanca → texto oscuro. La **cigüeña se
     renderiza al doble del tamaño de canvas** de la misma plantilla (no es un archivo aparte).
   - **La foto del código de barras NUNCA se compone en el cartel** — solo sirvió para identificar
     el producto (paso 1). **Las 6 combinaciones de plantilla tienen hueco de foto de producto**
     (`imagenProducto` en `carteleria-plantillas.js`) y usan la foto **ya limpia** del catálogo
     (`assets/productos/`, `src/lib/carteleria-catalogo.js`), matcheada primero por código de
     artículo y si no por el nombre del producto (por palabras en común entre ese nombre y el
     nombre del archivo — no hace falta que sea exacto). Si ningún archivo del catálogo matchea, el cartel
     queda **sin foto** (nunca se usa la foto del código de barras como respaldo — no tiene ningún
     sentido visual. Hay un recorte de fondo automático con IA, `src/lib/carteleria-fondo.js`, que
     se probó para otro propósito y quedó sin usar — ver "Límites conocidos").
4. **Verificación de Marketing** — a cada persona con rol `marketing` le llegan uno o dos mensajes:
   la foto del código de barras escaneado (si Depósito mandó una — puede no haber ninguna si cargó
   el producto a mano), y el diseño generado con el producto/precio en el pie y dos botones:
   - **"✅ Está bien"** (`carteleria_ok:<id>`) — guarda atómica (`verificado_en`) y recién ahí
     dispara el aviso final (impresión o pedido a la gráfica, ver abajo) + le avisa a Depósito que
     su pedido fue verificado.
   - **"✏️ Corregir"** (`carteleria_corregir:<id>`) — abre un wizard (`corregir-carteleria-wizard`)
     donde Marketing tipea el producto y/o el precio correctos (o "igual" para no tocar ese campo);
     para `nuevo_ingreso` no pregunta precio (no existe ese campo). El bot **regenera el cartel**
     con los datos corregidos — si cambió el nombre del producto, vuelve a buscar en el catálogo con
     el nombre nuevo — y se lo vuelve a mandar con los mismos dos botones — se puede corregir las
     veces que haga falta antes de aprobar.
5. **Aviso final a Marketing** (`avisarAMarketingFinal`, disparado desde `acciones-deposito.js`
   cuando Marketing toca "✅ Está bien") — usa el diseño ya aprobado:
   - **A4 / A4 Color**: el cartel con el pie "🖨️ Imprimir A4 — 3 copias." Sin botón — es avisar e
     imprimir, sin loop de vuelta.
   - **Cartel simple / Gráfica cigüeña**: el cartel + dos botones — **"📲 Pedir por WhatsApp"**
     (abre un chat de WhatsApp con el número de la gráfica, `GRAFICA_WHATSAPP_NUMBER` en `.env`, y
     el mensaje ya escrito; Marketing solo adjunta la foto a mano y manda, un link de WhatsApp no
     puede adjuntar archivos automáticamente) y **"✅ Ya pedí los carteles"** (`carteleria_pedido:<id>`,
     migración 029, guarda atómica) — avisa a quien pidió la cartelería.

**Si algo falla al generar el cartel** (error de `satori`/`sharp`, poco probable) el bot avisa a
Depósito que reintente o avise al admin — no hay foto de respaldo para mandarle a Marketing en ese
caso, porque ya no hay ningún "flujo viejo": el producto y el precio siempre vienen confirmados
antes de intentar generar el diseño.

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
- El catálogo tiene ~4550 fotos cargadas (Supabase Storage, ver `assets/productos/README.md`), la
  mayoría nombradas por código de artículo. Un producto que no esté en ese catálogo (o cuyo código
  no matcheó ninguna foto) simplemente sale **sin foto** — las 6 combinaciones de plantilla tienen
  hueco de imagen, pero el precio y el nombre nunca dependen de esto.
- El matcheo del catálogo es primero por **código de artículo exacto** (determinístico, la mayoría
  de los casos) y recién si no hay código cae a superposición de palabras entre el nombre del
  producto y el nombre del archivo (`carteleria-catalogo.js`) — para los pocos archivos con nombre
  descriptivo en vez de código, con el mismo riesgo de siempre (nombres parecidos entre sí, p.ej.
  "Coca Cola 500ml" vs "Coca Cola Zero 500ml"); por eso Marketing siempre revisa el diseño antes de
  aprobar.
- `bot.articulos.codigo` tiene ceros a la izquierda (ej. `"010013"`) y los nombres de archivo del
  catálogo no (`"10013.webp"`) — el matcheo por código los compara como número, no como string
  (`normalizarCodigo` en `carteleria-catalogo.js`).
- satori **no decodifica WebP** (aunque el string aparezca en su bundle, no hay decoder real —
  falla en silencio, sin tirar error). Como el catálogo sube todo en WebP, `carteleria-render.js`
  normaliza siempre la foto del producto a PNG con `sharp` antes de componerla.
- La tipografía del diseño generado es **Anton** (`@fontsource/anton`, subset `latin` — cubre
  acentos/ñ), no la fuente exacta de la marca pero del mismo estilo condensado/bold; satori mide el
  texto real así que nunca se desborda.
- La lectura del código de barras (`zxing-wasm`) depende de que la foto esté enfocada y con buena
  luz — con fotos borrosas o muy anguladas puede no detectar el código; en ese caso se le pide a
  Depósito reintentar o cargar el código/nombre a mano, nunca se inventa un match.
- `src/lib/carteleria-fondo.js` (recorte automático de fondo con `@imgly/background-removal-node`)
  quedó en el repo pero **sin usarse** — se probó como alternativa al catálogo y el resultado no
  convenció (quedaban restos semi-transparentes del fondo real de la foto). Si se retoma más
  adelante, recordar que es una dependencia pesada (~130MB, modelo ONNX) y tarda varios segundos
  por foto.
