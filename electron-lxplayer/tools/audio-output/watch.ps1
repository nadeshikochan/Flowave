param([int]$OwnerProcessId = 0, [switch]$Once, [int]$WearDiagnosticSeconds = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -Path (Join-Path $PSScriptRoot 'wear-state.cs')
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Threading;
using System.Runtime.InteropServices;
namespace FlowaveOutput {
 [ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class EnumeratorObject {}
 [ComImport,Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Enumerator {
  [PreserveSig]int EnumAudioEndpoints(int flow,uint mask,out Devices devices);
  [PreserveSig]int GetDefaultAudioEndpoint(int flow,int role,out Device device);
  [PreserveSig]int GetDevice([MarshalAs(UnmanagedType.LPWStr)]string id,out Device device);
  [PreserveSig]int RegisterEndpointNotificationCallback([MarshalAs(UnmanagedType.Interface)]IEndpointNotifications client);
  [PreserveSig]int UnregisterEndpointNotificationCallback([MarshalAs(UnmanagedType.Interface)]IEndpointNotifications client);
 }
 [ComImport,Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Devices {
  [PreserveSig]int GetCount(out uint count);[PreserveSig]int Item(uint index,out Device device);
 }
 [ComImport,Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Device {
  [PreserveSig]int Activate(ref Guid iid,uint context,IntPtr parameters,[MarshalAs(UnmanagedType.IUnknown)]out object instance);
  [PreserveSig]int OpenPropertyStore(uint access,out Properties properties);
  [PreserveSig]int GetId([MarshalAs(UnmanagedType.LPWStr)]out string id);[PreserveSig]int GetState(out uint state);
 }
 [StructLayout(LayoutKind.Sequential)] public struct Key {public Guid fmt;public uint pid;public Key(string f,uint p){fmt=new Guid(f);pid=p;}}
 [StructLayout(LayoutKind.Explicit,Size=24)] struct Value {[FieldOffset(0)]public ushort type;[FieldOffset(8)]public IntPtr pointer;}
 [ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Properties {
  [PreserveSig]int GetCount(out uint n);[PreserveSig]int GetAt(uint n,out Key key);[PreserveSig]int GetValue(ref Key key,out Value value);
 }
 [ComImport,Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface SessionManager {
  [PreserveSig]int GetAudioSessionControl(IntPtr guid,uint flags,out IntPtr control);
  [PreserveSig]int GetSimpleAudioVolume(IntPtr guid,uint flags,out IntPtr volume);
  [PreserveSig]int GetSessionEnumerator(out Sessions sessions);
 }
 [ComImport,Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Sessions {
  [PreserveSig]int GetCount(out int n);[PreserveSig]int GetSession(int n,[MarshalAs(UnmanagedType.IUnknown)]out object control);
 }
 [ComImport,Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Session {
  [PreserveSig]int GetState(out int state);
  [PreserveSig]int GetDisplayName(out IntPtr name);[PreserveSig]int SetDisplayName(IntPtr name,IntPtr context);
  [PreserveSig]int GetIconPath(out IntPtr path);[PreserveSig]int SetIconPath(IntPtr path,IntPtr context);
  [PreserveSig]int GetGroupingParam(out Guid value);[PreserveSig]int SetGroupingParam(ref Guid value,IntPtr context);
  [PreserveSig]int RegisterNotification(IntPtr client);[PreserveSig]int UnregisterNotification(IntPtr client);
  [PreserveSig]int GetSessionIdentifier(out IntPtr value);[PreserveSig]int GetSessionInstanceIdentifier(out IntPtr value);
  [PreserveSig]int GetProcessId(out uint pid);
 }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct ProcessEntry {
  public uint size,usage,pid;public UIntPtr heap;public uint module,threads,parent;public int priority;public uint flags;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string name;
 }
 [ComVisible(true),Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 public interface IEndpointNotifications {
  [PreserveSig]int OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)]string id,uint state);
  [PreserveSig]int OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)]string id);
  [PreserveSig]int OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)]string id);
  [PreserveSig]int OnDefaultDeviceChanged(int flow,int role,[MarshalAs(UnmanagedType.LPWStr)]string id);
  [PreserveSig]int OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)]string id,Key key);
 }
 public class DeviceEvent {public string type="device-event",kind,id;public uint state;public int flow,role;}
 [ComVisible(true),ClassInterface(ClassInterfaceType.None)]
 public class EndpointEvents:IEndpointNotifications,IDisposable {
  volatile bool closed;Enumerator enumerator;ConcurrentQueue<DeviceEvent> queue=new ConcurrentQueue<DeviceEvent>();AutoResetEvent signal=new AutoResetEvent(false);
  public EndpointEvents(){enumerator=(Enumerator)new EnumeratorObject();int hr=enumerator.RegisterEndpointNotificationCallback(this);if(hr!=0){Marshal.ReleaseComObject(enumerator);enumerator=null;Marshal.ThrowExceptionForHR(hr);}}
  int Push(string kind,string id,uint state=0,int flow=-1,int role=-1){if(closed)return 0;if(queue.Count<128)queue.Enqueue(new DeviceEvent{kind=kind,id=id??"",state=state,flow=flow,role=role});try{signal.Set();}catch(ObjectDisposedException){}return 0;}
  public int OnDeviceStateChanged(string id,uint state){return Push("state",id,state);}
  public int OnDeviceAdded(string id){return Push("added",id);}
  public int OnDeviceRemoved(string id){return Push("removed",id);}
  public int OnDefaultDeviceChanged(int flow,int role,string id){return Push("default",id,0,flow,role);}
  public int OnPropertyValueChanged(string id,Key key){return Push("property",id);}
  public DeviceEvent[] Drain(){var result=new List<DeviceEvent>();DeviceEvent value;while(queue.TryDequeue(out value))result.Add(value);return result.ToArray();}
  public void Wait(int milliseconds){signal.WaitOne(milliseconds);}
  public WaitHandle Signal {get{return signal;}}
  public void Dispose(){closed=true;if(enumerator!=null){enumerator.UnregisterEndpointNotificationCallback(this);Marshal.ReleaseComObject(enumerator);enumerator=null;}signal.Dispose();}
 }
 public class Route {public string id="",name="",transport="unknown",route="unknown",reason="";public bool confirmed=false;}
 public static class Probe {
  [DllImport("ole32.dll")]static extern int PropVariantClear(ref Value value);
  [DllImport("cfgmgr32.dll",CharSet=CharSet.Unicode)]static extern uint CM_Locate_DevNodeW(out uint node,string id,uint flags);
  [DllImport("cfgmgr32.dll")]static extern uint CM_Get_Parent(out uint parent,uint node,uint flags);
  [DllImport("cfgmgr32.dll",CharSet=CharSet.Unicode)]static extern uint CM_Get_Device_IDW(uint node,StringBuilder id,uint length,uint flags);
  [DllImport("kernel32.dll")]static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool Process32FirstW(IntPtr snapshot,ref ProcessEntry entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool Process32NextW(IntPtr snapshot,ref ProcessEntry entry);
  [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
  static void Release(object o){if(o!=null&&Marshal.IsComObject(o))Marshal.ReleaseComObject(o);}
  static string Property(Device d,Key key){Properties p=null;Value v=new Value();try{if(d.OpenPropertyStore(0,out p)!=0||p.GetValue(ref key,out v)!=0)return "";return v.type==31?Marshal.PtrToStringUni(v.pointer):"";}finally{PropVariantClear(ref v);Release(p);}}
  static Dictionary<uint,uint> Parents(){var map=new Dictionary<uint,uint>();var snap=CreateToolhelp32Snapshot(2,0);if(snap==new IntPtr(-1))return map;try{var e=new ProcessEntry();e.size=(uint)Marshal.SizeOf(e);if(Process32FirstW(snap,ref e))do{map[e.pid]=e.parent;}while(Process32NextW(snap,ref e));}finally{CloseHandle(snap);}return map;}
  static bool Owned(uint pid,uint root,Dictionary<uint,uint> parents){for(int i=0;i<24&&pid!=0;i++){if(pid==root)return true;uint next;if(!parents.TryGetValue(pid,out next)||pid==next)break;pid=next;}return false;}
  static int SessionState(Device d,uint owner,Dictionary<uint,uint> parents){object manager=null;Sessions sessions=null;int best=-1;try{Guid iid=typeof(SessionManager).GUID;if(d.Activate(ref iid,23,IntPtr.Zero,out manager)!=0)return -1;var m=(SessionManager)manager;if(m.GetSessionEnumerator(out sessions)!=0)return -1;int n;sessions.GetCount(out n);for(int i=0;i<n;i++){object raw=null;try{if(sessions.GetSession(i,out raw)!=0)continue;var s=raw as Session;if(s==null)continue;uint pid;int state;if(s.GetProcessId(out pid)>=0&&Owned(pid,owner,parents)&&s.GetState(out state)==0&&state<2)best=Math.Max(best,state);}finally{Release(raw);}}}catch{}finally{Release(sessions);Release(manager);}return best;}
  static string Transport(Device d,string id){
   var keys=new string[]{Property(d,new Key("78c34fc8-104a-4aca-9ea4-524d52996e57",256)),"SWD\\MMDEVAPI\\"+id};
   bool physical=false;
   foreach(string key in keys){if(String.IsNullOrEmpty(key))continue;uint node;if(CM_Locate_DevNodeW(out node,key,0)!=0)continue;for(int i=0;i<16;i++){var b=new StringBuilder(1024);if(CM_Get_Device_IDW(node,b,1024,0)!=0)break;string value=b.ToString().ToUpperInvariant();if(value.StartsWith("BTHENUM\\")||value.StartsWith("BTHHFENUM\\")||value.StartsWith("BTHLEDEVICE\\")||value.StartsWith("BTH\\"))return "bluetooth";if(value.StartsWith("HDAUDIO\\")||value.StartsWith("USB\\")||value.StartsWith("INTELAUDIO\\")||value.StartsWith("DISPLAY\\"))physical=true;uint next;if(CM_Get_Parent(out next,node,0)!=0||next==node)break;node=next;}}
   return physical?"other":"unknown";
  }
  // Resolve the remote radio from this endpoint's actual PnP ancestry. Never
  // pick a paired headset by name or expose its hardware address in JSON/IPC.
  public static ulong WearAddress(string id){
   Enumerator e=null;Device d=null;
   try {
    e=(Enumerator)new EnumeratorObject();if(e.GetDevice(id,out d)!=0)return 0;
    var keys=new string[]{Property(d,new Key("78c34fc8-104a-4aca-9ea4-524d52996e57",256)),"SWD\\MMDEVAPI\\"+id};
    foreach(string key in keys){uint node;if(String.IsNullOrEmpty(key)||CM_Locate_DevNodeW(out node,key,0)!=0)continue;
     for(int i=0;i<16;i++){var text=new StringBuilder(1024);if(CM_Get_Device_IDW(node,text,1024,0)!=0)break;
      var match=System.Text.RegularExpressions.Regex.Match(text.ToString(),@"^BTHENUM\\DEV_([0-9A-F]{12})(?:\\|$)",System.Text.RegularExpressions.RegexOptions.IgnoreCase);
      if(match.Success)return Convert.ToUInt64(match.Groups[1].Value,16);
      match=System.Text.RegularExpressions.Regex.Match(text.ToString(),@"^BTHENUM\\\{[^}]+\}[^\\]*\\[^\\]*&([0-9A-F]{12})_C[0-9A-F]+$",System.Text.RegularExpressions.RegexOptions.IgnoreCase);
      if(match.Success)return Convert.ToUInt64(match.Groups[1].Value,16);
      uint parent;if(CM_Get_Parent(out parent,node,0)!=0||parent==node)break;node=parent;
     }
    }
   }catch{}finally{Release(d);Release(e);}return 0;
  }
  public static Route Read(int owner){Enumerator e=null;Devices devices=null;Device def=null;try{
   e=(Enumerator)new EnumeratorObject();string defaultId="";if(e.GetDefaultAudioEndpoint(0,0,out def)==0)def.GetId(out defaultId);
   if(e.EnumAudioEndpoints(0,1,out devices)!=0)return new Route{reason="endpoints-unavailable"};uint count;devices.GetCount(out count);var parents=Parents();var active=new List<Route>();var idle=new List<Route>();Route defaultRoute=null;
   for(uint i=0;i<count;i++){Device d=null;try{if(devices.Item(i,out d)!=0)continue;string id;d.GetId(out id);var r=new Route{id=id,name=Property(d,new Key("a45c254e-df1c-4efd-8020-67d146a850e0",14)),transport=Transport(d,id)};if(id==defaultId)defaultRoute=r;int state=SessionState(d,(uint)owner,parents);if(state==1)active.Add(r);else if(state==0)idle.Add(r);}finally{Release(d);}}
   if(active.Count==1){active[0].confirmed=true;active[0].route="session";return active[0];}
   if(active.Count>1)return new Route{reason="multiple-output-sessions"};
   if(idle.Count==1&&idle[0].id==defaultId){idle[0].confirmed=true;idle[0].route="session";return idle[0];}
   if(defaultRoute!=null){defaultRoute.route="default";defaultRoute.reason="awaiting-player-session";return defaultRoute;}
   return new Route{reason="no-output"};
  }catch(Exception error){return new Route{reason="probe-failed-"+error.HResult.ToString("X")};}finally{Release(def);Release(devices);Release(e);}}
 }
}
'@
$events = $null
$wear = $null
$diagnosticUntil = [DateTime]::UtcNow.AddSeconds([Math]::Min(60, [Math]::Max(0, $WearDiagnosticSeconds)))
$wearEndpoint = $null
try {
  if (-not $Once) { $events = New-Object FlowaveOutput.EndpointEvents; $wear = New-Object FlowaveWear.WearWatcher -ArgumentList ($WearDiagnosticSeconds -gt 0) }
  do {
    if ($WearDiagnosticSeconds -gt 0 -and [DateTime]::UtcNow -ge $diagnosticUntil) { break }
    if ($OwnerProcessId -gt 0) { try { $null = [System.Diagnostics.Process]::GetProcessById($OwnerProcessId) } catch { break } }
    if ($events) { foreach ($eventValue in $events.Drain()) { if ($WearDiagnosticSeconds -le 0) { $eventValue | ConvertTo-Json -Compress } } }
    $route = [FlowaveOutput.Probe]::Read($OwnerProcessId)
    if ($wear) {
      if ($wearEndpoint -ne $route.id) {
        $wearEndpoint = $route.id
        $address = [uint64]0
        # The model name selects a documented protocol; PnP selects the device.
        if ($route.transport -eq 'bluetooth' -and $route.name -match '(?i)HUAWEI FreeBuds Pro 5(?:\)|$)') {
          $address = [FlowaveOutput.Probe]::WearAddress($route.id)
        }
        $wear.SetTarget($route.id, $address)
        if ($WearDiagnosticSeconds -gt 0) {
          @{type='wear-diagnostic'; supported=($address -ne 0); status=$(if ($address -ne 0) {'connecting'} else {'no-supported-output'})} | ConvertTo-Json -Compress
        }
        elseif ($address -eq 0) { @{type='wear-state'; id=$route.id; status='unsupported'; worn=$null} | ConvertTo-Json -Compress }
      }
      foreach ($wearValue in $wear.Drain()) {
        if ($wearValue.id -ne $route.id) { continue }
        if ($WearDiagnosticSeconds -gt 0) { @{type='wear-diagnostic'; status=$wearValue.status; worn=$wearValue.worn} | ConvertTo-Json -Compress }
        else { $wearValue | ConvertTo-Json -Compress }
      }
    }
    if ($WearDiagnosticSeconds -le 0) { $route | ConvertTo-Json -Compress }
    [Console]::Out.Flush()
    if (-not $Once) { $null = [System.Threading.WaitHandle]::WaitAny([System.Threading.WaitHandle[]]@($events.Signal, $wear.Signal), 750) }
  } while (-not $Once)
} finally {
  if ($wear) { $wear.Dispose() }
  if ($events) { $events.Dispose() }
}
