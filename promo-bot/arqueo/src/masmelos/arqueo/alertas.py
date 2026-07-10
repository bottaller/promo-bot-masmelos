"""Generación de alertas accionables del arqueo.

Cada alerta termina en un "qué hacer" concreto — es la regla del proyecto:
si un hallazgo no dispara una acción, no va al informe. Severidades:

- ROJA:     hay que actuar hoy (plata posiblemente mal contada o sin conciliar).
- AMARILLA: error de proceso/registración a corregir esta semana.
- INFO:     contexto que el tesorero tiene que conocer, sin acción inmediata.
"""

from __future__ import annotations

import pandas as pd

from masmelos import config
from masmelos.arqueo import parse

_COLS = ["severidad", "fecha", "ambito", "monto", "detalle", "que_hacer"]


def _alerta(severidad, fecha, ambito, monto, detalle, que_hacer) -> dict:
    return {
        "severidad": severidad, "fecha": fecha, "ambito": ambito,
        "monto": monto, "detalle": detalle, "que_hacer": que_hacer,
    }


def generar_alertas(
    df: pd.DataFrame,
    arqueo: pd.DataFrame,
    bolsines: pd.DataFrame,
    difc: pd.DataFrame,
    gemelos: pd.DataFrame,
    alivios: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Consolida todas las alertas de la ventana, ordenadas por severidad."""
    alertas: list[dict] = []

    # 1. Asientos que no balancean: el export no es confiable ese día.
    desb = parse.asientos_desbalanceados(df)
    for _, r in desb.iterrows():
        alertas.append(_alerta(
            "ROJA", pd.NaT, f"Asiento {int(r['mov'])}", r["desbalance"],
            "Asiento con Debe ≠ Haber — export cortado o problema en Sigma.",
            "Re-exportar el diario y verificar el asiento en Sigma antes de "
            "confiar en el arqueo de ese día.",
        ))

    # 2. Cajas de venta que no cierran contablemente en cero.
    for _, r in arqueo[arqueo["neto_dia"].abs() > config.ARQUEO_UMBRAL_NETO_DIA].iterrows():
        alertas.append(_alerta(
            "ROJA", r["fecha"], r["caja"], r["neto_dia"],
            f"La caja no cerró en cero (neto {r['neto_dia']:+,.2f}): falta el "
            "cierre, un alivio, o hay una diferencia sin asentar/revertir.",
            "Revisar los asientos del día de esa caja en Sigma y completar lo "
            "que falte. Si es una diferencia real, asentarla por DIFC contra "
            "DESVIO DE CAJA.",
        ))

    # 3. Diferencias de arqueo grandes. Se alerta por asiento DIFC que declara
    #    una diferencia FÍSICA (original/real): las reversiones ("Revierte...")
    #    son limpieza administrativa de errores previos y NO mandan a recontar
    #    nada — usar la suma bruta del día (diferencia_registrada) las incluiría
    #    y re-alertaría en cada corrida de la ventana móvil. La experiencia de
    #    la semana de calibración: casi todo lo de 5+ cifras fue error de conteo.
    fisicas = difc[
        difc["tipo"].isin(["original", "real"])
        & (difc["efecto"].abs() >= config.ARQUEO_UMBRAL_DIFERENCIA)
    ]
    for _, r in fisicas.iterrows():
        signo = "sobrante" if r["efecto"] > 0 else "faltante"
        alertas.append(_alerta(
            "ROJA", r["fecha"], r["caja"], r["efecto"],
            f"Diferencia de arqueo grande ({signo}): '{r['concepto']}'. El "
            "antecedente dice que casi siempre es un error de conteo o de carga.",
            f"Recontar la bolsa con quien la cargó ({r['usuario'] or 'ver Sigma'}) "
            "ANTES de que pasen días: hoy estas correcciones tardan 1-3 días "
            "y generan cadenas de reversiones.",
        ))

    # 4. Bolsines sin conciliar.
    problema = bolsines[bolsines["estado"].isin(["SIN_BARRIDO", "MONTO_DISTINTO", "SIN_CIERRE"])]
    for _, r in problema.iterrows():
        detalles = {
            "SIN_BARRIDO": "El bolsín entró al buzón y nunca se barrió a caja "
                           "puente aunque hubo barridos posteriores.",
            "MONTO_DISTINTO": "El monto barrido no coincide con el del cierre.",
            "SIN_CIERRE": "Se barrió un bolsín cuyo cierre nunca se registró.",
        }
        alertas.append(_alerta(
            "ROJA", r["fecha_cierre"], f"Bolsín bol {r['bol']} prec {r['prec']} ({r['caja']})",
            r["diferencia"], detalles[r["estado"]],
            "Ubicar la bolsa física por el precinto y contarla contra los dos "
            "asientos ALV1.",
        ))

    # 5. Asientos gemelos: posible duplicación de carga.
    for _, r in gemelos.iterrows():
        alertas.append(_alerta(
            "AMARILLA", r["fecha"], f"Movs {int(r['mov_1'])} y {int(r['mov_2'])}",
            r["monto"],
            f"Dos asientos {r['comp']} idénticos ('{r['concepto']}') con "
            f"{r['segundos_entre']:.0f} segundos de diferencia y sin reversión.",
            "Confirmar contra el conteo físico si fueron dos bolsos del mismo "
            "monto o una carga duplicada; si es duplicado, revertir uno.",
        ))

    # 6. Criterio de imputación de diferencias partido en dos cuentas.
    mal_ruteadas = difc[
        (difc["tipo"] != "prueba")
        & (difc["contrapartida"] != "")
        & (difc["contrapartida"].str.contains("AJUSTES", case=False, na=False))
    ]
    for _, r in mal_ruteadas.iterrows():
        alertas.append(_alerta(
            "AMARILLA", r["fecha"], r["caja"], r["efecto"],
            "Diferencia de arqueo imputada a AJUSTES Y REDONDEOS en vez de "
            "DESVIO DE CAJA — el criterio quedó partido según quién carga.",
            "Unificar el criterio con tesorería: TODA diferencia de arqueo va "
            "a DESVIO DE CAJA (501100006).",
        ))

    # 7. Conceptos que contradicen el signo contable.
    for _, r in difc[difc["inconsistente"]].iterrows():
        alertas.append(_alerta(
            "AMARILLA", r["fecha"], r["caja"], r["efecto"],
            f"El concepto dice una cosa y el asiento otra: '{r['concepto']}' "
            f"pero el efecto contable es {r['efecto']:+,.2f}.",
            "Confirmar con quien lo cargó cuál es el signo real y corregir el "
            "asiento (o el hábito de carga).",
        ))

    # 8. Cobranzas que debitan una caja que no corresponde al comprobante.
    cob = df[df["comp"].isin(config.ARQUEO_PG_CAJA) & (df["debe"] > 0)]
    cob_caja = cob[cob["cuenta_id"].isin(config.ARQUEO_CAJAS_VENTA)]
    for (comp, cuenta_id, fecha), g in cob_caja.groupby(["comp", "cuenta_id", "fecha"]):
        if cuenta_id not in config.ARQUEO_PG_CAJA[comp]:
            alertas.append(_alerta(
                "AMARILLA", fecha,
                f"{comp} → {config.ARQUEO_CAJAS_VENTA[cuenta_id]}",
                g["debe"].sum(),
                f"El comprobante {comp} debitó una caja que no es la suya "
                f"({len(g)} renglones).",
                "Verificar en Sigma si la cajera cobró desde el puesto "
                "equivocado; distorsiona el arqueo de las dos cajas.",
            ))

    # 9. Renglones raros en AJUSTES Y REDONDEOS (mediana histórica: $10).
    aj = df[
        (df["cuenta_id"] == config.ARQUEO_CTA_AJUSTES)
        & (df["comp"] != config.ARQUEO_COMP_DIFERENCIA)
    ]
    aj_grandes = aj[(aj["debe"] + aj["haber"]) > config.ARQUEO_UMBRAL_AJUSTE_RENGLON]
    for _, r in aj_grandes.iterrows():
        alertas.append(_alerta(
            "INFO", r["fecha"], f"AJUSTES Y REDONDEOS ({r['comp']})",
            r["debe"] - r["haber"],
            f"Renglón de ajuste inusualmente grande ('{r['concepto']}'): la "
            "mediana histórica de esta cuenta es ~$10.",
            "Mirar el asiento: un ajuste grande suele ser otra cosa disfrazada.",
        ))

    # 10. Asientos modificados después de creados que tocan cuentas de caja.
    ctas_caja = (
        set(config.ARQUEO_CAJAS_VENTA)
        | set(config.ARQUEO_CAJAS_CASCADA)
        | {config.ARQUEO_CTA_USD}
    )
    modif = df[df["ult_modif"].notna() & df["cuenta_id"].isin(ctas_caja)]
    for mov, g in modif.groupby("mov"):
        alertas.append(_alerta(
            "ROJA", g["fecha"].iloc[0], f"Asiento {int(mov)}",
            float(g["debe"].sum()),
            f"Asiento de caja modificado después de creado (últ. modif. "
            f"{g['ult_modif'].iloc[0]} por {g['ult_usuario'].iloc[0]}). El "
            "export no muestra QUÉ cambió.",
            "Pedir en Sigma el detalle del cambio y re-validar el arqueo de "
            "ese día.",
        ))

    # 11. Alivios ALV1 atípicos (tipo 'otro'): efectivo moviéndose fuera del
    #     circuito esperado apertura/cierre/alivio/barrido. No caen en la
    #     conciliación de bolsines, así que sin esta alerta serían invisibles.
    if alivios is not None and len(alivios):
        for _, r in alivios[alivios["tipo"] == "otro"].iterrows():
            alertas.append(_alerta(
                "AMARILLA", r["fecha"],
                f"ALV1 mov {int(r['mov'])}: {r['origen']} → {r['destino']}",
                r["monto"],
                f"Movimiento de efectivo fuera del circuito esperado "
                f"('{r['concepto']}').",
                "Verificar en Sigma que el movimiento sea legítimo (no es una "
                "apertura/cierre/alivio/barrido normal).",
            ))

    out = pd.DataFrame(alertas, columns=_COLS)
    if out.empty:
        return out
    orden = pd.Categorical(out["severidad"], categories=["ROJA", "AMARILLA", "INFO"], ordered=True)
    return out.assign(severidad=orden).sort_values(
        ["severidad", "fecha"]
    ).reset_index(drop=True)
