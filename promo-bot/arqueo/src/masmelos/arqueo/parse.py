"""Carga y validación del export "Diario de movimientos" de Sigma.

El export sale A MANO de Sigma (no hay tabla equivalente en BigQuery), así que
este módulo es deliberadamente defensivo: valida la forma del archivo antes de
confiar en él, y mantiene un snapshot local acumulativo para que los exports
sucesivos (que se solapan) no dupliquen asientos.

Formato del archivo (validado contra el export real de jul-2026):
- Fila 1: "Empresa: 0008-HONRE_2,0009-..." — el export NO trae columna de
  empresa por asiento, solo este título. Limitación conocida (ver README).
- Fila 2: "Diario de movimientos contables del DD/MM/YYYY al DD/MM/YYYY".
- Fila 3: headers (a veces con encoding roto en "Últ.Modif."), por eso el
  renombre es POSICIONAL y no por nombre.
- Datos: partida doble — las filas de un mismo `Mov.` balancean Debe = Haber.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path

import pandas as pd

logger = logging.getLogger(__name__)


class ArqueoUsuarioError(ValueError):
    """Error ESPERABLE con mensaje apto para reenviar tal cual al usuario
    final (ej. un bot que recibe el Excel por chat): dice qué está mal y qué
    hacer, sin traceback ni jerga. Hereda de ValueError para no romper a los
    llamadores existentes.

    Los llamadores (main(), un bot) deben capturar ESTA clase — no ValueError
    a secas, que también matchearía errores internos de pandas (IntCastingNaN,
    DateParseError…) cuyo mensaje no es para el usuario.
    """


class ExportInvalidoError(ArqueoUsuarioError):
    """El archivo no es un export válido del "Diario de movimientos" de Sigma."""


# Renombre posicional de las 18 columnas del export.
COLUMNAS = [
    "mov", "fecha", "comp", "concepto", "cuenta_id", "cuenta",
    "cc", "centro_costo", "debe", "haber", "debe_nominal", "haber_nominal",
    "comprobante", "cuenta_asociada", "usuario", "ingreso",
    "ult_modif", "ult_usuario",
]

# Columnas que el resto del pipeline asume con estos dtypes.
_NUMERICAS = ["debe", "haber", "debe_nominal", "haber_nominal"]

_RE_PERIODO = re.compile(r"del\s+(\d{2}/\d{2}/\d{4})\s+al\s+(\d{2}/\d{2}/\d{4})")


def cargar_export(path: str | Path) -> tuple[pd.DataFrame, dict]:
    """Lee un export del diario y devuelve (datos normalizados, metadatos).

    Falla temprano (ExportInvalidoError, con mensaje apto para reenviar al
    usuario) si el archivo no tiene la forma esperada: mejor cortar acá que
    producir un arqueo silenciosamente incompleto.
    """
    path = Path(path)
    if not path.exists():
        raise ExportInvalidoError(
            f"No encuentro el archivo '{path}'. Revisá la ruta o el nombre."
        )
    try:
        crudo = pd.read_excel(path, header=None)
    except Exception as e:  # archivo corrupto, PDF renombrado, formato raro…
        raise ExportInvalidoError(
            f"No pude abrir '{path.name}' como Excel. Mandá el archivo .xlsx "
            "tal como sale de Sigma (reporte 'Diario de movimientos contables')."
        ) from e

    if crudo.shape[1] != len(COLUMNAS):
        raise ExportInvalidoError(
            f"'{path.name}' tiene {crudo.shape[1]} columnas y el Diario de "
            f"movimientos de Sigma trae {len(COLUMNAS)}. ¿Es otro reporte, o "
            "cambió el formato en Sigma?"
        )

    # El header "Mov." NO está en una fila fija: el título "Empresa: …" se
    # wrapea a 2+ filas cuando el export incluye varias empresas (visto en el
    # export real con 0006-0009). Se busca en las primeras filas.
    header_idx = None
    for i in range(min(10, len(crudo))):
        if str(crudo.iloc[i, 0]).strip() == "Mov.":
            header_idx = i
            break
    if header_idx is None:
        raise ExportInvalidoError(
            f"'{path.name}' no parece el 'Diario de movimientos' de Sigma "
            "(no encontré la fila de encabezados que arranca con 'Mov.'). "
            "Exportá ese reporte y volvé a mandarlo."
        )
    # Título: las filas antes del header. La empresa arranca con "Empresa:";
    # el período es la fila que matchea "del DD/MM/YYYY al DD/MM/YYYY".
    # El wrap de Sigma es un corte puro por ancho (puede partir MID-TOKEN, ej.
    # "…0009-" / "HONRE_2_…") y cada fragmento conserva sus propios espacios,
    # así que se reconstruye con "".join — un join con " " metería espacios
    # espurios adentro de los nombres (verificado con el export real).
    titulos = [str(crudo.iloc[i, 0]) for i in range(header_idx)
               if pd.notna(crudo.iloc[i, 0])]
    titulo_empresa = "".join(t for t in titulos if not _RE_PERIODO.search(t))
    titulo_periodo = next((t for t in titulos if _RE_PERIODO.search(t)), "")

    df = crudo.iloc[header_idx + 1:].copy()
    df.columns = COLUMNAS
    df = df.dropna(subset=["mov"]).reset_index(drop=True)
    if df.empty:
        raise ExportInvalidoError(
            f"'{path.name}' tiene el formato correcto pero está vacío (sin "
            "movimientos). Revisá el rango de fechas con el que exportaste."
        )

    # La normalización también va bajo el paraguas de ExportInvalidoError: un
    # archivo con la forma correcta pero contenido raro (fila de totales en
    # `mov`, un bool perdido en `fecha`) tiraría TypeError/ValueError crudos de
    # pandas — jerga que no es para el usuario.
    try:
        df["mov"] = df["mov"].astype("int64")
        df["fecha"] = pd.to_datetime(df["fecha"]).dt.normalize()
        df["ingreso"] = pd.to_datetime(df["ingreso"])
        # `ult_modif` viene casi siempre vacío; normalizarlo a datetime nos deja
        # comparar frescura por asiento en el snapshot (y detectar modificaciones).
        df["ult_modif"] = pd.to_datetime(df["ult_modif"], errors="coerce")
        df["cuenta_id"] = df["cuenta_id"].astype("int64")
    except Exception as e:
        raise ExportInvalidoError(
            f"'{path.name}' tiene la forma del Diario de movimientos pero no "
            "pude interpretar sus datos (¿una fila de totales u otro contenido "
            "raro?). Re-exportá el reporte de Sigma sin modificarlo."
        ) from e
    for col in _NUMERICAS:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0)
    for col in ("comp", "concepto", "cuenta", "usuario"):
        df[col] = df[col].astype("string").fillna("")

    empresas = titulo_empresa.replace("Empresa:", "").strip()
    m = _RE_PERIODO.search(titulo_periodo)
    meta = {
        "archivo": str(path),
        "empresas": empresas,
        "desde": pd.to_datetime(m.group(1), dayfirst=True) if m else df["fecha"].min(),
        "hasta": pd.to_datetime(m.group(2), dayfirst=True) if m else df["fecha"].max(),
        "n_filas": len(df),
        "n_asientos": df["mov"].nunique(),
    }
    logger.info(
        "Export %s: %s filas / %s asientos, %s → %s (empresas: %s)",
        path.name, meta["n_filas"], meta["n_asientos"],
        meta["desde"].date(), meta["hasta"].date(), empresas,
    )
    return df, meta


def asientos_desbalanceados(df: pd.DataFrame, tol: float = 0.01) -> pd.DataFrame:
    """Asientos cuya suma Debe ≠ suma Haber (en ARS).

    En el export real son 0 — si aparece alguno es señal de export cortado
    a mitad de asiento o de un problema serio en Sigma, y el arqueo de esa
    caja/día no es confiable.
    """
    g = df.groupby("mov").agg(debe=("debe", "sum"), haber=("haber", "sum"))
    g["desbalance"] = g["debe"] - g["haber"]
    return g[g["desbalance"].abs() > tol].reset_index()


def _version_por_mov(df: pd.DataFrame) -> pd.Series:
    """Marca de frescura de cada asiento: la última vez que se tocó en Sigma.

    Es max(ingreso, ult_modif) por `mov`. `ingreso` solo no alcanza: no
    cambia cuando el asiento se modifica después (ej. PRFA backdateado).
    """
    ts = df[["mov", "ingreso", "ult_modif"]].copy()
    ts["v"] = ts[["ingreso", "ult_modif"]].max(axis=1)
    return ts.groupby("mov")["v"].max()


def actualizar_snapshot(df: pd.DataFrame, path: str | Path) -> pd.DataFrame:
    """Mergea el export al snapshot local acumulativo, por asiento completo.

    La unidad de reemplazo es el `mov` entero (no la fila): si un asiento
    viene de nuevo en un export posterior —incluso modificado en Sigma—,
    la versión nueva pisa a la vieja completa. Así los exports solapados no
    duplican y las correcciones tardías (PRFA se backdatea hasta 3 días)
    quedan reflejadas.

    El reemplazo se hace SOLO si el asiento entrante es igual o más fresco que
    el del snapshot (por `_version_por_mov`). Re-correr por error un export
    viejo (un archivo que quedó en Descargas) ya no degrada silenciosamente
    las correcciones acumuladas: esos asientos se conservan y se loguea el
    warning. Un asiento BORRADO en Sigma no desaparece del snapshot; es el
    costo de no tener acceso directo a la base.
    """
    path = Path(path)
    if path.exists():
        previo = pd.read_parquet(path)
        if "ult_modif" in previo.columns:
            previo["ult_modif"] = pd.to_datetime(previo["ult_modif"], errors="coerce")
        v_prev = _version_por_mov(previo)
        v_new = _version_por_mov(df)
        # Movs presentes en ambos donde el snapshot ya tiene versión más nueva.
        comunes = v_new.index.intersection(v_prev.index)
        mas_viejos = [m for m in comunes if v_new[m] < v_prev[m]]
        if mas_viejos:
            logger.warning(
                "El export trae %s asiento(s) más viejos que el snapshot; se "
                "conserva la versión más reciente (¿export anterior al último?).",
                len(mas_viejos),
            )
        entrantes = df[~df["mov"].isin(set(mas_viejos))]
        previo = previo[~previo["mov"].isin(set(entrantes["mov"]))]
        combinado = pd.concat([previo, entrantes], ignore_index=True)
    else:
        combinado = df.copy()
    combinado = combinado.sort_values(["mov", "ingreso"], kind="stable").reset_index(drop=True)
    # Escritura atómica (tmp + replace): si el proceso muere a mitad de
    # escritura, el snapshot anterior queda intacto en vez de un parquet trunco.
    tmp = path.with_suffix(".parquet.tmp")
    combinado.to_parquet(tmp, index=False)
    os.replace(tmp, path)
    logger.info("Snapshot %s: %s filas / %s asientos", path.name,
                len(combinado), combinado["mov"].nunique())
    return combinado
