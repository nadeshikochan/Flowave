#ifndef SourceDir
  #error SourceDir is required
#endif
#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef AppIcon
  #error AppIcon is required
#endif
#ifndef ApplicationId
  #define ApplicationId "app.flowave.desktop"
#endif
#ifndef ShortcutLabel
  #define ShortcutLabel "Flowave"
#endif

[Setup]
AppId={#ApplicationId}
AppName={#ShortcutLabel}
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
UninstallDisplayName={#ShortcutLabel}

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "installer-check.ps1"; Flags: dontcopy
Source: "data-location.ps1"; Flags: dontcopy

[Icons]
Name: "{userprograms}\{#ShortcutLabel}"; Filename: "{app}\Flowave.exe"
Name: "{userdesktop}\{#ShortcutLabel}"; Filename: "{app}\Flowave.exe"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\backend\source\__pycache__"

[Code]
var
  DataPage: TInputDirWizardPage;
  StorageProgress: TOutputProgressWizardPage;
  DataPrepared: Boolean;

function LocationFile: String;
var
  LocalDir: String;
begin
  LocalDir := GetEnv('LOCALAPPDATA');
  if LocalDir = '' then LocalDir := ExpandConstant('{localappdata}');
  Result := AddBackslash(LocalDir) + 'Flowave\data-location.txt';
end;

function SavedDataDirectory: String;
var
  Lines: TArrayOfString;
begin
  Result := '';
  if LoadStringsFromFile(LocationFile, Lines) and (GetArrayLength(Lines) > 0) then
    Result := Trim(Lines[0]);
end;

procedure InitializeWizard;
begin
  DataPage := CreateInputDirPage(wpSelectDir, '软件数据存储位置',
    '请选择空间充足的数据文件夹，建议使用非系统盘。',
    '这里将保存听歌记录、设置、歌单、插件、模型和运行环境、曲库索引、分析结果、分轨、听歌轨迹、下载与缓存。' + #13#10#13#10
    + '占用会随安装功能和曲库规模增长。卸载软件保留此目录，请妥善备份。已有数据更换位置时会先复制并校验，原文件保留供核对。',
    False, 'FlowaveData');
  DataPage.Add('数据文件夹');
  DataPage.Values[0] := ExpandConstant('{param:DATADIR|}');
  if DataPage.Values[0] = '' then DataPage.Values[0] := SavedDataDirectory;
  StorageProgress := CreateOutputProgressPage('准备软件数据', '正在检查数据目录与已有内容。');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = DataPage.ID) and (Trim(DataPage.Values[0]) = '') then begin
    MsgBox('请选择软件数据存储位置，建议使用空间充足的非系统盘。', mbInformation, MB_OK);
    Result := False;
  end;
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo,
  MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result := MemoDirInfo + NewLine + NewLine + '软件数据存储位置' + NewLine + Space + DataPage.Values[0]
    + NewLine + Space + '记录、模型、索引、分析、分轨和缓存均存储于此，卸载后保留。'
    + NewLine + NewLine + MemoGroupInfo + NewLine + MemoTasksInfo;
end;

procedure OnStorageProgress(const S: String; const Error, FirstLine: Boolean);
begin
  Log(S);
  if not WizardSilent then
    StorageProgress.SetText(S, '全部校验通过后再切换目录，原数据保留。');
end;

function RunStorageAction(const Action: String): String;
var
  Code: Integer;
  Parameters, ErrorFile: String;
  Lines: TArrayOfString;
begin
  Result := '';
  ErrorFile := ExpandConstant('{tmp}\flowave-storage-error.txt');
  DeleteFile(ErrorFile);
  Parameters := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File '
    + AddQuotes(ExpandConstant('{tmp}\data-location.ps1')) + ' -Action ' + Action
    + ' -DataDir ' + AddQuotes(DataPage.Values[0]) + ' -InstallDir ' + AddQuotes(ExpandConstant('{app}'))
    + ' -ErrorFile ' + AddQuotes(ErrorFile);
  if not ExecAndLogOutput(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Parameters,
      '', SW_HIDE, ewWaitUntilTerminated, Code, @OnStorageProgress) then Code := 44;
  if Code <> 0 then begin
    Result := '数据目录准备失败，原数据保留。';
    if LoadStringsFromFile(ErrorFile, Lines) and (GetArrayLength(Lines) > 0) then Result := Lines[0];
  end;
end;

function CheckProgramDirectory(const Script, ProgramDir: String): Integer;
var
  Parameters, RegisteredDir: String;
begin
  Parameters := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + AddQuotes(Script)
    + ' -InstallDir ' + AddQuotes(RemoveBackslashUnlessRoot(ProgramDir));
  if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#ApplicationId}_is1', 'InstallLocation', RegisteredDir) and (RegisteredDir <> '') then
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
  if Result <> '' then exit;
  if Trim(DataPage.Values[0]) = '' then begin
    Result := '请选择软件数据存储位置。静默安装请指定 /DATADIR。';
    exit;
  end;
  ExtractTemporaryFile('data-location.ps1');
  if not WizardSilent then StorageProgress.Show;
  try
    Result := RunStorageAction('Prepare');
    DataPrepared := Result = '';
  finally
    if not WizardSilent then StorageProgress.Hide;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Error: String;
begin
  if (CurStep = ssPostInstall) and DataPrepared then begin
    Error := CheckMessage(CheckProgramDirectory(ExpandConstant('{tmp}\installer-check.ps1'), ExpandConstant('{app}')));
    if Error <> '' then RaiseException(Error);
    Error := RunStorageAction('Commit');
    if Error <> '' then RaiseException(Error);
  end;
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
      + SavedDataDirectory, mbInformation, MB_OKCANCEL or MB_DEFBUTTON2) = IDOK;
end;
