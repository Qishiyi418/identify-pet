// Original read-only Win32 foreground-window observer. No hooks or privileges.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
class FullscreenMonitor {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr h, ref MonitorInfo info);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref Point point);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder text, int count);
    static bool Fullscreen(IntPtr pet) {
        IntPtr foreground = GetForegroundWindow();
        if (foreground == IntPtr.Zero || foreground == pet || !IsWindowVisible(foreground) || IsIconic(foreground)) return false;
        var name = new StringBuilder(256); GetClassName(foreground, name, name.Capacity);
        if (name.ToString() == "Progman" || name.ToString() == "WorkerW" || name.ToString() == "Shell_TrayWnd") return false;
        IntPtr monitor = MonitorFromWindow(foreground, 2);
        if (monitor != MonitorFromWindow(pet, 2)) return false;
        var info = new MonitorInfo(); info.Size = Marshal.SizeOf(info);
        Rect client; var point = new Point();
        if (!GetMonitorInfo(monitor, ref info) || !GetClientRect(foreground, out client) || !ClientToScreen(foreground, ref point)) return false;
        return point.X <= info.Monitor.Left + 2 && point.Y <= info.Monitor.Top + 2 &&
            point.X + client.Right >= info.Monitor.Right - 2 && point.Y + client.Bottom >= info.Monitor.Bottom - 2;
    }
    static int Main(string[] args) {
        try {
            SetProcessDPIAware();
            var pet = new IntPtr(long.Parse(args[0]));
            var parent = Process.GetProcessById(int.Parse(args[1]));
            bool? previous = null;
            while (!parent.HasExited) {
                bool current = Fullscreen(pet);
                if (previous != current) { Console.WriteLine(current ? "1" : "0"); Console.Out.Flush(); previous = current; }
                Thread.Sleep(500);
            }
            return 0;
        } catch { return 1; }
    }
}
