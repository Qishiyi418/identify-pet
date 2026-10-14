// Original session display observer. Registers notifications on an invisible
// message-only window; it never requests a power state or holds a wake lock.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;
class DisplayMonitor : NativeWindow, IDisposable {
    const int WM_POWERBROADCAST = 0x218, PBT_POWERSETTINGCHANGE = 0x8013;
    static readonly Guid SessionDisplay = new Guid("2B84C20E-AD23-4DDF-93DB-05FFBD7EFCA5");
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr RegisterPowerSettingNotification(IntPtr recipient, ref Guid setting, uint flags);
    [DllImport("user32.dll")] static extern bool UnregisterPowerSettingNotification(IntPtr handle);
    IntPtr subscription;
    DisplayMonitor() {
        CreateHandle(new CreateParams { Caption = "PetSessionDisplayObserver", Parent = new IntPtr(-3) });
        Guid setting = SessionDisplay;
        subscription = RegisterPowerSettingNotification(Handle, ref setting, 0);
        if (subscription == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    static void Emit(string value) { Console.WriteLine(value); Console.Out.Flush(); }
    protected override void WndProc(ref Message message) {
        if (message.Msg == WM_POWERBROADCAST && message.WParam.ToInt64() == PBT_POWERSETTINGCHANGE && message.LParam != IntPtr.Zero) {
            Guid setting = (Guid)Marshal.PtrToStructure(message.LParam, typeof(Guid));
            if (setting == SessionDisplay && Marshal.ReadInt32(message.LParam, 16) == 4) {
                int state = Marshal.ReadInt32(message.LParam, 20);
                if (state >= 0 && state <= 2) Emit("display:" + state);
            }
        }
        base.WndProc(ref message);
    }
    public void Dispose() {
        if (subscription != IntPtr.Zero) { UnregisterPowerSettingNotification(subscription); subscription = IntPtr.Zero; }
        DestroyHandle();
    }
    [STAThread] static int Main(string[] args) {
        try {
            var parent = Process.GetProcessById(int.Parse(args[0]));
            using (var observer = new DisplayMonitor())
            using (var timer = new System.Windows.Forms.Timer()) {
                timer.Interval = 1000; timer.Tick += (sender, e) => { if (parent.HasExited) Application.ExitThread(); };
                timer.Start(); Emit("ready"); Application.Run();
            }
            return 0;
        } catch (Exception error) { Emit("error:" + error.Message); return 1; }
    }
}
