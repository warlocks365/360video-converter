; ============================================================================
; 360 Video Converter - Windows Installer Script
; Built with Inno Setup 6.7+
; Generates a standard Windows installer with desktop & Start Menu shortcuts
; ============================================================================

#define MyAppName "360 Video Converter"
; Read version from VERSION file for consistent versioning across builds
#define VersionFileHandle FileOpen(AddBackslash(SourcePath) + "VERSION")
#if VersionFileHandle != 0
  #define MyAppVersion Trim(FileRead(VersionFileHandle))
  #expr FileClose(VersionFileHandle)
#else
  #define MyAppVersion "0.0.0"
#endif
#define MyAppVersion4 MyAppVersion + ".0"
#define MyAppPublisher "360VideoConverter"
#define MyAppExeName "360VideoConverter.exe"
#define MyAppDescription "360° Panoramic Video Converter & Metadata Tool"

[Setup]
; NOTE: The value of AppId uniquely identifies this application.
; Do not use the same AppId value in installers for other applications.
AppId={{B8F3A7E2-4D6C-4A9F-9E3B-1C5D8A2F7E04}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL=https://github.com/warlocks365/360video-converter
AppSupportURL=https://github.com/warlocks365/360video-converter
AppUpdatesURL=https://github.com/warlocks365/360video-converter
AppContact=360 Video Converter
AppComments={#MyAppDescription}

; Default installation directory
DefaultDirName={commonpf}\360video-converter
DefaultGroupName={#MyAppName}

; Allow user to change install directory
DisableDirPage=no
; Allow user to change Start Menu group
DisableProgramGroupPage=no

; Uninstaller
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}

; Compression - ultra for best ratio on 743MB of mostly DLL data
Compression=lzma2/ultra64
SolidCompression=yes
LZMAUseSeparateProcess=yes

; Architecture - 64-bit only
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; Requires admin privileges to install to Program Files
PrivilegesRequired=admin

; Modern wizard style for Windows 11
WizardStyle=modern
ShowLanguageDialog=yes

; Output
OutputDir=installer_output
OutputBaseFilename=360VideoConverter_Setup_v{#MyAppVersion}

; Disk spanning off (single file installer)
DiskSpanning=no

; Don't allow multiple instances of the installer
AppMutex=360VideoConverter_Setup_Mutex,Global\360VideoConverter_Setup_Mutex

; Close applications using the files being installed
CloseApplications=no

; Version info embedded in installer file
VersionInfoVersion={#MyAppVersion4}
VersionInfoCompany={#MyAppPublisher}
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion4}

[Languages]
Name: "chinesesimplified"; MessagesFile: "languages\ChineseSimplified.isl"
Name: "chinesetraditional"; MessagesFile: "languages\ChineseTraditional.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
; English
english.LaunchProgram=Launch {#MyAppName}
english.DeleteUserDataQuestion=Do you want to delete user data (presets, task lists, settings)?
english.DeleteUserDataLocation=Location: %1
english.CreateStartMenuShortcut=Create Start Menu shortcut(s)
; Chinese Simplified
chinesesimplified.LaunchProgram=启动 {#MyAppName}
chinesesimplified.DeleteUserDataQuestion=是否删除用户数据（预设、任务列表、设置）？
chinesesimplified.DeleteUserDataLocation=位置: %1
chinesesimplified.CreateStartMenuShortcut=创建开始菜单快捷方式
; Chinese Traditional
chinesetraditional.LaunchProgram=啟動 {#MyAppName}
chinesetraditional.DeleteUserDataQuestion=是否刪除使用者資料（預設、任務列表、設定）？
chinesetraditional.DeleteUserDataLocation=位置: %1
chinesetraditional.CreateStartMenuShortcut=建立開始功能表捷徑

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce
Name: "startmenu"; Description: "{cm:CreateStartMenuShortcut}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Files]
; Main executable
Source: "dist\360VideoConverter.exe"; DestDir: "{app}"; Flags: ignoreversion
; FFmpeg tools
Source: "dist\ffmpeg.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\ffprobe.exe"; DestDir: "{app}"; Flags: ignoreversion
; All DLL dependencies (optional — static build has no DLLs)
Source: "dist\*.dll"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
; README
Source: "dist\README.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Start Menu - Main application (always created)
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Comment: "{#MyAppDescription}"
; Start Menu - Uninstall
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"; Comment: "Remove {#MyAppName}"
; Desktop shortcut (conditional on task)
Name: "{commondesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Comment: "{#MyAppDescription}"; Tasks: desktopicon

[Run]
; Option to launch the app after installation
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram}"; Flags: nowait postinstall skipifsilent runascurrentuser

[UninstallRun]
; Kill the app if it's running before uninstall
Filename: "taskkill"; Parameters: "/F /IM {#MyAppExeName}"; Flags: runhidden; RunOnceId: "KillApp"

[UninstallDelete]
; Clean up empty directories
Type: dirifempty; Name: "{app}"

[Code]
// Check if app is running before install/upgrade
function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  // Try to kill any running instance
  if Exec(ExpandConstant('{cmd}'), '/C taskkill /F /IM {#MyAppExeName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    // Killed successfully, wait a moment for file handles to release
    Sleep(1000);
  end;
  Result := True;
end;

// Clean up before uninstall
function InitializeUninstall(): Boolean;
var
  ResultCode: Integer;
begin
  if Exec(ExpandConstant('{cmd}'), '/C taskkill /F /IM {#MyAppExeName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    Sleep(1000);
  end;
  Result := True;
end;

// Ask user if they want to delete user data on uninstall
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  AppDataPath: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    AppDataPath := ExpandConstant('{userappdata}\360VideoConverter');
    if DirExists(AppDataPath) then
    begin
      if MsgBox(ExpandConstant('{cm:DeleteUserDataQuestion}') + #13#10 +
                 Format(ExpandConstant('{cm:DeleteUserDataLocation}'), [AppDataPath]),
                 mbConfirmation, MB_YESNO) = IDYES then
      begin
        DelTree(AppDataPath, True, True, True);
      end;
    end;
  end;
end;
