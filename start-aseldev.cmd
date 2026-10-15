@echo off
rem Runs YOUR AselDev Harness build with its own settings folder,
rem so it never clashes with the official "npx @deepseek-ai/dsh" version.
rem Everything printed is also saved to %USERPROFILE%\.dsh-aseldev\last-start.log
set "DSH_HOME=%USERPROFILE%\.dsh-aseldev"
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "pnpm dsh web 2>&1 | ForEach-Object { \"$_\" } | Tee-Object -FilePath \"$env:DSH_HOME\last-start.log\""
