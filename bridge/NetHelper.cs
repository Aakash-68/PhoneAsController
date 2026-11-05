// Network helper (PhoneController.exe --net), spawned by the server.
// Runs the laptop's own password-protected hotspot and reports network changes as they happen, so
// the server never has to poll. The hotspot needs no internet, router or existing Wi-Fi connection:
// it is a Wi-Fi Direct group in "legacy" mode, which phones see as a normal WPA2 network.
//
// stdin lines:   start <newline> ssid <newline> password   |   stop   |   wifi-on
// stdout lines:  NET [{"ip","name","desc","kind"},...]     (kind: hotspot usb wifi ethernet other)
//                HOTSPOT started | stopped | error <reason>
//                RADIO on | off | failed <reason>     (Wi-Fi radio: reported at start and on every change)
// The hotspot lives only as long as this process; it exits when the server closes stdin.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using Windows.Devices.Radios;
using Windows.Devices.WiFiDirect;
using Windows.Security.Credentials;

namespace PhoneController;

static class NetHelper
{
    static WiFiDirectAdvertisementPublisher? publisher;
    static readonly object outLock = new();
    static string lastNet = "";
    static StreamWriter stdout = StreamWriter.Null;
    static Radio? wifiRadio;   // held so its StateChanged event stays alive

    public static int Run()
    {
        // Streams, not Console.OutputEncoding: this program has no console window, which makes that throw.
        var utf8 = new UTF8Encoding(false);
        stdout = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true };
        var stdin = new StreamReader(Console.OpenStandardInput(), utf8);
        NetworkChange.NetworkAddressChanged += (_, _) => ReportNet();
        NetworkChange.NetworkAvailabilityChanged += (_, _) => ReportNet();
        ReportNet();
        WatchRadio();
        string? cmd;
        while ((cmd = stdin.ReadLine()) != null)
        {
            if (cmd == "start")
            {
                string? ssid = stdin.ReadLine(), pass = stdin.ReadLine();
                if (ssid == null || pass == null) break;
                Start(ssid, pass);
            }
            else if (cmd == "stop") Stop();
            else if (cmd == "wifi-on") WifiOn();
        }
        Stop();
        return 0;
    }

    static void Start(string ssid, string pass)
    {
        Stop();
        try
        {
            var pub = new WiFiDirectAdvertisementPublisher();
            pub.Advertisement.IsAutonomousGroupOwnerEnabled = true;
            pub.Advertisement.LegacySettings.IsEnabled = true;
            pub.Advertisement.LegacySettings.Ssid = ssid;
            pub.Advertisement.LegacySettings.Passphrase = new PasswordCredential { Password = pass };
            pub.StatusChanged += (p, e) =>
            {
                if (p != publisher) return;
                if (e.Status == WiFiDirectAdvertisementPublisherStatus.Started) Say("HOTSPOT started");
                else if (e.Status == WiFiDirectAdvertisementPublisherStatus.Stopped) Say("HOTSPOT stopped");
                else if (e.Status == WiFiDirectAdvertisementPublisherStatus.Aborted) Say($"HOTSPOT error {e.Error}");
            };
            publisher = pub;
            pub.Start();
        }
        catch (Exception e)
        {
            publisher = null;
            Say($"HOTSPOT error {e.Message.Replace('\r', ' ').Replace('\n', ' ')}");
        }
    }

    static void Stop()
    {
        var pub = publisher;
        publisher = null;
        try { pub?.Stop(); } catch { }
        if (pub != null) Say("HOTSPOT stopped");
    }

    // Windows doesn't tell the hotspot when the radio goes off (aeroplane mode), so watch the radio itself.
    static void WatchRadio()
    {
        try
        {
            Radio.RequestAccessAsync().AsTask().Wait();
            wifiRadio = Radio.GetRadiosAsync().AsTask().Result.FirstOrDefault((r) => r.Kind == RadioKind.WiFi);
            if (wifiRadio == null) return;
            wifiRadio.StateChanged += (_, _) => SayRadio();
            SayRadio();
        }
        catch (Exception e) { Console.Error.WriteLine($"radio: {(e.InnerException ?? e).Message}"); }
    }

    static void SayRadio()
    {
        var state = wifiRadio?.State;
        if (state == RadioState.On) Say("RADIO on");
        else if (state == RadioState.Off || state == RadioState.Disabled) Say("RADIO off");
    }

    // Only ever on request: the app must not transmit by itself while the laptop is in aeroplane mode.
    static void WifiOn()
    {
        try
        {
            if (wifiRadio == null) { Say("RADIO failed no Wi-Fi adapter found"); return; }
            var result = wifiRadio.SetStateAsync(RadioState.On).AsTask().Result;
            if (result != RadioAccessStatus.Allowed) Say($"RADIO failed {result}");
        }
        catch (Exception e)
        {
            Say($"RADIO failed {(e.InnerException ?? e).Message.Replace('\r', ' ').Replace('\n', ' ')}");
        }
    }

    static readonly Regex Virtual = new("Hyper-V|VMware|VirtualBox|Fortinet|WSL|TAP-|Tailscale|ZeroTier|WireGuard|VPN|Loopback|Bluetooth|Npcap|Docker", RegexOptions.IgnoreCase);
    static readonly Regex Tether = new("NDIS|Tether|Android|Samsung Mobile|Apple Mobile Device|Xiaomi|Pixel", RegexOptions.IgnoreCase);

    static string Kind(NetworkInterface n)
    {
        string d = n.Description;
        if (d.IndexOf("Wi-Fi Direct Virtual", StringComparison.OrdinalIgnoreCase) >= 0) return "hotspot";
        if (Virtual.IsMatch(d)) return "other";
        if (Tether.IsMatch(d)) return "usb";
        if (n.NetworkInterfaceType == NetworkInterfaceType.Wireless80211) return "wifi";
        return n.NetworkInterfaceType == NetworkInterfaceType.Ethernet ? "ethernet" : "other";
    }

    static string Json(string s)
    {
        var b = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c < 0x20) b.AppendFormat("\\u{0:x4}", (int)c);
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }

    static void ReportNet()
    {
        try
        {
            var items = new List<string>();
            foreach (var n in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (n.OperationalStatus != OperationalStatus.Up || n.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                foreach (var a in n.GetIPProperties().UnicastAddresses.Where((a) => a.Address.AddressFamily == AddressFamily.InterNetwork))
                {
                    string ip = a.Address.ToString();
                    if (ip.StartsWith("169.254.")) continue;
                    items.Add($"{{\"ip\":{Json(ip)},\"name\":{Json(n.Name)},\"desc\":{Json(n.Description)},\"kind\":\"{Kind(n)}\"}}");
                }
            }
            string line = "NET [" + string.Join(",", items) + "]";
            lock (outLock)
            {
                if (line == lastNet) return;
                lastNet = line;
            }
            Say(line);
        }
        catch { }
    }

    static void Say(string line)
    {
        lock (outLock) { stdout.WriteLine(line); }
    }
}
