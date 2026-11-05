// Launcher mode (double-click PhoneController.exe): start the server hidden if it isn't running,
// open the manager as an app window, and exit. The server stops itself when that window closes,
// taking the hotspot, ports and helpers with it, so nothing is left running.
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;

namespace PhoneController;

static class Launcher
{
    const string Ping = "http://127.0.0.1:8080/api/ping";
    const string ManagerUrl = "http://localhost:8080/app";

    public static int Run(string hash)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        if (!ServerUp())
        {
            var (node, server) = Locate(root);
            if (node == null || server == null)
            {
                Message("PhoneController files are missing. Please download it again.");
                return 1;
            }
            var psi = new ProcessStartInfo(node, $"\"{server}\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetDirectoryName(server)!,
            };
            psi.EnvironmentVariables["PC_BRIDGE"] = Process.GetCurrentProcess().MainModule!.FileName;
            psi.EnvironmentVariables["PC_LOG"] = "1";
            psi.EnvironmentVariables["PC_EXIT_WITH_WINDOW"] = "1";
            Process.Start(psi);
            var deadline = DateTime.UtcNow.AddSeconds(20);
            while (!ServerUp())
            {
                if (DateTime.UtcNow > deadline)
                {
                    Message("PhoneController couldn't start. Another program may be using port 8080.\n\nLog: %LOCALAPPDATA%\\PhoneController\\server.log");
                    return 1;
                }
                Thread.Sleep(250);
            }
        }
        OpenWindow(ManagerUrl + hash);
        return 0;
    }

    // Installed build: runtime\node.exe + app\server.js next to the exe. Dev: node on PATH + ..\testbench\server.js.
    static (string? node, string? server) Locate(string root)
    {
        string portableNode = Path.Combine(root, "runtime", "node.exe");
        string portableServer = Path.Combine(root, "app", "server.js");
        if (File.Exists(portableNode) && File.Exists(portableServer)) return (portableNode, portableServer);
        string devServer = Path.GetFullPath(Path.Combine(root, "..", "..", "testbench", "server.js"));
        return (File.Exists(devServer) ? "node" : null, File.Exists(devServer) ? devServer : null);
    }

    static bool ServerUp()
    {
        try
        {
            var req = WebRequest.CreateHttp(Ping);
            req.Timeout = 500;
            req.Proxy = null;
            using var res = req.GetResponse();
            using var body = new StreamReader(res.GetResponseStream());
            return body.ReadToEnd().Contains("PhoneController");
        }
        catch { return false; }
    }

    // Edge "app" window = no tabs or address bar, looks like a normal program. Falls back to the default browser.
    static void OpenWindow(string url)
    {
        string[] candidates =
        {
            Environment.ExpandEnvironmentVariables(@"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
            Environment.ExpandEnvironmentVariables(@"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
            Environment.ExpandEnvironmentVariables(@"%LocalAppData%\Microsoft\Edge\Application\msedge.exe"),
        };
        string? edge = candidates.FirstOrDefault(File.Exists);
        if (edge != null) Process.Start(edge, $"--app={url} --window-size=1100,860");
        else Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);
    static void Message(string text) => MessageBoxW(IntPtr.Zero, text, "PhoneController", 0x10);
}
