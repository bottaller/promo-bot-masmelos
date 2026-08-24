@echo off
rem ==========================================================================
rem  SYNC PLANILLA RETIRA  -  MasMelos
rem
rem  Manda la PLANILLA RETIRA del servidor al sitio, para que la pantalla de
rem  recepcion se actualice sola y nadie tenga que subir el archivo a mano.
rem
rem  Doble clic   = una pasada mostrando todo por pantalla (para probar).
rem  /loop        = se queda corriendo. Asi lo deja "Instalar sync.cmd".
rem
rem  Mientras config.txt no tenga una url cargada corre en MODO PRUEBA: hace
rem  todo (busca el archivo, lo lee, decide si cambio) menos mandarlo. Sirve
rem  para verificar la mitad dificil antes de que exista el otro extremo.
rem ==========================================================================

setlocal
set "TV_MODO=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $t=Get-Content -LiteralPath '%~f0' -Raw -Encoding UTF8; $i=$t.LastIndexOf([char]35+'__PS__'); $env:TV_DIR='%~dp0'; $env:TV_MODO='%TV_MODO%'; Invoke-Expression $t.Substring($i)"
exit /b

#__PS__
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
# En PowerShell 5.1 el .NET de abajo todavia puede arrancar negociando TLS 1.0,
# que ningun hosting moderno acepta. Sin esta linea el POST falla con un error
# de conexion que no explica nada.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$DIR     = $env:TV_DIR
$MODO    = ('' + $env:TV_MODO).Trim().ToLower()
$LOG     = Join-Path $DIR 'sync.log'
$ESTADO  = Join-Path $DIR 'estado.txt'
$CONFIG  = Join-Path $DIR 'config.txt'
$VISIBLE = ($MODO -ne '/loop')

# Donde vive la planilla. Se prueba primero por red y despues local, por si esto
# alguna vez termina corriendo en el propio servidor.
$BASES = @('\\192.168.0.210\Compartida', 'C:\Compartida')
$SUB   = '03 Ventas\06-TURNADO DE PEDIDOS\PEDIDOS RETIRA MORENO 2026'

function W($t) {
  $linea = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $t
  if ($VISIBLE) { Write-Host $linea }
  try { Add-Content -LiteralPath $LOG -Value $linea -Encoding UTF8 } catch {}
}

function Tam($b) {
  # Abajo de 1 KB se muestran los bytes. Redondear 89 bytes a "0 KB" hace parecer
  # que el archivo esta vacio, justo cuando lo que importa es lo chico que es.
  if ($b -lt 1024) { return ('{0} bytes' -f [long]$b) }
  return ('{0:N0} KB' -f ($b / 1KB))
}

function RecortarLog {
  # Esta maquina no la mira nadie: si el log no se recorta solo, en un ano ocupa
  # cientos de megas y encima deja de servir para buscar algo.
  try {
    if ((Test-Path -LiteralPath $LOG) -and ((Get-Item -LiteralPath $LOG).Length -gt 1MB)) {
      $u = Get-Content -LiteralPath $LOG -Tail 1500 -Encoding UTF8
      Set-Content -LiteralPath $LOG -Value $u -Encoding UTF8
    }
  } catch {}
}

function LeerIni($ruta) {
  $h = @{}
  if (Test-Path -LiteralPath $ruta) {
    foreach ($l in (Get-Content -LiteralPath $ruta -Encoding UTF8)) {
      if ($l -match '^\s*#') { continue }
      if ($l -match '^\s*([A-Za-z_]+)\s*=\s*(.*?)\s*$') { $h[$Matches[1].ToLower()] = $Matches[2] }
    }
  }
  return $h
}

function GuardarEstado($enviado, $tam, $sospechoso, $probado) {
  # "enviado" y "probado" se llevan aparte a proposito. En modo prueba se anota
  # en "probado" para no repetir el mismo aviso cada 4 minutos, pero "enviado"
  # queda vacio: asi, el dia que se carga la url, la planilla sale enseguida en
  # vez de quedarse esperando a que alguien la vuelva a editar.
  #
  # OJO CON LOS PARENTESIS DE CADA LINEA. En PowerShell la coma liga MAS FUERTE
  # que el +, asi que escrito sin parentesis
  #     @( 'enviado=' + $enviado, 'tam=' + $tam )
  # no arma una lista de dos elementos: arma UNO solo, pegando todo con espacios.
  # Estado.txt salia en una sola linea, LeerIni no podia parsearlo, y como el
  # valor ilegible se volvia a escribir en cada vuelta, el archivo crecia hasta
  # que el sync dejaba de darse cuenta de que la planilla no habia cambiado y
  # la remandaba siempre.
  $lineas = @(
    ('enviado='    + ('' + $enviado)),
    ('tam='        + ('' + $tam)),
    ('sospechoso=' + ('' + $sospechoso)),
    ('probado='    + ('' + $probado)),
    ('ultimo='     + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
  )
  try { Set-Content -LiteralPath $ESTADO -Value $lineas -Encoding UTF8 } catch {}
}

# ---------------------------------------------------------------------------
# Decir "sigo vivo"
# ---------------------------------------------------------------------------
function Latido($url, $token, $estado, $fi, $motivo) {
  # Se manda en CADA vuelta, aunque no haya nada que mandar.
  #
  # Sin esto, el servidor no puede distinguir "el script anda y nadie toco el
  # Excel" de "el script se murio": las dos se ven igual desde alla, que es no
  # recibir nada. Paso de verdad un lunes a la manana y no hubo forma de saber
  # cual de las dos era sin venir hasta esta maquina.
  #
  # Va aparte del envio de la planilla y es diminuto (solo headers), asi que
  # mandarlo cada 4 minutos no cuesta nada. Si falla, NO se toca el estado ni se
  # reintenta: el proximo ciclo late de nuevo.
  if (-not $url) { return }
  $u = ($url.TrimEnd('/')) + '/latido'
  $h = @{
    'X-Sync-Token' = $token
    'X-Equipo'     = $env:COMPUTERNAME
    'X-Estado'     = $estado
  }
  if ($fi) {
    $h['X-Archivo']       = $fi.Name
    $h['X-Archivo-Fecha'] = $fi.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
    $h['X-Archivo-Tam']   = [string]$fi.Length
  }
  if ($motivo) {
    # Los headers no admiten saltos de linea ni acentos: se limpia antes de mandar.
    $h['X-Motivo'] = (($motivo -replace '[^ -~]', ' ') -replace '\s+', ' ').Trim()
    if ($h['X-Motivo'].Length -gt 250) { $h['X-Motivo'] = $h['X-Motivo'].Substring(0, 250) }
  }
  try {
    [void](Invoke-WebRequest -Uri $u -Method Post -Headers $h -TimeoutSec 30 -UseBasicParsing)
  } catch {
    # Un latido perdido no es noticia: se anota corto y se sigue.
    W ('  (no pude mandar el latido: {0})' -f $_.Exception.Message)
  }
}

# ---------------------------------------------------------------------------
# Encontrar la planilla
# ---------------------------------------------------------------------------
function BuscarPlanilla {
  # A PROPOSITO no se arma la ruta pegando el nombre del mes. Hoy el unico
  # archivo cuelga de una carpeta que se llama "JULIO 2026" y se sigue editando
  # en agosto: el nombre de la carpeta miente. Se busca el xlsx mas nuevo que
  # cuelgue de PEDIDOS RETIRA MORENO 2026, asi el dia que alguien arme
  # "AGOSTO 2026" esto sigue andando sin que haya que tocarlo.
  # Se guarda el error de CADA base, no el ultimo: si solo se informa el ultimo,
  # el log termina diciendo "no existe C:\Compartida" y se pierde el motivo real,
  # que es por que fallo la ruta de red.
  $fallas = @()
  foreach ($b in $BASES) {
    $raiz = Join-Path $b $SUB
    try { [void]@(Get-ChildItem -LiteralPath $raiz -Force -ErrorAction Stop) }
    catch { $fallas += ('{0} -> {1}' -f $b, $_.Exception.Message); continue }

    $arch = @(Get-ChildItem -LiteralPath $raiz -Recurse -File -Force -ErrorAction SilentlyContinue |
              Where-Object { $_.Extension -in @('.xlsx','.xlsm') -and $_.Name -notlike '~$*' })
    if (-not $arch.Count) {
      return @{ ok = $false; motivo = "se llego a la carpeta pero no hay ningun xlsx: $raiz" }
    }
    return @{ ok = $true; archivo = ($arch | Sort-Object LastWriteTimeUtc -Descending)[0] }
  }
  return @{ ok = $false; motivo = 'no se llego a la carpeta compartida. ' + ($fallas -join '  ||  ') }
}

# ---------------------------------------------------------------------------
# Leerla sin agarrarla por la mitad
# ---------------------------------------------------------------------------
function LeerEstable($fi) {
  $antes = '{0}|{1}' -f $fi.LastWriteTimeUtc.Ticks, $fi.Length
  $bytes = $null
  # ReadWrite en el share mode es lo que permite leerla con Excel abierto, que
  # en horario de trabajo es el caso normal, no la excepcion.
  $fs = [IO.File]::Open($fi.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    $ms = New-Object IO.MemoryStream
    $fs.CopyTo($ms)
    $bytes = $ms.ToArray()
    $ms.Dispose()
  } finally { $fs.Dispose() }

  # Guardar un xlsx NO es atomico, y menos por red. Si mientras leiamos el
  # archivo cambio, lo que tenemos en la mano puede ser medio archivo. Se
  # descarta y se reintenta en el ciclo siguiente: perder unos minutos no le
  # importa a nadie, mandar un archivo cortado si.
  $ahora = Get-Item -LiteralPath $fi.FullName -Force
  if ($antes -ne ('{0}|{1}' -f $ahora.LastWriteTimeUtc.Ticks, $ahora.Length)) {
    return @{ ok = $false; motivo = 'lo estaban guardando justo en ese momento' }
  }
  # Todo xlsx es un zip y todo zip arranca con PK. Es el filtro mas barato
  # contra un archivo truncado.
  if ($bytes.Length -lt 4 -or $bytes[0] -ne 0x50 -or $bytes[1] -ne 0x4B) {
    return @{ ok = $false; motivo = 'no parece un xlsx valido (no arranca con PK)' }
  }
  return @{ ok = $true; bytes = $bytes }
}

# ---------------------------------------------------------------------------
# Una pasada
# ---------------------------------------------------------------------------
function Ciclo {
  $cfg = LeerIni $CONFIG
  $est = LeerIni $ESTADO
  $url   = ('' + $cfg['url']).Trim()
  $token = ('' + $cfg['token']).Trim()

  $b = BuscarPlanilla
  if (-not $b.ok) {
    W ('SIN ARCHIVO: ' + $b.motivo)
    # Se avisa al servidor QUE fallo. Es la diferencia entre que del otro lado
    # sepan "la sucursal no llega al archivo" y que se queden sin saber nada.
    Latido $url $token 'sin-archivo' $null $b.motivo
    return
  }

  $fi = $b.archivo
  $firma = '{0}|{1}' -f $fi.LastWriteTimeUtc.Ticks, $fi.Length

  # El 99% de los ciclos termina aca: el archivo no cambio desde la ultima vez.
  # Cuesta un listado de carpeta y nada mas. La linea igual se escribe en el log
  # porque es la unica senal de que el sync sigue vivo.
  $yaVisto = if ($url) { $est['enviado'] } else { $est['probado'] }
  if ($yaVisto -eq $firma) {
    W ('sin cambios (guardada {0:HH:mm}, {1})' -f $fi.LastWriteTime, (Tam $fi.Length))
    Latido $url $token 'ok' $fi $null
    return
  }

  # Dos strikes. Si el archivo se achico a menos de la mitad de lo ultimo que
  # mandamos, la primera vez NO se manda: casi siempre es un guardado a medias
  # o alguien que abrio el archivo equivocado. Si en el ciclo siguiente sigue
  # igual de chico, entonces es real y se manda. Asi el freno no se traba solo.
  $ultimoTam = 0
  try { $ultimoTam = [long]$est['tam'] } catch {}
  if ($ultimoTam -gt 0 -and $fi.Length -lt ($ultimoTam / 2)) {
    if ($est['sospechoso'] -ne $firma) {
      W ('OJO: la planilla se achico de {0} a {1}. No la mando todavia. Si en el proximo ciclo sigue igual, la mando.' -f (Tam $ultimoTam), (Tam $fi.Length))
      GuardarEstado $est['enviado'] $ultimoTam $firma $est['probado']
      Latido $url $token 'ok' $fi 'la planilla se achico a la mitad, la retengo un ciclo'
      return
    }
    W 'la planilla achicada sigue igual que el ciclo anterior: la mando.'
  }

  $r = LeerEstable $fi
  if (-not $r.ok) {
    W ('todavia no: ' + $r.motivo)
    Latido $url $token 'ok' $fi $null
    return
  }

  if (-not $url) {
    W ('MODO PRUEBA (config.txt sin url): mandaria {0}' -f (Tam $r.bytes.Length))
    W ('              ' + $fi.FullName)
    GuardarEstado $est['enviado'] $est['tam'] $est['sospechoso'] $firma
    return
  }


  $h = @{ 'X-Sync-Token' = $token; 'X-Archivo' = $fi.Name; 'X-Equipo' = $env:COMPUTERNAME }
  try {
    $resp = Invoke-WebRequest -Uri $url -Method Post -Body $r.bytes -ContentType 'application/octet-stream' -Headers $h -TimeoutSec 180 -UseBasicParsing
    $texto = '' + $resp.Content
    if ($texto.Length -gt 400) { $texto = $texto.Substring(0, 400) }
    W ('ENVIADA {0}  ->  {1}  {2}' -f (Tam $r.bytes.Length), $resp.StatusCode, $texto)
    GuardarEstado $firma $fi.Length '' $firma
  } catch {
    # No se toca el estado: sin marca de enviado, el proximo ciclo reintenta
    # solo. No hace falta ninguna logica de reintentos aparte.
    $detalle = $_.Exception.Message
    try {
      $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
      $cuerpo = $sr.ReadToEnd()
      $sr.Close()
      if ($cuerpo) {
        if ($cuerpo.Length -gt 300) { $cuerpo = $cuerpo.Substring(0, 300) }
        $detalle = $detalle + '  |  ' + $cuerpo
      }
    } catch {}
    W ('FALLO EL ENVIO: ' + $detalle)
    # El envio fallo, asi que el servidor no se entero de nada por esa via. El
    # latido es la unica forma de que sepan que la maquina esta viva y que el
    # problema esta en el medio y no aca.
    Latido $url $token 'error' $fi $detalle
  }
}

function EnHorario($cfg) {
  # Fuera de horario la planilla no se toca, asi que no tiene sentido ni mirar
  # la carpeta. Se compara como texto, que con HH:mm con cero adelante alcanza.
  $d = ('' + $cfg['desde']); if (-not $d) { $d = '06:00' }
  $h = ('' + $cfg['hasta']); if (-not $h) { $h = '22:00' }
  $ahora = (Get-Date).ToString('HH:mm')
  return ($ahora -ge $d -and $ahora -le $h)
}

# ---------------------------------------------------------------------------
if ($MODO -eq '/loop') {
  # Un solo proceso a la vez. Si alguien vuelve a iniciar sesion o corre el
  # instalador dos veces, el segundo se va en silencio en vez de duplicar envios.
  $creado = $false
  $mtx = New-Object Threading.Mutex($true, 'MasMelosSyncPlanilla', [ref]$creado)
  if (-not $creado) { exit }

  W '=== arranca el sync (modo continuo) ==='
  while ($true) {
    # La config se relee en cada vuelta a proposito: se puede cambiar la url o
    # el intervalo sin reiniciar nada ni volver a iniciar sesion.
    $cfg = LeerIni $CONFIG
    $min = 4
    try { $min = [int]$cfg['minutos'] } catch {}
    if ($min -lt 1) { $min = 1 }

    try {
      if (EnHorario $cfg) { Ciclo }
    } catch {
      # Pase lo que pase el loop NO se muere: si se muere, no vuelve hasta el
      # proximo inicio de sesion, y esta maquina estuvo 10 dias sin reiniciar.
      W ('ERROR: ' + $_.Exception.Message)
    }
    RecortarLog
    Start-Sleep -Seconds ($min * 60)
  }
}

W '=== pasada manual ==='
try { Ciclo } catch { W ('ERROR: ' + $_.Exception.Message) }
RecortarLog

# /una es la misma pasada pero sin frenar al final: la usa el instalador para
# mostrar el resultado dentro de su propia ventana.
if ($MODO -eq '/una') { exit }

Write-Host ''
Write-Host ('  Log: ' + $LOG)
Write-Host ''
Read-Host '  Enter para salir' | Out-Null
