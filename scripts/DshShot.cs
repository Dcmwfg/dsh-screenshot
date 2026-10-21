// dsh-screenshot native engine: hide the foreground window, freeze the screen,
// let the user drag a rectangle, restore the window, save the crop as PNG.
// Compiled on demand by scripts/snip.ps1 (Add-Type), so it must stay
// C# 5-compatible (no string interpolation, no expression-bodied members).

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class DshShot
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    private const int SW_HIDE = 0;
    private const int SW_RESTORE = 9;
    private const uint GA_ROOT = 2;
    private static readonly string[] ExcludedProcesses = { "powershell", "pwsh", "cmd", "conhost", "WindowsTerminal", "wezterm-gui" };

    /// <summary>Outcome of one capture attempt; serialized by RunJson.</summary>
    public sealed class Outcome
    {
        public bool ok;
        public string path = "";
        public string reason = "";
        public string message = "";
        public int width;
        public int height;
    }

    /// <summary>Run one capture and answer a single-line JSON document.</summary>
    public static string RunJson(string outPath, int timeoutSeconds, string targetFile, string autoSelect, string titleFragment, bool hideWindow)
    {
        Outcome outcome = Run(outPath, timeoutSeconds, targetFile, autoSelect, titleFragment, hideWindow);
        return "{"
            + "\"ok\":" + (outcome.ok ? "true" : "false")
            + ",\"path\":" + Quote(outcome.path)
            + ",\"reason\":" + Quote(outcome.reason)
            + ",\"message\":" + Quote(outcome.message)
            + ",\"width\":" + outcome.width
            + ",\"height\":" + outcome.height
            + "}";
    }

    private static Outcome Run(string outPath, int timeoutSeconds, string targetFile, string autoSelect, string titleFragment, bool hideWindow)
    {
        Outcome outcome = new Outcome();
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch { try { SetProcessDPIAware(); } catch { } }

        // The window to hide is the page's own browser window. The caller passes
        // its document title because the foreground window at spawn time can be a
        // console that the launcher briefly owned. Without hiding there is no
        // window to find at all: the frozen frame simply keeps what is on screen.
        IntPtr target = IntPtr.Zero;
        if (hideWindow)
        {
            target = FindByTitle(titleFragment);
            if (target == IntPtr.Zero) target = GetAncestor(GetForegroundWindow(), GA_ROOT);
            if (target == IntPtr.Zero || !IsWindow(target))
            {
                outcome.reason = "failed";
                outcome.message = "no window to hide";
                return outcome;
            }
            if (targetFile != null && targetFile.Length > 0)
            {
                try { File.WriteAllText(targetFile, target.ToInt64().ToString()); } catch { }
            }
        }

        try
        {
            if (hideWindow)
            {
                ShowWindow(target, SW_HIDE);
                // The compositor needs a beat before the window is really gone.
                System.Threading.Thread.Sleep(180);
                if (IsWindowVisible(target))
                {
                    outcome.reason = "failed";
                    outcome.message = "could not hide the source window";
                    return outcome;
                }
            }
            else
            {
                // The veil covers the whole screen anyway; this only lets the
                // click's own repaint settle so the frozen frame has no hover state.
                System.Threading.Thread.Sleep(140);
            }

            Rectangle virtualScreen = SystemInformation.VirtualScreen;
            using (Bitmap frozen = new Bitmap(virtualScreen.Width, virtualScreen.Height, PixelFormat.Format32bppPArgb))
            {
                using (Graphics g = Graphics.FromImage(frozen))
                {
                    g.CopyFromScreen(virtualScreen.X, virtualScreen.Y, 0, 0, frozen.Size, CopyPixelOperation.SourceCopy);
                }

                Rectangle selection = Rectangle.Empty;
                Bitmap composed = null;
                if (autoSelect != null && autoSelect.Length > 0)
                {
                    selection = ParseRectangle(autoSelect);
                    if (selection.Width < 1 || selection.Height < 1)
                    {
                        outcome.reason = "failed";
                        outcome.message = "autoSelect is not x,y,w,h";
                        return outcome;
                    }
                }
                else
                {
                    Application.EnableVisualStyles();
                    using (Selector selector = new Selector(frozen, virtualScreen, timeoutSeconds))
                    {
                        Application.Run(selector);
                        if (selector.Cancelled || selector.Result == null)
                        {
                            outcome.reason = "cancelled";
                            return outcome;
                        }
                        // The selector composites annotations itself, so the crop
                        // it hands back is already the final pixels.
                        composed = selector.Result;
                    }
                }

                Bitmap output = composed;
                if (output == null)
                {
                    Rectangle safe = Rectangle.Intersect(selection, new Rectangle(0, 0, frozen.Width, frozen.Height));
                    if (safe.Width < 1 || safe.Height < 1)
                    {
                        outcome.reason = "cancelled";
                        return outcome;
                    }
                    output = new Bitmap(safe.Width, safe.Height, PixelFormat.Format32bppPArgb);
                    using (Graphics g = Graphics.FromImage(output))
                    {
                        g.DrawImage(frozen, new Rectangle(0, 0, safe.Width, safe.Height), safe, GraphicsUnit.Pixel);
                    }
                }

                try
                {
                    string directory = Path.GetDirectoryName(outPath);
                    if (directory != null && directory.Length > 0) Directory.CreateDirectory(directory);
                    output.Save(outPath, ImageFormat.Png);

                    outcome.ok = true;
                    outcome.path = outPath;
                    outcome.width = output.Width;
                    outcome.height = output.Height;
                }
                finally
                {
                    output.Dispose();
                }

                return outcome;
            }
        }
        catch (Exception error)
        {
            outcome.ok = false;
            outcome.reason = "failed";
            outcome.message = error.GetType().Name + ": " + error.Message;
            return outcome;
        }
        finally
        {
            // Whatever happened above, a window we hid must come back. Without
            // hiding there is nothing to restore, and the target stays zero.
            if (hideWindow && target != IntPtr.Zero)
            {
                ShowWindow(target, SW_RESTORE);
                SetForegroundWindow(target);
            }
        }
    }

    /// <summary>
    /// Locate the visible top-level browser window whose caption contains the
    /// page title. Consoles owned by this launch are skipped, so a briefly
    /// focused helper process cannot become the hidden window.
    /// </summary>
    private static IntPtr FindByTitle(string fragment)
    {
        if (fragment == null || fragment.Trim().Length < 4) return IntPtr.Zero;
        string needle = fragment.Trim();
        IntPtr found = IntPtr.Zero;

        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) return true;
            if (GetWindowTextLength(hWnd) == 0) return true;

            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            string processName = "";
            try { processName = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
            catch { }
            foreach (string excluded in ExcludedProcesses)
            {
                if (string.Equals(processName, excluded, StringComparison.OrdinalIgnoreCase)) return true;
            }

            System.Text.StringBuilder caption = new System.Text.StringBuilder(GetWindowTextLength(hWnd) + 2);
            GetWindowText(hWnd, caption, caption.Capacity);
            if (caption.ToString().IndexOf(needle, StringComparison.Ordinal) < 0) return true;

            found = hWnd;
            return false;
        }, IntPtr.Zero);

        return found;
    }

    private static Rectangle ParseRectangle(string spec)
    {
        string[] parts = spec.Split(',');
        if (parts.Length != 4) return Rectangle.Empty;
        int x, y, w, hgt;
        if (!int.TryParse(parts[0].Trim(), out x)) return Rectangle.Empty;
        if (!int.TryParse(parts[1].Trim(), out y)) return Rectangle.Empty;
        if (!int.TryParse(parts[2].Trim(), out w)) return Rectangle.Empty;
        if (!int.TryParse(parts[3].Trim(), out hgt)) return Rectangle.Empty;
        return new Rectangle(x, y, w, hgt);
    }

    private static string Quote(string value)
    {
        if (value == null) return "null";
        System.Text.StringBuilder sb = new System.Text.StringBuilder("\"");
        foreach (char c in value)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.Append('"').ToString();
    }

    /// <summary>
    /// Full-screen selection overlay: drag a region, then adjust it in place -
    /// handles resize, the body slides, Ctrl+drag draws a mark - and confirm with
    /// the toolbar's tick, the way a chat client's screenshot tool works. The
    /// marks are composited into the returned bitmap, so callers only ever save
    /// finished pixels.
    /// </summary>
    public sealed class Selector : Form
    {
        private const int ToolRect = 0;
        private const int ToolArrow = 1;
        private const int ButtonSize = 28;
        private const int ButtonGap = 4;
        private const int ToolCount = 3;

        private readonly Bitmap frozen;
        private readonly Timer clock;
        private readonly int timeoutSeconds;
        private readonly List<Annotation> annotations = new List<Annotation>();
        private readonly List<Button> buttons = new List<Button>();
        private readonly ToolTip tooltips = new ToolTip();
        private DateTime started = DateTime.UtcNow;

        /// <summary>Smallest region the handles will shrink the box to.</summary>
        private const int MinSelection = 6;
        /// <summary>Side of one square resize handle.</summary>
        private const int HandleSize = 8;
        /// <summary>Extra slack around a handle so it can be grabbed off-centre.</summary>
        private const int HandleSlack = 4;
        /// <summary>How far inside the frame a press still counts as "move the box".</summary>
        private const int MoveStrip = 7;
        /// <summary>Handle bits: which edge a drag pulls.</summary>
        private const int EdgeLeft = 1;
        private const int EdgeRight = 2;
        private const int EdgeTop = 4;
        private const int EdgeBottom = 8;

        private Point press;
        private bool dragging;
        private bool editing;
        private bool annotating;
        private bool moving;
        private bool resizing;
        private int handle;
        private Rectangle dragStart;
        private Annotation pending;
        private int tool = ToolRect;

        public bool Cancelled = true;
        public Rectangle Selection = Rectangle.Empty;
        /// <summary>Finished crop with annotations, or null when nothing was captured.</summary>
        public Bitmap Result;

        private static readonly Font LabelFont = new Font("Microsoft YaHei UI", 9f, FontStyle.Regular, GraphicsUnit.Point);
        private static readonly Brush Veil = new SolidBrush(Color.FromArgb(110, 0, 0, 0));
        private static readonly Color Ink = Color.FromArgb(232, 62, 62);
        /// <summary>Toolbar accents: a green tick to accept, a red cross to dismiss.</summary>
        private static readonly Color ConfirmInk = Color.FromArgb(24, 146, 78);
        private static readonly Color CancelInk = Color.FromArgb(204, 40, 40);
        private static readonly Color ConfirmTint = Color.FromArgb(196, 232, 208);
        private static readonly Color CancelTint = Color.FromArgb(242, 205, 205);
        private static readonly Color UndoTint = Color.FromArgb(222, 228, 238);

        /// <summary>One drawn mark, in the overlay's own coordinates.</summary>
        private sealed class Annotation
        {
            public int Kind;
            public Point From;
            public Point To;
        }

        public Selector(Bitmap frozen, Rectangle screen, int timeoutSeconds)
        {
            this.frozen = frozen;
            this.timeoutSeconds = timeoutSeconds;

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Bounds = screen;
            TopMost = true;
            ShowInTaskbar = false;
            Cursor = Cursors.Cross;
            DoubleBuffered = true;
            BackColor = Color.Black;
            KeyPreview = true;

            // Undo the last mark, then a green tick to accept and a red cross to dismiss.
            // The glyphs are drawn, not typeset: the symbol font gave each one a
            // different optical weight and baseline, so the row never lined up.
            AddToolButton(PaintUndoGlyph, "\u64a4\u9500 (Ctrl+Z)", Ink, UndoTint, delegate { Undo(); });
            AddToolButton(PaintConfirmGlyph, "\u786e\u8ba4 (Enter)", ConfirmInk, ConfirmTint, delegate { Confirm(); });
            AddToolButton(PaintCancelGlyph, "\u53d6\u6d88 (Esc)", CancelInk, CancelTint, delegate { Cancelled = true; Close(); });

            clock = new Timer();
            clock.Interval = 250;
            clock.Tick += OnTick;
            clock.Start();
        }

        /// <summary>
        /// A button whose icon is painted rather than typeset. The symbol glyphs the
        /// row used before each came out of a different part of the font at a
        /// different weight and baseline, so no font size made the three of them
        /// agree; drawing the same strokes for all three fixes the proportions.
        /// </summary>
        private sealed class GlyphButton : Button
        {
            public Action<Graphics, Rectangle, Color> Glyph;

            public GlyphButton()
            {
                SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                    ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                Graphics g = e.Graphics;
                Rectangle box = new Rectangle(0, 0, Width, Height);
                bool hot = ClientRectangle.Contains(PointToClient(Cursor.Position));
                using (SolidBrush pad = new SolidBrush(hot ? FlatAppearance.MouseOverBackColor : BackColor))
                {
                    g.FillRectangle(pad, box);
                }
                using (Pen frame = new Pen(FlatAppearance.BorderColor, FlatAppearance.BorderSize))
                {
                    g.DrawRectangle(frame, 0, 0, Width - 1, Height - 1);
                }
                if (Glyph == null) return;
                System.Drawing.Drawing2D.SmoothingMode previous = g.SmoothingMode;
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                Glyph(g, new Rectangle(0, 0, Width - 2, Height - 2), FlatAppearance.BorderColor);
                g.SmoothingMode = previous;
            }
        }

        /// <summary>One toolbar button: a painted glyph in <paramref name="ink"/> over a tinted pad.</summary>
        private void AddToolButton(Action<Graphics, Rectangle, Color> glyph, string tip, Color ink, Color tint, EventHandler onClick)
        {
            GlyphButton button = new GlyphButton();
            button.Glyph = glyph;
            button.Size = new Size(ButtonSize, ButtonSize);
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderSize = 1;
            button.FlatAppearance.BorderColor = ink;
            button.FlatAppearance.MouseOverBackColor = Lighten(tint, 0.55f);
            button.BackColor = tint;
            button.ForeColor = ink;
            button.Cursor = Cursors.Hand;
            button.TabStop = false;
            button.Visible = false;
            tooltips.SetToolTip(button, tip);
            button.Click += onClick;
            buttons.Add(button);
            Controls.Add(button);
        }

        /// <summary>Mix a colour towards white; used for the hover pad.</summary>
        private static Color Lighten(Color colour, float amount)
        {
            return Color.FromArgb(
                colour.A,
                (int)(colour.R + (255 - colour.R) * amount),
                (int)(colour.G + (255 - colour.G) * amount),
                (int)(colour.B + (255 - colour.B) * amount));
        }

        /// <summary>Shared stroke for the three toolbar icons: one width, one colour, round ends.</summary>
        private static Pen GlyphPen(Color ink)
        {
            Pen pen = new Pen(ink, 2.1f);
            pen.StartCap = System.Drawing.Drawing2D.LineCap.Round;
            pen.EndCap = System.Drawing.Drawing2D.LineCap.Round;
            pen.LineJoin = System.Drawing.Drawing2D.LineJoin.Round;
            return pen;
        }

        /// <summary>
        /// Arrow head sitting on <paramref name="tip"/>, swept back from the tangent
        /// that runs from <paramref name="from"/> to <paramref name="tip"/>.
        /// </summary>
        private static void DrawHead(Graphics g, Pen pen, PointF from, PointF tip, float length)
        {
            double angle = Math.Atan2(tip.Y - from.Y, tip.X - from.X);
            const double spread = 0.62;
            PointF left = new PointF(
                (float)(tip.X - length * Math.Cos(angle - spread)),
                (float)(tip.Y - length * Math.Sin(angle - spread)));
            PointF right = new PointF(
                (float)(tip.X - length * Math.Cos(angle + spread)),
                (float)(tip.Y - length * Math.Sin(angle + spread)));
            g.DrawLine(pen, tip, left);
            g.DrawLine(pen, tip, right);
        }

        /// <summary>U-turn with a head: "put the last mark back".</summary>
        private static void PaintUndoGlyph(Graphics g, Rectangle box, Color ink)
        {
            float x = box.Left;
            float y = box.Top;
            float w = box.Width;
            float h = box.Height;
            PointF start = new PointF(x + w * 0.76f, y + h * 0.74f);
            PointF control1 = new PointF(x + w * 0.80f, y + h * 0.18f);
            PointF control2 = new PointF(x + w * 0.38f, y + h * 0.12f);
            PointF tip = new PointF(x + w * 0.36f, y + h * 0.60f);
            using (Pen pen = GlyphPen(ink))
            using (System.Drawing.Drawing2D.GraphicsPath path = new System.Drawing.Drawing2D.GraphicsPath())
            {
                path.AddBezier(start, control1, control2, tip);
                g.DrawPath(pen, path);
                DrawHead(g, pen, control2, tip, w * 0.30f);
            }
        }

        /// <summary>Tick: accept the region.</summary>
        private static void PaintConfirmGlyph(Graphics g, Rectangle box, Color ink)
        {
            float x = box.Left;
            float y = box.Top;
            float w = box.Width;
            float h = box.Height;
            PointF[] points = new PointF[]
            {
                new PointF(x + w * 0.22f, y + h * 0.52f),
                new PointF(x + w * 0.42f, y + h * 0.74f),
                new PointF(x + w * 0.80f, y + h * 0.24f),
            };
            using (Pen pen = GlyphPen(ink))
            {
                g.DrawLines(pen, points);
            }
        }

        /// <summary>Cross: dismiss without capturing.</summary>
        private static void PaintCancelGlyph(Graphics g, Rectangle box, Color ink)
        {
            float x = box.Left;
            float y = box.Top;
            float w = box.Width;
            float h = box.Height;
            using (Pen pen = GlyphPen(ink))
            {
                g.DrawLine(pen, x + w * 0.24f, y + h * 0.24f, x + w * 0.76f, y + h * 0.76f);
                g.DrawLine(pen, x + w * 0.76f, y + h * 0.24f, x + w * 0.24f, y + h * 0.76f);
            }
        }

        private void OnTick(object sender, EventArgs e)
        {
            if ((DateTime.UtcNow - started).TotalSeconds > timeoutSeconds)
            {
                Cancelled = true;
                Close();
            }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            Activate();
            Focus();
        }

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if (keyData == Keys.Escape)
            {
                Cancelled = true;
                Close();
                return true;
            }
            if (editing && (keyData == Keys.Enter || keyData == Keys.Return))
            {
                Confirm();
                return true;
            }
            if (editing && keyData == (Keys.Control | Keys.Z))
            {
                Undo();
                return true;
            }
            return base.ProcessCmdKey(ref msg, keyData);
        }

        /// <summary>
        /// Which handle, if any, sits under the point. Only the eight drawn grips
        /// answer: a grab zone running the whole edge would swallow the border strip
        /// that slides the frame, so the handles stay discrete squares like the ones
        /// on screen.
        /// </summary>
        private int HandleAt(Point point)
        {
            int reach = HandleSize / 2 + HandleSlack;
            int midX = Selection.Left + Selection.Width / 2;
            int midY = Selection.Top + Selection.Height / 2;
            int left = Selection.Left;
            int right = Selection.Right;
            int top = Selection.Top;
            int bottom = Selection.Bottom;

            // A frame shrunk to the minimum puts its grips on top of each other, so
            // answer with the closest one instead of the first that happens to match.
            int best = 0;
            int bestDistance = int.MaxValue;
            Consider(point, left, top, reach, EdgeLeft | EdgeTop, ref best, ref bestDistance);
            Consider(point, midX, top, reach, EdgeTop, ref best, ref bestDistance);
            Consider(point, right, top, reach, EdgeRight | EdgeTop, ref best, ref bestDistance);
            Consider(point, right, midY, reach, EdgeRight, ref best, ref bestDistance);
            Consider(point, right, bottom, reach, EdgeRight | EdgeBottom, ref best, ref bestDistance);
            Consider(point, midX, bottom, reach, EdgeBottom, ref best, ref bestDistance);
            Consider(point, left, bottom, reach, EdgeLeft | EdgeBottom, ref best, ref bestDistance);
            Consider(point, left, midY, reach, EdgeLeft, ref best, ref bestDistance);
            return best;
        }

        /// <summary>Keep the closest grip under the pointer, if the pointer is on one.</summary>
        private static void Consider(Point point, int x, int y, int reach, int bits, ref int best, ref int bestDistance)
        {
            int dx = point.X - x;
            int dy = point.Y - y;
            if (Math.Abs(dx) > reach || Math.Abs(dy) > reach) return;
            int distance = dx * dx + dy * dy;
            if (distance >= bestDistance) return;
            bestDistance = distance;
            best = bits;
        }

        /// <summary>True when the point is inside the frame but not on a handle or the toolbar.</summary>
        private bool InsideBody(Point point)
        {
            Rectangle inner = Selection;
            inner.Inflate(-MoveStrip, -MoveStrip);
            return inner.Contains(point);
        }

        /// <summary>Cursor that matches the edge under the pointer.</summary>
        private static Cursor CursorFor(int bits)
        {
            bool left = (bits & EdgeLeft) != 0;
            bool right = (bits & EdgeRight) != 0;
            bool top = (bits & EdgeTop) != 0;
            bool bottom = (bits & EdgeBottom) != 0;
            if ((left && top) || (right && bottom)) return Cursors.SizeNWSE;
            if ((right && top) || (left && bottom)) return Cursors.SizeNESW;
            if (left || right) return Cursors.SizeWE;
            if (top || bottom) return Cursors.SizeNS;
            return Cursors.SizeAll;
        }

        /// <summary>Resize the frame by dragging one handle, staying inside the screen.</summary>
        private void ResizeTo(Point point)
        {
            int left = dragStart.Left;
            int top = dragStart.Top;
            int right = dragStart.Right;
            int bottom = dragStart.Bottom;

            if ((handle & EdgeLeft) != 0) left = Math.Min(point.X, right - MinSelection);
            if ((handle & EdgeRight) != 0) right = Math.Max(point.X, left + MinSelection);
            if ((handle & EdgeTop) != 0) top = Math.Min(point.Y, bottom - MinSelection);
            if ((handle & EdgeBottom) != 0) bottom = Math.Max(point.Y, top + MinSelection);

            left = Math.Max(0, left);
            top = Math.Max(0, top);
            right = Math.Min(ClientSize.Width, right);
            bottom = Math.Min(ClientSize.Height, bottom);

            Selection = new Rectangle(left, top, right - left, bottom - top);
            LayoutToolbar();
            Invalidate();
        }

        /// <summary>True while Ctrl is down, which turns a body drag into a mark.</summary>
        private static bool CtrlHeld()
        {
            return (Control.ModifierKeys & Keys.Control) == Keys.Control;
        }

        /// <summary>
        /// Act on a press inside the frame: slide it, or - when the caller asks for a
        /// mark - start drawing one. The modifier is passed in rather than read here,
        /// so the decision can be exercised without a real keyboard.
        /// </summary>
        private void BodyPressed(Point point, bool mark)
        {
            if (!mark)
            {
                moving = true;
                press = point;
                dragStart = Selection;
                return;
            }

            if (!InsideBody(point)) return;
            annotating = true;
            pending = new Annotation();
            pending.Kind = tool;
            pending.From = point;
            pending.To = point;
            Invalidate();
        }

        /// <summary>Slide the whole frame by the drag delta, clamped to the screen.</summary>
        private void MoveTo(Point point)
        {
            int x = dragStart.X + (point.X - press.X);
            int y = dragStart.Y + (point.Y - press.Y);
            x = Math.Max(0, Math.Min(x, ClientSize.Width - dragStart.Width));
            y = Math.Max(0, Math.Min(y, ClientSize.Height - dragStart.Height));
            Selection = new Rectangle(x, y, dragStart.Width, dragStart.Height);
            LayoutToolbar();
            Invalidate();
        }

        /// <summary>Reveal the toolbar once a region is worth editing.</summary>
        private void EnterEditing()
        {
            editing = true;
            LayoutToolbar();
            foreach (Button button in buttons) button.Visible = true;
            Invalidate();
        }

        private void LayoutToolbar()
        {
            int total = ToolCount * ButtonSize + (ToolCount - 1) * ButtonGap;
            int x = Selection.Right - total;
            if (x < 8) x = 8;
            if (x + total > ClientSize.Width - 8) x = Math.Max(8, ClientSize.Width - 8 - total);

            int y = Selection.Bottom + 10;
            if (y + ButtonSize > ClientSize.Height - 8) y = Selection.Top - 10 - ButtonSize;
            if (y < 8) y = Math.Max(8, Selection.Bottom - 10 - ButtonSize);

            for (int index = 0; index < buttons.Count; index += 1)
            {
                buttons[index].Location = new Point(x + index * (ButtonSize + ButtonGap), y);
            }
        }

        private void Undo()
        {
            if (annotations.Count == 0) return;
            annotations.RemoveAt(annotations.Count - 1);
            Invalidate();
        }

        /// <summary>Settle after a move or resize: the toolbar follows the frame.</summary>
        private void DragFinished()
        {
            LayoutToolbar();
            Cursor = Cursors.Cross;
            Invalidate();
        }

        /// <summary>Composite the selection and its marks into the returned bitmap.</summary>
        private void Confirm()
        {
            Rectangle safe = Rectangle.Intersect(Selection, new Rectangle(0, 0, frozen.Width, frozen.Height));
            if (safe.Width < 1 || safe.Height < 1)
            {
                Cancelled = true;
                Close();
                return;
            }

            Bitmap output = new Bitmap(safe.Width, safe.Height, PixelFormat.Format32bppPArgb);
            using (Graphics g = Graphics.FromImage(output))
            {
                g.DrawImage(frozen, new Rectangle(0, 0, safe.Width, safe.Height), safe, GraphicsUnit.Pixel);
                if (annotations.Count > 0)
                {
                    g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                    g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                    g.TranslateTransform(-safe.X, -safe.Y);
                    foreach (Annotation mark in annotations) DrawAnnotation(g, mark);
                }
            }

            Result = output;
            Selection = safe;
            Cancelled = false;
            Close();
        }

        private static void DrawAnnotation(Graphics g, Annotation mark)
        {
            using (Pen pen = new Pen(Ink, 2.8f))
            {
                pen.StartCap = System.Drawing.Drawing2D.LineCap.Round;
                pen.EndCap = System.Drawing.Drawing2D.LineCap.Round;
                pen.LineJoin = System.Drawing.Drawing2D.LineJoin.Round;

                if (mark.Kind == ToolRect)
                {
                    Rectangle box = Normalize(mark.From, mark.To);
                    if (box.Width < 1 || box.Height < 1) return;
                    g.DrawRectangle(pen, box.X, box.Y, box.Width, box.Height);
                    return;
                }

                g.DrawLine(pen, mark.From, mark.To);
                double angle = Math.Atan2(mark.To.Y - mark.From.Y, mark.To.X - mark.From.X);
                const double headLength = 15.0;
                const double spread = 0.46;
                PointF left = new PointF(
                    (float)(mark.To.X - headLength * Math.Cos(angle - spread)),
                    (float)(mark.To.Y - headLength * Math.Sin(angle - spread)));
                PointF right = new PointF(
                    (float)(mark.To.X - headLength * Math.Cos(angle + spread)),
                    (float)(mark.To.Y - headLength * Math.Sin(angle + spread)));
                g.DrawLine(pen, mark.To, left);
                g.DrawLine(pen, mark.To, right);
            }
        }

        private static Rectangle Normalize(Point from, Point to)
        {
            int x = Math.Min(from.X, to.X);
            int y = Math.Min(from.Y, to.Y);
            return new Rectangle(x, y, Math.Abs(to.X - from.X), Math.Abs(to.Y - from.Y));
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.DrawImageUnscaled(frozen, 0, 0);
            g.FillRectangle(Veil, new Rectangle(0, 0, ClientSize.Width, ClientSize.Height));

            if (Selection.Width <= 0 || Selection.Height <= 0)
            {
                DrawHint(g);
                return;
            }

            System.Drawing.Drawing2D.GraphicsState state = g.Save();
            g.SetClip(Selection);
            g.DrawImageUnscaled(frozen, 0, 0);
            g.Restore(state);

            if (annotations.Count > 0 || pending != null)
            {
                System.Drawing.Drawing2D.GraphicsState clip = g.Save();
                g.SetClip(Selection);
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                foreach (Annotation mark in annotations) DrawAnnotation(g, mark);
                if (pending != null) DrawAnnotation(g, pending);
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.Default;
                g.Restore(clip);
            }

            using (Pen border = new Pen(Color.FromArgb(255, 255, 255), 1f))
            {
                g.DrawRectangle(border, Selection.X, Selection.Y, Selection.Width - 1, Selection.Height - 1);
            }

            // Edit mode shows grab handles, so the frame reads as adjustable
            // rather than as the only thing you can ever do.
            if (editing) DrawHandles(g);

            string badge = Selection.Width.ToString() + " \u00d7 " + Selection.Height.ToString();
            SizeF badgeSize = g.MeasureString(badge, LabelFont);
            float badgeX = Selection.X;
            float badgeY = Selection.Y > 30f ? Selection.Y - 28f : Selection.Bottom + 8f;
            using (SolidBrush back = new SolidBrush(Color.FromArgb(210, 0, 0, 0)))
            {
                g.FillRectangle(back, badgeX, badgeY, badgeSize.Width + 14f, badgeSize.Height + 6f);
            }
            g.DrawString(badge, LabelFont, Brushes.White, badgeX + 7f, badgeY + 3f);
        }

        /// <summary>Four corner grips and four edge grips around the frame.</summary>
        private void DrawHandles(Graphics g)
        {
            int half = HandleSize / 2;
            int midX = Selection.Left + Selection.Width / 2;
            int midY = Selection.Top + Selection.Height / 2;
            Point[] points = new Point[]
            {
                new Point(Selection.Left, Selection.Top),
                new Point(midX, Selection.Top),
                new Point(Selection.Right, Selection.Top),
                new Point(Selection.Right, midY),
                new Point(Selection.Right, Selection.Bottom),
                new Point(midX, Selection.Bottom),
                new Point(Selection.Left, Selection.Bottom),
                new Point(Selection.Left, midY),
            };

            using (SolidBrush fill = new SolidBrush(Color.White))
            using (Pen edge = new Pen(Color.FromArgb(80, 80, 80), 1f))
            {
                foreach (Point point in points)
                {
                    Rectangle grip = new Rectangle(point.X - half, point.Y - half, HandleSize, HandleSize);
                    g.FillRectangle(fill, grip);
                    g.DrawRectangle(edge, grip.X, grip.Y, grip.Width - 1, grip.Height - 1);
                }
            }
        }

        private void DrawHint(Graphics g)
        {
            string hint = "\u62d6\u52a8\u9009\u62e9\u533a\u57df    \u00b7    \u6846\u5185\u62d6\u52a8\u79fb\u52a8\u9009\u533a    \u00b7    \u62d6\u52a8\u8fb9\u6cbf\u8c03\u6574\u5927\u5c0f    \u00b7    Ctrl + \u62d6\u52a8\u8fdb\u884c\u6807\u6ce8    \u00b7    \u6309 Esc \u53d6\u6d88";
            SizeF size = g.MeasureString(hint, LabelFont);
            float x = (ClientSize.Width - size.Width) / 2f;
            float y = 56f;
            using (SolidBrush back = new SolidBrush(Color.FromArgb(190, 0, 0, 0)))
            {
                g.FillRectangle(back, x - 16f, y - 9f, size.Width + 32f, size.Height + 18f);
            }
            g.DrawString(hint, LabelFont, Brushes.White, x, y);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            started = DateTime.UtcNow;
            if (e.Button == MouseButtons.Right)
            {
                Cancelled = true;
                Close();
                return;
            }
            if (e.Button != MouseButtons.Left) return;

            if (editing)
            {
                // The frame stays live after the first drag: handles resize it, the
                // body and the inner border strip slide it, and holding Ctrl turns a
                // body drag into a mark. Dragging the body moves the frame because
                // that is what the pointer looks like it should do; marking is the
                // exception, so it costs a modifier.
                int hit = HandleAt(e.Location);
                if (hit != 0)
                {
                    resizing = true;
                    handle = hit;
                    press = e.Location;
                    dragStart = Selection;
                    return;
                }

                if (!Selection.Contains(e.Location)) return;
                BodyPressed(e.Location, Control.ModifierKeys == Keys.Control);
                return;
            }

            press = e.Location;
            dragging = true;
            Selection = new Rectangle(e.Location, Size.Empty);
            Invalidate();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (resizing)
            {
                ResizeTo(e.Location);
                return;
            }
            if (moving)
            {
                MoveTo(e.Location);
                return;
            }
            if (annotating && pending != null)
            {
                pending.To = e.Location;
                Invalidate();
                return;
            }
            if (dragging)
            {
                int x1 = Math.Min(press.X, e.X);
                int y1 = Math.Min(press.Y, e.Y);
                int x2 = Math.Max(press.X, e.X);
                int y2 = Math.Max(press.Y, e.Y);
                Selection = new Rectangle(x1, y1, x2 - x1, y2 - y1);
                Invalidate();
                return;
            }

            // Idle in edit mode: show the cursor the handles imply. Inside the frame
            // the pointer offers a move, and Ctrl flips it back to the crosshair that
            // draws a mark.
            if (editing)
            {
                int hit = HandleAt(e.Location);
                if (hit != 0) Cursor = CursorFor(hit);
                else if (!Selection.Contains(e.Location)) Cursor = Cursors.Cross;
                else Cursor = CtrlHeld() ? Cursors.Cross : Cursors.SizeAll;
            }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (annotating)
            {
                annotating = false;
                if (pending != null)
                {
                    int reach = Math.Abs(pending.To.X - pending.From.X) + Math.Abs(pending.To.Y - pending.From.Y);
                    if (reach >= 4) annotations.Add(pending);
                    pending = null;
                }
                Invalidate();
                return;
            }

            if (resizing)
            {
                resizing = false;
                handle = 0;
                DragFinished();
                return;
            }
            if (moving)
            {
                moving = false;
                DragFinished();
                return;
            }

            if (!dragging) return;
            dragging = false;
            if (Selection.Width >= 5 && Selection.Height >= 5)
            {
                EnterEditing();
                return;
            }
            // A stray click keeps the mode open instead of cancelling it.
            Selection = Rectangle.Empty;
            Invalidate();
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            clock.Stop();
            clock.Dispose();
            tooltips.Dispose();
            base.OnFormClosed(e);
        }
    }
}
