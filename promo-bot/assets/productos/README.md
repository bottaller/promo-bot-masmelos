# Catálogo de fotos de producto

Fotos de producto **ya limpias** (sin fondo, o con un fondo neutro que no moleste)
para componer en los carteles que tienen hueco de imagen (`nuevo_ingreso`,
`corto_vencimiento`). El bot **no** usa la foto que sube Depósito por `/carteleria`
para esto — esa foto solo sirve para que la IA identifique el producto; la imagen
del cartel siempre sale de acá.

## Cómo se buscan

`src/lib/carteleria-catalogo.js` matchea el **nombre del producto** (el que leyó la
IA, o el que corrigió Marketing) contra el **nombre de archivo** (sin extensión),
por palabras en común — no hace falta que coincida exacto. Si ningún archivo
comparte al menos una palabra con el nombre del producto, el cartel queda sin foto
(no se usa ninguna imagen "parecida a lo loco").

Ejemplos de nombres de archivo que matchean bien:

```
beldent menta.jpg          -> matchea "Beldent Chicles Menta Sin Azúcar"
toddy stick 400g.png       -> matchea "Toddy Stick x 400g"
yerba playadito 1kg.jpg    -> matchea "Yerba Mate Playadito x 1kg"
```

## Formato

- `.jpg`, `.jpeg`, `.png` o `.webp`.
- Cuantas más palabras del nombre real del producto tenga el archivo, mejor
  matchea — no hace falta ser exacto, pero sí parecido.
- Si el archivo es PNG con transparencia, se respeta (se ve el fondo de la
  plantilla). Si es JPEG/fondo sólido, ese fondo tapa la plantilla en el hueco de
  imagen — para mejor resultado, subí las fotos ya con fondo transparente o blanco
  liso.
