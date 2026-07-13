"""Render del Control 2 a un HTML autocontenido: flujo (Sankey) + árbol.

Genera un archivo que el tesorero/gerencia abre con doble-click (sin servidor,
sin dependencias), igual que el dashboard de clientes. El flujo muestra la
plata bajando por la cadena de custodia y saliendo hacia sus destinos; el
árbol lista cada salida del circuito con quién/cuándo/por qué, para tener en cuenta.

No usa variables de tema (es un archivo suelto en el navegador): los colores
van hardcodeados y sobrios.
"""

from __future__ import annotations

import html
import json
from pathlib import Path

import pandas as pd

from masmelos import config

# Columna de cada nodo. Ingresos a la izquierda (col 0): cajas de efectivo +
# Mercado Pago + tarjetas (por donde ENTRA la plata). Bancos en col 4 (un
# eslabón más), destinos en la última (col 5).
_COL = {"cajas": 0, "central": 0, "central_bis": 0, "tesoreria": 0,
        "administracion": 0, "mercadopago": 0, "tarjetas": 0,
        "buzon": 1, "puente": 2, "fuerte": 3,
        "banco_santander": 4, "banco_supervielle": 4}
_COL_DEST = 5
_COL_X = {0: 20, 1: 250, 2: 410, 3: 565, 4: 755, 5: 1010}
_COL_W = {0: 126, 1: 92, 2: 92, 3: 105, 4: 122, 5: 152}
_SVG_W = 1180

_CAT_LABEL = {
    "conciliable": "verificar extracto", "ok": "OK",
    "autorizado": "autorizado", "inter_empresa": "inter-empresa (Skyceo)",
    "revisar": "a considerar",
}
# Orden del árbol: primero lo que hay que mirar.
_CAT_ORDEN = {"revisar": 0, "inter_empresa": 1, "autorizado": 2, "conciliable": 3, "ok": 4}
# Secciones del árbol: categoría → (orden, título). El árbol es la lista COMPLETA
# de movimientos, dividida en control / bancos / ajustes.
_SECCION = {
    "revisar": (0, "Salidas del circuito — a considerar"),
    "inter_empresa": (0, "Salidas del circuito — a considerar"),
    "autorizado": (0, "Salidas del circuito — a considerar"),
    "conciliable": (1, "Movimientos a bancos (depósitos y transferencias)"),
    "ok": (2, "Ajustes de arqueo"),
}


def _clase_grupo(grupo: str) -> str:
    return ("chain" if grupo in config.ARQUEO_FLUJO_CUSTODIA
            else config.ARQUEO_DESTINO_CAT.get(grupo, "revisar"))


def _estado(detalle: dict, expandido: str) -> tuple[list[dict], list[dict], int]:
    """Arma un estado de render del flujo (nodos posicionados + edges) con el
    grupo `expandido` abierto en sus miembros (o "" para todo agrupado).

    Cada miembro se muestra como su propio nodo si su grupo está expandido; si
    no, colapsa en el nodo del grupo. Reusa `_layout` para posicionar.
    """
    mem = detalle["miembros"]
    glabel = detalle["grupos_label"]

    def disp(m):
        grupo = mem[m]["grupo"] if m in mem else m
        return m if grupo == expandido else grupo

    def label(did):
        return glabel.get(did) or mem.get(did, {}).get("label", did)

    nodos: dict[str, dict] = {}

    def _reg(did, tipo):
        nodos.setdefault(did, {"label": label(did), "tipo": tipo})

    entradas: dict[str, float] = {}
    for m, v in detalle["entradas_m"].items():
        did = disp(m)
        entradas[did] = entradas.get(did, 0.0) + v
        _reg(did, mem.get(m, {}).get("tipo", "custodia"))

    edges: dict[tuple[str, str], float] = {}
    for e in detalle["edges_m"]:
        od, dd = disp(e["origen"]), disp(e["destino"])
        if od == dd:
            continue
        edges[(od, dd)] = edges.get((od, dd), 0.0) + e["monto"]
        _reg(od, mem.get(e["origen"], {}).get("tipo", "custodia"))
        _reg(dd, mem.get(e["destino"], {}).get("tipo", "destino"))

    edge_list = [
        {"origen": o, "destino": d, "monto": m,
         "clase": _clase_grupo(mem[d]["grupo"] if d in mem else d)}
        for (o, d), m in edges.items()
    ]
    pos, alto = _layout({"nodos": nodos, "edges": edge_list, "entradas": entradas})

    # Marcas para el click: `exp` = grupo a abrir (nodo agrupado expandible);
    # `colapsar` = grupo a cerrar (nodo miembro de un grupo abierto).
    for n in pos:
        nid = n["id"]
        if nid in config.ARQUEO_FLUJO_EXPANDIBLE:
            n["exp"] = nid
        elif nid in mem and mem[nid]["grupo"] == expandido:
            n["colapsar"] = mem[nid]["grupo"]
    return pos, edge_list, alto


# Altura de nodo: piso para que entren dos líneas de texto, techo para que el
# más grande no reviente el alto. Entre medio, proporcional al monto → el
# tamaño del nodo ES la magnitud (Sankey de verdad, no cajitas iguales).
_MINH, _MAXH, _TOP, _GAP = 34, 96, 20, 14


def _bary_order(cols: dict[int, list[str]], edges: list[dict],
                amt: dict[str, float]) -> dict[int, list[str]]:
    """Reordena cada columna por baricentro (posición promedio de sus vecinos)
    para minimizar el cruce de ríos. Varias pasadas alternadas hasta estabilizar;
    desempata por monto. Los nodos sin conexión conservan su lugar."""
    nb: dict[str, list[tuple[str, float]]] = {}
    for e in edges:
        o, d, m = e["origen"], e["destino"], e["monto"]
        nb.setdefault(o, []).append((d, m))
        nb.setdefault(d, []).append((o, m))
    order = {c: sorted(ids, key=lambda n: -amt.get(n, 0)) for c, ids in cols.items()}

    def fracs() -> dict[str, float]:
        f = {}
        for ids in order.values():
            n = len(ids)
            for i, nid in enumerate(ids):
                f[nid] = (i + 0.5) / n if n else 0.5
        return f

    for _ in range(6):
        f = fracs()

        def bary(nid: str) -> float:
            ws = nb.get(nid, [])
            tot = sum(w for _, w in ws)
            if not tot:
                return f[nid]  # sin vecinos: se queda donde está
            return sum(f[o] * w for o, w in ws if o in f) / tot

        for ids in order.values():
            ids.sort(key=lambda n: (bary(n), -amt.get(n, 0)))
    return order


def _layout(flujo: dict) -> tuple[list[dict], int]:
    """Asigna x,y,alto a cada nodo y devuelve (nodos_posicionados, alto_svg)."""
    nodos, edges, entradas = flujo["nodos"], flujo["edges"], flujo["entradas"]
    out_tot: dict[str, float] = {}
    in_tot: dict[str, float] = {}
    for e in edges:
        out_tot[e["origen"]] = out_tot.get(e["origen"], 0.0) + e["monto"]
        in_tot[e["destino"]] = in_tot.get(e["destino"], 0.0) + e["monto"]

    # "entró" a un nodo = lo que le llega por la cadena; para las cajas de
    # origen (sin edge de entrada) es el efectivo cobrado. El número visible =
    # lo que PASÓ (el mayor de entró/salió), así nunca queda menor que sus ríos.
    entro_d: dict[str, float] = {}
    salio_d: dict[str, float] = {}
    amt: dict[str, float] = {}
    for nid, info in nodos.items():
        entro = max(in_tot.get(nid, 0), entradas.get(nid, 0))
        salio = out_tot.get(nid, 0)
        entro_d[nid], salio_d[nid] = entro, salio
        amt[nid] = max(entro, salio)
    max_amt = max(amt.values(), default=1.0) or 1.0

    def altura(a: float) -> int:
        return round(_MINH + (a / max_amt) * (_MAXH - _MINH))

    cols: dict[int, list[str]] = {0: [], 1: [], 2: [], 3: [], 4: [], 5: []}
    for nid, info in nodos.items():
        col = _COL.get(nid, _COL_DEST if info["tipo"] == "destino" else 0)
        cols[col].append(nid)

    order = _bary_order(cols, edges, amt)
    # Los pozos parados (casi todo lo que entró quedó ahí: MP, tarjetas) son
    # reservorios, no parte del río: van al fondo de su columna para no cortar
    # los cruces. No exigimos salió==0 exacto — un único movimiento chico de
    # salida no debería apagar la marca de un pozo que retuvo el 95 %+.
    def es_parado(n: str) -> bool:
        return (entro_d[n] > 0 and salio_d[n] < 0.05 * entro_d[n]
                and nodos[n]["tipo"] != "destino")
    for c, ids in order.items():
        parados = [n for n in ids if es_parado(n)]
        if parados:
            order[c] = [n for n in ids if not es_parado(n)] + parados

    col_h = {c: sum(altura(amt[n]) for n in ids) + max(0, len(ids) - 1) * _GAP
             for c, ids in order.items()}
    alto = max(340, max(col_h.values(), default=0) + _TOP * 2)

    pos = []
    for col, ids in order.items():
        y = (alto - col_h[col]) / 2
        for nid in ids:
            info = nodos[nid]
            h = altura(amt[nid])
            cat = (config.ARQUEO_DESTINO_CAT.get(nid, "revisar")
                   if info["tipo"] == "destino" else "chain")
            pos.append({
                "id": nid, "label": info["label"], "tipo": info["tipo"],
                "x": _COL_X[col], "y": round(y), "w": _COL_W[col], "h": h,
                "amount": round(amt[nid]), "cat": cat,
                "entro": round(entro_d[nid]), "salio": round(salio_d[nid]),
                "parked": es_parado(nid),
            })
            y += h + _GAP
    return pos, alto


def _arbol(salidas: pd.DataFrame, autoriz: dict[tuple, str]) -> list[dict]:
    """Agrupa las salidas por destino para el árbol expandible.

    `autoriz` mapea (mov, destino_id, monto) → estado revisado. Se llavea por el
    id ESTABLE del destino (no la etiqueta, que puede cambiar si el ERP renombra
    una cuenta) y por monto (un asiento puede tener varias salidas al mismo
    destino con firmas distintas).
    """
    if salidas.empty:
        return []
    grupos = []
    for (dnodo, dlabel, cat), g in salidas.groupby(["destino_id", "destino", "categoria"]):
        filas = [{
            "fecha": r["fecha"].strftime("%d/%m") if pd.notna(r["fecha"]) else "",
            "hora": r["ingreso"].strftime("%H:%M") if pd.notna(r["ingreso"]) else "",
            "mov": int(r["mov"]),
            "concepto": r["concepto"],
            "asociado": r.get("asociado", "") if "asociado" in g.columns else "",
            "usuario": r["usuario"],
            "monto": round(r["monto"]),
            "estado": autoriz.get((int(r["mov"]), str(dnodo), round(float(r["monto"]), 2)), ""),
        } for _, r in g.sort_values("monto", ascending=False).iterrows()]
        sec_orden, sec_titulo = _SECCION.get(cat, (9, "Otros"))
        grupos.append({
            "destino": dlabel, "cat": cat, "cat_label": _CAT_LABEL.get(cat, cat),
            "total": round(g["monto"].sum()), "n": len(g), "filas": filas,
            "sec_orden": sec_orden, "sec_titulo": sec_titulo,
        })
    grupos.sort(key=lambda x: (x["sec_orden"], _CAT_ORDEN.get(x["cat"], 9), -x["total"]))
    # "Chico" = poco peso dentro de su sección: se muestra igual (en un control
    # los montos chicos importan) pero muteado y bajo un divisor, para no gastar
    # el mismo espacio visual que un destino de millones.
    # OJO: dentro de una sección los grupos NO están ordenados por monto sino
    # primero por categoría (revisar → inter → autorizado), así que los chicos
    # NO son contiguos. Para que el divisor nunca deje un grupo grande por
    # debajo, solo marcamos el TRAMO FINAL contiguo de chicos de cada sección
    # (y el divisor va justo antes de ese tramo).
    sec_tot: dict[str, float] = {}
    for gp in grupos:
        sec_tot[gp["sec_titulo"]] = sec_tot.get(gp["sec_titulo"], 0) + gp["total"]
    for gp in grupos:
        gp["chico"] = False
        gp["divisor"] = False
    i, ngr = 0, len(grupos)
    while i < ngr:
        j = i
        sec = grupos[i]["sec_titulo"]
        while j < ngr and grupos[j]["sec_titulo"] == sec:
            j += 1
        umbral = max(10_000, 0.01 * sec_tot[sec])
        k = j  # inicio del tramo final de chicos
        while k - 1 >= i and grupos[k - 1]["total"] < umbral:
            k -= 1
        # solo si queda al menos un grupo grande arriba (si TODA la sección es
        # chica, el subtotal del encabezado ya lo dice: no hace falta divisor)
        if i < k < j:
            for gp in grupos[k:j]:
                gp["chico"] = True
            grupos[k]["divisor"] = True
        i = j
    return grupos


_TEMPLATE = r"""<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Control 2 — Flujo del efectivo — %(titulo)s</title>
<style>
 * { box-sizing: border-box; }
 body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1e293b; margin: 0; padding: 28px; background: #f8fafc; }
 .wrap { max-width: 1080px; margin: 0 auto; }
 h1 { font-size: 22px; font-weight: 600; margin: 0 0 2px; }
 .sub { color: #64748b; font-size: 14px; line-height: 1.6; margin: 0 0 20px; }
 .stats { display: grid; grid-template-columns: repeat(4,1fr); gap: 12px; margin-bottom: 20px; }
 .stat { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 14px; }
 .stat .lbl { font-size: 12px; color: #64748b; margin-bottom: 6px; }
 .stat .num { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
 .stat.fuga .num { color: #ea580c; } .stat.ok .num { color: #15803d; }
 .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 10px 8px 6px; overflow-x: auto; }
 svg { width: 100%%; min-width: 920px; display: block; }
 .lk { fill: none; cursor: pointer; transition: stroke-opacity .12s; }
 .nlbl { font-size: 12px; fill: #1e293b; font-weight: 600; }
 .namt { font-size: 11px; fill: #64748b; }
 .tip { position: fixed; pointer-events: none; background: #0f172a; color: #fff; font-size: 12px; padding: 6px 9px; border-radius: 6px; opacity: 0; transition: opacity .1s; white-space: nowrap; z-index: 9; }
 .legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12.5px; color: #475569; margin: 12px 4px 4px; }
 .legend.hint { color: #94a3b8; font-size: 12px; margin: 0 4px 24px; display: block; }
 .legend.hint a { color: #2563eb; text-decoration: none; border-bottom: 1px dotted #93c5fd; cursor: pointer; }
 .legend.hint b { color: #475569; font-weight: 600; }
 .legend span { display: inline-flex; align-items: center; gap: 6px; }
 .dot { width: 14px; height: 5px; border-radius: 3px; display: inline-block; }
 .dot.dotp { width: 11px; height: 11px; border-radius: 3px; border: 1.5px solid #6366f1; }
 .viewtoggle { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: #475569; margin: 12px 4px 0; }
 .viewtoggle button { font: inherit; padding: 3px 11px; border: 1px solid #cbd5e1; background: #fff; color: #475569; border-radius: 6px; cursor: pointer; }
 .viewtoggle button.on { background: #0f172a; color: #fff; border-color: #0f172a; }
 h2 { font-size: 16px; font-weight: 600; margin: 6px 0 3px; }
 .tintro { font-size: 13px; color: #64748b; margin-bottom: 12px; }
 .sechead { display: flex; justify-content: space-between; align-items: baseline; font-size: 13px; font-weight: 600; color: #334155; margin: 18px 2px 8px; padding-bottom: 5px; border-bottom: 1px solid #e2e8f0; }
 .sechead .secamt { font-weight: 500; color: #64748b; font-variant-numeric: tabular-nums; }
 .grp { background: #fff; border: 1px solid #e2e8f0; border-radius: 9px; margin-bottom: 8px; overflow: hidden; border-left: 3px solid #94a3b8; }
 .grp.revisar { border-left-color: #ea580c; } .grp.inter_empresa { border-left-color: #2563eb; }
 .grp.autorizado { border-left-color: #ca8a04; } .grp.conciliable { border-left-color: #0891b2; } .grp.ok { border-left-color: #15803d; }
 .grp.chico { opacity: .66; }
 .grp.chico .gname, .grp.chico .gamt { font-size: 13px; font-weight: 500; }
 .subdiv { font-size: 11px; color: #94a3b8; text-align: center; margin: 8px 0 3px; letter-spacing: .2px; }
 .ghead { display: flex; align-items: center; gap: 12px; padding: 11px 14px; cursor: pointer; }
 .ghead:hover { background: #f8fafc; }
 .caret { color: #94a3b8; font-size: 12px; width: 12px; transition: transform .12s; }
 .grp.open .caret { transform: rotate(90deg); }
 .gname { font-weight: 600; font-size: 14px; flex: 1; }
 .gtag { font-size: 11px; padding: 2px 9px; border-radius: 20px; background: #f1f5f9; color: #475569; }
 .grp.revisar .gtag { background: #fff2e8; color: #c2410c; } .grp.inter_empresa .gtag { background: #eaf1fe; color: #1d4ed8; }
 .grp.autorizado .gtag { background: #fef9e7; color: #a16207; } .grp.conciliable .gtag { background: #e6f6fa; color: #0e7490; } .grp.ok .gtag { background: #e9f6ee; color: #15803d; }
 .gamt { font-weight: 600; font-size: 14px; font-variant-numeric: tabular-nums; }
 .gbody { display: none; padding: 2px 14px 10px 30px; }
 .grp.open .gbody { display: block; }
 .row { display: grid; grid-template-columns: 74px 1fr 128px; gap: 10px; padding: 8px 0; border-top: 1px solid #eef2f6; font-size: 13px; align-items: baseline; }
 .when { color: #64748b; font-size: 12px; } .cpt { color: #334155; } .who { color: #94a3b8; font-size: 11px; }
 .asoc { color: #1d4ed8; font-weight: 600; }
 .ramt { text-align: right; font-variant-numeric: tabular-nums; }
 .firmado { color: #15803d; font-size: 11px; }
 .usd { margin-top: 30px; }
 .usdflow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 18px 16px; }
 .ustep { flex: 1 1 150px; min-width: 138px; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 14px; background: #f8fafc; }
 .ustep.caja { border-color: #ca8a04; background: #fef9e7; }
 .usname { font-size: 13px; font-weight: 600; color: #334155; }
 .ussub { font-size: 11px; color: #94a3b8; margin-top: 1px; }
 .usnum { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 7px; color: #1e293b; }
 .uarrow { font-size: 12px; color: #a16207; font-weight: 600; white-space: nowrap; text-align: center; padding: 0 2px; }
 .uarrow small { display: block; color: #94a3b8; font-weight: 500; font-size: 10.5px; }
 .usdnote { font-size: 13px; color: #92400e; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 10px 12px; margin: 4px 2px 14px; }
 .usdrow { grid-template-columns: 60px 1fr 116px; }
 .foot { color: #94a3b8; font-size: 11px; margin-top: 20px; }
</style></head><body><div class="wrap">
<h1>Control 2 — Seguí la plata</h1>
<div class="sub">%(subtitulo)s</div>
<div class="stats">
 <div class="stat"><div class="lbl">Ingresó al sistema</div><div class="num" id="s1"></div></div>
 <div class="stat ok"><div class="lbl">Depositado en banco</div><div class="num" id="s2"></div></div>
 <div class="stat fuga"><div class="lbl">Salió del circuito</div><div class="num" id="s3"></div></div>
 <div class="stat fuga"><div class="lbl">Salidas a considerar</div><div class="num" id="s4"></div></div>
</div>
<div class="card"><svg viewBox="0 0 %(ancho)d %(alto)d" id="svg"></svg></div>
<div class="viewtoggle">Por nodo, mostrar: <button id="mPaso" class="on">cuánto pasó</button><button id="mQuedo">cuánto quedó</button></div>
<div class="legend">
 <span><i class="dot" style="background:#94a3b8"></i> flujo interno</span>
 <span><i class="dot" style="background:#ea580c"></i> a considerar</span>
 <span><i class="dot" style="background:#2563eb"></i> inter-empresa (Skyceo)</span>
 <span><i class="dot" style="background:#ca8a04"></i> autorizado</span>
 <span><i class="dot" style="background:#0891b2"></i> a banco (conciliar extracto)</span>
 <span><i class="dot" style="background:#15803d"></i> ajuste de arqueo</span>
 <span><i class="dot dotp" style="background:#eef2ff"></i> parado (entró y no salió)</span>
</div>
<div class="legend hint">· la flecha marca a dónde va · el tamaño del nodo es su monto · <b>arrastrá las cards para reacomodarlas</b> · click en los nodos con ⊕ (Cajas, Tarjetas) para abrirlos · <a href="#" id="reset">↺ volver al orden automático</a></div>
<h2>Detalle de movimientos</h2>
<div class="tintro">Todo lo que se movió, por secciones. La primera es la plata que salió del circuito de custodia (ya validada al hacer cada movimiento) — queda acá para tenerla en cuenta y ver de dónde salió cada peso. Click en cada renglón para abrir quién, cuándo y por qué.</div>
<div id="tree"></div>
%(seccion_usd)s
<div class="foot">Generado por update_arqueo · Control 2 (trazabilidad del efectivo) · %(titulo)s</div>
</div>
<div class="tip" id="tip"></div>
<script>
var DATA = %(data)s;
var COL = {chain:'#94a3b8', conciliable:'#15803d', ok:'#15803d', autorizado:'#ca8a04', inter_empresa:'#2563eb', revisar:'#ea580c'};
var fmtM = function(v){ var a=Math.abs(v);
 if(a>=1e6) return '$'+(v/1e6).toLocaleString('es-AR',{minimumFractionDigits:1,maximumFractionDigits:1})+'M';
 if(a>=1e3) return '$'+Math.round(v/1e3).toLocaleString('es-AR')+'K';
 return '$'+Math.round(v).toLocaleString('es-AR'); };
var fmtF = function(v){ return '$'+Math.round(v).toLocaleString('es-AR'); };
// Número que muestra cada nodo. 'paso' = lo que circuló (n.amount, el default);
// 'quedo' = entró − salió (lo que se retuvo en ese nodo). El tamaño del nodo NO
// cambia (sigue siendo la actividad); solo cambia el número.
var modo='paso';
function montoNodo(n){ return modo==='quedo' ? (n.entro-n.salio) : n.amount; }
// Escapar texto libre (concepto/asociado/usuario/estado tipeados en Sigma)
// antes de meterlo en innerHTML — evita que un '<' rompa o inyecte el arbol.
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
var NS='http://www.w3.org/2000/svg', svg=document.getElementById('svg'), tip=document.getElementById('tip');
function el(t,a){var e=document.createElementNS(NS,t);for(var k in a)e.setAttribute(k,a[k]);return e;}
// defs: flechas por color (de todos los estados) + sombra sutil de los nodos
var defs=el('defs',{}), usados={};
Object.keys(DATA.estados).forEach(function(k){DATA.estados[k].links.forEach(function(l){usados[l.clase]=COL[l.clase]||'#94a3b8';});});
Object.keys(usados).forEach(function(cl){
 var m=el('marker',{id:'arr-'+cl,markerWidth:8,markerHeight:8,refX:6.5,refY:3,orient:'auto',markerUnits:'userSpaceOnUse'});
 m.appendChild(el('path',{d:'M0,0 L6.5,3 L0,6 Z',fill:usados[cl]})); defs.appendChild(m);
});
var fsh=el('filter',{id:'sh',x:'-20%%',y:'-20%%',width:'140%%',height:'160%%'});
fsh.appendChild(el('feDropShadow',{dx:0,dy:1,stdDeviation:1.2,'flood-color':'#0f172a','flood-opacity':0.14}));
defs.appendChild(fsh); svg.appendChild(defs);
var content=el('g',{}); svg.appendChild(content);

// escala de ancho fija (del estado agrupado) para que los ríos sean comparables
var maxA=0; DATA.estados[''].links.forEach(function(l){if(l.monto>maxA)maxA=l.monto;});
var sc=30/(maxA||1), NODE={}, linkEls=[];
function resaltar(nid){ linkEls.forEach(function(p){ p.setAttribute('stroke-opacity',(p.__o===nid||p.__d===nid)?0.95:0.05); }); }
function restaurar(){ linkEls.forEach(function(p){ p.setAttribute('stroke-opacity',p.__base); }); }

// --- ríos + arrastrar cards (efímero: al recargar vuelve al orden automático) ---
function pathD(s,d){
 if(s.x===d.x){ var xa=s.x+s.w/2,ya=s.y+s.h,xb=d.x+d.w/2,yb=d.y,my=(ya+yb)/2;
  return 'M'+xa+','+ya+' C'+xa+','+my+' '+xb+','+my+' '+xb+','+yb; }
 var x1=s.x+s.w,y1=s.y+s.h/2,x2=d.x,y2=d.y+d.h/2,mx=(x1+x2)/2;
 return 'M'+x1+','+y1+' C'+mx+','+y1+' '+mx+','+y2+' '+x2+','+y2;
}
var curEid='', drag=null, d0=null, n0=null, moved=false;
function svgPt(e){ var pt=svg.createSVGPoint(); pt.x=e.clientX; pt.y=e.clientY;
 var m=svg.getScreenCTM(); return m?pt.matrixTransform(m.inverse()):{x:e.clientX,y:e.clientY}; }
document.addEventListener('mousemove',function(e){
 if(!drag)return;
 var p=svgPt(e), dx=p.x-d0.x, dy=p.y-d0.y;
 if(Math.abs(dx)>3||Math.abs(dy)>3)moved=true;
 drag.x=n0.x+dx; drag.y=n0.y+dy;
 drag.__g.setAttribute('transform','translate('+drag.x+','+drag.y+')');
 tip.style.opacity=0;
 linkEls.forEach(function(q){ if(q.__l.origen===drag.id||q.__l.destino===drag.id)
  q.setAttribute('d',pathD(NODE[q.__l.origen],NODE[q.__l.destino])); });
});
document.addEventListener('mouseup',function(){ if(drag){ drag.__g.style.cursor='grab'; drag=null; } });

function render(eid){
 var st=DATA.estados[eid]; if(!st) return; curEid=eid;
 svg.setAttribute('viewBox','0 0 '+DATA.ancho+' '+st.alto);
 while(content.firstChild) content.removeChild(content.firstChild);
 // ox/oy = posición original: el drag muta n.x/n.y (para que los ríos sigan al
 // nodo), así que en cada render las restauramos → re-render/reset deshace el
 // arrastre y vuelve al orden automático.
 NODE={}; st.nodes.forEach(function(n){ if(n.ox===undefined){n.ox=n.x;n.oy=n.y;} n.x=n.ox; n.y=n.oy; NODE[n.id]=n;}); linkEls=[];
 st.links.forEach(function(l){
  var s=NODE[l.origen], d=NODE[l.destino]; if(!s||!d)return;
  var w=Math.max(1.6,l.monto*sc), base=l.clase==='chain'?0.34:0.55;
  var p=el('path',{d:pathD(s,d),'class':'lk',fill:'none',stroke:COL[l.clase]||'#94a3b8','stroke-width':w,'stroke-opacity':base,'marker-end':'url(#arr-'+l.clase+')'});
  p.__base=base; p.__o=l.origen; p.__d=l.destino; p.__l=l;
  p.addEventListener('mousemove',function(e){if(drag)return;tip.style.opacity=1;tip.style.left=(e.clientX+12)+'px';tip.style.top=(e.clientY+12)+'px';tip.textContent=s.label+' → '+d.label+':  '+fmtF(l.monto);p.setAttribute('stroke-opacity',0.95);});
  p.addEventListener('mouseleave',function(){tip.style.opacity=0;p.setAttribute('stroke-opacity',p.__base);});
  linkEls.push(p); content.appendChild(p);
 });
 st.nodes.forEach(function(n){
  var esBanco=(n.id==='banco_santander'||n.id==='banco_supervielle');
  var stroke, fill;
  if(n.parked){ stroke='#6366f1'; fill='#eef2ff'; }
  else if(esBanco){ stroke='#0891b2'; fill='#f0fbfd'; }
  else { stroke=n.cat==='revisar'?'#ea580c':(n.cat==='inter_empresa'?'#2563eb':(n.cat==='autorizado'?'#ca8a04':(n.cat==='conciliable'||n.cat==='ok'?'#15803d':'#cbd5e1')));
   fill=n.cat==='revisar'?'#fff7f2':(n.cat==='inter_empresa'?'#f5f8ff':(n.cat==='autorizado'?'#fffdf3':(n.cat==='conciliable'||n.cat==='ok'?'#f4faf6':'#fff'))); }
  // g con transform: mover el nodo = actualizar el translate (drag) y sus ríos.
  var g=el('g',{filter:'url(#sh)',style:'cursor:grab',transform:'translate('+n.x+','+n.y+')'});
  n.__g=g;
  g.appendChild(el('rect',{x:0,y:0,width:n.w,height:n.h,rx:8,fill:fill,stroke:stroke,'stroke-width':n.tipo==='destino'?1.3:0.9,'stroke-dasharray':n.exp?'4 2':''}));
  // Pozo parado: stub corto que muere en un reservorio (relativo al nodo, así
  // se arrastra junto con él).
  if(n.parked){
   var sy=n.h/2, sw=Math.max(3,Math.min(11,(n.entro-n.salio)*sc));
   g.appendChild(el('path',{d:'M'+n.w+','+sy+' L'+(n.w+20)+','+sy,stroke:'#6366f1','stroke-width':sw,'stroke-opacity':0.30,'stroke-linecap':'round',fill:'none'}));
   g.appendChild(el('circle',{cx:n.w+24,cy:sy,r:5,fill:'#6366f1','fill-opacity':0.42}));
  }
  var suf=n.exp?'  ⊕':(n.colapsar?'  ⊖':''), cy=n.h/2;
  var tl=el('text',{x:10,y:n.amount?cy-2:cy+4,'class':'nlbl'});tl.textContent=n.label+suf;g.appendChild(tl);
  if(n.amount){var ta=el('text',{x:10,y:cy+13,'class':'namt'});ta.textContent=fmtM(montoNodo(n))+(n.parked?' · parado':'');g.appendChild(ta);}
  g.addEventListener('mousemove',function(e){
   if(drag)return;
   tip.style.opacity=1;tip.style.left=(e.clientX+12)+'px';tip.style.top=(e.clientY+12)+'px';
   var q=n.entro-n.salio, extra=(n.entro?('  ·  quedó '+fmtF(q)+(n.parked?' (parado)':'')):'');
   var accion=n.exp?'  ·  arrastrá, o click para abrir':(n.colapsar?'  ·  arrastrá, o click para cerrar':'  ·  arrastrá para mover');
   tip.textContent=n.label+':  entró '+fmtF(n.entro)+'  ·  salió '+fmtF(n.salio)+extra+accion;
  });
  g.addEventListener('mouseenter',function(){if(!drag)resaltar(n.id);});
  g.addEventListener('mouseleave',function(){restaurar();tip.style.opacity=0;});
  g.addEventListener('mousedown',function(e){drag=n;d0=svgPt(e);n0={x:n.x,y:n.y};moved=false;g.style.cursor='grabbing';content.appendChild(g);e.preventDefault();});
  if(n.exp) g.addEventListener('click',function(){if(!moved)render(n.exp);});
  else if(n.colapsar) g.addEventListener('click',function(){if(!moved)render('');});
  content.appendChild(g);
 });
}
render('');
var rb=document.getElementById('reset');
if(rb)rb.addEventListener('click',function(e){e.preventDefault();render(curEid);});
function setModo(m){ modo=m;
 document.getElementById('mPaso').className=(m==='paso'?'on':'');
 document.getElementById('mQuedo').className=(m==='quedo'?'on':'');
 render(curEid); }
document.getElementById('mPaso').addEventListener('click',function(){setModo('paso');});
document.getElementById('mQuedo').addEventListener('click',function(){setModo('quedo');});
document.getElementById('s1').textContent=fmtM(DATA.stats.entro);
document.getElementById('s2').textContent=fmtM(DATA.stats.banco);
document.getElementById('s3').textContent=fmtM(DATA.stats.fuera);
document.getElementById('s4').textContent=DATA.stats.n_firmar;
var tree=document.getElementById('tree'), secActual=null;
DATA.tree.forEach(function(f){
 if(f.sec_titulo!==secActual){
  secActual=f.sec_titulo;
  var tot=DATA.tree.filter(function(x){return x.sec_titulo===f.sec_titulo;}).reduce(function(a,x){return a+x.total;},0);
  var h=document.createElement('div'); h.className='sechead';
  h.innerHTML='<span>'+esc(f.sec_titulo)+'</span><span class="secamt">'+fmtF(tot)+'</span>';
  tree.appendChild(h);
 }
 // Divisor antes del tramo final de montos chicos (posición marcada en Python,
 // para que nunca deje un grupo grande por debajo del rótulo).
 if(f.divisor){
  var dv=document.createElement('div'); dv.className='subdiv'; dv.textContent='· montos menores ·';
  tree.appendChild(dv);
 }
 var box=document.createElement('div'); box.className='grp '+f.cat+(f.chico?' chico':'');
 var rows=f.filas.map(function(r){
  var est=r.estado?'<span class="firmado">✓ '+esc(r.estado)+'</span>':'';
  var asoc=r.asociado?' <span class="asoc">→ '+esc(r.asociado)+'</span>':'';
  return '<div class="row"><span class="when">'+r.fecha+' '+r.hora+'</span><span><span class="cpt">'+esc(r.concepto)+'</span>'+asoc+'<br><span class="who">cargó: '+esc(r.usuario)+'  ·  mov '+r.mov+'  '+est+'</span></span><span class="ramt">'+fmtF(r.monto)+'</span></div>';
 }).join('');
 box.innerHTML='<div class="ghead"><span class="caret">▶</span><span class="gname">'+esc(f.destino)+'</span><span class="gtag">'+esc(f.cat_label)+'</span><span class="gamt">'+fmtF(f.total)+'</span></div><div class="gbody">'+rows+'</div>';
 if(f.cat==='revisar'||f.cat==='inter_empresa')box.classList.add('open');
 box.querySelector('.ghead').addEventListener('click',function(){box.classList.toggle('open');});
 tree.appendChild(box);
});
</script></body></html>"""


def _fmt_usd(x: float) -> str:
    """USD con separador de miles es-AR y signo (−) para negativos."""
    s = f"{abs(x):,.0f}".replace(",", ".")
    return ("−US$ " if x < -0.5 else "US$ ") + s


def _render_usd(fusd: dict | None) -> str:
    """HTML estático de la sección "Seguí los dólares" (o "" si no hubo USD)."""
    if not fusd or not fusd.get("activo"):
        return ""
    nodos, edges, saldo = fusd["nodos"], fusd["edges"], fusd["saldo"]
    ctas = config.ARQUEO_CTAS_USD
    orden = ["compra"] + [str(c) for c in ctas] + ["venta"]
    presentes = [n for n in orden if n in nodos]
    emap = {(e["origen"], e["destino"]): e["usd"] for e in edges}

    piezas = []
    for i, nid in enumerate(presentes):
        info = nodos[nid]
        es_caja = info["tipo"] == "caja"
        if es_caja:
            d = saldo.get(nid, 0.0)
            sub = ("pasó de largo" if abs(d) <= 0.5
                   else "quedó en la caja" if d > 0 else "bajó en la ventana")
            num = _fmt_usd(d)
        else:
            tot = sum(e["usd"] for e in edges if nid in (e["origen"], e["destino"]))
            sub = "pesos → dólares" if nid == "compra" else "dólares → pesos"
            num = _fmt_usd(tot)
        cls = "ustep caja" if es_caja else "ustep"
        piezas.append(f'<div class="{cls}"><div class="usname">{html.escape(info["label"])}</div>'
                      f'<div class="ussub">{sub}</div><div class="usnum">{num}</div></div>')
        if i < len(presentes) - 1:
            amt = emap.get((nid, presentes[i + 1]))
            piezas.append(f'<div class="uarrow">→<small>{_fmt_usd(amt)}</small></div>'
                          if amt else '<div class="uarrow">→</div>')
    strip = '<div class="card usdflow">' + "".join(piezas) + "</div>"

    # Nota: dólares que SALIERON del negocio (cajas dólar que no son la física).
    salieron = {ctas[int(k)]: v for k, v in saldo.items()
                if int(k) != config.ARQUEO_CTA_USD and v > 0.5}
    nota = ""
    if salieron:
        det = " · ".join(f"{html.escape(lbl)}: {_fmt_usd(v)}" for lbl, v in salieron.items())
        nota = (f'<div class="usdnote">💵 Dólares que <b>salieron del negocio</b> en la ventana '
                f'(los controlás vos aparte): {det}.</div>')

    filas = []
    for m in fusd["movimientos"]:
        cot = ""
        if m.get("cotizacion"):
            cot = " · $" + f"{m['cotizacion']:,.0f}".replace(",", ".")
        # Fecha defensiva: un asiento sin fecha (NaT) no debe tumbar TODO el HTML
        # (mismo criterio que el lado en pesos). strftime sobre NaT lanza ValueError.
        fstr = f"{m['fecha']:%d/%m}" if pd.notna(m["fecha"]) else ""
        filas.append(
            f'<div class="row usdrow"><span class="when">{fstr}</span>'
            f'<span><span class="cpt">{html.escape(m["concepto"])}</span><br>'
            f'<span class="who">{html.escape(m["origen"])} → {html.escape(m["destino"])}{cot}</span></span>'
            f'<span class="ramt">{_fmt_usd(m["usd"])}</span></div>')
    tabla = '<div class="grp usd open"><div class="gbody">' + "".join(filas) + "</div></div>"

    return ('<div class="usd"><h2>Seguí los dólares</h2>'
            '<div class="tintro">El recorrido de la caja en dólares (columnas <i>Nominal</i> del '
            'diario): los pesos que compran USD entran a la caja física de Tesorería y, lo que sale '
            'del negocio, pasa a la Caja Dolares. El monto de cada caja es su saldo neto de la '
            'ventana (no el saldo total).</div>' + strip + nota + tabla + "</div>")


def render_html(flujo: dict, meta: dict, autoriz: dict[int, str] | None = None,
                flujo_usd: dict | None = None) -> str:
    """Devuelve el HTML completo del Control 2."""
    autoriz = autoriz or {}
    salidas = flujo["salidas"]
    arbol = _arbol(salidas, autoriz)
    detalle = flujo["detalle"]

    # Estados de render: "" = todo agrupado; cada grupo expandible = abierto.
    presentes = {i["grupo"] for i in detalle["miembros"].values()}
    estados = {}
    for eid in [""] + sorted(g for g in config.ARQUEO_FLUJO_EXPANDIBLE if g in presentes):
        pos, edge_list, alto = _estado(detalle, eid)
        estados[eid] = {"nodes": pos, "links": edge_list, "alto": alto}

    entro = sum(flujo["entradas"].values())
    # Depositado en banco = todo lo que ENTRA a un banco desde el circuito de
    # efectivo (fuerte, puente, cajas…), excluyendo las transferencias
    # banco↔banco (que no son un depósito nuevo, solo mueven plata ya
    # bancarizada). La sección "Movimientos a bancos" del árbol es más amplia
    # (incluye esas transferencias) — por eso su subtotal puede ser mayor.
    bancos = {"banco_santander", "banco_supervielle"}
    banco = float(sum(e["monto"] for e in flujo["edges"]
                      if e["destino"] in bancos and e["origen"] not in bancos))
    if not salidas.empty:
        firmar_mask = salidas["categoria"].isin(["revisar", "inter_empresa", "autorizado"])
        fuera = float(salidas.loc[firmar_mask, "monto"].sum())
        n_firmar = int(firmar_mask.sum())
    else:
        fuera = 0.0
        n_firmar = 0

    data = {
        "estados": estados,
        "ancho": _SVG_W,
        "tree": arbol,
        "stats": {"entro": entro, "banco": banco, "fuera": fuera, "n_firmar": n_firmar},
    }
    titulo = f"{meta['desde']:%d/%m/%Y} al {meta['hasta']:%d/%m/%Y}"
    sub = (f"Flujo del efectivo del {titulo}. Cada río es un movimiento; el ancho "
           "es el monto. En naranja/amarillo/azul, la plata que salió del circuito "
           "de custodia, para tener en cuenta. Datos del diario contable.")
    return _TEMPLATE % {
        # Alto inicial = el del estado agrupado (el que render('') dibuja al
        # cargar), no el de la última iteración del loop, para no arrancar con
        # un viewBox de más y que el SVG "salte" al primer render.
        "titulo": titulo, "subtitulo": sub, "alto": estados[""]["alto"],
        "ancho": _SVG_W,
        "seccion_usd": _render_usd(flujo_usd),
        # Neutralizar el cierre de <script>: un concepto tipeado en Sigma con
        # "</script>" cortaría el bloque y dejaría el dashboard en blanco (+ XSS).
        # "<\/" es un escape JS válido que el runtime relee como "</".
        "data": json.dumps(data, ensure_ascii=False).replace("</", "<\\/"),
    }


def generar_flujo_html(path: str | Path, flujo: dict, meta: dict,
                       autoriz: dict[int, str] | None = None,
                       flujo_usd: dict | None = None) -> Path:
    """Escribe el HTML del Control 2 y devuelve el path."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_html(flujo, meta, autoriz, flujo_usd), encoding="utf-8")
    return path
