"""Control 2 — trazabilidad del efectivo: flujo por la cadena y fugas.

Sigue la plata desde que entra en efectivo hasta que sale del circuito de
custodia (cajas → buzón → puente → caja fuerte → destino). Todo movimiento
ENTRE cuentas de la cadena es flujo interno; todo movimiento HACIA una cuenta
fuera de la cadena es una SALIDA que hay que autorizar.

La idea de control (planteada por Renzo): un desvío interno se disfraza
mandando plata a "una cuenta cualquiera". Este módulo hace visible cada una de
esas salidas con monto, usuario y hora, clasificada por categoría (banco =
conciliable, retiro/USD/proveedores = autorizado, Skyceo = inter-empresa,
gastos o destino nuevo = revisar). Se construye solo con el diario — no
necesita archivos externos.
"""

from __future__ import annotations

import pandas as pd

from masmelos import config
from masmelos.arqueo import core


def _nodo(cuenta_id: int, cuenta: str) -> tuple[str, str]:
    """(node_id, etiqueta) de una cuenta. Precedencia: número → nombre →
    sucursal de baja → gastos → desconocido. Lo no mapeado conserva su nombre
    real y cae en 'revisar' (destino nuevo = señal de novedad)."""
    if cuenta_id in config.ARQUEO_FLUJO_NODO:
        return config.ARQUEO_FLUJO_NODO[cuenta_id]
    nombre = str(cuenta or "").strip().upper()
    if nombre in config.ARQUEO_DESTINO_NOMBRE:
        return config.ARQUEO_DESTINO_NOMBRE[nombre]
    # Sucursales dadas de baja: plata que se mueve ahí es una novedad a revisar.
    if any(s in nombre for s in config.ARQUEO_SUCURSALES_BAJA):
        return f"baja_{cuenta_id}", f"{cuenta} (sucursal baja)"
    if str(cuenta_id).startswith(config.ARQUEO_FLUJO_GASTOS_PREFIJOS):
        return "gastos", "Gastos"
    # Destino desconocido: nodo propio por cuenta (lo importante es que se vea).
    return f"otro_{cuenta_id}", (cuenta or f"Cuenta {cuenta_id}")


def _miembro(cuenta_id: int, cuenta: str, nodo: str, label: str) -> tuple[str, str]:
    """(member_id, etiqueta) — el nodo detallado de una cuenta. Solo difiere del
    grupo cuando la cuenta pertenece a un grupo expandible (ej. Caja 1 dentro de
    'Cajas 1–5'); si no, el miembro ES el grupo."""
    if nodo in config.ARQUEO_FLUJO_EXPANDIBLE and cuenta_id in config.ARQUEO_FLUJO_MIEMBRO:
        return config.ARQUEO_FLUJO_MIEMBRO[cuenta_id]
    return nodo, label


def construir_flujo(df: pd.DataFrame) -> dict:
    """Devuelve {nodos, edges, salidas} para el flujo del efectivo.

    - nodos: {id: {label, tipo}} — tipo custodia/destino.
    - edges: lista de {origen, destino, monto, clase}. clase 'chain' para
      flujo interno; para salidas, la categoría del destino.
    - salidas: DataFrame detalle de cada asiento que saca plata del circuito
      (fecha, hora, mov, origen, destino, categoria, monto, usuario, concepto).
      Es la base del árbol y del log de autorizaciones.
    """
    custodia_ids = {
        cid for cid, (nodo, _) in config.ARQUEO_FLUJO_NODO.items()
        if nodo in config.ARQUEO_FLUJO_CUSTODIA
    }

    edges: dict[tuple[str, str], float] = {}
    nodos: dict[str, dict] = {}
    salidas: list[dict] = []
    # Nivel MIEMBRO (para desplegar grupos en el flujo): edges e info por miembro.
    edges_m: dict[tuple[str, str], float] = {}
    mem_info: dict[str, dict] = {}

    def _reg_nodo(nid: str, label: str, tipo: str) -> None:
        if nid not in nodos:
            nodos[nid] = {"label": label, "tipo": tipo}

    def _reg_mem(mid: str, label: str, grupo: str, tipo: str) -> None:
        if mid not in mem_info:
            mem_info[mid] = {"label": label, "grupo": grupo, "tipo": tipo}

    # Un asiento cruza la FRONTERA del circuito según el neto de sus cuentas de
    # custodia (Σdebe − Σhaber):
    #   neto > 0  → ENTRÓ efectivo desde afuera. Cubre la cobranza física (PG) y
    #               los depósitos/transferencias que ingresan al banco (PAGC,
    #               echeq). Se suma como ENTRADA al/los nodo(s) de custodia
    #               debitados (solo importa el ancho del río, no se lista).
    #   neto < 0  → SALIÓ efectivo hacia afuera: pago, retiro, compra USD… y las
    #               anulaciones de cobranza EMBEBIDAS en un PG (caja→deudores).
    #               Se dibuja como río + salida "a revisar".
    #   neto ≈ 0  → movimiento INTERNO de la cadena (alivio/cierre/retiro entre
    #               cuentas de custodia). El vuelto de una cobranza (haber chico a
    #               la propia caja) queda dentro de un asiento neto>0 y no ensucia.
    # DIFC se excluye acá y se netea aparte (bloque de DESVÍO, más abajo): sin eso
    # cada faltante y su reversión se contarían BRUTOS (inflaba ~860× el neto).
    _TOL = 0.5
    entradas: dict[str, float] = {}
    entradas_m: dict[str, float] = {}

    def _entrada(cid: int, cuenta: str, monto: float) -> None:
        nodo, label = _nodo(cid, cuenta)
        entradas[nodo] = entradas.get(nodo, 0.0) + monto
        _reg_nodo(nodo, label, "custodia")
        mem, mlabel = _miembro(cid, cuenta, nodo, label)
        entradas_m[mem] = entradas_m.get(mem, 0.0) + monto
        _reg_mem(mem, mlabel, nodo, "custodia")

    mov_df = df[df["comp"] != config.ARQUEO_COMP_DIFERENCIA]
    for mov, g in mov_df.groupby("mov"):
        cust = g[g["cuenta_id"].isin(custodia_ids)]
        if cust.empty:
            continue
        neto = float(cust["debe"].sum() - cust["haber"].sum())

        # (1) Entró plata desde afuera → entrada prorrateada por el debe de cada
        #     cuenta de custodia debitada.
        if neto > _TOL:
            deb = cust[cust["debe"] > 0]
            base = float(deb["debe"].sum())
            if base > 0:
                for _, r in deb.iterrows():
                    _entrada(int(r["cuenta_id"]), r["cuenta"],
                             neto * float(r["debe"]) / base)
            continue

        # (2) Circuló/salió: hay cuenta(s) de custodia con haber (fuente). Río
        #     desde la fuente hacia cada debe — interno si el destino es de la
        #     cadena, salida a revisar si es de afuera. Es la lógica de siempre,
        #     ahora también para las anulaciones dentro de un PG (neto<0); el
        #     vuelto no llega acá porque su asiento es neto>0.
        sale = cust[cust["haber"] > 0]
        if sale.empty:
            continue
        origen_id = int(sale["cuenta_id"].iloc[0])
        o_nodo, o_label = _nodo(origen_id, sale["cuenta"].iloc[0])
        o_mem, o_mlabel = _miembro(origen_id, sale["cuenta"].iloc[0], o_nodo, o_label)
        _reg_nodo(o_nodo, o_label, "custodia")
        _reg_mem(o_mem, o_mlabel, o_nodo, "custodia")

        for _, d in g[g["debe"] > 0].iterrows():
            dst_id = int(d["cuenta_id"])
            d_nodo, d_label = _nodo(dst_id, d["cuenta"])
            if d_nodo == o_nodo:
                continue  # movimiento dentro del mismo grupo (tranches)
            es_chain = d_nodo in config.ARQUEO_FLUJO_CUSTODIA
            _reg_nodo(d_nodo, d_label, "custodia" if es_chain else "destino")
            clase = "chain" if es_chain else config.ARQUEO_DESTINO_CAT.get(d_nodo, "revisar")
            edges[(o_nodo, d_nodo)] = edges.get((o_nodo, d_nodo), 0.0) + float(d["debe"])
            d_mem, d_mlabel = _miembro(dst_id, d["cuenta"], d_nodo, d_label)
            _reg_mem(d_mem, d_mlabel, d_nodo, "custodia" if es_chain else "destino")
            if d_mem != o_mem:
                edges_m[(o_mem, d_mem)] = edges_m.get((o_mem, d_mem), 0.0) + float(d["debe"])

            # Al árbol: las salidas externas (para revisar) + los movimientos a
            # bancos (depósitos y transferencias banco↔banco, categoría
            # 'conciliable'), para que la lista sea completa por secciones.
            es_banco = d_nodo in {"banco_santander", "banco_supervielle"}
            if (not es_chain) or es_banco:
                # cuenta_asociada nombra la contraparte (proveedor). Solo está
                # poblada en pagos a proveedores; en el resto queda vacía.
                asociado = str(d.get("cuenta_asociada", "") or "").strip()
                salidas.append({
                    "fecha": g["fecha"].iloc[0], "ingreso": g["ingreso"].iloc[0],
                    "mov": int(mov), "origen": o_label, "destino_id": d_nodo,
                    "destino": d_label,
                    "categoria": "conciliable" if es_banco else clase,
                    "monto": float(d["debe"]),
                    "usuario": g["usuario"].iloc[0], "concepto": str(g["concepto"].iloc[0]),
                    "asociado": asociado,
                })

    # DESVÍO DE CAJA: no se dibuja el bruto de las DIFC (faltantes + reversiones
    # inflan ~860× la cifra); se muestra el NETO por caja — la diferencia real
    # que reporta Control 1 (resumen_difc) — como una pequeña salida 'ok'.
    difc_ev = core.clasificar_difc(df)
    if not difc_ev.empty:
        fisicas = difc_ev[difc_ev["tipo"] != "prueba"]
        for cid, ge in fisicas.groupby("cuenta_id"):
            neto = float(ge["efecto"].sum())
            if abs(neto) < 0.5:
                continue
            o_nodo, o_label = _nodo(int(cid), ge["caja"].iloc[0])
            # Solo diferencias de arqueo de CAJAS de custodia (no bancos/skyceo).
            if o_nodo not in config.ARQUEO_FLUJO_CUSTODIA:
                continue
            edges[(o_nodo, "desvio")] = edges.get((o_nodo, "desvio"), 0.0) + abs(neto)
            _reg_nodo(o_nodo, o_label, "custodia")
            _reg_nodo("desvio", "Desvío de caja", "destino")
            o_mem, o_mlabel = _miembro(int(cid), ge["caja"].iloc[0], o_nodo, o_label)
            edges_m[(o_mem, "desvio")] = edges_m.get((o_mem, "desvio"), 0.0) + abs(neto)
            _reg_mem(o_mem, o_mlabel, o_nodo, "custodia")
            _reg_mem("desvio", "Desvío de caja", "desvio", "destino")
            # y al árbol también (una fila neteada por caja; el detalle
            # asiento-por-asiento está en la hoja Diferencias del Excel).
            ult = ge.sort_values("ingreso").iloc[-1]
            salidas.append({
                "fecha": ult["fecha"], "ingreso": ult["ingreso"], "mov": int(ult["mov"]),
                "origen": o_label, "destino_id": "desvio", "destino": "Desvío de caja",
                "categoria": "ok", "monto": abs(neto), "usuario": ult["usuario"],
                "concepto": ("sobrante" if neto > 0 else "faltante") + " neto de arqueo",
                "asociado": "",
            })

    def _clase(d: str) -> str:
        return ("chain" if d in config.ARQUEO_FLUJO_CUSTODIA
                else config.ARQUEO_DESTINO_CAT.get(d, "revisar"))

    edge_list = [{"origen": o, "destino": d, "monto": m, "clase": _clase(d)}
                 for (o, d), m in edges.items()]
    # Detalle a nivel miembro: para desplegar grupos (clase por el grupo del destino).
    edges_m_list = [
        {"origen": o, "destino": d, "monto": m,
         "clase": _clase(mem_info.get(d, {}).get("grupo", d))}
        for (o, d), m in edges_m.items()
    ]
    detalle = {
        "miembros": mem_info,        # member_id → {label, grupo, tipo}
        "edges_m": edges_m_list,
        "entradas_m": entradas_m,
        "grupos_label": {g[0]: g[1] for g in config.ARQUEO_FLUJO_NODO.values()},
    }
    sal_df = pd.DataFrame(salidas)
    if not sal_df.empty:
        sal_df = sal_df.sort_values("monto", ascending=False).reset_index(drop=True)
    return {"nodos": nodos, "edges": edge_list, "entradas": entradas,
            "salidas": sal_df, "detalle": detalle}


def resumen_salidas(salidas: pd.DataFrame) -> pd.DataFrame:
    """Total por destino, con su categoría — para las tarjetas de arriba."""
    cols = ["destino", "categoria", "monto", "n"]
    if salidas.empty:
        return pd.DataFrame(columns=cols)
    out = (
        salidas.groupby(["destino_id", "destino", "categoria"])
        .agg(monto=("monto", "sum"), n=("mov", "count"))
        .reset_index()
        .drop(columns="destino_id")
        .sort_values("monto", ascending=False)
    )
    return out[cols].reset_index(drop=True)


def construir_flujo_usd(df: pd.DataFrame) -> dict:
    """Mini-flujo de la caja en dólares — "Seguí los dólares".

    Espeja "Seguí la plata" pero en USD, usando las columnas *Nominal* y solo las
    cuentas de config.ARQUEO_CTAS_USD. Sigue el recorrido típico:
        compra (pesos → USD) → Caja Dólar Tesorería (006) → Caja Dolares (005)
    y una venta (USD → pesos) si la hubiera. Clasifica cada asiento que toca una
    caja dólar:
      - dos cajas dólar (una entrega, otra recibe) → TRANSFERENCIA entre cajas.
      - una caja recibe (Nominal al Debe), sin otra caja → COMPRA (viene de pesos).
      - una caja entrega (Nominal al Haber), sin otra caja → VENTA (va a pesos).

    Devuelve {activo, nodos, edges, movimientos, saldo}:
      - activo: hubo algún movimiento de USD en la ventana.
      - nodos: {node_id -> {label, tipo}} — tipo 'externo' (compra/venta) o 'caja'.
      - edges: [{origen, destino, usd}] sumados por par.
      - movimientos: [{fecha, concepto, usuario, origen, destino, usd, cotizacion}].
      - saldo: {node_id -> Δ USD en la ventana} (lo que entró − lo que salió de cada caja).
    """
    ctas = config.ARQUEO_CTAS_USD
    COMPRA, VENTA = "compra", "venta"
    dol = df[df["cuenta_id"].isin(ctas)]
    activo = not dol.empty and float(
        dol["debe_nominal"].abs().sum() + dol["haber_nominal"].abs().sum()) > 0.5
    if not activo:
        return {"activo": False, "nodos": {}, "edges": [], "movimientos": [], "saldo": {}}

    edges: dict[tuple[str, str], float] = {}
    movimientos: list[dict] = []
    saldo: dict[str, float] = {}

    def _mov(fecha, concepto, usuario, o_lbl, d_lbl, usd, ars):
        movimientos.append({
            "fecha": fecha, "concepto": concepto, "usuario": usuario,
            "origen": o_lbl, "destino": d_lbl, "usd": round(usd, 2),
            "cotizacion": round(abs(ars) / usd, 2) if usd else None,
        })

    for _mov_id, g in df.groupby("mov"):
        gd = g[g["cuenta_id"].isin(ctas)]
        recibe = [(int(r.cuenta_id), float(r.debe_nominal), float(r.debe))
                  for r in gd.itertuples() if r.debe_nominal > 0]
        entrega = [(int(r.cuenta_id), float(r.haber_nominal), float(r.haber))
                   for r in gd.itertuples() if r.haber_nominal > 0]
        if not recibe and not entrega:
            continue
        fecha = g["fecha"].iloc[0]
        concepto = str(g["concepto"].iloc[0])
        usuario = str(g["usuario"].iloc[0])
        for cid, u, _a in recibe:
            saldo[str(cid)] = saldo.get(str(cid), 0.0) + u
        for cid, u, _a in entrega:
            saldo[str(cid)] = saldo.get(str(cid), 0.0) - u

        if recibe and entrega:
            # Transferencia entre cajas dólar (ej. 006 → 005). En la práctica es 1→1
            # con montos iguales; si se partiera, el monto RECIBIDO reparte bien. El
            # origen textual es la caja que entrega (siempre una en estos asientos).
            o_cid = entrega[0][0]
            for (d_cid, d_u, d_ars) in recibe:
                edges[(str(o_cid), str(d_cid))] = edges.get((str(o_cid), str(d_cid)), 0.0) + d_u
                _mov(fecha, concepto, usuario, ctas[o_cid], ctas[d_cid], d_u, d_ars)
        elif recibe:
            for (d_cid, d_u, d_ars) in recibe:
                edges[(COMPRA, str(d_cid))] = edges.get((COMPRA, str(d_cid)), 0.0) + d_u
                _mov(fecha, concepto, usuario, "Compra USD", ctas[d_cid], d_u, d_ars)
        else:
            for (o_cid, o_u, o_ars) in entrega:
                edges[(str(o_cid), VENTA)] = edges.get((str(o_cid), VENTA), 0.0) + o_u
                _mov(fecha, concepto, usuario, ctas[o_cid], "Venta USD", o_u, o_ars)

    nodos: dict[str, dict] = {}
    if any(o == COMPRA for o, _ in edges):
        nodos[COMPRA] = {"label": "Compra USD", "tipo": "externo"}
    for cid, label in ctas.items():          # en el orden de config
        if str(cid) in saldo:
            nodos[str(cid)] = {"label": label, "tipo": "caja"}
    if any(d == VENTA for _, d in edges):
        nodos[VENTA] = {"label": "Venta USD", "tipo": "externo"}

    edge_list = [{"origen": o, "destino": d, "usd": round(m, 2)} for (o, d), m in edges.items()]
    return {"activo": True, "nodos": nodos, "edges": edge_list,
            "movimientos": movimientos, "saldo": {k: round(v, 2) for k, v in saldo.items()}}
