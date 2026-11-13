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
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "resources\uninstall-data.ps1,resources\storage-layout.json,resources\installer-check.ps1,resources\data-location.ps1"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "uninstall-data.ps1"; DestDir: "{app}\resources"; Flags: ignoreversion
Source: "..\..\resources\storage-layout.json"; DestDir: "{app}\resources"; Flags: ignoreversion
Source: "installer-check.ps1"; DestDir: "{app}\resources"; Flags: ignoreversion
Source: "data-location.ps1"; DestDir: "{app}\resources"; Flags: ignoreversion
Source: "installer-check.ps1"; Flags: dontcopy
Source: "data-location.ps1"; Flags: dontcopy

[Icons]
Name: "{userprograms}\{#ShortcutLabel}"; Filename: "{app}\Flowave.exe"
Name: "{userdesktop}\{#ShortcutLabel}"; Filename: "{app}\Flowave.exe"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\backend\source\__pycache__"

[Code]
var
  DataModePage: TInputOptionWizardPage;
  DataPage: TInputDirWizardPage;
  PreviousDataDirectory: String;
  StorageProgress: TOutputProgressWizardPage;
  DataPrepared: Boolean;
  RemoveDataGroups: String;
  ForgetWorkspaceLocations: Boolean;

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
var
  Mode, RegisteredDir: String;
begin
  PreviousDataDirectory := SavedDataDirectory;
  if (PreviousDataDirectory = '') and DirExists(AddBackslash(ExtractFileDir(LocationFile)) + 'data') then
    PreviousDataDirectory := AddBackslash(ExtractFileDir(LocationFile)) + 'data';
  DataModePage := CreateInputOptionPage(wpSelectDir, '软件数据',
    '选择全新开始，或继续使用已有工作区。',
    '工作区保存设置、歌单、记录、插件、模型、索引和处理结果。' + #13#10
    + '检测到的旧目录：' + PreviousDataDirectory, True, False);
  DataModePage.Add('创建全新工作区');
  DataModePage.Add('继续使用旧目录，就地读取已有内容');
  DataModePage.Add('复制旧数据到新目录，校验后切换');
  DataModePage.SelectedValueIndex := 0;
  if (PreviousDataDirectory <> '') and RegQueryStringValue(HKCU,
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#ApplicationId}_is1', 'InstallLocation', RegisteredDir) then
    DataModePage.SelectedValueIndex := 1;
  Mode := ExpandConstant('{param:DATAMODE|}');
  if CompareText(Mode, 'New') = 0 then DataModePage.SelectedValueIndex := 0
  else if CompareText(Mode, 'Existing') = 0 then DataModePage.SelectedValueIndex := 1
  else if CompareText(Mode, 'Copy') = 0 then DataModePage.SelectedValueIndex := 2
  else if Mode <> '' then RaiseException('DATAMODE须为New、Existing或Copy。');
  DataPage := CreateInputDirPage(DataModePage.ID, '软件数据存储位置',
    '请选择空间充足的数据文件夹，建议使用非系统盘。',
    '这里将保存听歌记录、设置、歌单、插件、模型和运行环境、曲库索引、分析结果、分轨、听歌轨迹、下载与缓存。' + #13#10#13#10
    + '占用会随安装功能和曲库规模增长。卸载默认保留此目录。全新工作区请选择空文件夹；复制迁移仅按上一页明确选择执行。',
    False, 'FlowaveData');
  DataPage.Add('数据文件夹');
  DataPage.Values[0] := ExpandConstant('{param:DATADIR|}');
  if (DataPage.Values[0] = '') and (DataModePage.SelectedValueIndex = 1) then DataPage.Values[0] := PreviousDataDirectory;
  StorageProgress := CreateOutputProgressPage('准备软件数据', '正在检查数据目录与已有内容。');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = DataModePage.ID then begin
    if (DataModePage.SelectedValueIndex <> 0) and (PreviousDataDirectory = '') then begin
      MsgBox('未检测到旧目录，请选择创建全新工作区。安装后也可在软件中打开其他已有工作区。', mbInformation, MB_OK);
      Result := False;
      exit;
    end;
    if DataModePage.SelectedValueIndex = 1 then DataPage.Values[0] := PreviousDataDirectory
    else if CompareText(DataPage.Values[0], PreviousDataDirectory) = 0 then DataPage.Values[0] := '';
  end;
  if (CurPageID = DataPage.ID) and (Trim(DataPage.Values[0]) = '') then begin
    MsgBox('请选择软件数据存储位置，建议使用空间充足的非系统盘。', mbInformation, MB_OK);
    Result := False;
  end;
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo,
  MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
var
  ModeLabel: String;
begin
  case DataModePage.SelectedValueIndex of
    1: ModeLabel := '继续使用旧数据目录';
    2: ModeLabel := '复制旧数据到新目录';
  else ModeLabel := '创建全新工作区';
  end;
  Result := MemoDirInfo + NewLine + NewLine + ModeLabel
    + NewLine + '软件数据存储位置' + NewLine + Space + DataPage.Values[0]
    + NewLine + Space + '记录、模型、索引、分析、分轨和缓存均存储于此，卸载后保留。'
    + NewLine + NewLine + MemoGroupInfo + NewLine + MemoTasksInfo;
end;

procedure OnStorageProgress(const S: String; const Error, FirstLine: Boolean);
begin
  Log(S);
  if not WizardSilent then begin
    if DataModePage.SelectedValueIndex = 2 then StorageProgress.SetText(S, '复制校验完成后切换，旧目录保留。')
    else if DataModePage.SelectedValueIndex = 1 then StorageProgress.SetText(S, '正在确认已有工作区。')
    else StorageProgress.SetText(S, '正在准备全新工作区。');
  end;
end;

function RunStorageAction(const Action: String): String;
var
  Code: Integer;
  Parameters, ErrorFile: String;
  Mode: String;
  Lines: TArrayOfString;
begin
  Result := '';
  ErrorFile := ExpandConstant('{tmp}\flowave-storage-error.txt');
  DeleteFile(ErrorFile);
  case DataModePage.SelectedValueIndex of
    1: Mode := 'Existing';
    2: Mode := 'Copy';
  else Mode := 'New';
  end;
  Parameters := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File '
    + AddQuotes(ExpandConstant('{tmp}\data-location.ps1')) + ' -Action ' + Action
    + ' -DataDir ' + AddQuotes(DataPage.Values[0]) + ' -InstallDir ' + AddQuotes(ExpandConstant('{app}'))
    + ' -DataMode ' + Mode
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
  Form: TSetupForm;
  Intro, Location: TNewStaticText;
  Keep: array[0..3] of TNewCheckBox;
  Forget: TNewCheckBox;
  ProceedButton, CancelButton: TNewButton;
  Labels, Ids: array[0..3] of String;
  I: Integer;
begin
  Code := CheckProgramDirectory(ExpandConstant('{app}\resources\installer-check.ps1'), ExpandConstant('{app}'));
  Result := Code = 0;
  if (not Result) and (not UninstallSilent) then
    MsgBox(CheckMessage(Code), mbError, MB_OK);
  if not Result then exit;
  RemoveDataGroups := ExpandConstant('{param:REMOVEDATA|}');
  ForgetWorkspaceLocations := ExpandConstant('{param:FORGETLOCATIONS|0}') = '1';
  if UninstallSilent then exit;
  Labels[0] := '保留设置、歌单、记录与轨迹'; Ids[0] := 'personal';
  Labels[1] := '保留索引、分析、分轨与谱面'; Ids[1] := 'results';
  Labels[2] := '保留插件、模型与计算环境'; Ids[2] := 'resources';
  Labels[3] := '保留缓存、日志与浏览器会话'; Ids[3] := 'temporary';
  Form := CreateCustomForm(580, 360, False, False);
  try
    Form.Caption := '卸载 Flowave — 保留内容';
    Intro := TNewStaticText.Create(Form); Intro.Parent := Form;
    Intro.SetBounds(ScaleX(20),ScaleY(16),ScaleX(540),ScaleY(40));
    Intro.WordWrap := True;
    Intro.Caption := '选中的内容会保留，取消选中后将在卸载时删除。仅处理下方工作区，下载的音乐和其他工作区保留。';
    Location := TNewStaticText.Create(Form); Location.Parent := Form;
    Location.SetBounds(ScaleX(20),ScaleY(61),ScaleX(540),ScaleY(48));
    Location.WordWrap := True; Location.Caption := SavedDataDirectory;
    for I := 0 to 3 do begin
      Keep[I] := TNewCheckBox.Create(Form); Keep[I].Parent := Form;
      Keep[I].SetBounds(ScaleX(24),ScaleY(119+I*31),ScaleX(530),ScaleY(25));
      Keep[I].Caption := Labels[I]; Keep[I].Checked := True;
    end;
    Forget := TNewCheckBox.Create(Form); Forget.Parent := Form;
    Forget.SetBounds(ScaleX(24),ScaleY(251),ScaleX(530),ScaleY(25));
    Forget.Caption := '同时忘记默认工作区与最近列表'; Forget.Checked := False;
    ProceedButton := TNewButton.Create(Form); ProceedButton.Parent := Form;
    ProceedButton.SetBounds(ScaleX(350),ScaleY(310),ScaleX(100),ScaleY(30));
    ProceedButton.Caption := '继续卸载'; ProceedButton.ModalResult := mrOK;
    CancelButton := TNewButton.Create(Form); CancelButton.Parent := Form;
    CancelButton.SetBounds(ScaleX(460),ScaleY(310),ScaleX(100),ScaleY(30));
    CancelButton.Caption := '取消'; CancelButton.ModalResult := mrCancel; CancelButton.Cancel := True;
    Form.ActiveControl := CancelButton;
    Result := Form.ShowModal = mrOK;
    if Result then begin
      RemoveDataGroups := '';
      for I := 0 to 3 do if not Keep[I].Checked then begin
        if RemoveDataGroups <> '' then RemoveDataGroups := RemoveDataGroups + ',';
        RemoveDataGroups := RemoveDataGroups + Ids[I];
      end;
      ForgetWorkspaceLocations := Forget.Checked;
      if RemoveDataGroups <> '' then
        Result := MsgBox('即将按刚才的选择删除工作区中的相应内容，删除后无法通过重装恢复。请确认已备份需要保留的内容。' + #13#10#13#10 + SavedDataDirectory,
          mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
    end;
  finally
    Form.Free;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
  Parameters: String;
begin
  if (CurUninstallStep <> usUninstall) or ((RemoveDataGroups = '') and (not ForgetWorkspaceLocations)) then exit;
  Parameters := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File '
    + AddQuotes(ExpandConstant('{app}\resources\uninstall-data.ps1')) + ' -Action Remove -DataDir '
    + AddQuotes(SavedDataDirectory) + ' -InstallDir ' + AddQuotes(ExpandConstant('{app}'));
  if RemoveDataGroups <> '' then Parameters := Parameters + ' -Groups ' + AddQuotes(RemoveDataGroups);
  if ForgetWorkspaceLocations then Parameters := Parameters + ' -ForgetLocations';
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Parameters, '', SW_HIDE, ewWaitUntilTerminated, Code) then Code := 45;
  if Code <> 0 then RaiseException('部分数据未能清理，卸载已停止。请确认工作区可访问且后台任务已退出。原位置记录保留，可稍后重试。');
end;
