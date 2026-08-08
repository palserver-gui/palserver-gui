@echo off
rem ============================================================
rem  palserver GUI - run agent from source (dev mode)
rem
rem  Web UI: http://localhost:8250
rem
rem  Closing this window stops the agent, but NOT the game server:
rem  PalServer is spawned detached and keeps running. The agent
rem  re-adopts it via server.pid on the next start.
rem
rem  Caveat: do not save source files while a server install or
rem  update is running - DepotDownloader is a child of the agent
rem  and a watch-restart would kill the download.
rem
rem  NOTE: this file is intentionally ASCII-only. cmd.exe parses a
rem  .bat with the current OEM codepage, so non-ASCII text here
rem  gets mangled once "chcp 65001" switches the codepage midway.
rem ============================================================
setlocal
chcp 65001 >nul
title palserver agent (source)
cd /d "%~dp0"

rem pnpm is not on PATH on this machine, so everything goes through
rem corepack. The root dev:agent script shells out to "pnpm" again and
rem would fail, hence the per-package calls below.

echo [1/4] building @palserver/shared ...
call corepack pnpm --filter @palserver/shared build
if errorlevel 1 goto fail

echo [2/4] building @palserver/discord-bot ...
call corepack pnpm --filter @palserver/discord-bot build
if errorlevel 1 goto fail

rem The agent serves packages/web/dist when it exists (resolved once at
rem startup). Without it you only get the REST API on :8250. Built on demand
rem here because it is gitignored; run this manually after editing the UI:
rem     corepack pnpm --filter @palserver/web build
if exist "packages\web\dist\index.html" goto webready
echo [3/4] building @palserver/web (first run only) ...
call corepack pnpm --filter @palserver/web build
if errorlevel 1 goto fail
goto webdone
:webready
echo [3/4] web/dist present - skipping UI build
:webdone

echo.
echo [4/4] starting agent on http://localhost:8250
echo.
call corepack pnpm --filter @palserver/agent dev
goto end

:fail
echo.
echo *** build failed - see the errors above ***
echo     missing deps? run: corepack pnpm install
echo.
pause
exit /b 1

:end
echo.
echo agent stopped. (the game server may still be running)
pause
