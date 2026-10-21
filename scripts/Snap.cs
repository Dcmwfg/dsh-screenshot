using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

/// <summary>
/// One shutter: optionally push a window aside, blit the desktop into a bitmap,
/// put the window back, save a PNG. No UI lives here — the crop happens in the
/// browser, over a frozen copy of what this returned.
///
/// Kept deliberately small so the failure surface is the interop, not a form.
/// </summary>
public static class Snap
{
    private const int SwMinimize = 6;
    private const int SwRestore = 9;
    private const int SrcCopy = 0x00CC0020;
    private const int CaptureBlt = 0x40000000;

    [DllImport("user32.dll", EntryPoint = "ShowWindowAsync")]
    private static extern bool ShowWindowAsync(IntPtr window, int command);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr window);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr window, IntPtr dc);

    [DllImport("dwmapi.dll")]
    private static extern int DwmFlush();

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleDC(IntPtr dc);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int width, int height);

    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr dc, IntPtr shape);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr shape);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr dc);

    [DllImport("gdi32.dll")]
    private static extern bool BitBlt(
        IntPtr target, int x, int y, int width, int height,
        IntPtr source, int sourceX, int sourceY, int rop);

    /// <summary>
    /// Take the shot. Every argument is a plain string or int so PowerShell can
    /// pass what it parsed from its own command line without object marshalling.
    /// </summary>
    /// <returns>One JSON object on a single line.</returns>
    public static string Run(string outPath, int hide, string titleFragment, string recordPath, int settleMs)
    {
        IntPtr parked = IntPtr.Zero;
        try
        {
            // Before any measurement: a DPI-unaware process sees the scaled
            // virtual screen (1536x864 at 125%) while the DC holds 1920x1080,
            // and the blit silently captures a corner of the real desktop.
            TryDpiAware();

            Rectangle screen = SystemInformation.VirtualScreen;
            if (screen.Width <= 0 || screen.Height <= 0)
                return Fail("the virtual screen has no usable size");

            string how;
            IntPtr target = IntPtr.Zero;
            if (hide != 0)
            {
                target = FindWindow(titleFragment, out how);
                if (how != "ok")
                    return Fail(how);
                parked = target;
                if (recordPath != null && recordPath.Length > 0)
                    TryWriteRecord(recordPath, target);

                ShowWindowAsync(target, SwMinimize);
                AwaitMinimize(target, settleMs);
            }

            byte[] png = Blit(screen, settleMs);
            string directory = Path.GetDirectoryName(outPath);
            if (directory != null && directory.Length > 0 && !Directory.Exists(directory))
                Directory.CreateDirectory(directory);
            File.WriteAllBytes(outPath, png);

            // Restore before answering: the caller should never receive a reply
            // that refers to a shot taken while its own window is still parked.
            bool restored = true;
            if (parked != IntPtr.Zero)
                restored = Unpark(parked, settleMs);

            string payload = "{";
            payload += "\"ok\":true";
            payload += ",\"path\":" + Quote(outPath);
            payload += ",\"width\":" + screen.Width.ToString();
            payload += ",\"height\":" + screen.Height.ToString();
            payload += ",\"left\":" + screen.X.ToString();
            payload += ",\"top\":" + screen.Y.ToString();
            payload += ",\"restored\":" + (restored ? "true" : "false");
            payload += ",\"reason\":\"\"";
            payload += ",\"message\":\"\"";
            payload += "}";
            return payload;
        }
        catch (Exception error)
        {
            return Fail(error.GetType().Name + ": " + error.Message);
        }
        finally
        {
            if (parked != IntPtr.Zero)
                Unpark(parked, settleMs);
            if (recordPath != null && recordPath.Length > 0)
            {
                try { if (File.Exists(recordPath)) File.Delete(recordPath); }
                catch { }
            }
        }
    }

    private static void TryDpiAware()
    {
        try { SetProcessDPIAware(); }
        catch { }
    }

    /// <summary>
    /// The top-level window whose caption contains the fragment. A fragment
    /// that matches nothing is an error rather than a guess: minimizing the
    /// wrong window and shooting its desktop is worse than refusing.
    /// </summary>
    private static IntPtr FindWindow(string fragment, out string how)
    {
        how = "ok";
        int self = Process.GetCurrentProcess().Id;

        if (fragment == null || fragment.Trim().Length == 0)
        {
            IntPtr foreground = GetForegroundWindow();
            if (foreground == IntPtr.Zero || !IsWindowVisible(foreground))
            {
                how = "no window is in the foreground to step aside";
                return IntPtr.Zero;
            }
            return foreground;
        }

        string needle = fragment.Trim();
        Process[] all = Process.GetProcesses();
        IntPtr best = IntPtr.Zero;
        try
        {
            for (int index = 0; index < all.Length; index++)
            {
                Process process = all[index];
                if (process.Id == self) continue;
                IntPtr handle;
                try { handle = process.MainWindowHandle; }
                catch { continue; }
                if (handle == IntPtr.Zero) continue;
                if (!IsWindowVisible(handle)) continue;
                string caption;
                try { caption = process.MainWindowTitle; }
                catch { continue; }
                if (caption == null || caption.Length == 0) continue;
                if (caption.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) continue;
                best = handle;
                break;
            }
        }
        finally
        {
            for (int index = 0; index < all.Length; index++)
            {
                try { all[index].Dispose(); }
                catch { }
            }
        }

        if (best == IntPtr.Zero)
        {
            how = "no visible window has a caption containing the page title";
            return IntPtr.Zero;
        }
        return best;
    }

    /// <summary>
    /// Wait for the minimize animation to finish. Without this the blit can land
    /// on a frame where the window is halfway out and still covers the desktop.
    /// </summary>
    private static void AwaitMinimize(IntPtr window, int settleMs)
    {
        int limit = settleMs > 0 ? settleMs : 1200;
        int spent = 0;
        while (!IsIconic(window) && spent < limit)
        {
            DwmFlush();
            Thread.Sleep(40);
            spent += 40;
        }
        Settle(settleMs);
    }

    /// <summary>Drain compositor frames so what follows is a settled desktop.</summary>
    private static void Settle(int settleMs)
    {
        int frames = settleMs > 0 ? Math.Max(4, settleMs / 60) : 10;
        for (int index = 0; index < frames; index++)
        {
            DwmFlush();
            Thread.Sleep(60);
        }
    }

    private static bool Unpark(IntPtr window, int settleMs)
    {
        try
        {
            if (!IsWindowVisible(window) || IsIconic(window))
                ShowWindowAsync(window, SwRestore);
            SetForegroundWindow(window);
            DwmFlush();
            Thread.Sleep(80);
            DwmFlush();
            return !IsIconic(window);
        }
        catch
        {
            return false;
        }
    }

    private static void TryWriteRecord(string recordPath, IntPtr window)
    {
        try
        {
            string directory = Path.GetDirectoryName(recordPath);
            if (directory != null && directory.Length > 0 && !Directory.Exists(directory))
                Directory.CreateDirectory(directory);
            File.WriteAllText(recordPath, window.ToInt64().ToString(), Encoding.ASCII);
        }
        catch
        {
        }
    }

    /// <summary>
    /// Screen DC to memory DC. BitBlt with CAPTUREBLT is what keeps layered and
    /// DWM-composited surfaces (wallpapers, hardware overlays) in the result;
    /// Graphics.CopyFromScreen drops them on some machines.
    /// </summary>
    private static byte[] Blit(Rectangle screen, int settleMs)
    {
        IntPtr screenDc = GetDC(IntPtr.Zero);
        if (screenDc == IntPtr.Zero)
            throw new InvalidOperationException("GetDC returned no screen context");

        IntPtr memoryDc = IntPtr.Zero;
        IntPtr bitmap = IntPtr.Zero;
        IntPtr previous = IntPtr.Zero;
        try
        {
            memoryDc = CreateCompatibleDC(screenDc);
            bitmap = CreateCompatibleBitmap(screenDc, screen.Width, screen.Height);
            if (memoryDc == IntPtr.Zero || bitmap == IntPtr.Zero)
                throw new InvalidOperationException("could not allocate the capture surface");

            previous = SelectObject(memoryDc, bitmap);
            bool copied = BitBlt(
                memoryDc, 0, 0, screen.Width, screen.Height,
                screenDc, screen.X, screen.Y, SrcCopy | CaptureBlt);
            if (!copied)
                throw new InvalidOperationException("BitBlt refused the desktop copy");

            SelectObject(memoryDc, previous);
            previous = IntPtr.Zero;

            using (Image image = Image.FromHbitmap(bitmap))
            using (Bitmap frame = new Bitmap(image))
            using (MemoryStream buffer = new MemoryStream())
            {
                frame.Save(buffer, ImageFormat.Png);
                return buffer.ToArray();
            }
        }
        finally
        {
            if (previous != IntPtr.Zero && memoryDc != IntPtr.Zero) SelectObject(memoryDc, previous);
            if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
            if (memoryDc != IntPtr.Zero) DeleteDC(memoryDc);
            ReleaseDC(IntPtr.Zero, screenDc);
        }
    }

    private static string Fail(string message)
    {
        return "{\"ok\":false,\"path\":\"\",\"width\":0,\"height\":0,\"left\":0,\"top\":0,\"restored\":false,\"reason\":\"failed\",\"message\":" + Quote(message) + "}";
    }

    private static string Quote(string value)
    {
        if (value == null) return "\"\"";
        StringBuilder text = new StringBuilder(value.Length + 8);
        text.Append('"');
        for (int index = 0; index < value.Length; index++)
        {
            char letter = value[index];
            if (letter == '"') text.Append("\\\"");
            else if (letter == '\\') text.Append("\\\\");
            else if (letter == '\n') text.Append("\\n");
            else if (letter == '\r') text.Append("\\r");
            else if (letter == '\t') text.Append("\\t");
            else if (letter < 0x20) text.Append(' ');
            else text.Append(letter);
        }
        text.Append('"');
        return text.ToString();
    }
}
