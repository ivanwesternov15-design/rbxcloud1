@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions EnableDelayedExpansion

rem ============ COLORS ============
for /F %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
set "R=%ESC%[0m"
set "B=%ESC%[1m"
set "RED=%ESC%[91m"
set "GRN=%ESC%[92m"
set "YEL=%ESC%[93m"
set "BLU=%ESC%[94m"
set "CYN=%ESC%[96m"

title Robux Clicker - Server and tunnel

echo.
echo %B%%CYN%====================================================%R%
echo %B%%CYN%            ROBUX CLICKER - LAUNCHER             %R%
echo %B%%CYN%====================================================%R%
echo.

cd /d "%~dp0"

rem ============ CHECK PYTHON ============
where python >nul 2>&1
if errorlevel 1 (
    echo %RED%[ERROR]%R% Python not found!
    echo    Install Python from https://python.org
    echo.
    pause
    exit /b 1
)
echo %GRN%[OK]%R% Python found.

rem ============ FIND NGROK ============
set "NGROK="
if exist "C:\Users\wiazy\ngrok-latest\ngrok.exe" set "NGROK=C:\Users\wiazy\ngrok-latest\ngrok.exe"
if not defined NGROK if exist "%~dp0ngrok.exe" set "NGROK=%~dp0ngrok.exe"
if not defined NGROK if exist "%USERPROFILE%\ngrok.exe" set "NGROK=%USERPROFILE%\ngrok.exe"
if not defined NGROK if exist "%LOCALAPPDATA%\Python\Python314\Scripts\ngrok.exe" set "NGROK=%LOCALAPPDATA%\Python\Python314\Scripts\ngrok.exe"
if not defined NGROK (
    echo %YEL%[WARNING]%R% ngrok not found. Continuing without tunnel.
    set "NGROK_MODE=NO_NGROK"
) else (
    echo %GRN%[OK]%R% ngrok found.
)

rem ============ CHECK PORT ============
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo %RED%[ERROR]%R% Port 3000 already in use!
    echo    Close the old server process and try again.
    echo.
    pause
    exit /b 1
)
echo %GRN%[OK]%R% Port 3000 is free.

rem ============ START NGROK ============
if not defined NGROK_MODE (
    echo %CYN%[INFO]%R% Starting ngrok tunnel...
    start "ngrok-tunnel" "%NGROK%" http 3000
    timeout /t 4 /nobreak >nul 2>&1

    set "PUBLIC_URL="
    for /l %%n in (1,1,10) do (
        if not defined PUBLIC_URL (
            for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "try { (Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 3).tunnels[0].public_url } catch { '' }"`) do set "PUBLIC_URL=%%i"
            if not defined PUBLIC_URL timeout /t 2 /nobreak >nul 2>&1
        )
    )
    if defined PUBLIC_URL (
        echo %GRN%[SUCCESS]%R% Public URL: %BLU%!PUBLIC_URL!%R%
        echo.
        echo    %B%Share this link:  %CYN%!PUBLIC_URL!%R%
        echo.
    ) else (
        echo %YEL%[WARNING]%R% Could not get ngrok URL.
        echo    Check the ngrok-tunnel window.
    )
)

echo.
echo %B%%GRN%====================================================%R%
echo %B%%GRN%   Starting server... logs below                %R%
echo %B%%GRN%   Stop: CTRL+C                                  %R%
echo %B%%GRN%====================================================%R%
echo.

rem ============ START SERVER.PY ============
python -u server.py

rem ============ AFTER STOP ============
echo.
echo %YEL%[INFO]%R% Server stopped. Stopping tunnel...
if not defined NGROK_MODE (
    taskkill /f /im ngrok.exe >nul 2>&1
)
echo %GRN%[OK]%R% Tunnel stopped.
echo.
timeout /t 3 /nobreak >nul 2>&1
exit /b 0
