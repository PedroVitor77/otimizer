@echo off
title PulsePC - Modo Navegador
cd /d "%~dp0"

set "PY_EXE=C:\Users\pedro\AppData\Local\Programs\Python\Python312\python.exe"
if not exist "%PY_EXE%" set "PY_EXE=python"

echo Iniciando servidor PulsePC e abrindo no navegador...
"%PY_EXE%" "%~dp0app.py" --browser
pause
