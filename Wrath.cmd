@echo off
rem ---------------------------------------------------------------------------
rem  Wrath launcher (with console). The desktop shortcut uses Wrath.vbs.
rem  Arguments are passed to the CLI, e.g. "Wrath.cmd login".
rem ---------------------------------------------------------------------------

setlocal
title Wrath

rem run from this folder
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo   Node.js is not installed, or is not on your PATH.
    echo   Get it from https://nodejs.org and run this again.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo.
    echo   First run: installing dependencies, this takes a moment...
    echo.
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo   Dependency install failed. Scroll up for the reason.
        echo.
        pause
        exit /b 1
    )
)

node "src\index.js" %*
set "EXITCODE=%ERRORLEVEL%"

rem 3221225786 = ctrl+c, not a crash
if "%EXITCODE%"=="0" goto :done
if "%EXITCODE%"=="3221225786" goto :done

echo.
echo   Wrath stopped with exit code %EXITCODE%. The reason is above.
echo.
pause

:done
endlocal
