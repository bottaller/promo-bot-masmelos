@echo off
rem ===========================================================================
rem  DIAGNOSTICO DE LA PLANILLA
rem
rem  CORRER EN LA PC DEL EMPLEADO (la que abre la planilla todos los dias),
rem  con doble clic. NO TOCA NADA.
rem
rem  Tambien funciona corrido en el propio servidor: prueba primero la ruta
rem  local C:\Compartida y si no, la de red \192.168.0.210\Compartida.
rem
rem  Contesta tres cosas de una:
rem    1. Se llega a la carpeta de la planilla? Y si no, es porque NO EXISTE o
rem       porque NO HAY PERMISO? (Test-Path no distingue: para las dos dice que
rem       no, y por eso el diagnostico anterior salio mal.)
rem    2. Si es permiso: QUE CUENTAS si pueden leerla. Eso define con que
rem       usuario va a tener que correr la sincronizacion.
rem    3. Si se llega: donde esta el archivo y si se puede leer.
rem ===========================================================================

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $t=Get-Content -LiteralPath '%~f0' -Raw -Encoding UTF8; $i=$t.LastIndexOf([char]35+'__POWERSHELL__'); $env:TV_DIR='%~dp0'; Invoke-Expression $t.Substring($i)"
exit /b

#__POWERSHELL__
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$salida = Join-Path $env:TV_DIR ('diagnostico-' + $env:COMPUTERNAME + '.txt')
$L = New-Object System.Collections.ArrayList
function W($t) { [void]$L.Add($t); Write-Host $t }

# La ruta, partida en niveles. Se camina uno por uno para saber DONDE se corta.
# La base puede ser LOCAL (si esto corre en el propio servidor) o POR RED (si
# corre en la PC de un empleado). Se prueban las dos y gana la que responda.
$BASES = @('C:\Compartida', '\\192.168.0.210\Compartida')
$RAIZ = $null
foreach ($b in $BASES) {
  try { [void]@(Get-ChildItem -LiteralPath $b -Force -ErrorAction Stop); $RAIZ = $b; break } catch {}
}
if (-not $RAIZ) { $RAIZ = $BASES[-1] }   # asi el informe muestra el error real

$NIVELES = @(
  $RAIZ,
  (Join-Path $RAIZ '03 Ventas'),
  (Join-Path $RAIZ '03 Ventas\06-TURNADO DE PEDIDOS'),
  (Join-Path $RAIZ '03 Ventas\06-TURNADO DE PEDIDOS\PEDIDOS RETIRA MORENO 2026')
)

W ''
W '  DIAGNOSTICO DE LA PLANILLA'
W '  =========================='
W ("  Equipo   : {0}" -f $env:COMPUTERNAME)
W ("  Usuario  : {0}\{1}" -f $env:USERDOMAIN, $env:USERNAME)
try {
  $adm = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  W ("  Es admin : {0}" -f $(if ($adm) { 'SI' } else { 'no' }))
} catch {}
W ("  Fecha    : {0:yyyy-MM-dd HH:mm}" -f (Get-Date))
W ("  Leyendo  : {0}" -f $RAIZ)
W ''

# ---------------------------------------------------------------------------
# 1. Caminar la ruta distinguiendo NO EXISTE de NO TENGO PERMISO
# ---------------------------------------------------------------------------
# Test-Path devuelve $false en los dos casos, asi que no sirve. Lo que si
# distingue es intentar LISTAR el contenido y mirar la excepcion.
W '--- CAMINANDO LA RUTA ---'
$ultimoOk = $null
$trabado = $null
foreach ($n in $NIVELES) {
  try {
    $hijos = @(Get-ChildItem -LiteralPath $n -Force -ErrorAction Stop)
    W ("  OK           {0}   ({1} elementos)" -f $n, $hijos.Count)
    $ultimoOk = $n
  } catch [System.UnauthorizedAccessException] {
    W ("  SIN PERMISO  {0}" -f $n)
    $trabado = $n; break
  } catch [System.Management.Automation.ItemNotFoundException] {
    W ("  NO EXISTE    {0}" -f $n)
    $trabado = $n; break
  } catch {
    W ("  ERROR        {0}" -f $n)
    W ("               {0}" -f $_.Exception.Message)
    $trabado = $n; break
  }
}
W ''

# ---------------------------------------------------------------------------
# 2. Si se cortó, mostrar el porqué con detalle
# ---------------------------------------------------------------------------
if ($trabado) {
  $existe = Test-Path -LiteralPath $trabado -ErrorAction SilentlyContinue
  W '--- POR QUE SE CORTO ---'

  if ($ultimoOk) {
    W ("  Lo que SI hay dentro de: {0}" -f $ultimoOk)
    try {
      Get-ChildItem -LiteralPath $ultimoOk -Directory -Force -ErrorAction Stop | Sort-Object Name |
        ForEach-Object {
          # Se marcan los nombres con caracteres invisibles, que son los que hacen
          # que una ruta escrita a mano no matchee.
          $raro = ''
          if ($_.Name -match '  ') { $raro = '   <-- ESPACIO DOBLE' }
          elseif ($_.Name -ne $_.Name.Trim()) { $raro = '   <-- ESPACIO AL BORDE' }
          elseif ($_.Name.ToCharArray() | Where-Object { [int]$_ -gt 126 }) { $raro = '   <-- tiene acentos o caracteres especiales' }
          W ("    [{0}]{1}" -f $_.Name, $raro)
        }
    } catch { W ("    (no pude listarlo: {0})" -f $_.Exception.Message) }
    W ''
  }

  # Quien SI puede leer la carpeta trabada. Esto es lo que define con que cuenta
  # tiene que correr la tarea programada.
  W ("  Permisos de: {0}" -f $trabado)
  if ($existe) {
    try {
      $acl = Get-Acl -LiteralPath $trabado -ErrorAction Stop
      W ("    Dueño: {0}" -f $acl.Owner)
      W '    Quien tiene acceso:'
      $acl.Access | ForEach-Object {
        W ("      {0,-40} {1} {2}" -f $_.IdentityReference, $_.AccessControlType, $_.FileSystemRights)
      }
    } catch { W ("    No pude leer los permisos: {0}" -f $_.Exception.Message) }
  } else {
    if ($trabado.StartsWith('\')) {
      # Sobre una ruta de red, "no existe" puede ser en realidad "no estoy
      # autenticado contra ese servidor". Windows las reporta igual.
      W '    Es una ruta de RED. Sobre red, "no existe" puede significar en'
      W '    realidad que esta maquina no esta autenticada contra el servidor.'
      W '    Ver mas abajo si hay credencial guardada.'
    } else {
      W '    La carpeta no existe, asi que no es un tema de permisos.'
      W '    Revisar el nombre exacto en el listado de arriba.'
    }
  }
  W ''
}

# ---------------------------------------------------------------------------
# 3. Si se llego, buscar el archivo
# ---------------------------------------------------------------------------
if (-not $trabado) {
  $carpeta = $NIVELES[-1]
  W '--- BUSCANDO EL ARCHIVO ---'
  $errs = $null
  $arch = @(Get-ChildItem -LiteralPath $carpeta -Recurse -File -Force -ErrorAction SilentlyContinue -ErrorVariable errs |
            Where-Object { $_.Extension -in @('.xlsx','.xlsm','.xls') -and $_.Name -notlike '~$*' })
  W ("  Excels: {0}    Subcarpetas ilegibles: {1}" -f $arch.Count, @($errs).Count)
  W ''
  $arch | Sort-Object LastWriteTime -Descending | Select-Object -First 15 | ForEach-Object {
    W ("  {0:yyyy-MM-dd HH:mm}  {1,6:N0} KB  {2}" -f $_.LastWriteTime, ($_.Length/1KB), $_.FullName.Substring($carpeta.Length))
  }
  W ''
  $m = $arch | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($m) {
    W '--- PRUEBA DE LECTURA DEL MAS RECIENTE ---'
    W ("  {0}" -f $m.FullName)
    try {
      # ReadWrite en el share mode es la clave: permite leerlo aunque Excel lo
      # tenga abierto, que va a ser el caso normal en horario de trabajo.
      $fs = [IO.File]::Open($m.FullName, 'Open', 'Read', 'ReadWrite')
      $b = New-Object byte[] 4; [void]$fs.Read($b,0,4); $fs.Close()
      W ("  Lectura: OK    xlsx valido: {0}" -f $(if ($b[0] -eq 0x50 -and $b[1] -eq 0x4B) { 'si' } else { 'NO' }))
      W ("  Modificado: {0:yyyy-MM-dd HH:mm:ss}" -f $m.LastWriteTime)
    } catch { W ("  NO se pudo leer: {0}" -f $_.Exception.Message) }
  }
  W ''
}

# ---------------------------------------------------------------------------
# 4. Lo que el agente necesita de ESTA maquina
# ---------------------------------------------------------------------------
W '--- ESTA MAQUINA ---'
try {
  $os = Get-CimInstance Win32_OperatingSystem
  W ("  Windows  : {0}" -f $os.Caption)
  W ("  Prendida : hace {0:N1} dias" -f ((Get-Date) - $os.LastBootUpTime).TotalDays)
} catch {}
$nd = Get-Command node -ErrorAction SilentlyContinue
W ("  Node     : {0}" -f $(if ($nd) { (& node --version) + '  (' + $nd.Source + ')' } else { 'NO instalado' }))
W '  Credencial guardada para 192.168.0.210:'
$ck = @(cmd /c "cmdkey /list 2>nul" | Select-String '192.168.0.210')
if ($ck.Count) { $ck | ForEach-Object { W ("    {0}" -f $_.ToString().Trim()) } }
else {
  W '    NINGUNA'
  W '    OJO: si el acceso al recurso se hizo tipeando la clave sin tildar'
  W '    "recordar credenciales", despues de reiniciar la tarea deja de andar.'
}
W ''

$L -join "`r`n" | Set-Content -LiteralPath $salida -Encoding UTF8
W '============================================================'
W ("  Informe: {0}" -f $salida)
W '  Mandame ese archivo.'
W '============================================================'
W ''
Read-Host '  Enter para salir' | Out-Null
