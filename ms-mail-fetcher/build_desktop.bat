@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM ===== Project paths (this .bat should be placed in workspace root) =====
set "ROOT_DIR=%~dp0"
set "WEB_DIR=%ROOT_DIR%ms-mail-fetcher-web"
set "SERVER_DIR=%ROOT_DIR%ms-mail-fetcher-server"
set "DESKTOP_DIR=%ROOT_DIR%ms-mail-fetcher-desktop"
set "WEB_DIST_DIR=%WEB_DIR%\dist"
set "DESKTOP_TEMPLATE_DIR=%DESKTOP_DIR%\template"
set "DESKTOP_DIST_DIR=%DESKTOP_DIR%\dist"


echo [1/4] Build frontend...
if not exist "%WEB_DIR%" (
  echo [ERROR] Web directory not found: %WEB_DIR%
  exit /b 1
)
pushd "%WEB_DIR%"
call npm run build
if errorlevel 1 (
  echo [ERROR] Frontend build failed.
  popd
  exit /b 1
)
popd


echo [2/4] Replace desktop template directory...
if not exist "%WEB_DIST_DIR%" (
  echo [ERROR] Frontend dist not found: %WEB_DIST_DIR%
  exit /b 1
)
if not exist "%DESKTOP_DIR%" (
  echo [ERROR] Desktop directory not found: %DESKTOP_DIR%
  exit /b 1
)
if exist "%DESKTOP_TEMPLATE_DIR%" (
  rmdir /s /q "%DESKTOP_TEMPLATE_DIR%"
)
mkdir "%DESKTOP_TEMPLATE_DIR%"
xcopy "%WEB_DIST_DIR%\*" "%DESKTOP_TEMPLATE_DIR%\" /E /I /Y >nul
if errorlevel 1 (
  echo [ERROR] Copy dist to desktop template failed.
  exit /b 1
)


echo [3/4] Clean desktop dist directory before packaging...
taskkill /F /IM ms-mail-fetcher.exe >nul 2>&1
timeout /t 1 /nobreak >nul
if exist "%DESKTOP_DIST_DIR%" (
  set /a RETRY_COUNT=0
  :DELETE_DESKTOP_DIST
  set /a RETRY_COUNT+=1
  rmdir /s /q "%DESKTOP_DIST_DIR%"
  if exist "%DESKTOP_DIST_DIR%" (
    if !RETRY_COUNT! LSS 4 (
      echo [WARN] dist is in use, retry !RETRY_COUNT!/3 ...
      timeout /t 2 /nobreak >nul
      goto DELETE_DESKTOP_DIST
    ) else (
      echo [ERROR] Failed to delete dist after retries. Files are still locked.
      echo [HINT] Please close running app windows/processes and try again.
      exit /b 1
    )
  )
)


echo [4/4] Build desktop package with PyInstaller...
if not exist "%SERVER_DIR%" (
  echo [ERROR] Server directory not found: %SERVER_DIR%
  exit /b 1
)
pushd "%DESKTOP_DIR%"
call python -m PyInstaller --clean ms-mail-fetcher-desktop.spec
if errorlevel 1 (
  echo [ERROR] PyInstaller build failed.
  popd
  exit /b 1
)
popd

echo.
echo [DONE] Build completed successfully.
echo Output: %DESKTOP_DIR%\dist\ms-mail-fetcher\ms-mail-fetcher.exe
exit /b 0

