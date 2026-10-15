@echo off
rem Rebuild + restart AselDev Harness (see rebuild-aseldev.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rebuild-aseldev.ps1"
