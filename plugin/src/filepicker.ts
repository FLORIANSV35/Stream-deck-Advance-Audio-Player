import { execFile } from "node:child_process";

const WINDOWS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Filter = 'Audio files|*.wav;*.mp3;*.aif;*.aiff;*.m4a;*.aac;*.flac;*.caf;*.mp4|All files|*.*'
if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.FileName) }
`;

const MAC_SCRIPT =
  'POSIX path of (choose file with prompt "Choose an audio file" of type {"public.audio", "public.movie"})';

/** Opens the system's own file dialog and resolves with the full path chosen (undefined if cancelled). A browser cannot give us one. */
export function pickAudioFile(): Promise<string | undefined> {
  const [cmd, args] =
    process.platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-STA", "-Command", WINDOWS_SCRIPT]]
      : ["/usr/bin/osascript", ["-e", MAC_SCRIPT]];
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (error, stdout) => {
      const path = stdout.toString().trim();
      resolve(error || !path ? undefined : path);
    });
  });
}
