@echo off
rem ==========================================================================
rem  QUITAR EL SYNC DE LA PLANILLA
rem
rem  Lo baja y saca el arranque automatico. No borra la carpeta ni el log, asi
rem  que despues se puede volver a instalar con "Instalar sync.cmd" y queda
rem  igual que antes.
rem ==========================================================================

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $t=Get-Content -LiteralPath '%~f0' -Raw -Encoding UTF8; $i=$t.LastIndexOf([char]35+'__PS__'); $env:TV_DIR='%~dp0'; Invoke-Expression $t.Substring($i)"
exit /b

#__PS__
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$DIR    = $env:TV_DIR.TrimEnd('\')
$VBS    = Join-Path $DIR 'Sync oculto.vbs'
$INICIO = [Environment]::GetFolderPath('Startup')
$LNK    = Join-Path $INICIO 'MasMelos - Sync planilla.lnk'

Write-Host ''
Write-Host '  QUITAR EL SYNC DE LA PLANILLA'
Write-Host '  ============================='
Write-Host ''

# Se busca por la marca del MODO CONTINUO, no por el nombre del archivo. Si se
# filtrara solo por "Sync planilla.cmd" tambien matchearia cualquier proceso que
# tenga ese texto en su linea de comando (una prueba, un editor, una consola
# abierta) y se estaria matando algo que no es el sync.
$marca = "TV_MODO='/" + "loop'"
$bajados = 0
$procs = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
           Where-Object { $_.CommandLine -like ('*' + $marca + '*') })
foreach ($p in $procs) {
  # Y tambien el cmd.exe que lo envuelve: matando solo al powershell, el cmd
  # queda huerfano para siempre. Se confirma que el padre sea un cmd de este
  # mismo script antes de tocarlo: matar un padre a ciegas puede ser explorer.
  $padre = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ParentProcessId) -ErrorAction SilentlyContinue
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $bajados++ } catch {}
  if ($padre -and $padre.Name -eq 'cmd.exe' -and $padre.CommandLine -like '*Sync planilla.cmd*') {
    try { Stop-Process -Id $padre.ProcessId -Force -ErrorAction Stop; $bajados++ } catch {}
  }
}
if ($bajados) { Write-Host ('  Baje el sync ({0} procesos).' -f $bajados) }
else { Write-Host '  No habia ningun sync corriendo.' }

if (Test-Path -LiteralPath $LNK) {
  try { Remove-Item -LiteralPath $LNK -Force -ErrorAction Stop; Write-Host '  Saque el arranque automatico.' }
  catch { Write-Host ('  No pude sacar el acceso directo: {0}' -f $_.Exception.Message) }
} else {
  Write-Host '  No estaba el arranque automatico.'
}

if (Test-Path -LiteralPath $VBS) {
  try { Remove-Item -LiteralPath $VBS -Force -ErrorAction Stop; Write-Host '  Borre el lanzador.' } catch {}
}

Write-Host ''
Write-Host '  Listo. El log y la config quedan donde estaban.'
Write-Host ''
Read-Host '  Enter para salir' | Out-Null
