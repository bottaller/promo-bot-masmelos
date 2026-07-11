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
import re
from pathlib import Path

import pandas as pd

logger = logging.getLogger(__name__)

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

    Falla temprano (ValueError) si el archivo no tiene la forma esperada:
    mejor cortar acá que producir un arqueo silenciosamente incompleto.
    """
    path = Path(path)
    crudo = pd.read_excel(path, header=None)

    if crudo.shape[1] != len(COLUMNAS):
        raise ValueError(
            f"El export tiene {crudo.shape[1]} columnas y se esperaban "
            f"{len(COLUMNAS)}. ¿Cambió el formato del reporte en Sigma?"
        )

    titulo_empresa = str(crudo.iloc[0, 0]) if pd.notna(crudo.iloc[0, 0]) else ""
    titulo_periodo = str(crudo.iloc[1, 0]) if pd.notna(crudo.iloc[1, 0]) else ""
    header = str(crudo.iloc[2, 0]).strip()
    if header != "Mov.":
        raise ValueError(
            f"La fila 3 debería arrancar con el header 'Mov.' y trae {header!r}. "
            "¿Es realmente un 'Diario de movimientos' de Sigma?"
        )

    df = crudo.iloc[3:].copy()
    df.columns = COLUMNAS
    df = df.dropna(subset=["mov"]).reset_index(drop=True)

    df["mov"] = df["mov"].astype("int64")
    df["fecha"] = pd.to_datetime(df["fecha"]).dt.normalize()
    df["ingreso"] = pd.to_datetime(df["ingreso"])
    # `ult_modif` viene casi siempre vacío; normalizarlo a datetime nos deja
    # comparar frescura por asiento en el snapshot (y detectar modificaciones).
    df["ult_modif"] = pd.to_datetime(df["ult_modif"], errors="coerce")
    df["cuenta_id"] = df["cuenta_id"].astype("int64")
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
    combinado.to_parquet(path, index=False)
    logger.info("Snapshot %s: %s filas / %s asientos", path.name,
                len(combinado), combinado["mov"].nunique())
    return combinado
