@echo off
rem ==========================================================================
rem  INSTALAR EL SYNC DE LA PLANILLA
rem
rem  Deja el sync andando y lo hace arrancar solo cada vez que se inicia sesion
rem  en esta maquina. No pide administrador y no instala nada en el sistema:
rem  todo vive en esta misma carpeta, mas un acceso directo en Inicio.
rem
rem  Para sacarlo: "Quitar sync.cmd".
rem ==========================================================================

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $t=Get-Content -LiteralPath '%~f0' -Raw -Encoding UTF8; $i=$t.LastIndexOf([char]35+'__PS__'); $env:TV_DIR='%~dp0'; Invoke-Expression $t.Substring($i)"
exit /b

#__PS__
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$DIR    = $env:TV_DIR.TrimEnd('\')
$WORKER = Join-Path $DIR 'Sync planilla.cmd'
$VBS    = Join-Path $DIR 'Sync oculto.vbs'
$CONFIG = Join-Path $DIR 'config.txt'
$INICIO = [Environment]::GetFolderPath('Startup')
$LNK    = Join-Path $INICIO 'MasMelos - Sync planilla.lnk'

function BajarSync {
  # Se busca por la marca del MODO CONTINUO, no por el nombre del archivo. Si se
  # filtrara solo por "Sync planilla.cmd" tambien matchearia cualquier proceso
  # que tenga ese texto en su linea de comando (una prueba, un editor, una
  # consola abierta) y se estaria matando algo que no es el sync.
  $marca = "TV_MODO='/" + "loop'"
  $bajados = 0
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -like ('*' + $marca + '*') })
  foreach ($p in $procs) {
    # Y tambien el cmd.exe que lo envuelve. Matando solo al powershell, el cmd
    # queda huerfano para siempre (comprobado). Se confirma que el padre sea un
    # cmd de este mismo script antes de tocarlo: matar un padre a ciegas puede
    # ser explorer.exe.
    $padre = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ParentProcessId) -ErrorAction SilentlyContinue
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $bajados++ } catch {}
    if ($padre -and $padre.Name -eq 'cmd.exe' -and $padre.CommandLine -like '*Sync planilla.cmd*') {
      try { Stop-Process -Id $padre.ProcessId -Force -ErrorAction Stop; $bajados++ } catch {}
    }
  }
  return $bajados
}

Write-Host ''
Write-Host '  INSTALAR EL SYNC DE LA PLANILLA'
Write-Host '  ==============================='
Write-Host ''

if (-not (Test-Path -LiteralPath $WORKER)) {
  Write-Host '  FALTA "Sync planilla.cmd" en esta carpeta. Copia los archivos juntos.'
  Read-Host '  Enter para salir' | Out-Null
  exit
}

# ---------------------------------------------------------------------------
# 1. Bajar lo que ya estuviera corriendo
# ---------------------------------------------------------------------------
# Sin esto, reinstalar deja dos procesos mandando el mismo archivo. El mutex del
# worker lo evitaria igual, pero mejor dejar la maquina limpia.
$n = BajarSync
if ($n) { Write-Host ('  Baje el sync anterior ({0} procesos).' -f $n) }

# ---------------------------------------------------------------------------
# 2. El lanzador sin ventana
# ---------------------------------------------------------------------------
# Un .cmd arrancado desde Inicio siempre abre una consola negra, aunque se la
# ponga minimizada. Este .vbs de dos lineas es la unica forma limpia de que el
# empleado no vea nada: WScript.Run con 0 no muestra ventana.
# Se usa Chr(34) en vez de comillas dobladas ("""") porque la ruta lleva
# espacios y hay que citarla, pero el VBS con comillas dobladas se vuelve
# ilegible y es facil romperlo al editarlo despues.
$contenido = @"
' Lo genera "Instalar sync.cmd". Arranca el sync sin mostrar ninguna ventana.
Set s = CreateObject("WScript.Shell")
s.Run Chr(34) & "$WORKER" & Chr(34) & " /loop", 0, False
"@
# ANSI a proposito: wscript se lleva mal con UTF-8 con BOM si la ruta tiene
# acentos (por ejemplo un perfil de usuario con enie).
[IO.File]::WriteAllText($VBS, $contenido, [Text.Encoding]::Default)
Write-Host ('  Lanzador: {0}' -f $VBS)

# ---------------------------------------------------------------------------
# 3. Que arranque al iniciar sesion
# ---------------------------------------------------------------------------
# Va por la carpeta Inicio y NO por el Programador de tareas: crear una tarea
# programada pide administrador y esta cuenta no lo es. Como la maquina queda
# siempre con sesion iniciada (estuvo 10 dias prendida sin reiniciar), el loop
# vive todo ese tiempo y solo necesita volver a arrancar despues de un reinicio.
try {
  $ws = New-Object -ComObject WScript.Shell
  # El objeto NO se puede llamar $lnk: PowerShell no distingue mayusculas, asi
  # que $lnk y $LNK son la misma variable y la ruta se pierde apenas se asigna.
  $acceso = $ws.CreateShortcut($LNK)
  $acceso.TargetPath       = 'wscript.exe'
  $acceso.Arguments        = '"' + $VBS + '"'
  $acceso.WorkingDirectory = $DIR
  $acceso.Description      = 'Manda la planilla de retiros al sitio'
  $acceso.Save()
  Write-Host ('  Inicio automatico: {0}' -f $LNK)
} catch {
  Write-Host ('  NO pude crear el acceso directo de inicio: {0}' -f $_.Exception.Message)
}

# ---------------------------------------------------------------------------
# 4. Cerrar el config
# ---------------------------------------------------------------------------
# Ahi adentro va el token. No es una clave de base de datos (con eso solo se
# puede subir la planilla, nada mas), pero no hay razon para que lo lea
# cualquiera que se siente en esta maquina.
if (Test-Path -LiteralPath $CONFIG) {
  try {
    $q = '"' + $CONFIG + '"'
    cmd /c "icacls $q /inheritance:r /grant:r `"$env:USERNAME`":(R,W) >nul 2>&1"
  } catch {}
}

# ---------------------------------------------------------------------------
# 5. Arrancarlo y probar de una
# ---------------------------------------------------------------------------
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $VBS + '"') -WindowStyle Hidden
Write-Host '  Sync arrancado.'
Write-Host ''

$cfg = ''
if (Test-Path -LiteralPath $CONFIG) { $cfg = (Get-Content -LiteralPath $CONFIG -Raw) }
if ($cfg -notmatch '(?m)^\s*url\s*=\s*\S') {
  Write-Host '  ------------------------------------------------------------'
  Write-Host '  OJO: config.txt no tiene url, asi que esta en MODO PRUEBA.'
  Write-Host '  Busca la planilla y lo anota en sync.log, pero no manda nada.'
  Write-Host '  Cuando tengas la url y el token, cargalos en config.txt y el'
  Write-Host '  sync los toma solo en pocos minutos, sin reinstalar nada.'
  Write-Host '  ------------------------------------------------------------'
  Write-Host ''
}

Write-Host '  Hago una pasada de prueba ahora para ver si llega al archivo...'
Write-Host ''
& $WORKER '/una'

Write-Host ''
Write-Host '  ============================================================'
Write-Host ('  Log: {0}' -f (Join-Path $DIR 'sync.log'))
Write-Host '  ============================================================'
Write-Host ''
Read-Host '  Enter para salir' | Out-Null
