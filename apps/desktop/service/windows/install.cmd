@echo off
REM CrewBus desktop — register the logon task (run once, elevated not required).
REM Adjust the exe path inside CrewBus-Logon.xml first if you installed
REM per-machine (default below is the per-user Tauri NSIS path).
setlocal
schtasks /create /tn "CrewBus" /xml "%~dp0CrewBus-Logon.xml" /f
echo Registered. Verify with: schtasks /query /tn "CrewBus"
echo Start it now with: schtasks /run /tn "CrewBus"
echo Remove with: schtasks /delete /tn "CrewBus" /f
endlocal
