"""Arqueo de caja diario sobre el export "Diario de movimientos" de Sigma.

Pensado para que el tesorero (y gerencia) lo corra cada mañana: exporta el
diario de Sigma con ~7 días hacia atrás, lo pasa por acá y revisa el Excel.
El saldo teórico por caja se calcula automático — el conteo físico se
compara contra un número, no al revés (hoy el 53% de los arqueos manuales
de la semana de calibración se cargó mal y generó cadenas de reversiones).

Qué genera (en reports/arqueo/):
- <AAAA-MM>/arqueo_<desde>_<hasta>.xlsx  (Control 1, 7 hojas: Resumen / Arqueo
                                 diario / Bolsines / Diferencias / Alertas /
                                 Cascada / Caja USD). Los informes del día van a
                                 una SUBCARPETA POR MES para no amontonarlos.
- <AAAA-MM>/flujo_<desde>_<hasta>.html   (Control 2, dashboard del flujo)
- diferencias_log.csv / revision_log.csv (acumulativos en la RAÍZ de arqueo/;
                                 upsert por asiento; `estado_seguimiento` /
                                 `estado_revision` se completan A MANO y
                                 sobreviven a las re-corridas — igual que
                                 fuga_log.csv en clientes. NO se parten por mes.)

Además mantiene data/raw/diario_contable.parquet: snapshot local acumulativo
del diario (merge por asiento), porque los exports se solapan y las
correcciones llegan hasta 3 días tarde.

Uso:
    python -m masmelos.update_arqueo "C:/ruta/Diario de movimientos.xlsx"
    python -m masmelos.update_arqueo export1.xlsx export2.xlsx
    python -m masmelos.update_arqueo --desde 2026-07-01 --hasta 2026-07-06
    python -m masmelos.update_arqueo exp.xlsx --sin-snapshot   # no acumular

Razonamiento completo: docs/arqueo/README.md.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import logging
import os
import sys
from datetime import datetime

import pandas as pd

from masmelos import config
from masmelos.arqueo import alertas as alertas_mod
from masmelos.arqueo import core, excel, flujo, flujo_html, parse

logger = logging.getLogger(__name__)

OUT_DIR = config.REPORTS_DIR / "arqueo"
DIF_LOG_PATH = OUT_DIR / "diferencias_log.csv"
AUTORIZ_LOG_PATH = OUT_DIR / "revision_log.csv"

_LOG_COLS = ["mov", "fecha", "caja", "tipo", "efecto_ars", "concepto",
             "usuario", "estado_seguimiento"]
_AUTORIZ_COLS = ["mov", "fecha", "destino_id", "destino", "asociado", "categoria",
                 "monto_ars", "concepto", "usuario", "estado_revision"]


def _leer_log(path) -> pd.DataFrame:
    """Lee diferencias_log.csv tolerando que el tesorero lo edite en Excel.

    Excel con locale argentino re-guarda el CSV con separador ';' y fechas
    dd/mm/yyyy, y a veces en cp1252. Sin esto la corrida siguiente crashea o
    corrompe las fechas en silencio. Mismo mecanismo que `_leer_fuga_log` de
    update_clientes (que ya resolvió este problema para fuga_log.csv).
    """
    try:
        previo = pd.read_csv(path, encoding="utf-8-sig", sep=None, engine="python")
    except UnicodeDecodeError:
        previo = pd.read_csv(path, encoding="cp1252", sep=None, engine="python")
    # dayfirst corrige el dd/mm/yyyy de Excel; format="mixed" tolera que
    # convivan filas ISO (las que escribe to_csv) con dd/mm (las que reescribe
    # Excel) en la misma columna.
    previo["fecha"] = pd.to_datetime(previo["fecha"], dayfirst=True, format="mixed")
    previo["mov"] = previo["mov"].astype("int64")
    if "estado_seguimiento" not in previo.columns:
        previo["estado_seguimiento"] = ""
    return previo


def actualizar_log_diferencias(difc_eventos: pd.DataFrame, path=DIF_LOG_PATH) -> pd.DataFrame:
    """Upsert de los asientos DIFC al log de seguimiento.

    `estado_seguimiento` (vacío / explicada / recontada / descuento a cajera /
    lo que el tesorero decida anotar) se completa a mano en Excel y NO se
    pisa en la re-corrida: los asientos que ya estaban conservan su estado.
    """
    nuevos = difc_eventos.rename(columns={"efecto": "efecto_ars"})[
        ["mov", "fecha", "caja", "tipo", "efecto_ars", "concepto", "usuario"]
    ].copy()
    nuevos["estado_seguimiento"] = ""

    if path.exists():
        previo = _leer_log(path)
        estados = previo.set_index("mov")["estado_seguimiento"].fillna("")
        nuevos["estado_seguimiento"] = (
            nuevos["mov"].map(estados).fillna("").astype(str)
        )
        combinado = pd.concat(
            [previo[~previo["mov"].isin(set(nuevos["mov"]))], nuevos],
            ignore_index=True,
        )
    else:
        combinado = nuevos
    combinado = combinado.sort_values("mov").reset_index(drop=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    combinado[_LOG_COLS].to_csv(path, index=False, encoding="utf-8-sig")
    return combinado


def actualizar_log_autorizaciones(salidas: pd.DataFrame, path=AUTORIZ_LOG_PATH) -> pd.DataFrame:
    """Upsert de las salidas del circuito al log de revisión (Control 2).

    Cada salida de plata fuera de la cadena de custodia queda registrada; la
    columna `estado_revision` la completa gerencia a mano (revisado /
    aclaración) y sobrevive a las re-corridas. Devuelve el log con el estado
    ya mapeado por `mov` para poder pintarlo en el HTML del mismo día.
    """
    # El log de revisión es SOLO la lista de control (salidas hacia afuera del
    # circuito). Los movimientos a bancos (conciliable) y los ajustes/desvío
    # (ok) están en el árbol pero no se firman acá.
    if not salidas.empty:
        salidas = salidas[salidas["categoria"].isin(
            ["revisar", "inter_empresa", "autorizado"])]
    if salidas.empty:
        return pd.DataFrame(columns=_AUTORIZ_COLS)
    nuevos = salidas.rename(columns={"monto": "monto_ars"}).copy()
    if "asociado" not in nuevos.columns:
        nuevos["asociado"] = ""
    nuevos = nuevos[["mov", "fecha", "destino_id", "destino", "asociado",
                     "categoria", "monto_ars", "concepto", "usuario"]].copy()
    nuevos["estado_revision"] = ""

    if path.exists():
        previo = _leer_log(path)
        # Logs viejos sin destino_id: fallback al nombre (migración one-shot).
        if "destino_id" not in previo.columns:
            previo["destino_id"] = previo["destino"]
        # La clave es (mov, destino_id ESTABLE, monto): un asiento puede tener
        # varias salidas al mismo destino (pago + redondeo, o tranches), y el
        # nombre de una cuenta desconocida puede cambiar entre corridas — por
        # eso NO se llavea por la etiqueta.
        def _k(mov, did, monto):
            return (int(mov), str(did), round(float(monto), 2))
        prev_map = {}
        for _, r in previo.iterrows():
            est = "" if pd.isna(r["estado_revision"]) else str(r["estado_revision"])
            prev_map[_k(r["mov"], r["destino_id"], r["monto_ars"])] = est
        nuevos["estado_revision"] = [
            prev_map.get(_k(m, did, mo), "")
            for m, did, mo in zip(nuevos["mov"], nuevos["destino_id"], nuevos["monto_ars"])
        ]
        claves_nuevas = {_k(m, did, mo) for m, did, mo
                         in zip(nuevos["mov"], nuevos["destino_id"], nuevos["monto_ars"])}
        prev_keep = previo[~previo.apply(
            lambda r: _k(r["mov"], r["destino_id"], r["monto_ars"]) in claves_nuevas, axis=1)]
        combinado = pd.concat([prev_keep, nuevos], ignore_index=True)
    else:
        combinado = nuevos
    combinado = combinado.sort_values(["fecha", "monto_ars"], ascending=[True, False]).reset_index(drop=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    combinado[_AUTORIZ_COLS].to_csv(path, index=False, encoding="utf-8-sig")
    return combinado


def _imprimir_resumen(meta, arqueo, difc_resumen, bolsines, alertas) -> None:
    # Solo ASCII en la consola: la terminal de Windows (cp1252) rompe con
    # em-dashes y tildes de más.
    print(f"\n=== ARQUEO DE CAJA {meta['desde']:%d/%m/%Y} al {meta['hasta']:%d/%m/%Y} ===")
    dif_total = float(difc_resumen["neto_final"].sum()) if len(difc_resumen) else 0.0
    print(f"Diferencia neta de la ventana (post-correcciones): $ {dif_total:+,.2f}")
    dias_revisar = arqueo[arqueo["estado"] == "REVISAR"]
    if len(dias_revisar):
        print(f"\nCajas/días a revisar ({len(dias_revisar)}):")
        for _, r in dias_revisar.iterrows():
            print(f"  {r['fecha']:%d/%m} {r['caja']:<18} neto {r['neto_dia']:+15,.2f}"
                  f"  dif.registrada {r['diferencia_registrada']:+12,.2f}")
    else:
        print("Todas las cajas cierran en cero. OK")
    sin_conciliar = bolsines[~bolsines["estado"].isin(["CONCILIADO", "PENDIENTE"])]
    print(f"\nBolsines: {len(bolsines)} en ventana — "
          f"{int((bolsines['estado'] == 'CONCILIADO').sum())} conciliados, "
          f"{int((bolsines['estado'] == 'PENDIENTE').sum())} pendientes, "
          f"{len(sin_conciliar)} con problema")
    if len(alertas):
        n = alertas["severidad"].value_counts()
        print(f"Alertas: {n.get('ROJA', 0)} ROJAS, {n.get('AMARILLA', 0)} amarillas, "
              f"{n.get('INFO', 0)} info")


def _imprimir_flujo(grafo) -> None:
    """Resumen del Control 2: salidas del circuito para revisar."""
    sal = grafo["salidas"]
    if sal.empty:
        return
    firmar = sal[sal["categoria"].isin(["revisar", "inter_empresa", "autorizado"])]
    print(f"\nControl 2 - salio del circuito: $ {firmar['monto'].sum():,.0f} "
          f"en {len(firmar)} salida(s) a revisar")
    res = (firmar.groupby(["destino", "categoria"])["monto"].sum()
           .reset_index().sort_values("monto", ascending=False))
    for _, r in res.iterrows():
        print(f"  {r['destino']:<24} {r['categoria']:<14} $ {r['monto']:>15,.0f}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Arqueo de caja desde el diario de movimientos de Sigma."
    )
    ap.add_argument("exports", nargs="*",
                    help="Uno o más .xlsx exportados de Sigma. Si se omiten, "
                         "se usa el snapshot local acumulado.")
    ap.add_argument("--sin-snapshot", action="store_true",
                    help="No acumular el export al snapshot local.")
    ap.add_argument("--desde", type=str, default=None,
                    help="Inicio de la ventana del reporte (YYYY-MM-DD).")
    ap.add_argument("--hasta", type=str, default=None,
                    help="Fin de la ventana del reporte (YYYY-MM-DD).")
    ap.add_argument("--abrir", action="store_true",
                    help="Abrir los informes (Excel + flujo HTML) al terminar. "
                         "Lo usa arqueo.bat; por consola normalmente no hace falta.")
    ap.add_argument("--json", action="store_true",
                    help="Emitir una línea JSON final con las rutas ({ok, html, xlsx}); "
                         "el resumen humano va a stderr. Para invocarlo desde un bot.")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    # 1. Cargar exports y/o snapshot.
    metas = []
    nuevos = None
    for ruta in args.exports:
        try:
            df_exp, meta_exp = parse.cargar_export(ruta)
        except Exception as e:  # noqa: BLE001 — cargar_export es el borde de entrada
            # Cualquier fallo leyendo/validando el export es un problema del archivo
            # que mandó el usuario (otro formato, no es el Diario de Sigma, corrupto).
            # En --json lo devolvemos como error de usuario; sin --json, comportamiento
            # de siempre (propaga con traceback).
            if args.json:
                print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
                return 0
            raise
        metas.append(meta_exp)
        if nuevos is None:
            nuevos = df_exp
        else:
            # El export más nuevo pisa asientos repetidos del anterior.
            nuevos = pd.concat(
                [nuevos[~nuevos["mov"].isin(set(df_exp["mov"]))], df_exp],
                ignore_index=True,
            )

    if nuevos is not None and not args.sin_snapshot:
        base = parse.actualizar_snapshot(nuevos, config.ARQUEO_SNAPSHOT)
    elif nuevos is not None:
        base = nuevos
    elif config.ARQUEO_SNAPSHOT.exists():
        base = pd.read_parquet(config.ARQUEO_SNAPSHOT)
        logger.info("Sin exports nuevos: uso el snapshot (%s filas)", len(base))
    else:
        print("No hay exports ni snapshot previo. Pasá al menos un .xlsx del "
              "diario de movimientos de Sigma.", file=sys.stderr)
        return 1

    # 2. Ventana del reporte: lo que trajo el export nuevo, o lo que se pida.
    ref = nuevos if nuevos is not None else base
    desde = pd.to_datetime(args.desde) if args.desde else ref["fecha"].min()
    hasta = pd.to_datetime(args.hasta) if args.hasta else ref["fecha"].max()
    df = base[(base["fecha"] >= desde) & (base["fecha"] <= hasta)].copy()
    if df.empty:
        print(f"No hay movimientos entre {desde:%Y-%m-%d} y {hasta:%Y-%m-%d}.",
              file=sys.stderr)
        return 1

    meta = {
        "desde": desde, "hasta": hasta,
        "empresas": metas[0]["empresas"] if metas else "snapshot local",
        "generado": datetime.now().strftime("%d/%m/%Y %H:%M"),
    }

    # 3. Cálculos.
    arqueo = core.arqueo_caja_dia(df)
    alivios = core.clasificar_alivios(df)
    # Bolsines: conciliar sobre la historia (hasta `hasta`), no sobre el df ya
    # recortado. El barrido de la primera mañana de la ventana corresponde a
    # bolsas cerradas el día ANTERIOR a `desde`; sin la historia darían falsos
    # SIN_CIERRE (alerta ROJA) en cada corrida diaria. Después se filtra a la
    # ventana del reporte. Cortar en `hasta` preserva PENDIENTE en el borde
    # derecho (no ve barridos futuros).
    bolsines_hist = core.conciliar_bolsines(base[base["fecha"] <= hasta])
    bolsines = bolsines_hist[
        bolsines_hist["fecha_cierre"].between(desde, hasta)
        | bolsines_hist["fecha_barrido"].between(desde, hasta)
    ].reset_index(drop=True)
    difc_eventos = core.clasificar_difc(df)
    difc_res = core.resumen_difc(difc_eventos)
    cascada = core.cascada_diaria(df)
    usd = core.movimientos_usd(df)
    medios = core.medios_pago_dia(df)
    gemelos = core.detectar_gemelos(df)
    tabla_alertas = alertas_mod.generar_alertas(
        df, arqueo, bolsines, difc_eventos, gemelos, alivios)
    # Control 2: flujo del efectivo + salidas del circuito, y el mini-flujo en dólares.
    grafo = flujo.construir_flujo(df)
    flujo_usd = flujo.construir_flujo_usd(df)

    # 4. Outputs. El snapshot ya se guardó (paso 1); el Excel y los logs se
    #    escriben tolerando que el tesorero los tenga abiertos en Excel.
    #    Los INFORMES del día van a una subcarpeta por mes (por `hasta`, el día
    #    del reporte) para que la carpeta no se llene con las corridas diarias.
    #    Los LOGS quedan en la raíz: son acumulativos y se editan a mano — NO se
    #    parten por mes (rompería el seguimiento entre meses).
    mes_dir = OUT_DIR / f"{hasta:%Y-%m}"
    mes_dir.mkdir(parents=True, exist_ok=True)
    out_xlsx = mes_dir / f"arqueo_{desde:%Y-%m-%d}_{hasta:%Y-%m-%d}.xlsx"
    out_xlsx = excel.generar_excel(out_xlsx, meta, arqueo, medios, bolsines,
                                   difc_eventos, difc_res, tabla_alertas, cascada, usd)
    try:
        actualizar_log_diferencias(difc_eventos)
        log_msg = str(DIF_LOG_PATH)
    except PermissionError:
        log_msg = ("NO se actualizó — está abierto en Excel. Cerralo y volvé a "
                   "correr para refrescar el seguimiento.")

    # Control 2: log de autorizaciones (con estado firmado que sobrevive) +
    # HTML de flujo, pintando lo ya autorizado. La clave es
    # (mov, destino_id, monto) — estable e única por salida.
    def _autoriz_dict(log):
        return {
            (int(m), str(did), round(float(mo), 2)): str(e)
            for m, did, mo, e in zip(log["mov"], log["destino_id"],
                                     log["monto_ars"], log["estado_revision"])
            if pd.notna(e) and str(e).strip()
        } if len(log) else {}
    try:
        log_aut = actualizar_log_autorizaciones(grafo["salidas"])
        autoriz = _autoriz_dict(log_aut)
        aut_msg = str(AUTORIZ_LOG_PATH)
    except PermissionError:
        # El CSV está abierto en Excel: no pudimos ESCRIBIR, pero sí LEER — así
        # el HTML del día sigue pintando las firmas ya guardadas en disco.
        try:
            previo = _leer_log(AUTORIZ_LOG_PATH)
            if "destino_id" not in previo.columns:
                previo["destino_id"] = previo["destino"]
            autoriz = _autoriz_dict(previo)
        except Exception:
            autoriz = {}
        aut_msg = "NO se actualizó — abierto en Excel (firmas previas conservadas)."
    out_html = flujo_html.generar_flujo_html(
        mes_dir / f"flujo_{desde:%Y-%m-%d}_{hasta:%Y-%m-%d}.html", grafo, meta, autoriz, flujo_usd)

    # En --json el resumen humano va a stderr, para que stdout quede solo con la línea JSON.
    with (contextlib.redirect_stdout(sys.stderr) if args.json else contextlib.nullcontext()):
        _imprimir_resumen(meta, arqueo, difc_res, bolsines, tabla_alertas)
        _imprimir_flujo(grafo)
        print(f"\nExcel:  {out_xlsx}")
        print(f"Flujo:  {out_html}")
        print(f"Log dif.:    {log_msg}")
        print(f"Log autoriz: {aut_msg}")

    # Abrir los informes con la app por defecto (Excel / navegador). Lo pide
    # arqueo.bat con --abrir; abre las rutas EXACTAS que se generaron, sin tener
    # que adivinar la subcarpeta del mes.
    if args.abrir and hasattr(os, "startfile"):
        for f in (out_xlsx, out_html):
            try:
                os.startfile(f)  # noqa: S606 — Windows, ruta propia del script
            except OSError:
                pass

    if args.json:
        print(json.dumps({"ok": True, "html": str(out_html), "xlsx": str(out_xlsx)},
                         ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
