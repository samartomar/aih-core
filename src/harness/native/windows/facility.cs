// Fixed Windows lifecycle/pipe facility. No policy, credential or provider access.
// Build with the recorded .NET Framework compiler; never compile at runtime.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class Facility {
    const int FrameLimit = 1048576, Chunk = 16384;
    const uint KillOnJobClose = 0x2000, CreateSuspended = 0x4, UnicodeEnvironment = 0x400;
    const uint ExtendedStartupInfoPresent = 0x80000, CreateNoWindow = 0x8000000;
    const uint PipeAccessDuplex = 3, FileFlagOverlapped = 0x40000000, FirstPipeInstance = 0x80000, RejectRemoteClients = 8;
    const uint WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 258, STILL_ACTIVE = 259;
    static readonly object OutputLock = new object(), StateLock = new object();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = FrameLimit, RecursionLimit = 16 };
    static readonly List<FileStream> Pins = new List<FileStream>();
    static readonly Dictionary<string, Dictionary<string, object>> PinRecords = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
    static readonly Dictionary<int, Peer> Peers = new Dictionary<int, Peer>();
    static readonly List<NamedPipeServerStream> Listeners = new List<NamedPipeServerStream>();
    static object[] Entries = new object[0];
    static IntPtr Job = IntPtr.Zero, Root = IntPtr.Zero;
    static FileStream ChildInput;
    static string PipeName;
    static int NextPeer, Accepted, PipeBytes, ChildBytes, Waiting;
    static volatile bool Stopping, Faulted, PipeClosed;
    static readonly Stopwatch Clock = Stopwatch.StartNew();
    static long Until = 30000;
    static long CleanupUntil = Int64.MaxValue;
    static Timer DeadlineTimer;

    static Dictionary<string, object> Obj(object x) { return (Dictionary<string, object>)x; }
    static string Str(Dictionary<string, object> x, string k) { return (string)x[k]; }
    static int Num(Dictionary<string, object> x, string k) { return Convert.ToInt32(x[k]); }
    static object[] Arr(Dictionary<string, object> x, string k) { return (object[])x[k]; }
    static void Send(object x) {
        lock (OutputLock) {
            string line = new JavaScriptSerializer { MaxJsonLength = FrameLimit, RecursionLimit = 16 }.Serialize(x);
            if (line.Length > FrameLimit) throw new InvalidDataException();
            Console.Out.WriteLine(line); Console.Out.Flush();
        }
    }
    static void Event(string type, object value) { Send(new { type = type, value = value }); }
    static void Check(bool ok) { if (!ok) throw new InvalidOperationException(); }
    static string ReadFrame() {
        StringBuilder s = new StringBuilder(); int c;
        while ((c = Console.In.Read()) >= 0) { if (c == '\n') return s.ToString(); if (s.Length >= FrameLimit) throw new InvalidDataException(); s.Append((char)c); }
        return s.Length == 0 ? null : s.ToString();
    }
    static bool Absolute(string p) { return !String.IsNullOrEmpty(p) && Path.IsPathRooted(p) && Path.GetFullPath(p).Equals(p, StringComparison.OrdinalIgnoreCase) && p.Length < 32700 && !p.StartsWith("\\\\"); }
    static string Hash(Stream stream) { using (SHA256 h = SHA256.Create()) { return BitConverter.ToString(h.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); } }
    static void LoadPins(object[] records) {
        Check(records.Length <= 128);
        foreach (object record in records) {
            Check(!Stopping);
            Dictionary<string, object> p = Obj(record); string path = Str(p, "path"), digest = Str(p, "sha256");
            Check(Absolute(path) && digest.Length == 64 && !PinRecords.ContainsKey(path));
            Check((File.GetAttributes(path) & FileAttributes.ReparsePoint) == 0);
            FileStream f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            Pins.Add(f); Check(f.Length == Convert.ToInt64(p["byteLength"]) && Hash(f) == digest); f.Position = 0;
            PinRecords.Add(path, p);
        }
    }
    static void LoadEntries(object[] entries) {
        Check(entries.Length <= 8); HashSet<string> ids = new HashSet<string>();
        foreach (object entry in entries) {
            Dictionary<string, object> e = Obj(entry); string id = Str(e, "id"), exe = Str(e, "executablePath"); object[] argv = Arr(e, "argv");
            Check(id.Length > 0 && id.Length <= 128 && ids.Add(id) && Absolute(exe) && PinRecords.ContainsKey(exe));
            Check(Str(PinRecords[exe], "sha256") == Str(e, "executableSha256") && argv.Length > 0 && argv.Length <= 128);
            Check(Absolute((string)argv[0]) && PinRecords.ContainsKey((string)argv[0]));
            foreach (object a in argv) Check(a is string && ((string)a).Length <= 32700 && ((string)a).IndexOf('\0') < 0);
        }
        Entries = entries;
    }
    static IntPtr NewJob() {
        IntPtr j = CreateJobObject(IntPtr.Zero, null); Check(j != IntPtr.Zero);
        try {
            ExtendedLimits limits = new ExtendedLimits(); limits.Basic.LimitFlags = KillOnJobClose;
            Check(SetInformationJobObject(j, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))); return j;
        } catch { CloseHandle(j); throw; }
    }
    static uint Active() { BasicAccounting a; Check(QueryInformationJobObject(Job, 1, out a, (uint)Marshal.SizeOf(typeof(BasicAccounting)), IntPtr.Zero)); return a.ActiveProcesses; }
    static bool Live(IntPtr process) { if (process == IntPtr.Zero) return false; uint wait = WaitForSingleObject(process, 0); Check(wait == WAIT_OBJECT_0 || wait == WAIT_TIMEOUT); return wait == WAIT_TIMEOUT; }
    static string Birth(IntPtr process) { long created, exited, kernel, user; Check(GetProcessTimes(process, out created, out exited, out kernel, out user)); return created.ToString(System.Globalization.CultureInfo.InvariantCulture); }
    static string Image(IntPtr process) { StringBuilder path = new StringBuilder(32768); int size = path.Capacity; Check(QueryFullProcessImageName(process, 0, path, ref size)); return Path.GetFullPath(path.ToString()); }
    static void Kill() { try { if (Job != IntPtr.Zero) TerminateJobObject(Job, 137); } catch { } try { if (Live(Root)) TerminateProcess(Root, 137); } catch { } }
    static void CleanupWindow(int milliseconds) {
        long end = Clock.ElapsedMilliseconds + Math.Max(0, Math.Min(10000, milliseconds));
        lock (StateLock) { if (end < CleanupUntil) CleanupUntil = end; }
    }
    static void StopOperation() { CleanupWindow(10000); Stopping = true; ClosePipes(); Kill(); }
    static void Fail() { Faulted = true; CleanupWindow(10000); Stopping = true; Kill(); }

    static string Quote(string arg) {
        if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return arg;
        StringBuilder s = new StringBuilder("\""); int backslashes = 0;
        foreach (char c in arg) {
            if (c == '\\') { backslashes++; continue; }
            s.Append('\\', c == '"' ? backslashes * 2 + 1 : backslashes); s.Append(c); backslashes = 0;
        }
        s.Append('\\', backslashes * 2); s.Append('"'); return s.ToString();
    }
    static void Pump(FileStream stream, string type) {
        new Thread(delegate() {
            try {
                byte[] bytes = new byte[Chunk]; int n;
                while ((n = stream.Read(bytes, 0, bytes.Length)) > 0) {
                    int observed = Interlocked.Add(ref ChildBytes, n);
                    if (observed > 2097152) { Event("fault", new { reason = "output-limit", observedBytes = observed }); Fail(); break; }
                    Event(type, Convert.ToBase64String(bytes, 0, n));
                }
            } catch { if (!Stopping) { Fail(); Event("fault", "stream-failed"); } }
            finally { stream.Dispose(); Event(type + "-end", null); }
        }) { IsBackground = true }.Start();
    }
    static object Launch(Dictionary<string, object> c) {
        Check(!Stopping && Root == IntPtr.Zero);
        string file = Str(c, "file"), cwd = Str(c, "cwd"); object[] argv = Arr(c, "argv");
        Check(Absolute(file) && Absolute(cwd) && PinRecords.ContainsKey(file) && argv.Length <= 128);
        StringBuilder command = new StringBuilder(Quote(file)); foreach (object x in argv) { Check(x is string && ((string)x).IndexOf('\0') < 0); command.Append(' ').Append(Quote((string)x)); } Check(command.Length < 32767);
        Dictionary<string, object> environment = Obj(c["env"]); Check(environment.Count <= 256);
        List<string> keys = new List<string>(environment.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase); StringBuilder env = new StringBuilder();
        foreach (string key in keys) { Check(key.Length > 0 && key.IndexOfAny(new char[] { '=', '\0' }) < 0 && environment[key] is string && ((string)environment[key]).IndexOf('\0') < 0); env.Append(key).Append('=').Append((string)environment[key]).Append('\0'); }
        env.Append('\0'); Check(env.Length <= 262144);
        SecurityAttributes sa = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = 1 };
        IntPtr inRead = IntPtr.Zero, inWrite = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero, errRead = IntPtr.Zero, errWrite = IntPtr.Zero;
        IntPtr attr = IntPtr.Zero, inherited = IntPtr.Zero, environmentBlock = IntPtr.Zero; ProcessInformation pi = new ProcessInformation();
        try {
            Check(CreatePipe(out inRead, out inWrite, ref sa, 0)); Check(CreatePipe(out outRead, out outWrite, ref sa, 0)); Check(CreatePipe(out errRead, out errWrite, ref sa, 0));
            Check(SetHandleInformation(inWrite, 1, 0) && SetHandleInformation(outRead, 1, 0) && SetHandleInformation(errRead, 1, 0));
            IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size); attr = Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attr, 1, 0, ref size));
            inherited = Marshal.AllocHGlobal(3 * IntPtr.Size); Marshal.WriteIntPtr(inherited, 0, inRead); Marshal.WriteIntPtr(inherited, IntPtr.Size, outWrite); Marshal.WriteIntPtr(inherited, 2 * IntPtr.Size, errWrite);
            Check(UpdateProcThreadAttribute(attr, 0, (IntPtr)0x20002, inherited, (IntPtr)(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            StartupInfoEx startup = new StartupInfoEx(); startup.Info.Size = Marshal.SizeOf(typeof(StartupInfoEx)); startup.Info.Flags = 0x100; startup.Info.StdInput = inRead; startup.Info.StdOutput = outWrite; startup.Info.StdError = errWrite; startup.Attributes = attr;
            environmentBlock = Marshal.StringToHGlobalUni(env.ToString());
            Check(!Stopping);
            Check(CreateProcess(file, command, IntPtr.Zero, IntPtr.Zero, true, CreateSuspended | UnicodeEnvironment | ExtendedStartupInfoPresent | CreateNoWindow, environmentBlock, cwd, ref startup, out pi));
            Root = pi.Process; // retain ownership before any subsequent operation can fail
            Event("created", new { pid = pi.ProcessId, birth = Birth(Root) });
            Check(AssignProcessToJobObject(Job, Root)); bool member; Check(IsProcessInJob(Root, Job, out member) && member);
            string birth = Birth(Root), image = Image(Root); Check(image.Equals(file, StringComparison.OrdinalIgnoreCase));
            ChildInput = new FileStream(new SafeFileHandle(inWrite, true), FileAccess.Write); inWrite = IntPtr.Zero;
            FileStream output = new FileStream(new SafeFileHandle(outRead, true), FileAccess.Read); outRead = IntPtr.Zero;
            FileStream error = new FileStream(new SafeFileHandle(errRead, true), FileAccess.Read); errRead = IntPtr.Zero;
            Check(!Stopping && ResumeThread(pi.Thread) != 0xffffffff); Pump(output, "stdout"); Pump(error, "stderr");
            IntPtr held = Root; new Thread(delegate() { WaitForSingleObject(held, 0xffffffff); uint code; if (GetExitCodeProcess(held, out code)) Event("exit", new { code = (long)code, signal = (string)null }); }) { IsBackground = true }.Start();
            return new { status = "started", pid = pi.ProcessId, birth = birth };
        } catch { StopOperation(); if (Root != IntPtr.Zero) { IntPtr held = Root; new Thread(delegate() { WaitForSingleObject(held, 0xffffffff); uint code; if (GetExitCodeProcess(held, out code)) Event("exit", new { code = (long)code, signal = (string)null }); }) { IsBackground = true }.Start(); } throw; }
        finally {
            foreach (IntPtr h in new IntPtr[] { inRead, inWrite, outRead, outWrite, errRead, errWrite, pi.Thread }) if (h != IntPtr.Zero) CloseHandle(h);
            if (attr != IntPtr.Zero) { DeleteProcThreadAttributeList(attr); Marshal.FreeHGlobal(attr); } if (inherited != IntPtr.Zero) Marshal.FreeHGlobal(inherited); if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
        }
    }

    sealed class Peer {
        internal int Id; internal NamedPipeServerStream Pipe; internal IntPtr Process;
        internal void Close() { try { Pipe.Dispose(); } catch { } lock (this) { if (Process != IntPtr.Zero) { CloseHandle(Process); Process = IntPtr.Zero; } } }
    }
    static string[] CommandLine(uint pid) {
        string command;
        using (ManagementObject p = new ManagementObject(null, "Win32_Process.Handle='" + pid.ToString(System.Globalization.CultureInfo.InvariantCulture) + "'", new ObjectGetOptions(null, TimeSpan.FromSeconds(2), false))) { p.Get(); command = p["CommandLine"] as string; }
        Check(command != null && command.Length < 32767); int count; IntPtr argv = CommandLineToArgv(command, out count); Check(argv != IntPtr.Zero && count <= 130);
        try { string[] result = new string[count]; for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size)); return result; } finally { LocalFree(argv); }
    }
    static object Observe(Peer peer) {
        lock (peer) {
            string stage = "membership";
            try {
            IntPtr process = peer.Process; bool member;
            Check(process != IntPtr.Zero && Live(process) && IsProcessInJob(process, Job, out member) && member);
            stage = "image"; string birth = Birth(process), image = Image(process);
            stage = "command-line"; string[] args = CommandLine(GetProcessId(process));
            stage = "birth";
            Check(Live(process) && Birth(process) == birth && args.Length > 1 && args[0].Equals(image, StringComparison.OrdinalIgnoreCase));
            stage = "entry";
            foreach (object candidate in Entries) {
                Dictionary<string, object> e = Obj(candidate); object[] expected = Arr(e, "argv");
                if (!image.Equals(Str(e, "executablePath"), StringComparison.OrdinalIgnoreCase) || args.Length != expected.Length + 1) continue;
                bool match = true; for (int i = 0; i < expected.Length; i++) if (args[i + 1] != (string)expected[i]) match = false;
                if (match) return new { status = "observed", pid = GetProcessId(process), birth = birth, executablePath = image, executableSha256 = Str(e, "executableSha256"), argv = expected, selectedEntryId = Str(e, "id") };
            }
            throw new InvalidOperationException();
            } catch { return new { status = "unavailable", reason = "ipc-peer-" + stage }; }
        }
    }
    static PipeSecurity PipeAcl() {
        SecurityIdentifier owner = WindowsIdentity.GetCurrent().User; PipeSecurity acl = new PipeSecurity(); acl.SetOwner(owner); acl.SetAccessRuleProtection(true, false);
        // Additional server instances need CreateNewInstance; all peers still require owned Job identity.
        acl.AddAccessRule(new PipeAccessRule(owner, PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize | PipeAccessRights.CreateNewInstance, AccessControlType.Allow));
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.FullControl, AccessControlType.Allow)); return acl;
    }
    static NamedPipeServerStream NewPipe(bool first) {
        byte[] descriptor = PipeAcl().GetSecurityDescriptorBinaryForm(); GCHandle pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
        try {
            SecurityAttributes sa = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = pinned.AddrOfPinnedObject(), Inherit = 0 };
            IntPtr handle = CreateNamedPipe("\\\\.\\pipe\\" + PipeName, PipeAccessDuplex | FileFlagOverlapped | (first ? FirstPipeInstance : 0u), RejectRemoteClients, 4, Chunk, Chunk, 0, ref sa); Check(handle != new IntPtr(-1));
            return new NamedPipeServerStream(PipeDirection.InOut, true, false, new SafePipeHandle(handle, true));
        } finally { pinned.Free(); }
    }
    static void Listen(NamedPipeServerStream pipe) {
        new Thread(delegate() {
            Peer peer = null;
            try {
                pipe.WaitForConnection(); lock (StateLock) Waiting--; if (Stopping || PipeClosed) { pipe.Dispose(); return; }
                uint pid; Check(GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out pid));
                IntPtr process = OpenProcess(0x1000 | 0x100000, false, pid); Check(process != IntPtr.Zero);
                peer = new Peer { Id = Interlocked.Increment(ref NextPeer), Pipe = pipe, Process = process };
                lock (StateLock) { Check(Peers.Count < 4 && ++Accepted <= 16); Peers.Add(peer.Id, peer); }
                Event("connect", new { id = peer.Id });
                EnsureListener();
                byte[] bytes = new byte[Chunk]; int n; while (!Stopping && (n = pipe.Read(bytes, 0, bytes.Length)) > 0) {
                    int observed = Interlocked.Add(ref PipeBytes, n);
                    if (observed > 4194304) { Event("fault", new { reason = "pipe-limit", observedBytes = observed }); Fail(); break; }
                    Event("pipe-data", new { id = peer.Id, data = Convert.ToBase64String(bytes, 0, n) });
                }
            } catch { if (!Stopping && peer == null) Event("pipe-rejected", null); }
            finally { if (peer != null) { lock (StateLock) Peers.Remove(peer.Id); peer.Close(); Event("pipe-end", peer.Id); } else pipe.Dispose(); if (!Stopping && !PipeClosed) try { EnsureListener(); } catch { Fail(); } }
        }) { IsBackground = true }.Start();
    }
    static void EnsureListener() {
        NamedPipeServerStream next = null;
        lock (StateLock) { if (!Stopping && !PipeClosed && Accepted < 16 && Waiting == 0 && Peers.Count < 4) { next = NewPipe(false); Listeners.Add(next); Waiting++; } }
        if (next != null) Listen(next);
    }
    static object CreatePipeListener() {
        Check(!Stopping && PipeName == null); PipeName = "aih-native-" + Guid.NewGuid().ToString("N"); NamedPipeServerStream pipe = NewPipe(true); lock (StateLock) { Listeners.Add(pipe); Waiting++; } Listen(pipe);
        return new { status = "ready", endpoint = "\\\\.\\pipe\\" + PipeName };
    }
    static object Probe() {
        Check(!Stopping); Job = NewJob(); Check(Active() == 0); PipeName = "aih-probe-" + Guid.NewGuid().ToString("N");
        using (NamedPipeServerStream server = NewPipe(true)) {
            bool observed = false;
            Thread connected = new Thread(delegate() {
                try { server.WaitForConnection(); uint pid; Check(GetNamedPipeClientProcessId(server.SafePipeHandle.DangerousGetHandle(), out pid)); Check(pid == (uint)Process.GetCurrentProcess().Id); Check(server.ReadByte() == 73); server.WriteByte(74); observed = true; } catch { }
            }) { IsBackground = true }; connected.Start();
            using (NamedPipeClientStream client = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut)) { client.Connect(1000); client.WriteByte(73); Check(client.ReadByte() == 74); }
            Check(connected.Join(1000) && observed && Active() == 0);
        }
        return new { status = "available" };
    }
    static void ClosePipes() {
        PipeClosed = true; lock (StateLock) { foreach (NamedPipeServerStream pipe in Listeners) try { pipe.Dispose(); } catch { } foreach (Peer peer in Peers.Values) peer.Close(); Peers.Clear(); }
    }
    static object Terminate(int grace, int deadline) {
        Stopwatch watch = Stopwatch.StartNew(); CleanupWindow(deadline); Stopping = true; ClosePipes(); try { if (ChildInput != null) ChildInput.Dispose(); } catch { }
        bool zero = false, activeKnown = false; uint active = 0;
        try {
            while (watch.ElapsedMilliseconds < Math.Min(grace, deadline)) { active = Active(); activeKnown = true; if (active == 0 && !Live(Root)) { zero = true; break; } Thread.Sleep(10); }
            if (!zero) { Kill(); while (watch.ElapsedMilliseconds < deadline) { active = Active(); activeKnown = true; if (active == 0 && !Live(Root)) { zero = true; break; } Thread.Sleep(10); } }
            active = Active(); activeKnown = true; zero = active == 0 && !Live(Root);
        } catch { zero = false; }
        object[] survivors = new object[0];
        try { if (!zero && Live(Root)) survivors = new object[] { new { pid = GetProcessId(Root), role = "client" } }; } catch { zero = false; }
        return new { processes = zero && !Faulted ? "confirmed" : "unresolved", survivors = survivors, elapsedMs = watch.ElapsedMilliseconds, activeProcesses = activeKnown ? (long?)active : null };
    }

    static void PathSafe(string path) {
        Check(Absolute(path)); string current = path;
        while (!String.IsNullOrEmpty(current)) { Check((File.GetAttributes(current) & FileAttributes.ReparsePoint) == 0); current = Path.GetDirectoryName(current); }
    }
    static List<string> CellPaths(string directory) {
        PathSafe(directory); Check(Directory.Exists(directory)); List<string> paths = new List<string>(); Queue<string> pending = new Queue<string>(); pending.Enqueue(directory);
        while (pending.Count > 0) { string path = pending.Dequeue(); Check(paths.Count < 512); Check((File.GetAttributes(path) & FileAttributes.ReparsePoint) == 0); paths.Add(path); if (Directory.Exists(path)) foreach (string child in Directory.EnumerateFileSystemEntries(path)) { Check(paths.Count + pending.Count < 512); pending.Enqueue(child); } }
        return paths;
    }
    sealed class CellHandle : IDisposable {
        internal string Path; internal IntPtr Handle; internal bool Directory;
        public void Dispose() { if (Handle != IntPtr.Zero) { CloseHandle(Handle); Handle = IntPtr.Zero; } }
    }
    static CellHandle HoldPath(string path, bool write) {
        // Deny rename/delete while checking and changing this exact object; never follow its reparse point.
        IntPtr h = CreateFile(path, 0x20000u | (write ? 0x40000u : 0u), 1, IntPtr.Zero, 3, 0x2200000, IntPtr.Zero);
        Check(h != new IntPtr(-1));
        try {
            FileInformation info; Check(GetFileInformationByHandle(h, out info)); Check((info.Attributes & 0x400) == 0);
            Check((info.Attributes & 0x10) != 0 || info.Links == 1); // ACL effects must not reach another file path.
            StringBuilder final = new StringBuilder(32768); Check(GetFinalPathNameByHandle(h, final, (uint)final.Capacity, 0) > 0);
            Check(final.ToString().StartsWith("\\\\?\\") && final.ToString().Substring(4).Equals(path, StringComparison.OrdinalIgnoreCase));
            return new CellHandle { Path = path, Handle = h, Directory = (info.Attributes & 0x10) != 0 };
        } catch { CloseHandle(h); throw; }
    }
    static RawSecurityDescriptor Descriptor(IntPtr handle) {
        IntPtr owner, group, dacl, sacl, descriptor;
        Check(GetSecurityInfo(handle, 1, 1 | 4, out owner, out group, out dacl, out sacl, out descriptor) == 0);
        try { uint length = GetSecurityDescriptorLength(descriptor); Check(length > 0 && length <= 65536); byte[] bytes = new byte[length]; Marshal.Copy(descriptor, bytes, 0, bytes.Length); return new RawSecurityDescriptor(bytes, 0); } finally { LocalFree(descriptor); }
    }
    static object Cell(Dictionary<string, object> c, bool protect) {
        Check(!Stopping); List<string> paths = CellPaths(Str(c, "directory")); SecurityIdentifier user = WindowsIdentity.GetCurrent().User, system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), admin = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        List<CellHandle> held = new List<CellHandle>();
        try {
        string ancestor = Path.GetDirectoryName(paths[0]); while (!String.IsNullOrEmpty(ancestor)) { held.Add(HoldPath(ancestor, false)); ancestor = Path.GetDirectoryName(ancestor); }
        List<CellHandle> cell = new List<CellHandle>(); foreach (string path in paths) { CellHandle h = HoldPath(path, protect); held.Add(h); cell.Add(h); Check(Descriptor(h.Handle).Owner.Equals(user)); }
        if (protect) foreach (CellHandle path in cell) {
            Check(!Stopping);
            bool directory = path.Directory; FileSystemSecurity acl = directory ? (FileSystemSecurity)new DirectorySecurity() : new FileSecurity(); acl.SetOwner(user); acl.SetAccessRuleProtection(true, false);
            foreach (SecurityIdentifier sid in new SecurityIdentifier[] { user, system, admin }) acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, directory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
            byte[] descriptor = acl.GetSecurityDescriptorBinaryForm(); Check(SetKernelObjectSecurity(path.Handle, 4u | 0x80000000u, descriptor));
        }
        foreach (CellHandle path in cell) { RawSecurityDescriptor acl = Descriptor(path.Handle); Check((acl.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0 && acl.Owner.Equals(user) && acl.DiscretionaryAcl != null); HashSet<string> allowed = new HashSet<string>();
            foreach (GenericAce ace in acl.DiscretionaryAcl) { CommonAce rule = ace as CommonAce; Check(rule != null && rule.AceQualifier == AceQualifier.AccessAllowed && (rule.SecurityIdentifier.Equals(user) || rule.SecurityIdentifier.Equals(system) || rule.SecurityIdentifier.Equals(admin)) && (rule.AccessMask & (int)FileSystemRights.FullControl) == (int)FileSystemRights.FullControl); allowed.Add(rule.SecurityIdentifier.Value); } Check(allowed.Contains(user.Value)); }
        return new { status = "protected" };
        } finally { foreach (CellHandle h in held) h.Dispose(); }
    }

    static int Main() {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        try {
            DeadlineTimer = new Timer(delegate(object state) {
                if (!Stopping && Clock.ElapsedMilliseconds >= Interlocked.Read(ref Until)) StopOperation();
                if (Stopping && Clock.ElapsedMilliseconds >= Interlocked.Read(ref CleanupUntil)) { Kill(); Environment.Exit(124); }
            }, null, 25, 25);
            Event("ready", new { protocol = 1 }); string line;
            while ((line = ReadFrame()) != null) {
                Dictionary<string, object> c = Obj(Json.DeserializeObject(line)); int id = Num(c, "id"); object result;
                try {
                    string op = Str(c, "op");
                    if (op == "init") { Check(Job == IntPtr.Zero && !Stopping); Until = Clock.ElapsedMilliseconds + Num(c, "deadlineMs"); LoadPins(Arr(c, "runtimePins")); LoadEntries(Arr(c, "selectedEntries")); Check(!Stopping); Job = NewJob(); Check(Active() == 0); result = new { status = "ready" }; }
                    else if (op == "probe") result = Probe();
                    else if (op == "protect" || op == "validate") result = Cell(c, op == "protect");
                    else if (op == "start") result = Launch(c);
                    else if (op == "pipe") result = CreatePipeListener();
                    else if (op == "pipe-stop") { ClosePipes(); result = new { ok = true }; }
                    else if (op == "peer") { Peer peer; lock (StateLock) Check(Peers.TryGetValue(Num(c, "peer"), out peer)); result = Observe(peer); }
                    else if (op == "pipe-write") { Peer peer; lock (StateLock) Check(Peers.TryGetValue(Num(c, "peer"), out peer)); byte[] bytes = Convert.FromBase64String(Str(c, "data")); Check(bytes.Length <= Chunk); peer.Pipe.Write(bytes, 0, bytes.Length); result = new { ok = true }; }
                    else if (op == "pipe-close") { Peer peer; lock (StateLock) Peers.TryGetValue(Num(c, "peer"), out peer); if (peer != null) peer.Close(); result = new { ok = true }; }
                    else if (op == "input") { byte[] bytes = Convert.FromBase64String(Str(c, "data")); Check(bytes.Length <= Chunk && ChildInput != null && !Stopping); ChildInput.Write(bytes, 0, bytes.Length); ChildInput.Flush(); result = new { ok = true }; }
                    else if (op == "input-end") { if (ChildInput != null) ChildInput.Dispose(); result = new { ok = true }; }
                    else if (op == "track") result = new { activeProcesses = Active() };
                    else if (op == "cancel") { StopOperation(); result = new { ok = true }; }
                    else if (op == "terminate") result = Terminate(Num(c, "graceMs"), Num(c, "deadlineMs"));
                    else throw new InvalidDataException();
                    Send(new { id = id, result = result });
                } catch { Send(new { id = id, result = new { status = "unavailable", reason = "windows-facility-failed", partialPid = Root == IntPtr.Zero ? 0 : GetProcessId(Root) } }); }
            }
            return 0;
        } catch { return 125; }
        finally { Stopping = true; ClosePipes(); Kill(); if (Root != IntPtr.Zero) CloseHandle(Root); if (Job != IntPtr.Zero) CloseHandle(Job); foreach (FileStream pin in Pins) pin.Dispose(); if (DeadlineTimer != null) DeadlineTimer.Dispose(); }
    }

    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { internal int Length; internal IntPtr Descriptor; internal int Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo { internal int Size; internal string Reserved, Desktop, Title; internal int X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags; internal short ShowWindow, Reserved2; internal IntPtr ReservedPtr, StdInput, StdOutput, StdError; }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { internal StartupInfo Info; internal IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { internal IntPtr Process, Thread; internal uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { internal long PerProcessUserTimeLimit, PerJobUserTimeLimit; internal uint LimitFlags; internal UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; internal uint ActiveProcessLimit; internal UIntPtr Affinity; internal uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { internal ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { internal BasicLimits Basic; internal IoCounters Io; internal UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)] struct BasicAccounting { internal long TotalUserTime, TotalKernelTime, ThisPeriodUserTime, ThisPeriodKernelTime; internal uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
    [StructLayout(LayoutKind.Sequential)] struct FileInformation { internal uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out BasicAccounting info, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exit);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exit);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes sa, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")] static extern bool CreateProcess(string file, StringBuilder command, IntPtr processSa, IntPtr threadSa, bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfoEx startup, out ProcessInformation pi);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateNamedPipeW")] static extern IntPtr CreateNamedPipe(string name, uint openMode, uint pipeMode, int instances, int outSize, int inSize, int timeout, ref SecurityAttributes sa);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "CommandLineToArgvW")] static extern IntPtr CommandLineToArgv(string command, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")] static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr sa, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(IntPtr file, out FileInformation info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandle(IntPtr file, StringBuilder path, uint size, uint flags);
    [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetKernelObjectSecurity(IntPtr handle, uint information, byte[] descriptor);
}
