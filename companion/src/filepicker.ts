import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

const WINDOWS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Filter = 'Audio files|*.wav;*.mp3;*.aif;*.aiff;*.m4a;*.aac;*.flac;*.caf;*.mp4|All files|*.*'
if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.FileName) }
`;

const MAC_SCRIPT =
  'POSIX path of (choose file with prompt "Choose an audio file" of type {"public.audio", "public.movie"})';

/** Opens the system's own file dialog and resolves with the full path chosen (undefined if cancelled). Only
 * meaningful when Companion runs on the same machine the person is sitting at — same trick the Stream Deck
 * plugin uses (plugin/src/filepicker.ts), unchanged. */
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

/** A path typed into the web editor may be relative, or use the wrong slash direction if copy-pasted across
 * platforms — try a few variants before giving up. */
export function resolvePath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const candidates = new Set<string>([p]);
  candidates.add(p.replace(/\\/g, "/"));
  if (process.platform === "win32") candidates.add(p.replace(/\//g, "\\"));
  return [...candidates].find((c) => existsSync(c));
}
