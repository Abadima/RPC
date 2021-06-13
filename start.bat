@echo off
echo Starting..
:main
node app.js
echo Retrying Rich Presence..
goto main