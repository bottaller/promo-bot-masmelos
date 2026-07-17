# Área Depósito

> Un doc por área. Este cubre **Depósito**: sus comandos, el flujo de datos y los límites conocidos.
> Última actualización: **2026-07-17**.

## Qué hace el rol

La persona de Depósito puede dejar un **informe en texto libre** sobre un proveedor o un producto,
dirigido a **Calidad** o a **Compras** (uno u otro por informe, nunca ambos a la vez porque el
contenido suele ser distinto para cada área). El informe queda guardado y se avisa automáticamente
a **todos** los que tengan el rol de destino, sin importar de qué proveedor se trate.

## Comandos

| Comando | Qué hace |
|---------|----------|
| `/informe` | Pregunta el destino (Calidad o Compras), el proveedor o producto (texto libre, **no** se valida contra el maestro de artículos) y el contenido del informe. Guarda todo en `bot.deposito_informes` y avisa por Telegram a todos los que tengan el rol elegido. |

## Modelo de datos

`bot.deposito_informes` (migración 015):

- `destino_area` — `'calidad'` o `'compras'`.
- `referencia` — proveedor o producto, texto libre tal como lo escribió quien cargó el informe.
- `mensaje` — el contenido del informe.
- `usuario_id` / `usuario_nombre` — quién lo cargó.

## Avisos

Reutiliza el mismo mecanismo de `src/notificar.js` que usan las promociones: `notificarPorRol(rol,
mensaje)` busca a todos los que tienen ese rol en `bot.usuario_area` (activos) y les manda el
mensaje. No hay mapeo por proveedor ni por persona — es puramente por rol.

## Límites conocidos

- El "proveedor o producto" es texto libre: no se contrasta contra `bot.articulos`, así que puede
  haber variaciones de escritura entre informes del mismo proveedor.
- Todavía no hay un comando para **listar** informes ya cargados (quedan en la base, pero se
  consultan solo por Telegram en el momento en que se mandan).
