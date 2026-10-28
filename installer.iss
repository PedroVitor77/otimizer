; Script Inno Setup para PulsePC Pro
; Criado para distribuicao independente no Windows 10/11

#define MyAppName "PulsePC Pro"
#define MyAppVersion "1.3.5"
#define MyAppPublisher "Pedro Vitor"
#define MyAppURL "https://github.com/PedroVitor77/otimizer"
#define MyAppExeName "PulsePC.exe"

[Setup]
; Informacoes basicas do aplicativo
AppId={{E68B8D14-729B-4B7E-971A-3A65D8291F02}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\PulsePC
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
LicenseFile=
; Exige privilegios de administrador para operacoes de sistema e limpeza profunda
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=commandline
OutputBaseFilename=PulsePC_Setup
OutputDir=installer_output
SetupIconFile=assets\pulsepc.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "dist\PulsePC\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\assets\pulsepc.ico"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon; IconFilename: "{app}\assets\pulsepc.ico"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
