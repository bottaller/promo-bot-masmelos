#!/usr/bin/env bash
# Sincroniza / chequea la copia vendoreada del motor de arqueo (arqueo/src/masmelos)
# contra el repo fuente masmelos-analytics.
#
# Es una herramienta LOCAL: se corre en TU PC (donde tenés el checkout de
# masmelos-analytics). NO corre en Railway — allá se deploya la copia ya commiteada.
# Ver COPIADO_DE.md para la regla de una sola dirección.
#
# Uso:
#   bash arqueo/sync.sh check [ruta-a-masmelos-analytics]   # diffea y avisa si hay drift (default)
#   bash arqueo/sync.sh sync  [ruta-a-masmelos-analytics]   # re-copia el motor y estampa el commit
#
# La ruta a masmelos-analytics se pasa como 2do argumento, o por la variable de
# entorno MASMELOS_ANALYTICS (export MASMELOS_ANALYTICS=/ruta/al/repo).
set -uo pipefail

CMD="${1:-check}"
ANALYTICS="${2:-${MASMELOS_ANALYTICS:-}}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_MOTOR="$HERE/src/masmelos"          # la copia vendoreada (en este repo)
SRC_MOTOR="$ANALYTICS/src/masmelos"      # la fuente (masmelos-analytics)
COPIADO="$HERE/COPIADO_DE.md"

# Lo que se vendorea: SOLO el subset del arqueo. masmelos-analytics/src/masmelos
# tiene además analysis/, clientes/, etc. que el bot no usa ni necesita.
SUBSET="__init__.py config.py update_arqueo.py arqueo"

if [ -z "$ANALYTICS" ]; then
  echo "Falta la ruta a masmelos-analytics."
  echo "  Como argumento:  bash arqueo/sync.sh $CMD /ruta/a/masmelos-analytics"
  echo "  O como variable:  export MASMELOS_ANALYTICS=/ruta/a/masmelos-analytics"
  exit 2
fi
if [ ! -f "$SRC_MOTOR/__init__.py" ]; then
  echo "No encuentro el motor en '$SRC_MOTOR'."
  echo "¿Esa es la raíz del repo masmelos-analytics? (esperaba src/masmelos/__init__.py)"
  exit 2
fi

hash_src()   { git -C "$ANALYTICS" rev-parse --short HEAD 2>/dev/null || echo "??"; }
branch_src() { git -C "$ANALYTICS" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "??"; }
hash_vendor(){ grep -oE '\*\*Commit\*\*: `[^`]+`' "$COPIADO" 2>/dev/null | grep -oE '`[^`]+`' | tr -d '`' || echo "??"; }

case "$CMD" in
  check)
    echo "Fuente (masmelos-analytics): $(branch_src) @ $(hash_src)"
    echo "Vendoreado (COPIADO_DE.md):  commit $(hash_vendor)"
    echo ""
    drift=0
    for item in $SUBSET; do
      diff -r --strip-trailing-cr --exclude=__pycache__ "$SRC_MOTOR/$item" "$REPO_MOTOR/$item" || drift=1
    done
    if [ "$drift" = "0" ]; then
      echo ""
      echo "✓ EN SYNC — el subset del arqueo del repo es igual al de masmelos-analytics (contenido)."
    else
      echo ""
      echo "✗ DRIFT — hay diferencias (ver arriba). Actualizá con:  bash arqueo/sync.sh sync"
      exit 1
    fi
    ;;
  sync)
    echo "Copiando el subset del arqueo desde $SRC_MOTOR ..."
    rm -rf "$REPO_MOTOR"
    mkdir -p "$REPO_MOTOR"
    for item in $SUBSET; do cp -r "$SRC_MOTOR/$item" "$REPO_MOTOR/$item"; done
    find "$REPO_MOTOR" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null
    H="$(hash_src)"; B="$(branch_src)"
    sed -i "s|^- \*\*Rama\*\*:.*|- **Rama**: \`$B\`|"     "$COPIADO"
    sed -i "s|^- \*\*Commit\*\*:.*|- **Commit**: \`$H\`|" "$COPIADO"
    echo "Listo: motor actualizado a $B @ $H y estampado en COPIADO_DE.md."
    echo ""
    echo "Revisá y commiteá (desde la raíz del repo del bot):"
    echo "  git add promo-bot/arqueo && git commit -m \"Actualizar motor de arqueo a $H\""
    ;;
  *)
    echo "Comando desconocido: '$CMD'. Usá 'check' o 'sync'."
    exit 2
    ;;
esac
