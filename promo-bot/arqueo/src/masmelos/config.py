"""Constantes del proyecto MasMelos Analytics.

Las decisiones de negocio (qué comprobantes contar, qué columnas de costo usar,
qué sucursal incluir) viven acá en un solo lugar para que cualquier cambio
sea explícito y trazable.
"""

from __future__ import annotations

import os
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

# Cargar .env desde la raíz del repo
ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
EXTERNAL_DIR = DATA_DIR / "external"
PROCESSED_DIR = DATA_DIR / "processed"
REPORTS_DIR = ROOT / "reports"
SECRETS_DIR = ROOT / "secrets"

for _d in (RAW_DIR, EXTERNAL_DIR, PROCESSED_DIR, REPORTS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# BigQuery
# ---------------------------------------------------------------------------
BQ_PROJECT_ID = os.getenv("BQ_PROJECT_ID", "")
BQ_DATASET = os.getenv("BQ_DATASET", "")
BQ_TABLE = os.getenv("BQ_TABLE", "")
BQ_FQN = f"{BQ_PROJECT_ID}.{BQ_DATASET}.{BQ_TABLE}" if BQ_PROJECT_ID else ""

GOOGLE_APPLICATION_CREDENTIALS = os.getenv(
    "GOOGLE_APPLICATION_CREDENTIALS",
    str(SECRETS_DIR / "bq-service-account.json"),
)

# Si el path apuntado por GOOGLE_APPLICATION_CREDENTIALS no existe (caso
# típico: estamos usando ADC con `gcloud auth application-default login`),
# limpiamos la env var. Si la dejamos seteada, google-auth la prioriza
# sobre ADC y falla con DefaultCredentialsError "File ... was not found".
if not Path(GOOGLE_APPLICATION_CREDENTIALS).exists():
    os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)

# ---------------------------------------------------------------------------
# Filtros de negocio
# ---------------------------------------------------------------------------
SUCURSAL_NOMBRE: str = os.getenv("SUCURSAL_NOMBRE", "MORENO")
WINDOW_MONTHS: int = int(os.getenv("WINDOW_MONTHS", "12"))

# Filtro canónico de Moreno: por PUNTO_VENTA (códigos del ERP).
# Lista validada contra el dataset real (perfilado inicial): tomamos todos
# los PUNTO_VENTA con SUCURSAL_NOMBRE='MORENO' que aparecen en BQ.
#
# Nota: el código 91 ("PRESU MORENO 1") está en el dataset como Moreno,
# pero en la fórmula DAX original de Renzo aparecía como PIBA porque DAX
# evalúa de arriba abajo y el primer match ganaba. Esto es un bug en el
# PowerBI existente: ~$240M/año se estaban contando como PIBA cuando son
# Moreno. Acá lo corregimos.
PUNTO_VENTA_MORENO: set[int] = {
    6, 7, 17, 18,
    51, 52,
    81, 82, 83, 84, 85, 86,
    91, 92, 93, 94, 95, 96,
}

# Mapping completo PUNTO_VENTA → sucursal histórica. Útil para tablas de
# referencia y para validar que el filtro no se nos escape.
PUNTO_VENTA_SUCURSAL: dict[int, str] = {
    8: "MERCADO LIBRE", 9: "MERCADO LIBRE", 80: "NOTAS DE CREDITO ML",
    19: "PIBA", 12: "PIBA", 23: "PIBA", 20: "PIBA",
    70: "PIBA", 71: "PIBA", 60: "PIBA", 61: "PIBA", 62: "PIBA",
    # 91 NO es PIBA — el dataset lo reporta como MORENO ("PRESU MORENO 1").
    # Lo sumamos al spread de PUNTO_VENTA_MORENO debajo.
    **{pv: "MORENO" for pv in PUNTO_VENTA_MORENO},
    35: "MORON", 36: "MORON", 37: "MORON", 39: "MORON", 40: "MORON",
    30: "MORON", 32: "MORON", 38: "MORON",
    47: "ITUZAINGO", 48: "ITUZAINGO", 87: "ITUZAINGO", 88: "ITUZAINGO",
}

# Unidad de negocio derivada de COMPROBANTE_LISTA. Una venta a un kiosco no
# es lo mismo que a un revendedor mayorista o a Mercado Libre — esta
# segmentación es la base del análisis comercial real.
UNIDAD_NEGOCIO_MAP: dict[str, str] = {
    "0": "ESPECIAL", "9": "ESPECIAL", "10": "ESPECIAL",
    "1": "CONSUMIDOR FINAL",
    "2": "KIOSCO",
    "3": "KIOSCO REPARTO",
    "4": "GOLOTECAS/CADENAS",
    "5": "GOLOTECA CADENAS REPARTO",
    "6": "REVENDEDOR MAYORISTA",
    "7": "REVENTA MAYORISTA REPARTO",
    "8": "BUSCA",
    "11": "DASPA",
    "12": "MERCADO LIBRE",
    "13": "AXION",
    "14": "AXION OPERADORES",
    "15": "ESTACIONES DE TERCEROS",
    "16": "SHELL",
}

# Empresa: 0001 y 0006 son "blanco", 0002 es "negro". El campo en BQ es
# `EMPRESA` y suele venir como string con padding ("0001"). Normalizamos a
# string al hacer el lookup.
EMPRESA_MAP: dict[str, str] = {
    "0001": "BLANCO",
    "0006": "BLANCO",
    "0002": "NEGRO",
    # Códigos sin padding por si vienen como int o string corto
    "1": "BLANCO",
    "6": "BLANCO",
    "2": "NEGRO",
}

# Comprobantes que cuentan como venta. Validado contra el dataset real:
# - F = Factura (suma) → ~99% de las filas
# - C = Nota de Crédito (resta) → ya viene con ITEM_FINAL negativo en BQ,
#       NO hay que invertir signo
# - D = Nota de Débito → marginal (<0.01%), excluida por simplicidad
# - Otros (remitos, presupuestos) → no aparecen en el dataset
#
# La LETRA (A/B/C) se conserva como información pero no filtra.
TIPOS_FACTURA = {"F"}
TIPOS_NOTA_CREDITO = {"C"}
TIPOS_VALIDOS = TIPOS_FACTURA | TIPOS_NOTA_CREDITO

# Letras de comprobante válidas (A/B/C). M y E quedan fuera por ahora.
LETRAS_VALIDAS = {"A", "B", "C"}

# ---------------------------------------------------------------------------
# Costos
# ---------------------------------------------------------------------------
# Orden de prioridad: si COSTO_PROMEDIO_PONDERADO está null/cero, caer a
# COSTO_ULTIMA_COMPRA. Si los dos fallan, la línea queda sin margen calculable.
COSTO_PRINCIPAL = "COSTO_PROMEDIO_PONDERADO"
COSTO_FALLBACK = "COSTO_ULTIMA_COMPRA"

# ---------------------------------------------------------------------------
# Columnas a traer de BQ (subset de las +140 disponibles)
# ---------------------------------------------------------------------------
COLUMNAS_BQ: list[str] = [
    # Tiempo
    "FECHA", "FECHA_ENTREGA",
    # Comprobante
    "COMPROBANTE_NUMERO", "COMPROBANTE_TIPO", "LETRA", "ESTADO",
    "COMPROBANTE_LISTA",  # → unidad_negocio (CONSUMIDOR FINAL / KIOSCO / etc.)
    "PUNTO_VENTA", "PUNTO_VENTA_NOMBRE",
    # Sucursal / empresa
    "EMPRESA", "EMPRESA_NOMBRE",  # EMPRESA → empresa_label (BLANCO/NEGRO)
    "SUCURSAL", "SUCURSAL_NOMBRE",
    # Vendedor
    "VENDEDOR_NOMBRE", "VENDEDOR_SUPERVISOR",
    # Cliente
    "CLIENTE_ID", "CLIENTE_NOMBRE",
    "CLIENTE_RUBRO", "CLIENTE_GRUPO", "CLIENTE_ZONA",
    "CLIENTE_LOCALIDAD", "CLIENTE_PARTIDO", "CLIENTE_PROVINCIA",
    "CLIENTE_LATITUD", "CLIENTE_LONGITUD",
    # Producto
    "ITEM_ARTICULO_ID", "ITEM_DESCRIPCION",
    "ITEM_RUBRO_NOMBRE", "ITEM_LINEA_NOMBRE", "ITEM_DIVISION_NOMBRE", "ITEM_GRUPO_NOMBRE",
    "ITEM_MARCA", "ITEM_PROVEEDOR_NOMBRE",
    # OJO: estas columnas usan prefijo IT_ (no ITEM_) en el schema de Sigma
    "IT_FECHA_DE_DISCONTINUIDAD", "IT_FECHA_DE_BAJA",
    # Cantidades
    "ITEM_CANTIDAD", "ITEM_BULTOS", "ITEM_KILOS", "ITEM_LITROS",
    # Precios y montos
    "ITEM_PRECIO_UNITARIO",
    "ITEM_DESCUENTO_TOTAL_MONTO",
    "ITEM_NETO", "ITEM_NETO_SIN_IMPUESTO", "ITEM_FINAL",
    # Costos
    "COSTO_PROMEDIO_PONDERADO", "COSTO_ULTIMA_COMPRA",
    # Moneda
    "MONEDA_NOMBRE", "COTIZACION",
]

# ---------------------------------------------------------------------------
# Datos externos
# ---------------------------------------------------------------------------
IPC_API_URL = "https://api.argentinadatos.com/v1/finanzas/indices/inflacion"
# argentinadatos expone serie diaria histórica de cada tipo de dólar.
# dolarapi.com solo tiene snapshot actual — no sirve para deflactación.
USD_API_URL = "https://api.argentinadatos.com/v1/cotizaciones/dolares"

# Para la base de deflactación usamos el último mes con dato IPC.
# `transform/deflate.py` lo resuelve dinámicamente.

# ---------------------------------------------------------------------------
# Análisis
# ---------------------------------------------------------------------------
TOP_N_DEFAULT = 50
PARETO_THRESHOLD = 0.80  # 80/20

# Fuga silenciosa: comparar últimos 90 días vs 90 días anteriores.
# Un cliente está "en fuga" si su facturación cayó >= 30% entre ventanas.
FUGA_VENTANA_DIAS = 90
FUGA_UMBRAL_CAIDA = 0.30

# SKUs en caída: ranking actual vs hace 6 meses.
CAIDA_VENTANA_MESES = 6

# SKUs nuevos: primera venta dentro de los últimos 90 días.
NUEVOS_VENTANA_DIAS = 90

# ---------------------------------------------------------------------------
# Índice de inflación propia (precios de venta y de costo)
# ---------------------------------------------------------------------------
# Base monetaria del índice de venta: el neto SIN IVA. Lo elegimos así para que
# sea comparable contra el costo (que también es sin IVA, es costo de
# reposición) y no meta ruido por mezcla de alícuotas (21% vs 10,5% en
# alimentos). El precio unitario de cada celda es un "unit value":
# suma(neto) / suma(cantidad), que netea NC y promedia descuentos.
INFLACION_VALOR_VENTA = "ITEM_NETO_SIN_IMPUESTO"

# El índice se arma a nivel SKU × canal: un mismo artículo se vende a distinto
# precio según la lista (consumidor final vs mayorista). Si no separáramos por
# canal, un cambio de mix de canal se confundiría con inflación de precios.
INFLACION_SKU_COL = "ITEM_ARTICULO_ID"
INFLACION_CANAL_COL = "unidad_negocio"
INFLACION_RUBRO_COL = "ITEM_RUBRO_NOMBRE"
INFLACION_CANTIDAD_COL = "ITEM_CANTIDAD"

# Robustez del índice:
# - Una celda (SKU×canal×mes) entra al cálculo solo si su cantidad neta supera
#   este mínimo. Evita que una venta y su NC casi se cancelen y el unit value
#   resultante explote.
# - Validado empíricamente en la auditoría del 2026-06: con umbral 5 perdemos
#   ~25% de las celdas pero solo el 1,2% de la facturación. Las celdas con
#   1-4 unidades son ruido (compras puntuales, errores, NCs casi netas) y su
#   precio "implícito" es muy volátil. Subir el umbral mejora la calidad sin
#   comprometer cobertura.
INFLACION_CANTIDAD_MIN = 5.0
# - Recorte de relativos de precio mes a mes: un artículo cuyo precio se
#   multiplica por más de 3 o cae a menos de 1/3 en un solo mes es casi seguro
#   un error de carga o un cambio de unidad de medida. Esas celdas se descartan
#   del índice (no se incluyen ni en numerador ni en denominador).
INFLACION_REL_MIN = 1 / 3
INFLACION_REL_MAX = 3.0

# Para la métrica de costo por ticket (que suma niveles, no relativos): un costo
# unitario que supera este múltiplo del precio de venta de la línea se descarta.
# Es error de carga del ERP (costos de millones que no se condicen con el precio),
# no un margen negativo real. El índice no necesita esto porque acota los
# relativos mes a mes; las sumas de nivel sí, o un outlier las destruye.
INFLACION_COSTO_MAX_RATIO = 5.0

# Excel histórico acumulativo (una fila por mes; conserva meses que ya salieron
# de la ventana de 12 meses del dataset).
INFLACION_EXCEL_PATH = REPORTS_DIR / "inflacion" / "inflacion_propia.xlsx"

# Snapshot del costo de compras agregado por SKU × mes (promedio ponderado con
# IVA). Es la fuente del COSTO REAL que reemplaza al costo roto del ERP de
# bq_ventas. Lo genera `ingest.bigquery.fetch_compras` (o, por ahora, el bq CLI).
COMPRAS_COSTO_SNAPSHOT = RAW_DIR / "compras_costo_sku_mes.csv"


# ---------------------------------------------------------------------------
# Análisis de clientes (segmentación + cohortes + fuga interanual)
# Razonamiento completo en docs/clientes/README.md
# ---------------------------------------------------------------------------
# Segmentación por meses con compra en los últimos 12 cerrados
CLIENTES_CORE_MIN_MESES = 8        # >= 8 de 12 → CORE
CLIENTES_FRECUENTE_MIN_MESES = 5   # 5-7 → FRECUENTE
CLIENTES_ESTACIONAL_PCT = 0.50     # > 50% de la facturación en un trimestre estacional

# Fuga interanual: mismo trimestre vs año anterior, medida en BULTOS.
# Se clasifica por bultos (inmune a inflación); el nominal queda de referencia.
CLIENTES_MIN_FACT_BASE = 500_000   # facturación nominal mínima en el trim base
CLIENTES_FUGA_SEVERA = -60         # cayó más de 60%
CLIENTES_FUGA_FUERTE = -30         # 30-60%
CLIENTES_FUGA_ALERTA = -10         # 10-30%

# Confianza de la fuga: Z-score de la caída vs la variabilidad histórica propia
CLIENTES_MIN_MESES_HIST = 6        # mínimo de meses para calcular Z
CLIENTES_Z_ALTA = -2.0             # caída > 2 desvíos → confianza ALTA
CLIENTES_Z_MEDIA = -1.0            # 1-2 desvíos → MEDIA; menos → BAJA

# Urgencia RELATIVA a la frecuencia de compra del cliente:
# ratio = días sin comprar / mediana de días entre compras del cliente.
CLIENTES_URGENCIA_RATIO_ACTIVO = 1.5   # ratio < 1.5 → dentro de su ritmo
CLIENTES_URGENCIA_RATIO_RIESGO = 3.0   # 1.5-3 → en riesgo; > 3 → perdido
# Fallback absoluto para clientes sin frecuencia calculable (1 sola compra)
CLIENTES_URGENCIA_DIAS_ACTIVO = 15
CLIENTES_URGENCIA_DIAS_RIESGO = 45


# ---------------------------------------------------------------------------
# Arqueo de caja (diario de movimientos contables de Sigma)
# Razonamiento completo en docs/arqueo/README.md
# ---------------------------------------------------------------------------
# Cuentas de caja que se arquean por día (deben cerrar en cero: todo lo
# cobrado se alivia al buzón/puente el mismo día o a la mañana siguiente).
ARQUEO_CAJAS_VENTA: dict[int, str] = {
    111100001: "CAJA 1",
    111100002: "CAJA 2",
    111100003: "CAJA 3",
    111100004: "CAJA 4",
    111100005: "CAJA 5",
    111100006: "CAJA TESORERIA",
    111402002: "CAJA CENTRAL",
    112402005: "CAJA 6",       # casi muerta (código de grupo 112 erróneo)
    112402006: "CAJA CENTRAL BIS",
}

# Cascada de consolidación del efectivo (acumulan saldo entre días).
ARQUEO_CTA_BUZON = 111100007
ARQUEO_CTA_PUENTE = 111100008
ARQUEO_CTA_FUERTE = 111101003
ARQUEO_CAJAS_CASCADA: dict[int, str] = {
    111100007: "BUZON",
    111100008: "CAJA PUENTE",
    111101003: "CAJA FUERTE",
    111101004: "CAJA GERENCIA",
    111100030: "CAJA 1 PIBA",
    111111019: "CAJA ADMINISTRACION",
}
# La caja en dólares se arquea aparte con las columnas *Nominal* (USD);
# el importe en ARS depende de la cotización del día.
ARQUEO_CTA_USD = 111102006

# Cuentas donde se registran las diferencias de arqueo. El criterio histórico
# es DESVIO DE CAJA; desde jul-2026 algunas diferencias chicas y las pruebas
# van a AJUSTES Y REDONDEOS — el reporte las lee de las dos y alerta para
# unificar el criterio.
ARQUEO_CTA_DESVIO = 501100006
ARQUEO_CTA_AJUSTES = 412200001

# Comprobantes del circuito de caja.
ARQUEO_COMP_COBRANZA: set[str] = {
    "PG11", "PG23", "PG24", "PG25", "PG26", "PG27", "PG31", "PG32", "PG34",
}
ARQUEO_COMP_ALIVIO = "ALV1"
ARQUEO_COMP_DIFERENCIA = "DIFC"
ARQUEO_COMP_RETIRO = "MOV2"
ARQUEO_COMP_DEPOSITO = "DEPO"

# Cada comprobante de cobranza pertenece a un puesto físico. Si un PG debita
# una caja de venta que no es la suya es una mis-imputación (alerta).
# PG11 es la mesa de tesorería/administración y puede tocar varias.
ARQUEO_PG_CAJA: dict[str, set[int]] = {
    "PG23": {111100001},
    "PG24": {111100002},
    "PG25": {111100003},
    "PG26": {111100004},
    "PG27": {111100005},
    "PG31": {111402002},
    "PG32": {112402005},
    "PG34": {112402006},
    "PG11": {111100006, 111100030, 111111019},
}

# Cuentas de medios de pago no-efectivo que conviven con las cajas en los
# recibos de cobranza (el arqueo físico NO las cuenta, pero el resumen sí).
ARQUEO_CTAS_MP: set[int] = {422101014}
ARQUEO_CTAS_TARJETA: set[int] = {
    111301001, 111301002, 111302002, 111304001, 111305001,
}
ARQUEO_CTAS_CHEQUE: set[int] = {111401001, 111401008, 111401010}

# Umbrales de alertas (ARS). Calibrados con la semana 01-06/07/2026: las
# diferencias reales de caja van de $50 a $4.000; todo lo de 5+ cifras fueron
# errores de conteo/carga que después se revirtieron.
ARQUEO_UMBRAL_DIFERENCIA = 10_000      # diferencia final caja/día → alerta roja
ARQUEO_UMBRAL_NETO_DIA = 1.0           # caja de venta que no cierra en cero
ARQUEO_UMBRAL_AJUSTE_RENGLON = 100     # renglón de AJUSTES Y REDONDEOS sospechoso
ARQUEO_UMBRAL_GEMELOS = 1_000_000      # asientos idénticos cercanos en el tiempo
ARQUEO_GEMELOS_VENTANA_SEG = 300
# (No hay umbral de "overnight": el export no trae saldos iniciales, así que
#  la cascada solo da saldo RELATIVO a la ventana — un umbral absoluto sería
#  miscalibrado. Queda en el backlog de docs/arqueo/README.md §6.)

# ---------------------------------------------------------------------------
# Control 2 — trazabilidad del efectivo (flujo + fugas)
# Sigue la plata por la cadena de custodia y marca toda salida hacia cuentas
# fuera del circuito para que gerencia la autorice. Ver docs/arqueo/README.md.
# ---------------------------------------------------------------------------
# Mapa cuenta → (nodo del flujo, etiqueta). Cuentas de la CADENA de custodia
# (por donde pasa el efectivo antes de salir) y NODOS DESTINO (a donde sale).
ARQUEO_FLUJO_NODO: dict[int, tuple[str, str]] = {
    # --- Cadena de custodia ---
    111100001: ("cajas", "Cajas 1–5"), 111100002: ("cajas", "Cajas 1–5"),
    111100003: ("cajas", "Cajas 1–5"), 111100004: ("cajas", "Cajas 1–5"),
    111100005: ("cajas", "Cajas 1–5"), 112402005: ("cajas", "Cajas 1–5"),
    111100006: ("tesoreria", "Tesorería"),
    111402002: ("central", "Central"),
    112402006: ("central_bis", "Central Bis"),
    111100007: ("buzon", "Buzón"),
    111100008: ("puente", "Caja Puente"),
    111101003: ("fuerte", "Caja Fuerte"),
    # CAJA ADMINISTRACIÓN es de HONRE: es efectivo propio, así que va en la
    # cadena de custodia para que sus SALIDAS (anulaciones, echeq) se vean.
    111111019: ("administracion", "Caja Administración"),
    # Los BANCOS de Honre son parte del circuito (la plata sigue viva ahí): van
    # en la cadena para ver las transferencias banco↔banco y los pagos que
    # salen del banco. Separados para que Santander→Supervielle sea visible.
    111201014: ("banco_santander", "Bco Santander"),
    111201015: ("banco_supervielle", "Bco Supervielle"),
    # MERCADO PAGO y TARJETAS son pozos del circuito: reciben cobranza y (cuando
    # se usan para pagar/transferir) su salida se dibuja sola. Hoy solo ingresan
    # — quedan preparados para el mes que tengan movimientos de salida.
    422101014: ("mercadopago", "Mercado Pago"),
    111301001: ("tarjetas", "Tarjetas"), 111301002: ("tarjetas", "Tarjetas"),
    111302002: ("tarjetas", "Tarjetas"), 111304001: ("tarjetas", "Tarjetas"),
    111305001: ("tarjetas", "Tarjetas"),
    # --- Destinos (salidas del circuito) ---
    # CAJA 1 PIBA es de SKYCEO: el reintegro fuerte→PIBA es la entrega terminal
    # a Skyceo (queda ahí, Honre no la vuelve a tocar). Destino inter-empresa.
    111100030: ("skyceo", "Skyceo (caja PIBA)"),
    111101004: ("gerencia", "Retiro gerencia"),
    111102006: ("usd", "Compra USD"),
    211101001: ("proveedores", "Pago proveedores"),
    112011001: ("anulacion", "Anulación cobranza"),  # caja → deudores (reversa)
    501100006: ("desvio", "Desvío de caja"),
    412200001: ("ajustes", "Ajustes y redondeos"),
}

# Cuentas de la cadena (el efectivo "vivo"). Un movimiento entre dos de estas
# es flujo interno; hacia cualquier otra cuenta es una SALIDA del circuito.
ARQUEO_FLUJO_CUSTODIA: set[str] = {
    "cajas", "tesoreria", "central", "central_bis", "buzon", "puente", "fuerte",
    "administracion", "banco_santander", "banco_supervielle",
    "mercadopago", "tarjetas",
}

# Categoría de cada nodo destino → severidad/color. Cualquier destino no
# listado cae en "revisar" (destino nuevo = la señal más pura de novedad).
#   conciliable = se cruza contra una fuente externa (banco → extracto)
#   ok          = destino contable esperado (diferencias de arqueo)
#   autorizado  = salida legítima recurrente, va a firmar (retiro, USD, prov.)
#   inter_empresa = cobranza por cuenta de Skyceo que se le reintegra
#   revisar     = discrecional o desconocido → mirar siempre
ARQUEO_DESTINO_CAT: dict[str, str] = {
    "desvio": "ok",
    "gerencia": "autorizado",
    "usd": "autorizado",
    "proveedores": "autorizado",
    "echeq": "autorizado",       # efectivo convertido a e-cheque
    "impuestos": "autorizado",   # pago de impuestos/cargas en efectivo
    "skyceo": "inter_empresa",
    "ajustes": "ok",
    "anulacion": "revisar",   # cobranza revertida: buen escondite de desvíos
    "gastos": "revisar",
}

# Nodos que se pueden DESPLEGAR en el flujo (click → se abren en sus miembros).
ARQUEO_FLUJO_EXPANDIBLE: set[str] = {"cajas", "tarjetas"}
# Miembro de cada cuenta de un grupo expandible: cuenta → (member_id, etiqueta).
# El nodo agrupado ("Cajas 1–5") se abre en estos al hacer click.
ARQUEO_FLUJO_MIEMBRO: dict[int, tuple[str, str]] = {
    111100001: ("caja1", "Caja 1"), 111100002: ("caja2", "Caja 2"),
    111100003: ("caja3", "Caja 3"), 111100004: ("caja4", "Caja 4"),
    111100005: ("caja5", "Caja 5"), 112402005: ("caja6", "Caja 6"),
    111301001: ("t_visac", "Visa Crédito"), 111301002: ("t_visad", "Visa Débito"),
    111302002: ("t_naranja", "Naranja"), 111304001: ("t_master", "Mastercard"),
    111305001: ("t_amex", "Amex"),
}

# Clasificación de destinos POR NOMBRE (el usuario piensa en nombres y muchas
# cuentas del plan no aparecen todavía en el snapshot). Se consulta cuando la
# cuenta_id no está en ARQUEO_FLUJO_NODO. Clave = nombre normalizado (upper).
# node_id → categoría vía ARQUEO_DESTINO_CAT.
ARQUEO_DESTINO_NOMBRE: dict[str, tuple[str, str]] = {
    # Skyceo (inter-empresa: plata que se le entrega a la otra sociedad)
    "BCO. SANTANDER (SKYCEO) 144-000021784": ("skyceo", "Skyceo"),
    "BCO. SUPERVIELLE CTA. CTE SKYCEO": ("skyceo", "Skyceo"),
    "MERCADO PAGO (SKYCEO)": ("skyceo", "Skyceo"),
    "FONDO COMUN INVERSION SKYCEO": ("skyceo", "Skyceo"),
    # Retiro de socios (autorizado, firmar)
    "RETIRO MARTIN PAVLOTSKY Y ROBERTO CARISEO 2023": ("gerencia", "Retiro socios"),
    # Dólares (autorizado)
    "CAJA DOLARES (USD)": ("usd", "Compra USD"),
    # Proveedores (autorizado)
    "PAGO A PROVEEDORES": ("proveedores", "Pago proveedores"),
    "PROVEEDORES SERVICIO": ("proveedores", "Pago proveedores"),
    "AJUSTE PROVEEDORES": ("proveedores", "Pago proveedores"),
    "CONCILIACION PROVEED./CLIENTES": ("proveedores", "Pago proveedores"),
    # E-cheques / cheques propios (autorizado)
    "ECHEQ": ("echeq", "E-cheque"),
    "ECHEQ PROPIOS": ("echeq", "E-cheque"),
    "ECHEQ HONRE": ("echeq", "E-cheque"),
    "CHEQUES EN CARTERA MORENO": ("echeq", "E-cheque"),
    # Impuestos / cargas sociales a pagar (autorizado)
    "CARGAS SOCIALES A PAGAR": ("impuestos", "Impuestos/cargas"),
    "CARGAS SOCIALES DIRECCION": ("impuestos", "Impuestos/cargas"),
    "IVA A PAGAR": ("impuestos", "Impuestos/cargas"),
    "INGRESOS BRUTOS A PAGAR": ("impuestos", "Impuestos/cargas"),
}

# Sucursales dadas de baja (Moreno es la única operativa). Si una cuenta de
# estas sucursales mueve plata, es una NOVEDAD para revisar — no un flujo
# normal. Ojo: CAJA 1 PIBA está mapeada por número (Skyceo) y gana antes.
ARQUEO_SUCURSALES_BAJA: tuple[str, ...] = ("MORON", "ITUZAINGO", "PIBA")

# Cuentas de gasto (grupos 422/251) → todas al nodo "gastos".
ARQUEO_FLUJO_GASTOS_PREFIJOS: tuple[str, ...] = ("4221", "4222", "4223", "2516")

# Snapshot local acumulativo del diario (merge por asiento en cada corrida).
ARQUEO_SNAPSHOT = RAW_DIR / "diario_contable.parquet"


def hoy() -> date:
    """Hook para mockear la fecha en tests si hace falta."""
    return date.today()
