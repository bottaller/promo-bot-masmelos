@echo off
rem ==========================================================================
rem  MASMELOS - SYNC DE LA PLANILLA RETIRA         (un solo archivo, sin zip)
rem
rem  DOBLE CLIC Y LISTO. No hay nada que descomprimir ni que editar.
rem
rem  Se instala solo en una carpeta fija, propia, que nadie limpia:
rem      %LOCALAPPDATA%\MasMelos\sync-planilla
rem
rem  POR QUE UN SOLO ARCHIVO. Antes esto era un zip de siete. Descomprimirlo dos
rem  veces creo "sync-planilla (1)" al lado de "sync-planilla", el arranque
rem  automatico quedo apuntando a una y el resto a la otra, y el sync termino sin
rem  correr. Un archivo que se copia solo a un lugar fijo no puede terminar asi.
rem
rem  Antes de instalar limpia CUALQUIER instalacion anterior, este donde este.
rem
rem  Otros usos (para el que sepa; no hacen falta para el uso normal):
rem     /estado   ver como esta todo, sin tocar nada
rem     /quitar   sacarlo por completo
rem     /una      una sola pasada, a mano
rem     /loop     el modo continuo (lo usa el arranque automatico)
rem ==========================================================================

setlocal
set "TV_MODO=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $t=Get-Content -LiteralPath '%~f0' -Raw -Encoding UTF8; $i=$t.LastIndexOf([char]35+'__PS__'); $env:TV_SELF='%~f0'; $env:TV_MODO='%TV_MODO%'; Invoke-Expression $t.Substring($i)"
exit /b

#__PS__
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
# En PowerShell 5.1 el .NET de abajo todavia puede negociar TLS 1.0, que ningun
# hosting moderno acepta. Sin esto el POST falla con un error que no explica nada.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$MODO = ('' + $env:TV_MODO).Trim().ToLower()
$SELF = $env:TV_SELF

# ── Lo unico que hay que cambiar si alguna vez cambia el bot ────────────────
$URL_DEF   = 'https://promo-bot-masmelos-production.up.railway.app/planilla'
$TOKEN_DEF = 'zYG7CM1mdfLDmwLu1grG0vM6uSPqM7ej'

# ── Donde vive la planilla ──────────────────────────────────────────────────
# Se prueba por red y despues local, por si esto alguna vez corre en el servidor.
$BASES = @('\\192.168.0.210\Compartida', 'C:\Compartida')
$SUB   = '03 Ventas\06-TURNADO DE PEDIDOS\PEDIDOS RETIRA MORENO 2026'

# ── Donde se instala ────────────────────────────────────────────────────────
# LOCALAPPDATA y no Descargas ni Escritorio: es una carpeta de la aplicacion,
# no la mira nadie, no la limpia el Liberador de espacio y no necesita permisos
# de administrador. TV_PRUEBA existe solo para poder testear el flujo completo
# sin tocar el perfil de verdad.
$DEST = if ($env:TV_PRUEBA) { Join-Path $env:TV_PRUEBA 'sync-planilla' }
        else { Join-Path $env:LOCALAPPDATA 'MasMelos\sync-planilla' }
$INICIO = if ($env:TV_PRUEBA) { Join-Path $env:TV_PRUEBA 'Inicio' }
          else { [Environment]::GetFolderPath('Startup') }
$LNK_NOMBRE = 'MasMelos - Sync planilla.lnk'

$WORKER = Join-Path $DEST 'Sync planilla.cmd'
$VBS    = Join-Path $DEST 'Sync oculto.vbs'
$LOG    = Join-Path $DEST 'sync.log'
$ESTADO = Join-Path $DEST 'estado.txt'
$CONFIG = Join-Path $DEST 'config.txt'
$VISIBLE = ($MODO -ne '/loop')

$INFORME = New-Object System.Collections.ArrayList
function W($t) {
  # OJO con el nombre de esta lista: PowerShell no distingue mayusculas, asi que
  # un $L de acumulador y un $l de bucle serian LA MISMA variable. Ya rompio dos
  # veces ($lnk contra $LNK, y $L contra $l): por eso van nombres largos.
  [void]$INFORME.Add($t)
  if ($VISIBLE) { Write-Host $t }
}
function Log($t) {
  $linea = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $t
  if ($VISIBLE) { Write-Host $linea }
  try { Add-Content -LiteralPath $LOG -Value $linea -Encoding UTF8 } catch {}
}

function Tam($b) {
  # Abajo de 1 KB se muestran bytes: redondear 89 bytes a "0 KB" hace parecer que
  # el archivo esta vacio, justo cuando lo que importa es lo chico que es.
  if ($b -lt 1024) { return ('{0} bytes' -f [long]$b) }
  return ('{0:N0} KB' -f ($b / 1KB))
}

function LeerIni($ruta) {
  $h = @{}
  if (Test-Path -LiteralPath $ruta) {
    foreach ($linea in (Get-Content -LiteralPath $ruta -Encoding UTF8)) {
      if ($linea -match '^\s*#') { continue }
      if ($linea -match '^\s*([A-Za-z_]+)\s*=\s*(.*?)\s*$') { $h[$Matches[1].ToLower()] = $Matches[2] }
    }
  }
  return $h
}

function Config {
  $c = LeerIni $CONFIG
  if (-not ('' + $c['url']).Trim())   { $c['url'] = $URL_DEF }
  if (-not ('' + $c['token']).Trim()) { $c['token'] = $TOKEN_DEF }
  if (-not $c['minutos']) { $c['minutos'] = '4' }
  if (-not $c['desde'])   { $c['desde'] = '06:00' }
  if (-not $c['hasta'])   { $c['hasta'] = '22:00' }
  return $c
}

function GuardarEstado($enviado, $tam, $sospechoso, $probado) {
  # Cada elemento entre parentesis: en PowerShell la coma liga MAS FUERTE que el
  # +, asi que sin ellos esto no arma una lista de cinco lineas sino UN string
  # pegado con espacios. Paso: estado.txt salia ilegible y el sync remandaba la
  # planilla en cada vuelta.
  $lineas = @(
    ('enviado='    + ('' + $enviado)),
    ('tam='        + ('' + $tam)),
    ('sospechoso=' + ('' + $sospechoso)),
    ('probado='    + ('' + $probado)),
    ('ultimo='     + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
  )
  try { Set-Content -LiteralPath $ESTADO -Value $lineas -Encoding UTF8 } catch {}
}

function RecortarLog {
  try {
    if ((Test-Path -LiteralPath $LOG) -and ((Get-Item -LiteralPath $LOG).Length -gt 1MB)) {
      $u = Get-Content -LiteralPath $LOG -Tail 1500 -Encoding UTF8
      Set-Content -LiteralPath $LOG -Value $u -Encoding UTF8
    }
  } catch {}
}

# ───────────────────────────────────────────────────────────────────────────
# Encontrar la planilla
# ───────────────────────────────────────────────────────────────────────────
function BuscarPlanilla {
  # A PROPOSITO no se arma la ruta pegando el nombre del mes: el archivo cuelga
  # de una carpeta llamada "JULIO 2026" que se sigue usando en agosto. Se busca
  # el xlsx mas nuevo bajo PEDIDOS RETIRA MORENO 2026, asi el dia que armen
  # "AGOSTO 2026" esto sigue andando sin tocar nada.
  $fallas = @()
  foreach ($b in $BASES) {
    $raiz = Join-Path $b $SUB
    try { [void]@(Get-ChildItem -LiteralPath $raiz -Force -ErrorAction Stop) }
    catch { $fallas += ('{0} -> {1}' -f $b, $_.Exception.Message); continue }

    $arch = @(Get-ChildItem -LiteralPath $raiz -Recurse -File -Force -ErrorAction SilentlyContinue |
              Where-Object { $_.Extension -in @('.xlsx','.xlsm') -and $_.Name -notlike '~$*' })
    if (-not $arch.Count) { return @{ ok = $false; motivo = "se llego a la carpeta pero no hay ningun xlsx: $raiz" } }
    return @{ ok = $true; archivo = ($arch | Sort-Object LastWriteTimeUtc -Descending)[0] }
  }
  return @{ ok = $false; motivo = 'no se llego a la carpeta compartida. ' + ($fallas -join '  ||  ') }
}

function LeerEstable($fi) {
  $antes = '{0}|{1}' -f $fi.LastWriteTimeUtc.Ticks, $fi.Length
  $bytes = $null
  # ReadWrite en el share mode: hay que poder leerla con Excel abierto, que en
  # horario de trabajo es el caso normal.
  $fs = [IO.File]::Open($fi.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    $ms = New-Object IO.MemoryStream
    $fs.CopyTo($ms); $bytes = $ms.ToArray(); $ms.Dispose()
  } finally { $fs.Dispose() }

  # Guardar un xlsx NO es atomico, y menos por red: si cambio mientras leiamos,
  # lo que tenemos puede ser medio archivo. Perder una vuelta no le importa a
  # nadie; mandar un archivo cortado si.
  $ahora = Get-Item -LiteralPath $fi.FullName -Force
  if ($antes -ne ('{0}|{1}' -f $ahora.LastWriteTimeUtc.Ticks, $ahora.Length)) {
    return @{ ok = $false; motivo = 'lo estaban guardando justo en ese momento' }
  }
  if ($bytes.Length -lt 4 -or $bytes[0] -ne 0x50 -or $bytes[1] -ne 0x4B) {
    return @{ ok = $false; motivo = 'no parece un xlsx valido (no arranca con PK)' }
  }
  return @{ ok = $true; bytes = $bytes }
}

# ───────────────────────────────────────────────────────────────────────────
# Decir "sigo vivo"
# ───────────────────────────────────────────────────────────────────────────
function Latido($url, $token, $estado, $fi, $motivo) {
  # Va en CADA vuelta, aunque no haya nada que mandar. Sin esto el servidor no
  # puede distinguir "el script anda y nadie toco el Excel" de "el script se
  # murio": las dos se ven igual desde alla. Es diminuto (solo headers).
  if (-not $url) { return }
  $u = ($url.TrimEnd('/')) + '/latido'
  $h = @{ 'X-Sync-Token' = $token; 'X-Equipo' = $env:COMPUTERNAME; 'X-Estado' = $estado }
  if ($fi) {
    $h['X-Archivo']       = $fi.Name
    $h['X-Archivo-Fecha'] = $fi.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
    $h['X-Archivo-Tam']   = [string]$fi.Length
  }
  if ($motivo) {
    # Los headers no admiten saltos de linea ni acentos.
    $m = (($motivo -replace '[^\x20-\x7E]', ' ') -replace '\s+', ' ').Trim()
    if ($m.Length -gt 250) { $m = $m.Substring(0, 250) }
    $h['X-Motivo'] = $m
  }
  try { [void](Invoke-WebRequest -Uri $u -Method Post -Headers $h -TimeoutSec 30 -UseBasicParsing) }
  catch { Log ('  (no pude mandar el latido: {0})' -f $_.Exception.Message) }
}

# ───────────────────────────────────────────────────────────────────────────
# Una pasada
# ───────────────────────────────────────────────────────────────────────────
function Ciclo {
  $cfg = Config
  $est = LeerIni $ESTADO
  $url = ('' + $cfg['url']).Trim()
  $token = ('' + $cfg['token']).Trim()

  $b = BuscarPlanilla
  if (-not $b.ok) {
    Log ('SIN ARCHIVO: ' + $b.motivo)
    Latido $url $token 'sin-archivo' $null $b.motivo
    return
  }
  $fi = $b.archivo
  $firma = '{0}|{1}' -f $fi.LastWriteTimeUtc.Ticks, $fi.Length

  # El 99% de las vueltas termina aca. La linea igual se escribe: es la unica
  # senal en el log de que el sync sigue dando vueltas.
  if ($est['enviado'] -eq $firma) {
    Log ('sin cambios (guardada {0:HH:mm}, {1})' -f $fi.LastWriteTime, (Tam $fi.Length))
    Latido $url $token 'ok' $fi $null
    return
  }

  # Dos strikes: si se achico a menos de la mitad, la primera vez NO se manda
  # (suele ser un guardado a medias). Si en la vuelta siguiente sigue igual, es
  # real y se manda. Asi el freno no se traba solo.
  $ultimoTam = 0
  try { $ultimoTam = [long]$est['tam'] } catch {}
  if ($ultimoTam -gt 0 -and $fi.Length -lt ($ultimoTam / 2)) {
    if ($est['sospechoso'] -ne $firma) {
      Log ('OJO: la planilla se achico de {0} a {1}. No la mando todavia.' -f (Tam $ultimoTam), (Tam $fi.Length))
      GuardarEstado $est['enviado'] $ultimoTam $firma $est['probado']
      Latido $url $token 'ok' $fi 'la planilla se achico a la mitad, la retengo un ciclo'
      return
    }
    Log 'la planilla achicada sigue igual que la vuelta anterior: la mando.'
  }

  $r = LeerEstable $fi
  if (-not $r.ok) { Log ('todavia no: ' + $r.motivo); Latido $url $token 'ok' $fi $null; return }

  $h = @{ 'X-Sync-Token' = $token; 'X-Archivo' = $fi.Name; 'X-Equipo' = $env:COMPUTERNAME }
  try {
    $resp = Invoke-WebRequest -Uri $url -Method Post -Body $r.bytes -ContentType 'application/octet-stream' `
              -Headers $h -TimeoutSec 180 -UseBasicParsing
    $texto = '' + $resp.Content
    if ($texto.Length -gt 400) { $texto = $texto.Substring(0, 400) }
    Log ('ENVIADA {0}  ->  {1}  {2}' -f (Tam $r.bytes.Length), $resp.StatusCode, $texto)
    GuardarEstado $firma $fi.Length '' $firma
  } catch {
    # No se toca el estado: sin marca de enviado, la proxima vuelta reintenta
    # sola. No hace falta ninguna logica de reintentos aparte.
    $detalle = $_.Exception.Message
    try {
      $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
      $cuerpo = $sr.ReadToEnd(); $sr.Close()
      if ($cuerpo) {
        if ($cuerpo.Length -gt 300) { $cuerpo = $cuerpo.Substring(0, 300) }
        $detalle = $detalle + '  |  ' + $cuerpo
      }
    } catch {}
    Log ('FALLO EL ENVIO: ' + $detalle)
    Latido $url $token 'error' $fi $detalle
  }
}

function EnHorario($cfg) {
  $d = '' + $cfg['desde']; $h = '' + $cfg['hasta']
  $ahora = (Get-Date).ToString('HH:mm')
  return ($ahora -ge $d -and $ahora -le $h)
}

# ───────────────────────────────────────────────────────────────────────────
# Bajar cualquier instalacion anterior, este donde este
# ───────────────────────────────────────────────────────────────────────────
function BajarTodo {
  # Se busca por la marca del modo continuo y no por la ruta: justamente el
  # problema fue que habia copias en carpetas distintas.
  $marca = 'TV_MODO=' + [char]39 + [char]47 + 'loop' + [char]39
  $bajados = 0
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -like ('*' + $marca + '*') })
  foreach ($p in $procs) {
    # Y el cmd.exe que lo envuelve: matando solo al powershell queda huerfano.
    # Se confirma que el padre sea un cmd antes de tocarlo (matar un padre a
    # ciegas puede ser explorer.exe).
    $padre = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ParentProcessId) -ErrorAction SilentlyContinue
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $bajados++ } catch {}
    if ($padre -and $padre.Name -eq 'cmd.exe' -and $padre.CommandLine -like '*Sync planilla*') {
      try { Stop-Process -Id $padre.ProcessId -Force -ErrorAction Stop; $bajados++ } catch {}
    }
  }
  return $bajados
}

function SacarAccesos {
  # Se borran TODOS los accesos directos con ese nombre, apunten a donde apunten:
  # el que quedo en la maquina apuntaba a "sync-planilla (1)".
  $sacados = @()
  foreach ($carpeta in @($INICIO, [Environment]::GetFolderPath('Startup'))) {
    if (-not $carpeta) { continue }
    $p = Join-Path $carpeta $LNK_NOMBRE
    if (Test-Path -LiteralPath $p) {
      try { Remove-Item -LiteralPath $p -Force -ErrorAction Stop; $sacados += $p } catch {}
    }
  }
  return $sacados
}

# ───────────────────────────────────────────────────────────────────────────
# Instalar
# ───────────────────────────────────────────────────────────────────────────
function Instalar {
  W ''
  W '  MASMELOS - SYNC DE LA PLANILLA'
  W '  =============================='
  W ''

  W '1) Limpiando lo anterior...'
  $n = BajarTodo
  W ("   procesos bajados: {0}" -f $n)
  foreach ($s in (SacarAccesos)) { W ("   saque el acceso directo: {0}" -f $s) }

  W ''
  W '2) Instalando...'
  New-Item -ItemType Directory -Force -Path $DEST | Out-Null
  # El propio archivo se copia a la carpeta fija. No hay nada que descomprimir,
  # asi que no puede quedar un "(1)" al lado.
  if ((Resolve-Path $SELF).Path -ne (Join-Path $DEST 'Sync planilla.cmd')) {
    Copy-Item -LiteralPath $SELF -Destination $WORKER -Force
  }
  if (-not (Test-Path -LiteralPath $CONFIG)) {
    $lineas = @(
      '# Se relee en cada vuelta: cambiar algo aca no requiere reinstalar nada.',
      ('url=' + $URL_DEF),
      ('token=' + $TOKEN_DEF),
      'minutos=4',
      'desde=06:00',
      'hasta=22:00'
    )
    Set-Content -LiteralPath $CONFIG -Value $lineas -Encoding UTF8
  }
  W ("   carpeta: {0}" -f $DEST)

  # Un .cmd lanzado desde Inicio siempre abre una consola negra. Este .vbs de dos
  # lineas es la unica forma limpia de que el empleado no vea nada.
  $q = [char]34
  $contenido = "' Lo genera el instalador. Arranca el sync sin mostrar ninguna ventana.`r`n" +
               "Set s = CreateObject(${q}WScript.Shell${q})`r`n" +
               "s.Run Chr(34) & ${q}$WORKER${q} & Chr(34) & ${q} $([char]47)loop${q}, 0, False`r`n"
  # ANSI: wscript se lleva mal con UTF-8 con BOM si la ruta tiene acentos.
  [IO.File]::WriteAllText($VBS, $contenido, [Text.Encoding]::Default)

  New-Item -ItemType Directory -Force -Path $INICIO | Out-Null
  try {
    $ws = New-Object -ComObject WScript.Shell
    # El objeto NO se puede llamar $lnk si hay un $LNK: son la misma variable.
    $acceso = $ws.CreateShortcut((Join-Path $INICIO $LNK_NOMBRE))
    $acceso.TargetPath = 'wscript.exe'
    $acceso.Arguments = $q + $VBS + $q
    $acceso.WorkingDirectory = $DEST
    $acceso.Description = 'Manda la planilla de retiros al sitio'
    $acceso.Save()
    W '   arranque automatico: listo'
  } catch { W ("   NO pude crear el arranque automatico: {0}" -f $_.Exception.Message) }

  # El token vive en config.txt. No es una clave de base (solo sirve para subir
  # esta planilla), pero no hay razon para que lo lea cualquiera.
  try { cmd /c ("icacls `"$CONFIG`" /inheritance:r /grant:r `"$env:USERNAME`":(R,W) >nul 2>&1") } catch {}

  W ''
  W '3) Arrancando...'
  Start-Process -FilePath 'wscript.exe' -ArgumentList ($q + $VBS + $q) -WindowStyle Hidden
  Start-Sleep -Seconds 3
  $vivos = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -like ('*' + 'TV_MODO=' + [char]39 + [char]47 + 'loop' + [char]39 + '*') })
  W ("   procesos corriendo: {0}" -f $vivos.Count)
  if (-not $vivos.Count) { W '   >> NO arranco. Avisale a sistemas con esta pantalla.' }

  W ''
  W '4) Probando contra el servidor...'
  Ciclo
  W ''
  W '  ============================================================'
  if ($vivos.Count) {
    W '   LISTO. Ya esta andando y va a arrancar solo al iniciar sesion.'
    W '   No hay nada mas que hacer.'
  }
  W ("   Log: {0}" -f $LOG)
  W '  ============================================================'
  W ''
}

# ───────────────────────────────────────────────────────────────────────────
# Estado
# ───────────────────────────────────────────────────────────────────────────
function Estado {
  W ''
  W '  ESTADO DEL SYNC'
  W '  ==============='
  W ("  Equipo : {0}\{1}" -f $env:COMPUTERNAME, $env:USERNAME)
  W ("  Fecha  : {0:yyyy-MM-dd HH:mm}" -f (Get-Date))
  W ("  Destino: {0}" -f $DEST)
  W ''

  W '--- INSTALACION ---'
  if (Test-Path -LiteralPath $WORKER) {
    $g = Get-Item -LiteralPath $WORKER
    W ("  Instalado   ({0:N0} KB, {1:yyyy-MM-dd HH:mm})" -f ($g.Length / 1KB), $g.LastWriteTime)
  } else { W '  NO instalado en la carpeta fija.' }

  $p = Join-Path $INICIO $LNK_NOMBRE
  if (Test-Path -LiteralPath $p) {
    try {
      $ws = New-Object -ComObject WScript.Shell
      W ('  Arranque automatico -> ' + $ws.CreateShortcut($p).Arguments)
    } catch {}
  } else { W '  Arranque automatico: NO configurado' }
  W ''

  W '--- PROCESOS ---'
  $marca = 'TV_MODO=' + [char]39 + [char]47 + 'loop' + [char]39
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -like ('*' + $marca + '*') })
  if (-not $procs.Count) { W '  NINGUNO. El sync no esta corriendo.' }
  foreach ($x in $procs) {
    $de = '?'
    if ($x.CommandLine -match "TV_SELF='([^']+)'") { $de = $Matches[1] }
    W ("  PID {0}, desde {1:yyyy-MM-dd HH:mm}" -f $x.ProcessId, $x.CreationDate)
    W ("     {0}" -f $de)
  }
  if ($procs.Count -gt 1) { W '  >> Hay mas de uno. Correr /quitar y volver a instalar.' }
  W ''

  W '--- LOG ---'
  if (Test-Path -LiteralPath $LOG) {
    Get-Content -LiteralPath $LOG -Tail 8 -Encoding UTF8 | ForEach-Object { W ('  ' + $_) }
    W ('  (ultima escritura hace {0:N0} minutos)' -f ((Get-Date) - (Get-Item -LiteralPath $LOG).LastWriteTime).TotalMinutes)
  } else { W '  todavia no hay log' }
  W ''

  W '--- SERVIDOR ---'
  $cfg = Config
  $base = ('' + $cfg['url']).Trim().TrimEnd('/')
  try {
    [void](Invoke-WebRequest -Uri ($base + '/latido') -Method Post -TimeoutSec 25 -UseBasicParsing `
      -Headers @{ 'X-Sync-Token' = $cfg['token']; 'X-Equipo' = $env:COMPUTERNAME; 'X-Estado' = 'ok' })
    W '  Latido de prueba: LLEGO'
  } catch {
    $c = $null; try { $c = [int]$_.Exception.Response.StatusCode } catch {}
    if ($c -eq 401) { W '  Latido de prueba: 401 -> el token no coincide con el del bot.' }
    else { W ('  Latido de prueba: NO LLEGO -> ' + $_.Exception.Message) }
  }
  try {
    $r = Invoke-WebRequest -Uri ($base + '/estado') -TimeoutSec 25 -UseBasicParsing -Headers @{ 'X-Sync-Token' = $cfg['token'] }
    W ('  El servidor dice: ' + $r.Content)
  } catch { W ('  No pude leer el estado: ' + $_.Exception.Message) }
  W ''

  $salida = Join-Path ([Environment]::GetFolderPath('Desktop')) ('estado-sync-' + $env:COMPUTERNAME + '.txt')
  try { $INFORME -join "`r`n" | Set-Content -LiteralPath $salida -Encoding UTF8; W ("  Informe: {0}" -f $salida) } catch {}
  W ''
}

function Quitar {
  W ''
  W '  QUITANDO EL SYNC'
  W ("   procesos bajados: {0}" -f (BajarTodo))
  foreach ($s in (SacarAccesos)) { W ("   saque: {0}" -f $s) }
  W ("   la carpeta {0} queda (con el log). Se puede borrar a mano." -f $DEST)
  W ''
}

# ───────────────────────────────────────────────────────────────────────────
if ($MODO -eq '/loop') {
  # Un solo proceso a la vez.
  $creado = $false
  $mtx = New-Object Threading.Mutex($true, 'MasMelosSyncPlanilla', [ref]$creado)
  if (-not $creado) { exit }
  Log '=== arranca el sync (modo continuo) ==='
  while ($true) {
    $cfg = Config
    $min = 4
    try { $min = [int]$cfg['minutos'] } catch {}
    if ($min -lt 1) { $min = 1 }
    try { if (EnHorario $cfg) { Ciclo } }
    catch { Log ('ERROR: ' + $_.Exception.Message) }  # pase lo que pase, el loop no se muere
    RecortarLog
    Start-Sleep -Seconds ($min * 60)
  }
}

if ($MODO -eq '/una') { Ciclo; exit }
if ($MODO -eq '/quitar') { Quitar; Read-Host '  Enter para salir' | Out-Null; exit }
if ($MODO -eq '/estado') { Estado; Read-Host '  Enter para salir' | Out-Null; exit }

# Sin argumentos: si se corre la copia YA instalada, mostrar el estado (es lo
# util); si se corre la copia suelta que trajo alguien, instalar.
if ((Test-Path -LiteralPath $WORKER) -and ((Resolve-Path $SELF).Path -eq (Resolve-Path $WORKER).Path)) { Estado }
else { Instalar }
Read-Host '  Enter para salir' | Out-Null
