@echo off
REM ===================================================================
REM  Regenera el PDF de la guia tecnica a partir del HTML.
REM  Se usa cada vez que agregas o cambias una captura.
REM
REM  Como se usa: doble click en este archivo.
REM ===================================================================

setlocal
cd /d "%~dp0"

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "CHROME=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"

if not defined CHROME (
  echo.
  echo   No encontre Chrome ni Edge instalado.
  echo   Alternativa: abri guia-tecnica.html en el navegador,
  echo   Ctrl+P, y elegi "Guardar como PDF".
  echo.
  pause
  exit /b 1
)

echo.
echo   Generando el PDF...
echo.

"%CHROME%" --headless --disable-gpu --no-pdf-header-footer ^
  --print-to-pdf="%~dp0Guia-Tecnica-Factura-ARCA.pdf" ^
  "file:///%~dp0guia-tecnica.html" >nul 2>&1

if exist "%~dp0Guia-Tecnica-Factura-ARCA.pdf" (
  echo   LISTO: Guia-Tecnica-Factura-ARCA.pdf
) else (
  echo   Algo fallo. Proba abriendo el HTML y usando Ctrl+P.
)

echo.
pause
