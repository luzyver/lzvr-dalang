@echo off
rem Runs Dalang on Windows: run.cmd [-Dev] [-Install]. See scripts\run.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run.ps1" %*
