"""Lógica del arqueo: saldo teórico, bolsines, diferencias y cascada.

Todo el módulo son funciones puras DataFrame → DataFrame (testeadas en
tests/test_arqueo.py). Las convenciones contables del diario que asumen:

- Partida doble: las filas de un `mov` balancean Debe = Haber en ARS.
- Cobranzas (PG*): Debe = medio de pago recibido (caja en efectivo / MP /
  tarjeta), Haber = Deudores por venta. Los vueltos son Haber chicos a la
  propia caja dentro del mismo asiento.
- Alivios (ALV1): mueven efectivo entre cajas. El concepto trae el bolsín
  físico ("cierre caja 3 bol 23 prec 5886") y el barrido matutino
  buzón → puente REPITE ese mismo concepto — esa dupla es la conciliación.
- Diferencias (DIFC): sobrante = Debe a la caja / faltante = Haber a la caja,
  contra DESVIO DE CAJA (o AJUSTES Y REDONDEOS desde jul-2026). Los errores
  se corrigen con asientos "Revierte..." y "Real/Oficial..." días después.
"""

from __future__ import annotations

import re

import numpy as np
import pandas as pd

from masmelos import config

# --- Parseo de conceptos --------------------------------------------------

# "bol 23 prec 5886", "Bol 912 Prec 9679", "bolsin 5 precinto 123"...
_RE_BOL = re.compile(r"bol\w*\.?\s*(\d+)", re.IGNORECASE)
_RE_PREC = re.compile(r"prec\w*\.?\s*(\d+)", re.IGNORECASE)
_RE_REVIERTE = re.compile(r"reviert", re.IGNORECASE)
_RE_CIERRE = re.compile(r"cierre", re.IGNORECASE)
_RE_APERTURA = re.compile(r"apertur", re.IGNORECASE)
_RE_SOBRANTE = re.compile(r"sobrante", re.IGNORECASE)
_RE_FALTANTE = re.compile(r"faltante", re.IGNORECASE)
_RE_REAL = re.compile(r"\b(real|oficial)\b", re.IGNORECASE)
_RE_PRUEBA = re.compile(r"prueba", re.IGNORECASE)


def extraer_bolsin(concepto: str) -> tuple[str | None, str | None]:
    """(número de bolsa, número de precinto) desde el texto libre, o Nones.

    "bolsines de apertura" matchea _RE_BOL sin número → devuelve None porque
    el grupo exige dígitos después de la palabra.
    """
    if not concepto:
        return None, None
    bol = _RE_BOL.search(concepto)
    prec = _RE_PREC.search(concepto)
    return (bol.group(1) if bol else None), (prec.group(1) if prec else None)


# --- Alivios (ALV1) --------------------------------------------------------

def clasificar_alivios(df: pd.DataFrame) -> pd.DataFrame:
    """Una fila por asiento ALV1 con origen → destino, bolsín y tipo.

    Tipos:
    - apertura: buzón → caja de venta (fondo fijo de $2.000)
    - cierre:   caja de venta → buzón, concepto "cierre..."
    - alivio:   caja de venta → buzón/puente, intermedio del día
    - barrido:  buzón → caja puente (a la mañana siguiente, repite el
                concepto del cierre original)
    - otro:     cualquier combinación no contemplada (se alerta aparte)

    `monto` lleva signo: los asientos "Revierte..." restan, así un bolsín
    revertido no queda colgado como pendiente eterno.
    """
    alv = df[df["comp"] == config.ARQUEO_COMP_ALIVIO]
    if alv.empty:
        return pd.DataFrame(columns=[
            "mov", "fecha", "ingreso", "concepto", "usuario",
            "origen_id", "origen", "destino_id", "destino",
            "monto", "bol", "prec", "tipo", "revierte",
        ])

    filas = []
    for mov, g in alv.groupby("mov"):
        debe = g[g["debe"] > 0]
        haber = g[g["haber"] > 0]
        concepto = str(g["concepto"].iloc[0])
        bol, prec = extraer_bolsin(concepto)
        revierte = bool(_RE_REVIERTE.search(concepto))
        monto = float(g["debe"].sum())
        origen_id = int(haber["cuenta_id"].iloc[0]) if len(haber) else None
        destino_id = int(debe["cuenta_id"].iloc[0]) if len(debe) else None
        # En una reversión el flujo físico es el inverso al asentado.
        if revierte:
            origen_id, destino_id = destino_id, origen_id
            monto = -monto

        if destino_id in config.ARQUEO_CAJAS_VENTA and origen_id == config.ARQUEO_CTA_BUZON:
            tipo = "apertura" if _RE_APERTURA.search(concepto) else "otro"
        elif origen_id in config.ARQUEO_CAJAS_VENTA:
            tipo = "cierre" if _RE_CIERRE.search(concepto) else "alivio"
        elif origen_id == config.ARQUEO_CTA_BUZON and destino_id == config.ARQUEO_CTA_PUENTE:
            tipo = "barrido"
        else:
            tipo = "otro"

        filas.append({
            "mov": mov, "fecha": g["fecha"].iloc[0], "ingreso": g["ingreso"].iloc[0],
            "concepto": concepto, "usuario": g["usuario"].iloc[0],
            "origen_id": origen_id,
            "origen": haber["cuenta"].iloc[0] if len(haber) else "",
            "destino_id": destino_id,
            "destino": debe["cuenta"].iloc[0] if len(debe) else "",
            "monto": monto, "bol": bol, "prec": prec,
            "tipo": tipo, "revierte": revierte,
        })
    return pd.DataFrame(filas)


def conciliar_bolsines(df: pd.DataFrame) -> pd.DataFrame:
    """Concilia cada bolsín físico: lo que entró al buzón vs lo que salió.

    Cada bolsa precintada genera dos patas: caja → buzón al cerrar (puede
    venir en tranches) y buzón → puente al contarla a la mañana siguiente
    (también en tranches, mismo concepto). Agrupamos por (bolsa, precinto) y
    comparamos sumas.

    Toma el diario CRUDO (no la tabla de alivios) porque las correcciones de
    conteo de una bolsa se cargan de dos formas que hay que netear contra la
    entrada al buzón:
    - ALV1 caja↔buzón "diferencia conteo ... mal pasado al sistema"
    - DIFC caja↔buzón "diferencia conteo bol N prec N"
    Ambas se modelan igual: el flujo NETO sobre el buzón (Debe − Haber) de
    todo asiento que referencia el bolsín y NO es el barrido. Así una bolsa ya
    corregida deja de figurar MONTO_DISTINTO y no manda a recontar de gusto.

    Estados:
    - CONCILIADO:     entró y salió por el mismo monto (ya neteadas correcciones).
    - PENDIENTE:      entró y todavía no salió, pero no hubo ningún barrido
                      posterior a su fecha — es lo normal para el último día.
    - SIN_BARRIDO:    entró, hubo barridos posteriores, y esta bolsa no salió.
    - MONTO_DISTINTO: entrada y salida difieren aun después de las correcciones.
    - SIN_CIERRE:     salió del buzón una bolsa cuyo cierre nunca se registró.
    """
    cols = ["bol", "prec", "caja", "fecha_cierre", "fecha_barrido",
            "monto_entrada", "monto_salida", "diferencia", "estado"]
    # Solo ALV1/DIFC mueven bolsines contra el buzón.
    rel = df[
        df["comp"].isin({config.ARQUEO_COMP_ALIVIO, config.ARQUEO_COMP_DIFERENCIA})
    ]
    if rel.empty:
        return pd.DataFrame(columns=cols)

    filas = []
    for _, g in rel.groupby("mov"):
        concepto = str(g["concepto"].iloc[0])
        bol, prec = extraer_bolsin(concepto)
        if not (bol and prec):
            continue
        # Las aperturas usan bolsines propios ($2.000 buzón → caja): no
        # participan de la conciliación del efectivo cerrado.
        if _RE_APERTURA.search(concepto):
            continue
        buz = g[g["cuenta_id"] == config.ARQUEO_CTA_BUZON]
        if buz.empty:
            continue
        delta_buz = float(buz["debe"].sum() - buz["haber"].sum())  # + = entra al buzón
        otras = g[g["cuenta_id"] != config.ARQUEO_CTA_BUZON]
        # El barrido es el único movimiento buzón → caja puente.
        es_barrido = bool((otras["cuenta_id"] == config.ARQUEO_CTA_PUENTE).any())
        filas.append({
            "bol": bol, "prec": prec, "fecha": g["fecha"].iloc[0],
            "delta_buz": delta_buz, "es_barrido": es_barrido,
            "caja": otras["cuenta"].iloc[0] if len(otras) else "",
        })
    if not filas:
        return pd.DataFrame(columns=cols)

    mov_df = pd.DataFrame(filas)
    ultimo_barrido = mov_df.loc[mov_df["es_barrido"], "fecha"].max()

    out = []
    for (bol, prec), g in mov_df.groupby(["bol", "prec"]):
        entrada_rows = g[~g["es_barrido"]]
        barrido_rows = g[g["es_barrido"]]
        monto_ent = float(entrada_rows["delta_buz"].sum())
        monto_sal = float(-barrido_rows["delta_buz"].sum())  # sale del buzón: Haber
        fecha_cierre = entrada_rows["fecha"].min() if len(entrada_rows) else pd.NaT
        # Caja: la del cierre (entrada), no la caja puente del barrido.
        caja = entrada_rows["caja"].iloc[0] if len(entrada_rows) else (
            barrido_rows["caja"].iloc[0] if len(barrido_rows) else "")

        if monto_ent and not monto_sal:
            if pd.isna(ultimo_barrido) or fecha_cierre >= ultimo_barrido:
                estado = "PENDIENTE"
            else:
                estado = "SIN_BARRIDO"
        elif monto_sal and not monto_ent:
            estado = "SIN_CIERRE"
        elif abs(monto_ent - monto_sal) <= 0.01:
            estado = "CONCILIADO"
        else:
            estado = "MONTO_DISTINTO"

        out.append({
            "bol": bol, "prec": prec, "caja": caja,
            "fecha_cierre": fecha_cierre,
            "fecha_barrido": barrido_rows["fecha"].max() if len(barrido_rows) else pd.NaT,
            "monto_entrada": monto_ent, "monto_salida": monto_sal,
            "diferencia": monto_ent - monto_sal, "estado": estado,
        })
    return pd.DataFrame(out, columns=cols).sort_values(
        ["fecha_cierre", "caja"]).reset_index(drop=True)


# --- Arqueo por caja × día --------------------------------------------------

def arqueo_caja_dia(df: pd.DataFrame) -> pd.DataFrame:
    """Descompone el movimiento diario de cada caja de venta.

    La identidad que tiene que cumplirse si el día se registró completo:
        apertura + cobrado_efectivo − vueltos − alivios − cierres
        + diferencia_registrada + otros = neto_dia = 0

    Un neto ≠ 0 no es plata que falta: es un día contablemente incompleto
    (cierre sin asentar, diferencia mal imputada, corrección pendiente) y es
    exactamente lo que hoy genera las cadenas de reversiones manuales.
    """
    caja_rows = df[df["cuenta_id"].isin(config.ARQUEO_CAJAS_VENTA)].copy()
    cols = ["fecha", "cuenta_id", "caja", "apertura", "cobrado_efectivo",
            "vueltos", "alivios", "cierres", "diferencia_registrada", "otros",
            "neto_dia", "n_cobranzas", "cajera", "estado"]
    if caja_rows.empty:
        return pd.DataFrame(columns=cols)

    es_cobranza = caja_rows["comp"].isin(config.ARQUEO_COMP_COBRANZA)
    es_alivio = caja_rows["comp"] == config.ARQUEO_COMP_ALIVIO
    es_difc = caja_rows["comp"] == config.ARQUEO_COMP_DIFERENCIA
    es_cierre = caja_rows["concepto"].str.contains(_RE_CIERRE, na=False)
    es_apertura = caja_rows["concepto"].str.contains(_RE_APERTURA, na=False)
    neto = caja_rows["debe"] - caja_rows["haber"]

    caja_rows = caja_rows.assign(
        _apertura=np.where(es_alivio & es_apertura, neto, 0.0),
        _cobrado=np.where(es_cobranza, caja_rows["debe"], 0.0),
        _vueltos=np.where(es_cobranza, caja_rows["haber"], 0.0),
        _cierres=np.where(es_alivio & es_cierre & ~es_apertura, -neto, 0.0),
        _alivios=np.where(es_alivio & ~es_cierre & ~es_apertura, -neto, 0.0),
        _difc=np.where(es_difc, neto, 0.0),
        _otros=np.where(~es_cobranza & ~es_alivio & ~es_difc, neto, 0.0),
        _neto=neto,
        _es_cobranza=es_cobranza,
        # Para contar recibos (asientos), no renglones: los vueltos y patas
        # extra de un mismo recibo no deben inflar la cuenta.
        _mov_cobranza=caja_rows["mov"].where(es_cobranza),
    )

    def _cajera(g: pd.DataFrame) -> str:
        cob = g[g["_es_cobranza"] & (g["usuario"] != "")]
        return cob["usuario"].mode().iloc[0] if len(cob) else ""

    agg = (
        caja_rows.groupby(["fecha", "cuenta_id"])
        .agg(
            apertura=("_apertura", "sum"),
            cobrado_efectivo=("_cobrado", "sum"),
            vueltos=("_vueltos", "sum"),
            alivios=("_alivios", "sum"),
            cierres=("_cierres", "sum"),
            diferencia_registrada=("_difc", "sum"),
            otros=("_otros", "sum"),
            neto_dia=("_neto", "sum"),
            n_cobranzas=("_mov_cobranza", "nunique"),
        )
        .reset_index()
    )
    cajeras = (
        caja_rows.groupby(["fecha", "cuenta_id"])
        .apply(_cajera, include_groups=False)
        .rename("cajera")
        .reset_index()
    )
    agg = agg.merge(cajeras, on=["fecha", "cuenta_id"], how="left")
    agg["cajera"] = agg["cajera"].fillna("")
    agg["caja"] = agg["cuenta_id"].map(config.ARQUEO_CAJAS_VENTA)

    # REVISAR = el día no cerró en cero (falta un cierre/alivio o hay una
    # corrección pendiente). Una diferencia física bien asentada deja neto=0
    # y NO ensucia el estado; el tamaño de la diferencia lo evalúa alertas.py
    # a partir de los DIFC clasificados (no de la suma bruta, que incluye
    # reversiones de días anteriores y daría falsos REVISAR en la ventana móvil).
    agg["estado"] = np.where(
        agg["neto_dia"].abs() <= config.ARQUEO_UMBRAL_NETO_DIA, "OK", "REVISAR")
    return agg[cols].sort_values(["fecha", "caja"]).reset_index(drop=True)


# --- Diferencias (DIFC) -----------------------------------------------------

def clasificar_difc(df: pd.DataFrame) -> pd.DataFrame:
    """Cada asiento DIFC clasificado: original / revierte / real / prueba.

    `efecto` es el impacto sobre la caja (positivo = sobrante). El neto por
    caja de la ventana ya descuenta las reversiones — es la diferencia REAL
    que sobrevive después de que tesorería limpió los errores de conteo.

    `inconsistente` marca asientos cuyo concepto dice "sobrante"/"faltante"
    al revés del signo contable (pasó 2 veces en la semana de calibración).
    """
    difc = df[df["comp"] == config.ARQUEO_COMP_DIFERENCIA]
    cols = ["mov", "fecha", "ingreso", "caja", "cuenta_id", "contrapartida",
            "tipo", "efecto", "concepto", "usuario", "inconsistente"]
    if difc.empty:
        return pd.DataFrame(columns=cols)

    ctas_diferencia = {config.ARQUEO_CTA_DESVIO, config.ARQUEO_CTA_AJUSTES}
    filas = []
    for mov, g in difc.groupby("mov"):
        pata_caja = g[~g["cuenta_id"].isin(ctas_diferencia)]
        pata_dif = g[g["cuenta_id"].isin(ctas_diferencia)]
        # Asientos DIFC atípicos (ej. corrección banco contra banco): la
        # "caja" es la primera pata no-diferencia que encontremos.
        if pata_caja.empty:
            pata_caja = g.iloc[[0]]
        concepto = str(g["concepto"].iloc[0])
        efecto = float(pata_caja["debe"].sum() - pata_caja["haber"].sum())

        # 'prueba' ANTES que 'revierte': los reverts de Sigma copian el
        # concepto original textual, así que "Revierte ajuste prueba..."
        # tiene ambas palabras. Si 'revierte' ganara, la reversión entraría
        # al neto mientras su original (prueba) queda excluido → diferencia
        # fantasma. Evaluando 'prueba' primero, ambas quedan fuera del neto.
        if _RE_PRUEBA.search(concepto):
            tipo = "prueba"
        elif _RE_REVIERTE.search(concepto):
            tipo = "revierte"
        elif _RE_REAL.search(concepto):
            tipo = "real"
        else:
            tipo = "original"

        dice_sobrante = bool(_RE_SOBRANTE.search(concepto))
        dice_faltante = bool(_RE_FALTANTE.search(concepto))
        inconsistente = (
            tipo in ("original", "real")
            and ((dice_sobrante and not dice_faltante and efecto < 0)
                 or (dice_faltante and not dice_sobrante and efecto > 0))
        )

        filas.append({
            "mov": mov, "fecha": g["fecha"].iloc[0], "ingreso": g["ingreso"].iloc[0],
            "caja": pata_caja["cuenta"].iloc[0],
            "cuenta_id": int(pata_caja["cuenta_id"].iloc[0]),
            "contrapartida": pata_dif["cuenta"].iloc[0] if len(pata_dif) else "",
            "tipo": tipo, "efecto": efecto, "concepto": concepto,
            "usuario": g["usuario"].iloc[0], "inconsistente": inconsistente,
        })
    return pd.DataFrame(filas, columns=cols).sort_values("ingreso").reset_index(drop=True)


def resumen_difc(eventos: pd.DataFrame) -> pd.DataFrame:
    """Diferencia final por caja: lo que quedó después de las correcciones."""
    if eventos.empty:
        return pd.DataFrame(columns=["caja", "neto_final", "n_asientos",
                                     "n_reversiones", "bruto_movido"])
    sin_pruebas = eventos[eventos["tipo"] != "prueba"]
    out = (
        sin_pruebas.groupby("caja")
        .agg(
            neto_final=("efecto", "sum"),
            n_asientos=("mov", "count"),
            n_reversiones=("tipo", lambda s: int((s == "revierte").sum())),
            bruto_movido=("efecto", lambda s: float(s.abs().sum())),
        )
        .reset_index()
        .sort_values("neto_final")
    )
    return out.reset_index(drop=True)


# --- Cascada de consolidación ------------------------------------------------

def cascada_diaria(df: pd.DataFrame) -> pd.DataFrame:
    """Flujo diario y saldo RELATIVO de buzón / puente / fuerte / etc.

    El export no trae saldos iniciales, así que `saldo_relativo` arranca en
    cero al inicio de la ventana: sirve para ver cuánto quedó durmiendo cada
    noche RESPECTO del arranque, no el efectivo absoluto en la caja fuerte.
    """
    rows = df[df["cuenta_id"].isin(config.ARQUEO_CAJAS_CASCADA)].copy()
    cols = ["fecha", "cuenta_id", "cuenta", "entradas", "salidas",
            "neto_dia", "saldo_relativo"]
    if rows.empty:
        return pd.DataFrame(columns=cols)
    agg = (
        rows.groupby(["fecha", "cuenta_id"])
        .agg(entradas=("debe", "sum"), salidas=("haber", "sum"))
        .reset_index()
    )
    agg["cuenta"] = agg["cuenta_id"].map(config.ARQUEO_CAJAS_CASCADA)
    agg["neto_dia"] = agg["entradas"] - agg["salidas"]
    agg = agg.sort_values(["cuenta_id", "fecha"])
    agg["saldo_relativo"] = agg.groupby("cuenta_id")["neto_dia"].cumsum()
    return agg[cols].sort_values(["fecha", "cuenta"]).reset_index(drop=True)


# --- Caja USD -----------------------------------------------------------------

def movimientos_usd(df: pd.DataFrame) -> pd.DataFrame:
    """Movimientos de la caja dólar, arqueados por la columna Nominal (USD)."""
    rows = df[df["cuenta_id"] == config.ARQUEO_CTA_USD].copy()
    cols = ["fecha", "concepto", "usuario", "usd", "ars", "cotizacion",
            "saldo_usd_relativo"]
    if rows.empty:
        return pd.DataFrame(columns=cols)
    rows["usd"] = rows["debe_nominal"] - rows["haber_nominal"]
    rows["ars"] = rows["debe"] - rows["haber"]
    rows["cotizacion"] = np.where(rows["usd"] != 0, rows["ars"] / rows["usd"], np.nan)
    rows = rows.sort_values("ingreso")
    rows["saldo_usd_relativo"] = rows["usd"].cumsum()
    return rows[cols].reset_index(drop=True)


# --- Medios de pago -------------------------------------------------------------

def medios_pago_dia(df: pd.DataFrame) -> pd.DataFrame:
    """Cobranza diaria por medio de pago (solo comprobantes PG).

    El arqueo físico concilia únicamente el efectivo, pero el tesorero
    necesita el cuadro completo para dimensionar qué NO pasa por las cajas
    (MP y tarjetas van directo a sus cuentas, aunque compartan el recibo).
    """
    cob = df[df["comp"].isin(config.ARQUEO_COMP_COBRANZA)].copy()
    cols = ["fecha", "efectivo", "mercado_pago", "tarjetas", "cheques", "total"]
    if cob.empty:
        return pd.DataFrame(columns=cols)
    # Efectivo = cajas de venta + cualquier caja que un PG pueda debitar
    # (PG11 cobra en CAJA 1 PIBA y CAJA ADMINISTRACION, que no son cajas de
    # salón). Sin esto el cuadro subestima el efectivo y el total ~3%.
    ctas_efectivo = set(config.ARQUEO_CAJAS_VENTA).union(
        *config.ARQUEO_PG_CAJA.values())
    neto = cob["debe"] - cob["haber"]
    cob = cob.assign(
        _efectivo=np.where(cob["cuenta_id"].isin(ctas_efectivo), neto, 0.0),
        _mp=np.where(cob["cuenta_id"].isin(config.ARQUEO_CTAS_MP), neto, 0.0),
        _tarjeta=np.where(cob["cuenta_id"].isin(config.ARQUEO_CTAS_TARJETA), neto, 0.0),
        _cheque=np.where(cob["cuenta_id"].isin(config.ARQUEO_CTAS_CHEQUE), neto, 0.0),
    )
    agg = (
        cob.groupby("fecha")
        .agg(
            efectivo=("_efectivo", "sum"),
            mercado_pago=("_mp", "sum"),
            tarjetas=("_tarjeta", "sum"),
            cheques=("_cheque", "sum"),
        )
        .reset_index()
    )
    agg["total"] = agg[["efectivo", "mercado_pago", "tarjetas", "cheques"]].sum(axis=1)
    return agg[cols]


# --- Asientos gemelos -------------------------------------------------------------

def detectar_gemelos(df: pd.DataFrame) -> pd.DataFrame:
    """Asientos idénticos (mismo comp, cuentas y monto) cargados casi juntos.

    Caso testigo que motivó el chequeo: dos MOV2 "Retiro a central" de
    $30.531.730 con 39 segundos de diferencia (01/07/2026) sin reversión.
    O son dos bolsos de monto exactamente igual o uno está duplicado — solo
    el conteo físico lo resuelve, por eso se alerta en vez de corregirse.

    Se excluye DIFC (sus reversiones son pares idénticos intencionales).
    """
    cols = ["mov_1", "mov_2", "fecha", "comp", "concepto", "monto",
            "segundos_entre", "usuario"]
    candidatos = df[
        (df["comp"] != config.ARQUEO_COMP_DIFERENCIA)
        & ~df["concepto"].str.contains(_RE_REVIERTE, na=False)
    ]
    if candidatos.empty:
        return pd.DataFrame(columns=cols)

    firmas = []
    for mov, g in candidatos.groupby("mov"):
        monto = float(g["debe"].sum())
        if monto < config.ARQUEO_UMBRAL_GEMELOS:
            continue
        firma = (
            g["comp"].iloc[0],
            round(monto, 2),
            frozenset(zip(g["cuenta_id"], np.sign(g["debe"] - g["haber"]))),
        )
        firmas.append({
            "mov": mov, "firma": firma, "ingreso": g["ingreso"].iloc[0],
            "fecha": g["fecha"].iloc[0], "comp": g["comp"].iloc[0],
            "concepto": g["concepto"].iloc[0], "monto": monto,
            "usuario": g["usuario"].iloc[0],
        })
    if not firmas:
        return pd.DataFrame(columns=cols)

    fdf = pd.DataFrame(firmas).sort_values("ingreso")
    pares = []
    for _, g in fdf.groupby("firma"):
        if len(g) < 2:
            continue
        for (_, a), (_, b) in zip(g.iterrows(), g.iloc[1:].iterrows()):
            delta = (b["ingreso"] - a["ingreso"]).total_seconds()
            if delta <= config.ARQUEO_GEMELOS_VENTANA_SEG:
                pares.append({
                    "mov_1": a["mov"], "mov_2": b["mov"], "fecha": a["fecha"],
                    "comp": a["comp"], "concepto": a["concepto"],
                    "monto": a["monto"], "segundos_entre": delta,
                    "usuario": a["usuario"],
                })
    return pd.DataFrame(pares, columns=cols)
