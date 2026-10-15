@echo off
rem Runs Dalang at Windows logon: autostart.cmd install|restart|stop|status|uninstall. See scripts\autostart.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\autostart.ps1" %*
