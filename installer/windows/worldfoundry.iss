; WorldFoundry - Windows installer (Inno Setup 6.3 or newer)
;
; Build (after "npm run package -- --target win-x64"):
;   ISCC.exe /DAppVersion=0.1.0 installer\windows\worldfoundry.iss
; Optional parameters: /DSourceDir=<package folder> /DOutputDir=<output folder>
;
; Program:       %ProgramFiles%\WorldFoundry   (service wrapper WinSW + Node + application)
; Data/config:   %ProgramData%\WorldFoundry    (worldfoundry.env, data\, servers\, logs\, tmp\, credentials.txt)
; Service:       "worldfoundry", account NT SERVICE\worldfoundry (virtual service account, not SYSTEM)
; Update service: "worldfoundry-updater" (LocalSystem), folder %ProgramData%\WorldFoundry Update (requests, status)
;
; Language: English only.
;
; Silent update (as the update service runs it):
;   worldfoundry-<version>-setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS="firewall,startmenu"
; Configuration, token, data and servers stay untouched; the tasks "firewall"/"startmenu" are only
; applied if they are named with /TASKS. The task names, the service ids and the firewall rule names are read by the
; update service of already installed versions and must not change.
;
; This file is saved as UTF-8 with BOM.

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\release\win-x64"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\release"
#endif

#define AppName "WorldFoundry"
; The product was called "WorldFoundry" before. The folder names, the Start menu folder and the firewall rule
; names below keep that name ON PURPOSE: installed versions (and the update service of them) use exactly these paths
; and names (the updater reads the firewall rule and the Start menu folder to decide which tasks to repeat), and an
; upgrade must find the existing program, data and update folders. AppId must never change either.
#define InstallFolderName "WorldFoundry"
#define DataFolderName "WorldFoundry"
#define ServiceId "worldfoundry"
#define ServiceExe "worldfoundry-service.exe"
#define ServiceAccount "NT SERVICE\worldfoundry"
#define UpdaterId "worldfoundry-updater"
#define UpdaterExe "worldfoundry-updater-service.exe"
#define UpdateFolderName "WorldFoundry Update"
#define UpdateTaskName "WorldFoundryUpdate"
#define FirewallWebRule "WorldFoundry - Web"
#define FirewallTcpRule "WorldFoundry - Game servers (TCP)"
#define FirewallUdpRule "WorldFoundry - Game servers (UDP)"
; Default port ranges of the games: Minecraft 25565+, Satisfactory 7777+ and 8888+ (TCP and UDP), Terraria 7777+ (TCP),
; 7 Days to Die 26900+ (TCP and UDP), Project Zomboid 16261+, ARK and ARK: Survival Ascended 7777+, Valheim 2456+,
; Palworld 8211+ and the Steam query ports 27015+ (UDP). RCON, telnet and REST (27020+, 8081+, 8212+ TCP) stay closed.
#define TcpPortRange "25565-25575,7777-7790,8888-8899,26900-26910"
#define UdpPortRange "2456-2470,7777-7790,8211-8221,16261-16280,26900-26910,27015-27030"
; firewall rule of versions that knew only Minecraft
#define FirewallOldRule "WorldFoundry - Minecraft"
#define StartMenuFolderName "WorldFoundry"
#define StartMenuFolder "{commonprograms}\" + StartMenuFolderName

[Setup]
AppId={{6F1D2B7C-93A4-4E58-B0C6-5A2E8D41F7A3}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=dxvro
DefaultDirName={autopf}\{#InstallFolderName}
DisableProgramGroupPage=yes
DefaultGroupName={#StartMenuFolderName}
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=worldfoundry-{#AppVersion}-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
CloseApplications=no
RestartApplications=no
UninstallDisplayName={#AppName}
VersionInfoVersion={#AppVersion}
VersionInfoDescription={#AppName} Setup
DisableWelcomePage=no
ShowLanguageDialog=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
english.WelcomeLabel2=This wizard will install [name/ver] on your computer.%n%nWorldFoundry is not an official product of any game publisher. NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.%n%nIt is recommended that you close all other applications before continuing.
english.FinishedLabel=Setup has finished installing [name] on your computer. Addresses and the access token are on the previous page and in the file credentials.txt.%n%nWorldFoundry is not an official product of any game publisher. NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.
english.FinishedLabelNoIcons=Setup has finished installing [name] on your computer. Addresses and the access token are on the previous page and in the file credentials.txt.%n%nWorldFoundry is not an official product of any game publisher. NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.

[CustomMessages]
english.TaskFirewall=Windows Firewall: open the web port (TCP 3000 or the port set in the configuration) and the default game server ports (TCP %1, UDP %2) for private networks
english.TaskGroupNetwork=Network:
english.TaskStartMenu=Start menu shortcut that opens the web interface
english.TaskGroupShortcuts=Shortcuts:
english.IconWeb=WorldFoundry Web Interface
english.IconResetPassword=Reset Password
english.IconResetPasswordComment=Reset the password of the web interface (administrator only)

english.CredPageCaption=Access details
english.CredPageDescription=Address and access token of WorldFoundry
english.CredAddresses=The web interface is available at:
english.CredLocal=(on this computer)
english.CredTip=(Tip: assign a fixed IP address to this computer in your router so that the address does not change.)
english.CredToken=Access token for signing in (please write it down, it is also the first password):
english.CredTokenAlso=The token is also stored in:
english.CredAdminOnly=(both files are readable by administrators only)
english.CredPassword=You can set your own password in the web interface under "System". Forgot the password: Start menu, "%1".
english.CredKept=The existing configuration including the access token was kept:
english.CredData=Data, servers and backups are in:
english.CredService=The service "WorldFoundry" starts automatically with Windows. Other devices on the network can only reach it if the Windows Firewall allows the port (task "Windows Firewall" during installation, or by hand).
english.Disclaimer=WorldFoundry is not an official product of any game publisher. NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.

english.StatusSetupService=Setting up the service ...
english.StatusStartService=Starting the service ...

english.ErrServiceConfigMissing=The service configuration %1 is missing.
english.ErrServiceConfigWrite=The service configuration could not be written.
english.ErrService=The Windows service could not be set up (code %1). See the setup log.
english.ErrServiceAccount=The service account %1 could not be set (code %2).
english.ErrUpdater=The update service could not be set up (code %1). See the setup log.
english.ErrUpdateFolderRights=The access rights for the update folder could not be set. See the setup log.
english.ErrRequestFolderRights=The access rights for the request folder of the update service could not be set. See the setup log.
english.ErrDataFolderRights=The access rights for the data folder could not be set. See the setup log.
english.ErrConfigRights=The access rights for the configuration file could not be set. See the setup log.
english.ErrConfigCreate=The configuration file could not be created (code %1).

english.UninstallDone=WorldFoundry was removed. The service and the firewall rules are deleted.
english.UninstallKept=Your data (servers, worlds, backups, configuration) was NOT deleted and is still in:
english.UninstallRemoveByHand=To remove it completely, delete this folder by hand.

[Tasks]
Name: "firewall"; Description: "{cm:TaskFirewall,{#TcpPortRange},{#UdpPortRange}}"; GroupDescription: "{cm:TaskGroupNetwork}"
Name: "startmenu"; Description: "{cm:TaskStartMenu}"; GroupDescription: "{cm:TaskGroupShortcuts}"

[Dirs]
Name: "{commonappdata}\{#DataFolderName}"; Flags: uninsneveruninstall
Name: "{commonappdata}\{#DataFolderName}\logs"; Flags: uninsneveruninstall
Name: "{commonappdata}\{#DataFolderName}\tmp"; Flags: uninsneveruninstall

[Files]
; start-portable.cmd and README.txt belong to the ZIP package only
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "\start-portable.cmd,\README.txt"; Flags: recursesubdirs createallsubdirs ignoreversion

[INI]
Filename: "{app}\WorldFoundry.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:{code:WebPort}"; Tasks: startmenu

[Icons]
Name: "{group}\{cm:IconWeb}"; Filename: "{app}\WorldFoundry.url"; Tasks: startmenu
; Asks for administrator rights itself (reset-password.cmd) and shows a new password
Name: "{group}\{cm:IconResetPassword}"; Filename: "{app}\reset-password.cmd"; WorkingDir: "{app}"; Comment: "{cm:IconResetPasswordComment}"

[InstallDelete]
; the shortcut is created again right afterwards
Type: files; Name: "{#StartMenuFolder}\WorldFoundry Web Interface.lnk"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
Type: filesandordirs; Name: "{commonappdata}\{#UpdateFolderName}"
; so that the Start menu folder can be removed
Type: files; Name: "{#StartMenuFolder}\WorldFoundry Web Interface.lnk"
Type: files; Name: "{#StartMenuFolder}\Reset Password.lnk"

[Code]
const
  ServiceName = '{#ServiceId}';
  UpdaterName = '{#UpdaterId}';
  ServiceAccount = '{#ServiceAccount}';
  SidSystem = '*S-1-5-18';
  SidAdministrators = '*S-1-5-32-544';
  DefaultPort = '3000';

var
  CredPage: TWizardPage;
  CredMemo: TNewMemo;
  FirstInstall: Boolean;

function DataDir: String;
begin
  Result := ExpandConstant('{commonappdata}\{#DataFolderName}');
end;

function ConfigFile: String;
begin
  Result := DataDir + '\worldfoundry.env';
end;

function CredentialsFile: String;
begin
  Result := DataDir + '\credentials.txt';
end;

function ServiceTool: String;
begin
  Result := ExpandConstant('{app}\{#ServiceExe}');
end;

function UpdaterTool: String;
begin
  Result := ExpandConstant('{app}\{#UpdaterExe}');
end;

function UpdateRoot: String;
begin
  Result := ExpandConstant('{commonappdata}\{#UpdateFolderName}');
end;

function RunTool(const FileName, Params: String): Integer;
var
  ResultCode: Integer;
begin
  ResultCode := -1;
  if not Exec(FileName, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    ResultCode := -1;
  Log(Format('Exec: "%s" %s -> %d', [FileName, Params, ResultCode]));
  Result := ResultCode;
end;

{ Reads a value (KEY=value) from the configuration file; quotation marks are removed }
function ReadConfigValue(const Key, Fallback: String): String;
var
  Lines: TArrayOfString;
  I: Integer;
  Line, Value: String;
begin
  Result := Fallback;
  if not LoadStringsFromFile(ConfigFile, Lines) then
    Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    Line := Trim(Lines[I]);
    if Pos(Key + '=', Line) = 1 then
    begin
      Value := Trim(Copy(Line, Length(Key) + 2, MaxInt));
      if (Length(Value) >= 2) and (Value[1] = '''') and (Value[Length(Value)] = '''') then
        Value := Copy(Value, 2, Length(Value) - 2);
      if Value <> '' then
        Result := Value;
      Exit;
    end;
  end;
end;

{ Web port: the port the application really listens on (data\network.json; can be changed in the web interface),
  otherwise PORT from the existing configuration, otherwise 3000 }
function WebPort(Param: String): String;
var
  Raw: AnsiString;
  Json, Digits: String;
  P: Integer;
begin
  Result := ReadConfigValue('PORT', DefaultPort);
  if LoadStringFromFile(DataDir + '\data\network.json', Raw) then
  begin
    Json := String(Raw);
    P := Pos('"port":', Json);
    if P > 0 then
    begin
      Digits := '';
      P := P + 7;
      while (P <= Length(Json)) and (Json[P] >= '0') and (Json[P] <= '9') do
      begin
        Digits := Digits + Json[P];
        P := P + 1;
      end;
      if Digits <> '' then
        Result := Digits;
    end;
  end;
end;

{ Addresses on the home network: tools\lan.mjs with the bundled Node executable (same selection as the application:
  private addresses first, no link-local addresses, virtual adapters separately); the port comes from network.json }
function LanAddressText(const Fallback: String): String;
var
  Params, OutFile: String;
  Raw: AnsiString;
  ResultCode: Integer;
begin
  Result := Fallback;
  OutFile := ExpandConstant('{tmp}\lan.txt');
  DeleteFile(OutFile);
  Params := '/C ""' + ExpandConstant('{app}\node\node.exe') + '" "' + ExpandConstant('{app}\tools\lan.mjs') + '" --text --data-dir "' +
    DataDir + '\data" --config "' + ConfigFile + '" > "' + OutFile + '""';
  if Exec(ExpandConstant('{cmd}'), Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0) then
    if LoadStringFromFile(OutFile, Raw) and (Trim(String(Raw)) <> '') then
      Result := TrimRight(String(Raw));
end;

function ServiceInstalled: Boolean;
begin
  Result := RunTool(ExpandConstant('{sys}\sc.exe'), 'query ' + ServiceName) = 0;
end;

{ icacls with accounts "NT SERVICE\<service>": the virtual service account only exists once the service is registered
  (before that error 1332, ERROR_NONE_MAPPED). Therefore every call that names the service account comes AFTER
  RegisterService. Name resolution can still need a moment right after the registration: on 1332 it is retried briefly. }
function RunIcacls(const Params: String): Integer;
var
  Attempt: Integer;
begin
  Result := -1;
  for Attempt := 1 to 5 do
  begin
    Result := RunTool(ExpandConstant('{sys}\icacls.exe'), Params);
    if Result <> 1332 then
      Exit;
    Sleep(1000);
  end;
end;

procedure StopService;
begin
  if FileExists(ServiceTool) then
    RunTool(ServiceTool, 'stopwait')
  else
    RunTool(ExpandConstant('{sys}\net.exe'), 'stop ' + ServiceName);
  { second safeguard: net stop waits until the service has really stopped; 2 = was not started }
  RunTool(ExpandConstant('{sys}\net.exe'), 'stop ' + ServiceName);
end;

{ The update service keeps node.exe open and is replaced by the installer: stop it first }
procedure StopUpdater;
begin
  RunTool(ExpandConstant('{sys}\net.exe'), 'stop ' + UpdaterName);
end;

procedure InitializeWizard;
begin
  CredPage := CreateCustomPage(wpInstalling, CustomMessage('CredPageCaption'), CustomMessage('CredPageDescription'));
  CredMemo := TNewMemo.Create(CredPage);
  CredMemo.Parent := CredPage.Surface;
  CredMemo.Left := 0;
  CredMemo.Top := 0;
  CredMemo.Width := CredPage.SurfaceWidth;
  CredMemo.Height := CredPage.SurfaceHeight;
  CredMemo.ReadOnly := True;
  CredMemo.ScrollBars := ssVertical;
  CredMemo.WordWrap := True;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  FirstInstall := not FileExists(ConfigFile);
  if ServiceInstalled then
  begin
    Log('Service found, stopping it for the update.');
    StopService;
  end;
  StopUpdater;
end;

{ Replaces the placeholders @DATADIR@ and @UPDATEROOT@ in the WinSW configurations }
procedure FillServiceConfig(const XmlName: String);
var
  FileName: String;
  Raw: AnsiString;
  Text: String;
begin
  FileName := ExpandConstant('{app}\' + XmlName);
  if not LoadStringFromFile(FileName, Raw) then
    RaiseException(FmtMessage(CustomMessage('ErrServiceConfigMissing'), [XmlName]));
  Text := String(Raw);
  StringChangeEx(Text, '@DATADIR@', DataDir, True);
  StringChangeEx(Text, '@UPDATEROOT@', UpdateRoot, True);
  if not SaveStringToFile(FileName, AnsiString(Text), False) then
    RaiseException(CustomMessage('ErrServiceConfigWrite'));
end;

procedure PrepareServiceConfig;
begin
  FillServiceConfig('worldfoundry-service.xml');
  FillServiceConfig('worldfoundry-updater-service.xml');
end;

{ Waits until the service has disappeared from the service manager (sc query -> 1060). A service that is still "marked for
  deletion" (1072) only disappears once no handle is open any more; "install" is therefore retried as well. }
procedure WaitForServiceGone(const Name: String);
var
  I: Integer;
begin
  for I := 1 to 30 do
  begin
    if RunTool(ExpandConstant('{sys}\sc.exe'), 'query ' + Name) = 1060 then
      Exit;
    Sleep(1000);
  end;
  Log('The service ' + Name + ' is still registered in the service manager after 30 seconds.');
end;

function InstallServiceWithRetry(const Tool: String): Integer;
var
  I: Integer;
begin
  Result := -1;
  for I := 1 to 30 do
  begin
    Result := RunTool(Tool, 'install');
    if Result = 0 then
      Exit;
    Sleep(1000);
  end;
end;

{ WinSW 2.x has no "refresh" (only WinSW 3 does). An existing service is therefore stopped, removed with "uninstall" (sc delete as
  fallback), we wait until it is gone and then register it again with "install". The failure actions come from
  the XML file; the caller sets the account afterwards with sc config. }
function ReregisterService(const Tool, Name: String): Integer;
begin
  if RunTool(ExpandConstant('{sys}\sc.exe'), 'query ' + Name) = 0 then
  begin
    RunTool(ExpandConstant('{sys}\net.exe'), 'stop ' + Name);
    if RunTool(Tool, 'uninstall') <> 0 then
      RunTool(ExpandConstant('{sys}\sc.exe'), 'delete ' + Name);
    WaitForServiceGone(Name);
  end;
  Result := InstallServiceWithRetry(Tool);
end;

procedure RegisterService;
var
  Code: Integer;
begin
  Code := ReregisterService(ServiceTool, ServiceName);
  if Code <> 0 then
    RaiseException(FmtMessage(CustomMessage('ErrService'), [IntToStr(Code)]));
  { virtual service account instead of SYSTEM: no password, access to the granted folders only }
  Code := RunTool(ExpandConstant('{sys}\sc.exe'), 'config ' + ServiceName + ' obj= "' + ServiceAccount + '"');
  if Code <> 0 then
    RaiseException(FmtMessage(CustomMessage('ErrServiceAccount'), [ServiceAccount, IntToStr(Code)]));
end;

{ Update folder: owned by root (SYSTEM/Administrators); the service account only reads status.json and may only write to request\.
  work\ and backup\ are invisible to the service account. Set again on every installation and update. }
procedure PrepareUpdateFolders;
begin
  ForceDirectories(UpdateRoot + '\request');
  ForceDirectories(UpdateRoot + '\work');
  ForceDirectories(UpdateRoot + '\backup');
  ForceDirectories(UpdateRoot + '\logs');
  if RunIcacls('"' + UpdateRoot + '" /inheritance:r /grant:r "' + SidSystem + ':(OI)(CI)F" "' + SidAdministrators +
    ':(OI)(CI)F" "' + ServiceAccount + ':(OI)(CI)RX"') <> 0 then
    RaiseException(CustomMessage('ErrUpdateFolderRights'));
  if RunIcacls('"' + UpdateRoot + '\request" /grant:r "' + ServiceAccount + ':(OI)(CI)M"') <> 0 then
    RaiseException(CustomMessage('ErrRequestFolderRights'));
  RunIcacls('"' + UpdateRoot + '\work" /inheritance:r /grant:r "' + SidSystem + ':(OI)(CI)F" "' + SidAdministrators + ':(OI)(CI)F"');
  RunIcacls('"' + UpdateRoot + '\backup" /inheritance:r /grant:r "' + SidSystem + ':(OI)(CI)F" "' + SidAdministrators + ':(OI)(CI)F"');
end;

procedure RegisterUpdater;
var
  Code: Integer;
begin
  { Here setup runs from the Task Scheduler (copy of node.exe), not inside the update service: it may be registered again }
  Code := ReregisterService(UpdaterTool, UpdaterName);
  if Code <> 0 then
    RaiseException(FmtMessage(CustomMessage('ErrUpdater'), [IntToStr(Code)]));
  { LocalSystem: may stop services and replace program files }
  RunTool(ExpandConstant('{sys}\sc.exe'), 'config ' + UpdaterName + ' obj= LocalSystem');
end;

procedure SecureFolderAndFiles;
begin
  { Data folder: only SYSTEM, Administrators and the service account (modify), no inheritance from ProgramData }
  if RunIcacls('"' + DataDir + '" /inheritance:r /grant:r "' + SidSystem + ':(OI)(CI)F" "' + SidAdministrators +
    ':(OI)(CI)F" "' + ServiceAccount + ':(OI)(CI)M"') <> 0 then
    RaiseException(CustomMessage('ErrDataFolderRights'));
end;

{ credentials.txt: administrators and SYSTEM only (explicit ACL, no inheritance) }
procedure SecureCredentialsFile;
begin
  if FileExists(CredentialsFile) then
    RunIcacls('"' + CredentialsFile + '" /inheritance:r /grant:r "' + SidSystem + ':F" "' + SidAdministrators + ':F"');
end;

procedure SecureConfigFiles;
begin
  { Configuration (contains the token): Administrators and SYSTEM full control, service account read-only }
  if RunIcacls('"' + ConfigFile + '" /inheritance:r /grant:r "' + SidSystem + ':F" "' + SidAdministrators + ':F" "' +
    ServiceAccount + ':R"') <> 0 then
    RaiseException(CustomMessage('ErrConfigRights'));
  { credentials.txt: Administrators and SYSTEM only }
  SecureCredentialsFile;
end;

procedure CreateConfig;
var
  Node, Params: String;
  Code: Integer;
begin
  Node := ExpandConstant('{app}\node\node.exe');
  Params := '"' + ExpandConstant('{app}\tools\setup-config.mjs') + '" --config "' + ConfigFile + '" --data-dir "' +
    DataDir + '\data" --servers-dir "' + DataDir + '\servers" --port ' + DefaultPort + ' --credentials-file "' +
    CredentialsFile + '"';
  Code := RunTool(Node, Params);
  if (Code <> 0) or not FileExists(ConfigFile) then
    RaiseException(FmtMessage(CustomMessage('ErrConfigCreate'), [IntToStr(Code)]));
end;

procedure ConfigureFirewall;
var
  Netsh, Port: String;
begin
  Netsh := ExpandConstant('{sys}\netsh.exe');
  Port := WebPort('');
  RunTool(Netsh, 'advfirewall firewall delete rule name="{#FirewallWebRule}"');
  RunTool(Netsh, 'advfirewall firewall delete rule name="{#FirewallOldRule}"');
  RunTool(Netsh, 'advfirewall firewall delete rule name="{#FirewallTcpRule}"');
  RunTool(Netsh, 'advfirewall firewall delete rule name="{#FirewallUdpRule}"');
  if RunTool(Netsh, 'advfirewall firewall add rule name="{#FirewallWebRule}" dir=in action=allow protocol=TCP localport=' +
    Port + ' profile=private') <> 0 then
    Log('The firewall rule for the web port could not be created.');
  if RunTool(Netsh, 'advfirewall firewall add rule name="{#FirewallTcpRule}" dir=in action=allow protocol=TCP localport={#TcpPortRange} profile=private') <> 0 then
    Log('The firewall rule for the TCP game ports could not be created.');
  if RunTool(Netsh, 'advfirewall firewall add rule name="{#FirewallUdpRule}" dir=in action=allow protocol=UDP localport={#UdpPortRange} profile=private') <> 0 then
    Log('The firewall rule for the UDP game ports could not be created.');
end;

function WaitForHealth: Boolean;
var
  I: Integer;
  Params: String;
begin
  Result := False;
  Params := '-e "fetch(''http://127.0.0.1:' + WebPort('') + '/api/health'').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"';
  for I := 1 to 30 do
  begin
    if RunTool(ExpandConstant('{app}\node\node.exe'), Params) = 0 then
    begin
      Result := True;
      Exit;
    end;
    Sleep(1000);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    WizardForm.StatusLabel.Caption := CustomMessage('StatusSetupService');
    PrepareServiceConfig;
    { Order: register the services first (so that NT SERVICE\worldfoundry exists), then set all rights that name the
      service account }
    RegisterService;
    RegisterUpdater;
    PrepareUpdateFolders;
    if FirstInstall then
      SecureFolderAndFiles;
    if FirstInstall then
      CreateConfig;
    if FirstInstall then
      SecureConfigFiles;
    if WizardIsTaskSelected('firewall') then
      ConfigureFirewall;
    WizardForm.StatusLabel.Caption := CustomMessage('StatusStartService');
    if RunTool(ServiceTool, 'start') <> 0 then
      Log('The service could not be started.')
    else if not WaitForHealth then
      Log('The service is not responding yet.');
    if RunTool(UpdaterTool, 'start') <> 0 then
      Log('The update service could not be started.');
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
var
  Port, Token, Text: String;
begin
  if CurPageID <> CredPage.ID then
    Exit;
  Port := WebPort('');
  Token := ReadConfigValue('AUTH_TOKEN', '');
  Text := CustomMessage('CredAddresses') + #13#10 +
    LanAddressText('   http://' + GetComputerNameString + ':' + Port) + #13#10 +
    '   http://localhost:' + Port + '   ' + CustomMessage('CredLocal') + #13#10 +
    CustomMessage('CredTip') + #13#10 + #13#10;
  if FirstInstall then
  begin
    Text := Text + CustomMessage('CredToken') + #13#10 + '   ' + Token + #13#10 + #13#10 +
      CustomMessage('CredTokenAlso') + #13#10 + '   ' + ConfigFile + #13#10 + '   ' + CredentialsFile + #13#10 +
      CustomMessage('CredAdminOnly') + #13#10 + #13#10 +
      FmtMessage(CustomMessage('CredPassword'), [CustomMessage('IconResetPassword')]) + #13#10 + #13#10;
  end
  else
    Text := Text + CustomMessage('CredKept') + #13#10 + '   ' + ConfigFile + #13#10 + #13#10;
  Text := Text + CustomMessage('CredData') + #13#10 + '   ' + DataDir + #13#10 + #13#10 +
    CustomMessage('CredService') + #13#10 + #13#10 +
    CustomMessage('Disclaimer');
  CredMemo.Text := Text;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Tool, Netsh: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    Tool := ExpandConstant('{app}\{#ServiceExe}');
    if FileExists(Tool) then
    begin
      RunTool(Tool, 'stopwait');
      if RunTool(Tool, 'uninstall') <> 0 then
        RunTool(ExpandConstant('{sys}\sc.exe'), 'delete ' + ServiceName);
    end
    else
      RunTool(ExpandConstant('{sys}\sc.exe'), 'delete ' + ServiceName);
    { Remove the update service and a possibly left-over one-time task }
    RunTool(ExpandConstant('{sys}\net.exe'), 'stop ' + UpdaterName);
    if FileExists(ExpandConstant('{app}\{#UpdaterExe}')) then
    begin
      if RunTool(ExpandConstant('{app}\{#UpdaterExe}'), 'uninstall') <> 0 then
        RunTool(ExpandConstant('{sys}\sc.exe'), 'delete ' + UpdaterName);
    end
    else
      RunTool(ExpandConstant('{sys}\sc.exe'), 'delete ' + UpdaterName);
    RunTool(ExpandConstant('{sys}\schtasks.exe'), '/Delete /TN {#UpdateTaskName} /F');
    Netsh := ExpandConstant('{sys}\netsh.exe');
    RunTool(Netsh, 'advfirewall firewall delete rule name="{#FirewallWebRule}"');
    RunTool(Netsh, 'advfirewall firewall delete rule name="{#FirewallOldRule}"');
    RunTool(Netsh, 'advfirewall firewall delete rule name="{#FirewallTcpRule}"');
    RunTool(Netsh, 'advfirewall firewall delete rule name="{#FirewallUdpRule}"');
  end;
  if CurUninstallStep = usPostUninstall then
  begin
    if not UninstallSilent then
      MsgBox(CustomMessage('UninstallDone') + #13#10 + #13#10 +
        CustomMessage('UninstallKept') + #13#10 +
        DataDir + #13#10 + #13#10 +
        CustomMessage('UninstallRemoveByHand'), mbInformation, MB_OK);
  end;
end;
