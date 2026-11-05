// Install.exe: one file holding the whole app (payload.zip as a resource). Double-click and it
//   1. installs to %LOCALAPPDATA%\Programs\PhoneController (no admin rights needed for this part)
//   2. adds Desktop + Start menu shortcuts and an "Installed apps" entry
//   3. asks Windows once (UAC) to allow phones through the firewall and install the controller driver
//   4. starts PhoneController
// Built by tools\build.ps1 with the C# compiler that ships in Windows, for .NET Framework, which
// also ships in Windows, so a fresh PC needs nothing first. C# 5 only: no newer syntax.
//
// Testing flags: --dir <path>  --no-admin  --no-shortcuts  --no-launch  --quiet
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Install
{
    const string AppName = "PhoneController";
    const string Version = "1.0.0";
    static Label status;
    static ProgressBar bar;
    static Form window;
    static List<string> args;
    static bool Has(string flag) { return args.Contains(flag); }

    [STAThread]
    static int Main(string[] argv)
    {
        args = new List<string>(argv);
        if (Has("--quiet"))
        {
            try { Work(); return 0; }
            catch (Exception e) { Console.Error.WriteLine(e); return 1; }
        }
        Application.EnableVisualStyles();
        window = new Form
        {
            Text = "Install PhoneController",
            ClientSize = new Size(440, 110),
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            StartPosition = FormStartPosition.CenterScreen,
            Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location),
        };
        status = new Label { Left = 16, Top = 16, Width = 408, Height = 40, Text = "Starting..." };
        bar = new ProgressBar { Left = 16, Top = 66, Width = 408, Height = 22, Maximum = 100 };
        window.Controls.Add(status);
        window.Controls.Add(bar);
        window.Shown += delegate
        {
            var worker = new Thread(delegate ()
            {
                try { Work(); Ui(delegate { window.Close(); }); }
                catch (Exception e)
                {
                    Ui(delegate
                    {
                        MessageBox.Show(window, "PhoneController could not be installed.\n\n" + e.Message, "Install PhoneController", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        window.Close();
                    });
                }
            });
            worker.IsBackground = true;
            worker.Start();
        };
        Application.Run(window);
        return 0;
    }

    static void Ui(MethodInvoker fn) { if (window != null && window.IsHandleCreated) window.Invoke(fn); }
    static void Step(string text, int percent)
    {
        if (window == null) { Console.WriteLine(text); return; }
        Ui(delegate { status.Text = text; bar.Value = percent; });
    }

    static string Target()
    {
        int i = args.IndexOf("--dir");
        if (i >= 0 && i + 1 < args.Count) return Path.GetFullPath(args[i + 1]);
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", AppName);
    }

    static void Work()
    {
        string dir = Target();
        string exe = Path.Combine(dir, AppName + ".exe");

        Step("Closing any running copy...", 5);
        StopRunning(dir);

        Step("Copying files...", 10);
        Extract(dir);

        if (!Has("--no-shortcuts"))
        {
            Step("Adding shortcuts...", 75);
            Shortcut(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), exe, dir);
            Shortcut(Environment.GetFolderPath(Environment.SpecialFolder.Programs), exe, dir);
            Register(dir, exe);
        }

        if (!Has("--no-admin"))
        {
            Step("Windows will ask for permission: this lets phones connect and installs the controller driver...", 80);
            Elevated(dir);
        }

        Step("Done. Starting PhoneController...", 100);
        if (!Has("--no-launch")) Process.Start(new ProcessStartInfo(exe) { WorkingDirectory = dir, UseShellExecute = true });
        Thread.Sleep(800);
    }

    // An older copy holds its files open. Ask it to quit, then make sure nothing from this folder is left.
    static void StopRunning(string dir)
    {
        try
        {
            var req = WebRequest.CreateHttp("http://127.0.0.1:8080/api/admin/quit");
            req.Method = "POST";
            req.Proxy = null;
            req.Timeout = 1500;
            req.ContentType = "application/json";
            req.Headers["Origin"] = "http://localhost:8080";
            using (var body = req.GetRequestStream()) { body.Write(new byte[] { 123, 125 }, 0, 2); }
            using (req.GetResponse()) { }
            Thread.Sleep(1500);
        }
        catch { }
        foreach (string name in new[] { "node", AppName })
        {
            foreach (var p in Process.GetProcessesByName(name))
            {
                try
                {
                    if (p.MainModule.FileName.StartsWith(dir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) { p.Kill(); p.WaitForExit(3000); }
                }
                catch { }
            }
        }
    }

    static void Extract(string dir)
    {
        // Replace the program but never the settings (those live in %LOCALAPPDATA%\PhoneController).
        Directory.CreateDirectory(dir);
        foreach (string sub in new[] { "app", "runtime", "vendor" })
        {
            string path = Path.Combine(dir, sub);
            for (int attempt = 0; Directory.Exists(path); attempt++)
            {
                try { Directory.Delete(path, true); }
                catch (Exception) { if (attempt >= 5) throw; Thread.Sleep(1000); }   // antivirus may hold files for a moment
            }
        }
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
        {
            string root = Path.GetFullPath(dir) + Path.DirectorySeparatorChar;
            int total = zip.Entries.Count, done = 0;
            foreach (var entry in zip.Entries)
            {
                string dest = Path.GetFullPath(Path.Combine(dir, entry.FullName));
                if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("bad path in package: " + entry.FullName);
                if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(dest); }
                else
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    entry.ExtractToFile(dest, true);
                }
                if (++done % 50 == 0) Step("Copying files...", 10 + 65 * done / total);
            }
        }
    }

    static void Shortcut(string folder, string exe, string dir)
    {
        Directory.CreateDirectory(folder);
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        dynamic link = shell.CreateShortcut(Path.Combine(folder, AppName + ".lnk"));
        link.TargetPath = exe;
        link.WorkingDirectory = dir;
        link.IconLocation = exe + ",0";
        link.Description = "Use your phone as a controller or mouse";
        link.Save();
    }

    static void Register(string dir, string exe)
    {
        using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + AppName))
        {
            key.SetValue("DisplayName", AppName);
            key.SetValue("DisplayVersion", Version);
            key.SetValue("Publisher", AppName);
            key.SetValue("DisplayIcon", exe + ",0");
            key.SetValue("InstallLocation", dir);
            key.SetValue("UninstallString", "\"" + exe + "\" --uninstall");
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }

    // One UAC prompt for both system changes. Saying No isn't fatal: the app's Setup page can redo them.
    static void Elevated(string dir)
    {
        string script = ElevatedScript(dir);
        var psi = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(script)))
        {
            UseShellExecute = true,
            Verb = "runas",
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        try { using (var p = Process.Start(psi)) { p.WaitForExit(); } }
        catch (System.ComponentModel.Win32Exception) { }
    }

    static string Quote(string s) { return "'" + s.Replace("'", "''") + "'"; }

    static string ElevatedScript(string dir)
    {
        string node = Path.Combine(dir, "runtime", "node.exe");
        string driver = Path.Combine(dir, "vendor", "ViGEmBus_1.22.0_x64_x86_arm64.exe");
        return "$node = " + Quote(node) + "\n"
             + "$driver = " + Quote(driver) + "\n"
             + "Get-NetFirewallApplicationFilter -Program $node -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | Remove-NetFirewallRule\n"
             + "Remove-NetFirewallRule -DisplayName 'PhoneController' -ErrorAction SilentlyContinue\n"
             + "New-NetFirewallRule -DisplayName 'PhoneController' -Direction Inbound -Program $node -Action Allow -Profile Any | Out-Null\n"
             // An existing driver is left alone: other apps (DS4Windows, Steam tools) may share it.
             + "if (-not (Get-Service ViGEmBus -ErrorAction SilentlyContinue)) {\n"
             + "  Start-Process $driver -ArgumentList '/exenoui','/qn','/norestart' -Wait\n"
             + "  if (-not (Get-Service ViGEmBus -ErrorAction SilentlyContinue)) { Start-Process $driver -Wait }\n"   // silent failed: show its wizard
             + "}\n";
    }
}
