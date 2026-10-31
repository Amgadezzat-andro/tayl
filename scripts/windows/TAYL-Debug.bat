@echo off
cd /d "%~dp0..\.."
set TAYL_DEBUG=1
echo TAYL debug mode - close this window to stop the server.
start "" http://127.0.0.1:3737
node server\index.js
pause
