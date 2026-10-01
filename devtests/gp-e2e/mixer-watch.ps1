# What the Windows volume mixer sees: every audio session on every active playback device, sampled every
# IntervalMs ms, with its process, its peak meter (IAudioMeterInformation, 0..1: what the mixer's green bar shows),
# its mute / volume and its state. Used by devtests/gp-e2e/solo-v6.js (and by hand) to prove that a harness is SILENT:
# no session of the harness's process tree may ever show a peak above 0.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File devtests/gp-e2e/mixer-watch.ps1 -Seconds 20
#   powershell ... -File mixer-watch.ps1 -Root <pid> -Out <file.json> -Stop <file>    (until <file> exists or <pid> is gone)
#
# Output: a JSON summary { samples, seconds, sessions: [{ pid, name, ours (in -Root's process tree), maxPeak, peakSamples
# (samples with peak > 0), activeSamples, muted (ever / always), minVolume, maxVolume, display }], error } to -Out (or
# stdout). Read-only: it never changes a volume or a mute.
param(
  [int]$Root = 0,
  [string]$Out = '',
  [string]$Stop = '',
  [double]$Seconds = 0,
  [int]$IntervalMs = 100
)
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace MixerWatch {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out IMMDevice device);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    [PreserveSig] int OpenPropertyStore(int access, out IntPtr props);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out int state);
  }
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr guid, int flags, out IntPtr ctrl);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr guid, int flags, out IntPtr vol);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
  }
  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
  }
  [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string v, ref Guid ctx);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string p);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string v, ref Guid ctx);
    [PreserveSig] int GetGroupingParam(out Guid g);
    [PreserveSig] int SetGroupingParam(ref Guid g, ref Guid ctx);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference(bool optOut);
  }
  [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioMeterInformation {
    [PreserveSig] int GetPeakValue(out float peak);
  }
  [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float v, ref Guid ctx);
    [PreserveSig] int GetMasterVolume(out float v);
    [PreserveSig] int SetMute(bool m, ref Guid ctx);
    [PreserveSig] int GetMute(out bool m);
  }

  public class Sample {
    public uint Pid; public string Device; public string Instance; public string Display; public int State;
    public float Peak; public bool Muted; public float Volume;
  }

  public static class Probe {
    public static List<Sample> Read() {
      var list = new List<Sample>();
      var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
      IMMDeviceCollection devs;
      if (en.EnumAudioEndpoints(0 /* eRender */, 1 /* ACTIVE */, out devs) != 0) return list;
      int n; devs.GetCount(out n);
      Guid iidMgr = typeof(IAudioSessionManager2).GUID;
      for (int d = 0; d < n; d++) {
        IMMDevice dev; if (devs.Item(d, out dev) != 0) continue;
        string devId; dev.GetId(out devId);
        object o; if (dev.Activate(ref iidMgr, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o) != 0) continue;
        var mgr = (IAudioSessionManager2)o;
        IAudioSessionEnumerator se; if (mgr.GetSessionEnumerator(out se) != 0) continue;
        int c; se.GetCount(out c);
        for (int i = 0; i < c; i++) {
          IAudioSessionControl2 s; if (se.GetSession(i, out s) != 0) continue;
          var x = new Sample(); x.Device = devId;
          s.GetProcessId(out x.Pid); s.GetState(out x.State);
          string dn; s.GetDisplayName(out dn); x.Display = dn;
          string inst; s.GetSessionInstanceIdentifier(out inst); x.Instance = inst;
          float p = 0; ((IAudioMeterInformation)s).GetPeakValue(out p); x.Peak = p;
          var vol = (ISimpleAudioVolume)s; bool m; vol.GetMute(out m); x.Muted = m; float v; vol.GetMasterVolume(out v); x.Volume = v;
          list.Add(x);
          Marshal.ReleaseComObject(s);
        }
        Marshal.ReleaseComObject(se); Marshal.ReleaseComObject(mgr); Marshal.ReleaseComObject(dev);
      }
      Marshal.ReleaseComObject(devs); Marshal.ReleaseComObject(en);
      return list;
    }
  }
}
'@
$summary = [ordered]@{ samples = 0; seconds = 0; root = $Root; sessions = @(); error = $null }
try {
  Add-Type -TypeDefinition $src -Language CSharp
} catch {
  $summary.error = 'compile: ' + $_.Exception.Message
}
$tree = @{}                     # pid -> in the -Root process tree (cached)
$names = @{}
function InTree([uint32]$p) {
  if ($Root -le 0) { return $false }
  $k = [string]$p
  if ($tree.ContainsKey($k)) { return $tree[$k] }
  $ok = $false; $cur = [int]$p; $guard = 0
  while ($cur -gt 0 -and $guard -lt 12) {
    if ($cur -eq $Root) { $ok = $true; break }
    $pr = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
    if (-not $pr) { break }
    $cur = [int]$pr.ParentProcessId; $guard++
  }
  $tree[$k] = $ok
  return $ok
}
$acc = @{}
$t0 = [DateTime]::UtcNow
if (-not $summary.error) {
  while ($true) {
    $el = ([DateTime]::UtcNow - $t0).TotalSeconds
    if ($Seconds -gt 0 -and $el -ge $Seconds) { break }
    if ($Stop -and (Test-Path $Stop)) { break }
    if ($Root -gt 0 -and -not (Get-Process -Id $Root -ErrorAction SilentlyContinue)) { break }
    try { $list = [MixerWatch.Probe]::Read() } catch { $summary.error = 'read: ' + $_.Exception.Message; break }
    $summary.samples++
    foreach ($x in $list) {
      $key = [string]$x.Pid + '|' + $x.Instance
      if (-not $acc.ContainsKey($key)) {
        $pn = ''
        if (-not $names.ContainsKey([string]$x.Pid)) { $pp = Get-Process -Id $x.Pid -ErrorAction SilentlyContinue; $names[[string]$x.Pid] = if ($pp) { $pp.ProcessName } else { '?' } }
        $pn = $names[[string]$x.Pid]
        $acc[$key] = [ordered]@{ pid = [int]$x.Pid; name = $pn; ours = (InTree $x.Pid); display = $x.Display; maxPeak = 0.0; peakSamples = 0; activeSamples = 0; samples = 0;
          mutedEver = $false; mutedAlways = $true; minVolume = 1.0; maxVolume = 0.0 }
      }
      $a = $acc[$key]
      $a.samples++
      if ($x.Peak -gt $a.maxPeak) { $a.maxPeak = [double]$x.Peak }
      if ($x.Peak -gt 0) { $a.peakSamples++ }
      if ($x.State -eq 1) { $a.activeSamples++ }
      if ($x.Muted) { $a.mutedEver = $true } else { $a.mutedAlways = $false }
      if ($x.Volume -lt $a.minVolume) { $a.minVolume = [double]$x.Volume }
      if ($x.Volume -gt $a.maxVolume) { $a.maxVolume = [double]$x.Volume }
    }
    Start-Sleep -Milliseconds $IntervalMs
  }
}
$summary.seconds = [math]::Round(([DateTime]::UtcNow - $t0).TotalSeconds, 2)
$summary.sessions = @($acc.Values)
$json = $summary | ConvertTo-Json -Depth 5
if ($Out) { [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding $false)) } else { $json }
