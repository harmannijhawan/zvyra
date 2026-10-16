@echo off
REM ============================================================================
REM  ZVYRA - build the macOS .dmg from Windows.
REM
REM  A .dmg CANNOT be built on Windows itself (it needs macOS/Xcode/hdiutil).
REM  So this script drives GitHub's real macOS cloud runner to build it, then
REM  downloads the finished .dmg to:  release\dmg\
REM
REM  First run does the one-time setup (git repo + push). Later runs just push
REM  your latest changes, rebuild on the Mac runner, and fetch the new .dmg.
REM
REM  REQUIREMENTS (install once, both are free):
REM    1. Git           -> https://git-scm.com/download/win
REM    2. GitHub CLI    -> https://cli.github.com/   (the 'gh' command)
REM  You also need a free GitHub account.
REM ============================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo(
echo === ZVYRA macOS .dmg builder ===
echo(

REM ---- 1. Check prerequisites ------------------------------------------------
where git >nul 2>nul
if errorlevel 1 (
  echo [X] Git is not installed or not on PATH.
  echo     Install it from https://git-scm.com/download/win  then run this again.
  goto :fail
)
where gh >nul 2>nul
if errorlevel 1 (
  echo [X] GitHub CLI ^(gh^) is not installed or not on PATH.
  echo     Install it from https://cli.github.com/  then run this again.
  goto :fail
)

REM ---- 2. Make sure gh is logged in -----------------------------------------
gh auth status >nul 2>nul
if errorlevel 1 (
  echo [*] You are not logged in to GitHub. Opening login...
  gh auth login || goto :fail
)

REM ---- 3. Initialise the git repo on first run ------------------------------
if not exist ".git" (
  echo [*] First run: initialising a git repository...
  git init -b main || goto :fail
  git add . || goto :fail
  git commit -m "ZVYRA with macOS build" || goto :fail
) else (
  echo [*] Committing any local changes...
  git add .
  git commit -m "Update ZVYRA" >nul 2>nul
)

REM ---- 4. Make sure there is a GitHub remote --------------------------------
git remote get-url origin >nul 2>nul
if errorlevel 1 (
  echo [*] No GitHub remote yet. Creating one and pushing...
  echo     ^(gh will ask for a repository name; a private repo is fine.^)
  gh repo create --source=. --private --push || goto :fail
) else (
  echo [*] Pushing to GitHub...
  git push -u origin main || goto :fail
)

REM ---- 5. Trigger the macOS build workflow ----------------------------------
echo(
echo [*] Starting the macOS build on a GitHub cloud runner...
gh workflow run "build-mac.yml" || goto :fail

echo [*] Waiting a few seconds for the run to register...
timeout /t 8 /nobreak >nul

REM ---- 6. Find the run id and watch it to completion ------------------------
for /f "delims=" %%i in ('gh run list --workflow "build-mac.yml" --limit 1 --json databaseId -q ".[0].databaseId"') do set RUN_ID=%%i
if "%RUN_ID%"=="" (
  echo [X] Could not find the workflow run. Check the Actions tab on GitHub.
  goto :fail
)
echo [*] Build run id: %RUN_ID%
echo [*] Watching the build ^(this takes several minutes on the Mac runner^)...
gh run watch %RUN_ID% --exit-status
if errorlevel 1 (
  echo(
  echo [X] The macOS build failed. See the log above or run:
  echo        gh run view %RUN_ID% --log-failed
  goto :fail
)

REM ---- 7. Download the .dmg artifact ----------------------------------------
echo(
echo [*] Build succeeded. Downloading the .dmg ...
if not exist "release\dmg" mkdir "release\dmg"
gh run download %RUN_ID% -n zvyra-macos -D "release\dmg" || goto :fail

echo(
echo ============================================================
echo  DONE. Your macOS installers are in:  release\dmg\
echo ============================================================
dir /b "release\dmg"
echo(
echo  - ZVYRA-*-arm64.dmg  = Apple Silicon Macs ^(M1/M2/M3/M4^)
echo  - ZVYRA-*-x64.dmg    = Intel Macs
echo(
echo  Note: the .dmg is UNSIGNED unless you added Apple signing secrets
echo  (see release\mac\CI-BUILD.md). Unsigned works for your own Mac:
echo  right-click the app -^> Open the first time to pass Gatekeeper.
echo(
pause
exit /b 0

:fail
echo(
echo Build did not complete. Nothing was produced. Fix the issue above and retry.
echo(
pause
exit /b 1
