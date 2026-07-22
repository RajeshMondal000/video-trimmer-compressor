@echo off
echo ================================
echo Video Tool Setup Helper
echo ================================
echo.

echo Checking if FFmpeg is installed...
ffmpeg -version >nul 2>&1
if %errorlevel% == 0 (
    echo ✓ FFmpeg is already installed!
    ffprobe -version >nul 2>&1
    if %errorlevel% == 0 (
        echo ✓ FFprobe is already installed!
        echo.
        echo All dependencies are ready. You can now run:
        echo   python app.py
        pause
        exit /b 0
    )
)

echo ✗ FFmpeg is not installed or not in PATH
echo.
echo This application requires FFmpeg to process videos.
echo.
echo Installation options:
echo 1. Automatic download and installation (recommended)
echo 2. Chocolatey installation (requires admin rights)
echo 3. Manual installation instructions
echo.
set /p choice="Choose option (1, 2, or 3): "

if "%choice%"=="1" (
    echo.
    echo Downloading and installing FFmpeg automatically...
    powershell -Command "& {$ffmpegUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'; $ffmpegZip = '$env:TEMP\ffmpeg.zip'; Invoke-WebRequest -Uri $ffmpegUrl -OutFile $ffmpegZip; Expand-Archive -Path $ffmpegZip -DestinationPath 'C:\' -Force; if (Test-Path 'C:\ffmpeg') { Remove-Item 'C:\ffmpeg' -Recurse -Force }; Get-ChildItem 'C:\' | Where-Object {$_.Name -like '*ffmpeg*'} | Rename-Item -NewName 'ffmpeg'; [Environment]::SetEnvironmentVariable('PATH', [Environment]::GetEnvironmentVariable('PATH', 'User') + ';C:\ffmpeg\bin', 'User')}"
    echo.
    echo Installation complete! Please restart this script to verify.
    echo Note: You may need to restart your command prompt for PATH changes to take effect.
) else if "%choice%"=="2" (
    echo.
    echo Checking for Chocolatey...
    choco -v >nul 2>&1
    if %errorlevel% == 0 (
        echo ✓ Chocolatey found. Installing FFmpeg...
        choco install ffmpeg -y
        echo.
        echo Installation complete! Please restart this script to verify.
    ) else (
        echo ✗ Chocolatey not found. 
        echo Please install Chocolatey first from: https://chocolatey.org/install
        echo Or choose option 1 for automatic installation.
    )
) else if "%choice%"=="3" (
    echo.
    echo Manual Installation Instructions:
    echo ================================
    echo 1. Go to https://ffmpeg.org/download.html
    echo 2. Download "Windows builds by BtbN" or similar
    echo 3. Extract the downloaded archive to a folder like C:\ffmpeg
    echo 4. Add C:\ffmpeg\bin to your system PATH environment variable
    echo 5. Restart your command prompt and try again
    echo.
    echo Detailed PATH setup:
    echo - Press Win + X, choose "System"
    echo - Click "Advanced system settings"
    echo - Click "Environment Variables"
    echo - Select "Path" in System variables, click "Edit"
    echo - Click "New" and add your ffmpeg\bin path
    echo - Click OK to save and restart command prompt
) else (
    echo Invalid option selected.
)

echo.
pause