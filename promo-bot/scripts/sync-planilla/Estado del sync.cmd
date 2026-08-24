@echo off
rem ==========================================================================
rem  ESTADO DEL SYNC
rem
rem  Doble clic. NO TOCA NADA: solo mira y cuenta.
rem
rem  Contesta de una las cuatro cosas que hay que saber cuando algo no anda:
rem    1. Que VERSION del script esta instalada en esta carpeta.
rem    2. Si el proceso esta corriendo de verdad.
rem    3. A donde apunta el arranque automatico (puede haber quedado
rem       apuntando a una carpeta vieja).
rem    4. Si el servidor esta recibiendo los latidos.
rem ==========================================================================

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $t=Get-Content -LiteralPath '%~f0' -Raw -Encoding UTF8; $i=$t.LastIndexOf([char]35+'__PS__'); $env:TV_DIR='%~dp0'; Invoke-Expression $t.Substring($i)"
exit /b

#__PS__
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$DIR = $env:TV_DIR.TrimEnd('\')
# OJO con el nombre: PowerShell no distingue mayusculas, asi que un $L de
# acumulador y un $l de bucle son LA MISMA variable. Ya paso: el bucle que lee
# config.txt lo pisaba con un string y el informe reventaba a la mitad.
$INFORME = New-Object System.Collections.ArrayList
function W($t) { [void]$INFORME.Add($t); Write-Host $t }

W ''
W '  ESTADO DEL SYNC DE LA PLANILLA'
W '  =============================='
W ("  Carpeta : {0}" -f $DIR)
W ("  Equipo  : {0}\{1}" -f $env:COMPUTERNAME, $env:USERNAME)
W ("  Fecha   : {0:yyyy-MM-dd HH:mm}" -f (Get-Date))
W ''

# ---------------------------------------------------------------------------
# 1. Que version esta instalada ACA
# ---------------------------------------------------------------------------
# Los zips se llamaron todos igual, asi que es facil haber descomprimido uno
# viejo. La marca es la funcion Latido: si no esta, es anterior al 24/08.
W '--- 1) VERSION DEL SCRIPT ---'
$worker = Join-Path $DIR 'Sync planilla.cmd'
if (-not (Test-Path -LiteralPath $worker)) {
  W '  NO ESTA "Sync planilla.cmd" en esta carpeta.'
} else {
  $txt = Get-Content -LiteralPath $worker -Raw -Encoding UTF8
  $tieneLatido = $txt -match 'function Latido'
  W ("  {0}   ({1:N0} KB, modificado {2:yyyy-MM-dd HH:mm})" -f `
      $(if ($tieneLatido) { 'NUEVA — manda latido' } else { 'VIEJA — NO manda latido' }), `
      ((Get-Item $worker).Length / 1KB), (Get-Item $worker).LastWriteTime)
  if (-not $tieneLatido) {
    W '  >> Esta es la causa mas probable de que el servidor diga que no reporta.'
    W '     Hay que descomprimir el zip NUEVO y volver a correr "Instalar sync.cmd".'
  }
}
W ''

# ---------------------------------------------------------------------------
# 2. Esta corriendo?
# ---------------------------------------------------------------------------
W '--- 2) PROCESOS CORRIENDO ---'
$marca = 'TV_MODO=' + [char]39 + [char]47 + 'loop' + [char]39
$procs = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
           Where-Object { $_.CommandLine -like ('*' + $marca + '*') })
if (-not $procs.Count) {
  W '  NINGUNO. El sync no esta corriendo.'
  W '  >> Correr "Instalar sync.cmd".'
} else {
  foreach ($p in $procs) {
    # De que carpeta salio este proceso: si hay dos instalaciones, aca se ve.
    $de = '?'
    if ($p.CommandLine -match "TV_DIR='([^']+)'") { $de = $Matches[1] }
    W ("  PID {0}, arrancado {1:yyyy-MM-dd HH:mm}" -f $p.ProcessId, $p.CreationDate)
    W ("     carpeta: {0}" -f $de)
    if ($de -and $de.TrimEnd('\') -ne $DIR) {
      W '     >> OJO: esta corriendo desde OTRA carpeta, no desde esta.'
    }
  }
  if ($procs.Count -gt 1) { W ('  >> Hay {0} corriendo a la vez. Deberia haber uno solo.' -f $procs.Count) }
}
W ''

# ---------------------------------------------------------------------------
# 3. El arranque automatico
# ---------------------------------------------------------------------------
# Guarda la ruta ABSOLUTA. Si se movio la carpeta sin reinstalar, sigue
# apuntando a la vieja y despues de reiniciar arranca la version equivocada.
W '--- 3) ARRANQUE AUTOMATICO ---'
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'MasMelos - Sync planilla.lnk'
if (-not (Test-Path -LiteralPath $lnk)) {
  W '  NO esta configurado: despues de reiniciar la PC no va a arrancar solo.'
} else {
  try {
    $ws = New-Object -ComObject WScript.Shell
    $acceso = $ws.CreateShortcut($lnk)
    W ("  Apunta a: {0}" -f $acceso.Arguments)
    if ($acceso.Arguments -notlike ('*' + $DIR + '*')) {
      W '  >> OJO: apunta a OTRA carpeta. Volver a correr "Instalar sync.cmd" desde esta.'
    }
  } catch { W ("  No pude leerlo: {0}" -f $_.Exception.Message) }
}
W ''

# ---------------------------------------------------------------------------
# 4. Que dice el log
# ---------------------------------------------------------------------------
W '--- 4) ULTIMAS LINEAS DEL LOG ---'
$log = Join-Path $DIR 'sync.log'
if (-not (Test-Path -LiteralPath $log)) {
  W '  No hay sync.log en esta carpeta: aca nunca corrio nada.'
} else {
  Get-Content -LiteralPath $log -Tail 8 -Encoding UTF8 | ForEach-Object { W ('  ' + $_) }
  $edad = (Get-Date) - (Get-Item -LiteralPath $log).LastWriteTime
  W ''
  W ("  Ultima escritura: hace {0:N0} minutos" -f $edad.TotalMinutes)
  if ($edad.TotalMinutes -gt 10) { W '  >> Mas de 10 minutos sin escribir: el sync NO esta dando vueltas.' }
}
W ''

# ---------------------------------------------------------------------------
# 5. Prueba contra el servidor
# ---------------------------------------------------------------------------
# Manda un latido de prueba y despues pregunta si llego. Separa "el script no
# corre" de "el script corre pero no llega al servidor".
W '--- 5) PRUEBA CONTRA EL SERVIDOR ---'
$cfg = @{}
$cfgPath = Join-Path $DIR 'config.txt'
if (Test-Path -LiteralPath $cfgPath) {
  foreach ($linea in (Get-Content -LiteralPath $cfgPath -Encoding UTF8)) {
    if ($linea -match '^\s*#') { continue }
    if ($linea -match '^\s*([A-Za-z_]+)\s*=\s*(.*?)\s*$') { $cfg[$Matches[1].ToLower()] = $Matches[2] }
  }
}
$url = ('' + $cfg['url']).Trim()
$token = ('' + $cfg['token']).Trim()
if (-not $url) {
  W '  config.txt no tiene url: el sync esta en modo prueba y no manda nada.'
} else {
  W ("  url: {0}" -f $url)
  $base = $url.TrimEnd('/')
  try {
    [void](Invoke-WebRequest -Uri ($base + '/latido') -Method Post -TimeoutSec 25 -UseBasicParsing `
      -Headers @{ 'X-Sync-Token' = $token; 'X-Equipo' = $env:COMPUTERNAME; 'X-Estado' = 'ok' })
    W '  Latido de prueba: LLEGO (o sea que desde esta PC se llega al servidor)'
  } catch {
    $c = $null; try { $c = [int]$_.Exception.Response.StatusCode } catch {}
    if ($c -eq 401) { W '  Latido de prueba: RECHAZADO (401) -> el token de config.txt no coincide con el del bot.' }
    elseif ($c -eq 404) { W '  Latido de prueba: 404 -> el bot todavia no tiene la ruta del latido.' }
    else { W ("  Latido de prueba: NO LLEGO -> {0}" -f $_.Exception.Message) }
  }
  try {
    $r = Invoke-WebRequest -Uri ($base + '/estado') -TimeoutSec 25 -UseBasicParsing -Headers @{ 'X-Sync-Token' = $token }
    W ('  El servidor dice: ' + $r.Content)
  } catch { W ('  No pude leer el estado del servidor: ' + $_.Exception.Message) }
}
W ''

$salida = Join-Path $DIR ('estado-sync-' + $env:COMPUTERNAME + '.txt')
$INFORME -join "`r`n" | Set-Content -LiteralPath $salida -Encoding UTF8
W '============================================================'
W ("  Informe: {0}" -f $salida)
W '  Mandame ese archivo.'
W '============================================================'
W ''
Read-Host '  Enter para salir' | Out-Null
