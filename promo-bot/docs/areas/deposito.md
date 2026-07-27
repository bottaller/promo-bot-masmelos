# Área Depósito

> Un doc por área. Este cubre **Depósito**: sus comandos, el flujo de datos y los límites conocidos.
> Última actualización: **2026-07-28**.

## Qué hace el rol

La persona de Depósito puede dejar un **informe en texto libre** sobre un proveedor o un producto,
dirigido a **Calidad** o a **Compras** (uno u otro por informe, nunca ambos a la vez porque el
contenido suele ser distinto para cada área). El informe queda guardado y se avisa automáticamente
a **todos** los que tengan el rol de destino, sin importar de qué proveedor se trate.

También puede pedir **cartelería** (foto de un producto con el precio + qué tipo de gráfica hace
falta), que se le avisa a Marketing.

## Comandos

| Comando | Qué hace |
|---------|----------|
| `/informe` | Pregunta el destino (Calidad o Compras), el proveedor o producto (texto libre, **no** se valida contra el maestro de artículos) y el contenido del informe. Guarda todo en `bot.deposito_informes` y avisa por Telegram a todos los que tengan el rol elegido. |
| `/carteleria` | Pide una foto (producto + precio juntos) y el tipo de gráfica: **A4**, **A4 Color**, **Cartel simple** o **Gráfica cigüeña**. Guarda el pedido y avisa a Marketing — ver detalle abajo. |

## Modelo de datos

`bot.deposito_informes` (migración 015):

- `destino_area` — `'calidad'` o `'compras'`.
- `referencia` — proveedor o producto, texto libre tal como lo escribió quien cargó el informe.
- `mensaje` — el contenido del informe.
- `usuario_id` / `usuario_nombre` — quién lo cargó.

`bot.carteleria` (migración 028):

- `foto_file_id` — la foto del producto con el precio (se reenvía por `file_id`, no se descarga).
- `tipo` — `'a4'` | `'a4_color'` | `'cartel_simple'` | `'ciguena'`.
- `usuario_id` / `usuario_nombre` / `usuario_telegram_id` — quién lo pidió.

## `/carteleria`: qué le llega a Marketing

Según el tipo elegido, el aviso a Marketing (`telegramIdsPorRol('marketing')`) es distinto:

- **A4 / A4 Color** (se hacen adentro): la foto con el pie "🖨️ Imprimir A4" o "🖨️ Imprimir A4
  Color". Sin botón — no hace falta nada más.
- **Cartel simple / Gráfica cigüeña** (van a la gráfica externa): la foto con el pie
  correspondiente + un botón **"📲 Pedir por WhatsApp"** que abre un chat de WhatsApp con el
  número de la gráfica (`GRAFICA_WHATSAPP_NUMBER` en `.env`) y el mensaje ya escrito ("Buenos
  días, solicito {tipo} a continuación les adjunto el diseño"). Marketing solo tiene que adjuntar
  la foto a mano y mandar — un link de WhatsApp no puede adjuntar archivos automáticamente, es una
  limitación de la plataforma.

No hay paso de confirmación de Marketing para `/carteleria` (a diferencia de `/ajuste` y
`/promoprecios`): es avisar y listo, sin loop de vuelta.

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
