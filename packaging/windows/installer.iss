#ifndef SourceDir
  #error SourceDir is required
#endif
#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef AppIcon
  #error AppIcon is required
#endif

[Setup]
AppId=app.flowave.desktop
AppName=Flowave
AppVersion={#AppVersion}
AppPublisher=Kumiko
AppPublisherURL=https://github.com/nadeshikochan/Flowave
DefaultDirName={localappdata}\Programs\Flowave
DefaultGroupName=Flowave
DisableProgramGroupPage=yes
DisableDirPage=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
SetupIconFile={#AppIcon}
UninstallDisplayIcon={app}\Flowave.exe
OutputBaseFilename=Flowave-{#AppVersion}-x64-Setup
Compression=lzma2/ultra64
SolidCompression=yes
CloseApplications=no
RestartApplications=no
UninstallDisplayName=Flowave

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "installer-check.ps1"; Flags: dontcopy

[Icons]
Name: "{userprograms}\Flowave"; Filename: "{app}\Flowave.exe"
Name: "{userdesktop}\Flowave"; Filename: "{app}\Flowave.exe"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\backend\source\__pycache__"

[Code]
function CheckProgramDirectory(const Script, ProgramDir: String): Integer;
var
  Parameters, RegisteredDir: String;
begin
  Parameters := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + AddQuotes(Script)
    + ' -InstallDir ' + AddQuotes(RemoveBackslashUnlessRoot(ProgramDir));
  if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\app.flowave.desktop_is1', 'InstallLocation', RegisteredDir) and (RegisteredDir <> '') then
    Parameters := Parameters + ' -RegisteredDir ' + AddQuotes(RemoveBackslashUnlessRoot(RegisteredDir));
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Parameters, '', SW_HIDE, ewWaitUntilTerminated, Result) then
    Result := 43;
end;

function CheckMessage(const Code: Integer): String;
begin
  case Code of
    0: Result := '';
    41: Result := '该目录包含便携版或个人数据。请为程序选择空目录，另行保管已有 data 和 models。';
    42: Result := '请先退出该目录中的 Flowave，并等待后台任务结束后重试。';
  else
    Result := '无法检查程序目录，请确认目录可访问后重试。';
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  ExtractTemporaryFile('installer-check.ps1');
  Result := CheckMessage(CheckProgramDirectory(ExpandConstant('{tmp}\installer-check.ps1'), ExpandConstant('{app}')));
end;

function InitializeUninstall: Boolean;
var
  Code: Integer;
begin
  Code := CheckProgramDirectory(ExpandConstant('{app}\resources\installer-check.ps1'), ExpandConstant('{app}'));
  Result := Code = 0;
  if (not Result) and (not UninstallSilent) then
    MsgBox(CheckMessage(Code), mbError, MB_OK);
  if Result and (not UninstallSilent) then
    Result := MsgBox('听歌记录、设置、插件、模型、索引和分析成果将保留在以下目录，重装后可继续使用。' + #13#10
      + ExpandConstant('{localappdata}\Flowave\data'), mbInformation, MB_OKCANCEL or MB_DEFBUTTON2) = IDOK;
end;
