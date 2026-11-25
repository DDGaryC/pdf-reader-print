# Starts the installer on a separate, invisible Windows desktop, reads what its first page says
# and takes a picture of it, then stops it before anything is installed. Nothing shows on screen.
param([string]$Exe, [string]$Picture)

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class InvisibleDesktop {
  const uint GENERIC_ALL = 0x10000000;
  const uint WM_GETTEXT = 0x000D;
  const uint SMTO_ABORTIFHUNG = 0x0002;

  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr attrs);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desktop);
  [DllImport("user32.dll")] static extern bool EnumDesktopWindows(IntPtr desktop, EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint msg, IntPtr wParam, StringBuilder lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string app, string command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static string TextOf(IntPtr hwnd) {
    var text = new StringBuilder(1024);
    IntPtr result;
    SendMessageTimeoutW(hwnd, WM_GETTEXT, (IntPtr)text.Capacity, text, SMTO_ABORTIFHUNG, 1000, out result);
    return text.ToString();
  }

  public static string Look(string exe, string picture, int waitMs) {
    string answer = null;
    var thread = new Thread(() => { answer = Run(exe, picture, waitMs); });
    thread.Start();
    thread.Join();
    return answer;
  }

  static string Run(string exe, string picture, int waitMs) {
    string name = "pdfrp-check-" + Guid.NewGuid().ToString("N");
    IntPtr desktop = CreateDesktopW(name, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
    if (desktop == IntPtr.Zero) return "could not create the desktop";
    var lines = new List<string>();
    PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
    try {
      if (!SetThreadDesktop(desktop)) return "could not enter the desktop: " + Marshal.GetLastWin32Error();
      var si = new STARTUPINFO();
      si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
      si.lpDesktop = name;
      if (!CreateProcessW(exe, null, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi)) return "could not start: " + Marshal.GetLastWin32Error();
      var started = Environment.TickCount;
      while (Environment.TickCount - started < waitMs) {
        Thread.Sleep(700);
        var tops = new List<IntPtr>();
        EnumDesktopWindows(desktop, (hwnd, l) => {
          uint pid;
          GetWindowThreadProcessId(hwnd, out pid);
          if (pid == pi.dwProcessId && IsWindowVisible(hwnd)) tops.Add(hwnd);
          return true;
        }, IntPtr.Zero);
        lines.Clear();
        IntPtr main = IntPtr.Zero;
        foreach (var top in tops) {
          string title = TextOf(top);
          if (title.Length > 0) main = top;
          lines.Add("WINDOW: " + title);
          EnumChildWindows(top, (child, l) => {
            if (IsWindowVisible(child)) {
              string words = TextOf(child);
              if (words.Length > 0) lines.Add("  " + words);
            }
            return true;
          }, IntPtr.Zero);
        }
        if (lines.Count >= 6 && main != IntPtr.Zero) {
          Thread.Sleep(800);
          RECT r;
          GetWindowRect(main, out r);
          using (var image = new Bitmap(r.Right - r.Left, r.Bottom - r.Top))
          using (var g = Graphics.FromImage(image)) {
            var hdc = g.GetHdc();
            PrintWindow(main, hdc, 2);
            g.ReleaseHdc(hdc);
            image.Save(picture, ImageFormat.Png);
          }
          break;
        }
      }
    } finally {
      if (pi.hProcess != IntPtr.Zero) {
        TerminateProcess(pi.hProcess, 0);
        WaitForSingleObject(pi.hProcess, 5000);
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
      }
      CloseDesktop(desktop);
    }
    return string.Join("\n", lines);
  }
}
'@

[Console]::OutputEncoding = [Text.Encoding]::UTF8
$tempBefore = @(Get-ChildItem $env:TEMP -Directory -Filter 'ns*.tmp' -ErrorAction SilentlyContinue | ForEach-Object Name)
[InvisibleDesktop]::Look($Exe, $Picture, 30000)
Start-Sleep -Milliseconds 500
Get-ChildItem $env:TEMP -Directory -Filter 'ns*.tmp' -ErrorAction SilentlyContinue |
  Where-Object { $tempBefore -notcontains $_.Name } |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
"--- installed folder exists: $(Test-Path "$env:LOCALAPPDATA\Programs\pdf-reader-print")"
"--- our registry entry exists: $(Test-Path 'HKCU:\Software\PDFReaderPrint')"
exit 0
