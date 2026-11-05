// Bridge mode (PhoneController.exe --bridge): turns 16-byte frames on stdin into ViGEm virtual
// controllers (Xbox 360 / DualShock 4). Spawned by the server. Feedback (rumble, DS4 lightbar)
// goes back as 8-byte frames on stdout.
//
// stdin frames (16 B):
//   [1][slot][kind 1=x360 2=ds4]                       plug in
//   [2][slot]                                          unplug
//   [3][slot][buttons u32][lx ly rx ry i16][l2 r2 u8]  report (buttons use the phone's DS4 bit layout)
// stdout frames (8 B):
//   [0x81][slot][large][small][r][g][b][0]             feedback
using System;
using System.IO;
using System.Threading.Tasks;
using Nefarius.ViGEm.Client;
using Nefarius.ViGEm.Client.Targets;
using Nefarius.ViGEm.Client.Targets.DualShock4;
using Nefarius.ViGEm.Client.Targets.Xbox360;

namespace PhoneController;

static class Bridge
{
    const int Slots = 8;
    static readonly IVirtualGamepad?[] pads = new IVirtualGamepad?[Slots];
    static readonly byte[]?[] lastFrame = new byte[]?[Slots];
    static readonly object padLock = new();   // reports come from stdin, priming from timers
    static readonly object outLock = new();
    static Stream stdout = Stream.Null;
    static ViGEmClient? client;

    public static int Run()
    {
        stdout = Console.OpenStandardOutput();
        try { client = new ViGEmClient(); }
        catch (Exception e) { Console.Error.WriteLine($"ERROR ViGEmBus driver not available: {e.Message}"); return 2; }
        Console.Error.WriteLine("READY");

        var stdin = Console.OpenStandardInput();
        var frame = new byte[16];
        try
        {
            while (ReadFrame(stdin, frame))   // false = server exited: unplug everything
            {
                int slot = frame[1];
                if (slot >= Slots) continue;
                try
                {
                    lock (padLock)
                    {
                        switch (frame[0])
                        {
                            case 1: Plug(slot, frame[2]); break;
                            case 2: Unplug(slot); lastFrame[slot] = null; Console.Error.WriteLine($"unplugged slot {slot}"); break;
                            case 3: Report(slot, frame); break;
                        }
                    }
                }
                catch (Exception e) { Console.Error.WriteLine($"slot {slot}: {e.Message}"); }
            }
        }
        finally
        {
            for (int i = 0; i < Slots; i++) Unplug(i);
            client.Dispose();
        }
        return 0;
    }

    static bool ReadFrame(Stream s, byte[] f)
    {
        int got = 0;
        while (got < f.Length)
        {
            int n = s.Read(f, got, f.Length - got);
            if (n <= 0) return false;
            got += n;
        }
        return true;
    }

    static void Feedback(int slot, byte large, byte small, byte r = 0, byte g = 0, byte b = 0)
    {
        var f = new byte[] { 0x81, (byte)slot, large, small, r, g, b, 0 };
        lock (outLock) { stdout.Write(f, 0, f.Length); stdout.Flush(); }
    }

    static void Unplug(int slot)
    {
        try { pads[slot]?.Disconnect(); } catch { }
        pads[slot] = null;
    }

    static void Plug(int slot, byte kind)
    {
        Unplug(slot);
        if (kind == 2)
        {
            var ds4 = client!.CreateDualShock4Controller();
            ds4.AutoSubmitReport = false;
#pragma warning disable CS0618 // FeedbackReceived is fine for rumble + lightbar here
            ds4.FeedbackReceived += (_, e) => Feedback(slot, e.LargeMotor, e.SmallMotor, e.LightbarColor.Red, e.LightbarColor.Green, e.LightbarColor.Blue);
#pragma warning restore CS0618
            ds4.Connect();
            pads[slot] = ds4;
        }
        else
        {
            var x = client!.CreateXbox360Controller();
            x.AutoSubmitReport = false;
            x.FeedbackReceived += (_, e) => Feedback(slot, e.LargeMotor, e.SmallMotor);
            x.Connect();
            pads[slot] = x;
        }
        Console.Error.WriteLine($"plugged slot {slot} as {(kind == 2 ? "DS4" : "X360")}");
        // A fresh pad reports junk until its state *changes*, and the driver drops reports equal to its
        // last one, so an all-zero report can't clear it. Once Windows has enumerated it, nudge then restore.
        var pad = pads[slot];
        foreach (var delay in new[] { 300, 1000 })
            _ = Task.Delay(delay).ContinueWith(_ => Prime(slot, pad));
    }

    static void Prime(int slot, IVirtualGamepad? expected)
    {
        lock (padLock)
        {
            if (pads[slot] != expected || expected == null) return;
            var f = (byte[])(lastFrame[slot] ?? new byte[16]).Clone();
            f[0] = 3; f[1] = (byte)slot;
            var nudged = (byte[])f.Clone();
            nudged[6] ^= 1;   // flip the lowest bit of LX
            Report(slot, nudged, remember: false);
            Report(slot, f, remember: false);
        }
    }

    // Phone button bits (gamepad.js BTN): 0 ✕, 1 ○, 2 □, 3 △, 4 up, 5 down, 6 left, 7 right,
    // 8 L2, 9 L1, 10 R2, 11 R1, 12 share, 13 options, 14 L3, 15 R3, 16 home (Xbox guide / PS), 17 touchpad click
    static bool Bit(uint b, int i) => (b & (1u << i)) != 0;

    static ushort X360Buttons(uint b)
    {
        ushort o = 0;
        if (Bit(b, 4)) o |= 0x0001; if (Bit(b, 5)) o |= 0x0002; if (Bit(b, 6)) o |= 0x0004; if (Bit(b, 7)) o |= 0x0008;
        if (Bit(b, 13)) o |= 0x0010; if (Bit(b, 12)) o |= 0x0020; if (Bit(b, 14)) o |= 0x0040; if (Bit(b, 15)) o |= 0x0080;
        if (Bit(b, 9)) o |= 0x0100; if (Bit(b, 11)) o |= 0x0200; if (Bit(b, 16)) o |= 0x0400;
        if (Bit(b, 0)) o |= 0x1000; if (Bit(b, 1)) o |= 0x2000; if (Bit(b, 2)) o |= 0x4000; if (Bit(b, 3)) o |= 0x8000;
        return o;
    }

    static ushort Ds4Buttons(uint b, byte l2, byte r2)
    {
        // Low nibble = d-pad hat: 0 N, 1 NE, 2 E, 3 SE, 4 S, 5 SW, 6 W, 7 NW, 8 none.
        bool u = Bit(b, 4), d = Bit(b, 5), l = Bit(b, 6), r = Bit(b, 7);
        int hat = u ? (r ? 1 : l ? 7 : 0) : d ? (r ? 3 : l ? 5 : 4) : r ? 2 : l ? 6 : 8;
        ushort o = (ushort)hat;
        if (Bit(b, 2)) o |= 1 << 4; if (Bit(b, 0)) o |= 1 << 5; if (Bit(b, 1)) o |= 1 << 6; if (Bit(b, 3)) o |= 1 << 7;
        if (Bit(b, 9)) o |= 1 << 8; if (Bit(b, 11)) o |= 1 << 9;
        if (Bit(b, 8) || l2 > 0) o |= 1 << 10; if (Bit(b, 10) || r2 > 0) o |= 1 << 11;
        if (Bit(b, 12)) o |= 1 << 12; if (Bit(b, 13)) o |= 1 << 13; if (Bit(b, 14)) o |= 1 << 14; if (Bit(b, 15)) o |= 1 << 15;
        return o;
    }

    static byte ToByteAxis(short v) => (byte)((v + 32768) >> 8);   // always 0..255
    static short NegateAxis(short v) => (short)Math.Min(32767, -v);    // -(-32768) doesn't fit

    static void Report(int slot, byte[] f, bool remember = true)
    {
        var pad = pads[slot];
        if (pad == null) return;
        if (remember) lastFrame[slot] = (byte[])f.Clone();
        uint buttons = BitConverter.ToUInt32(f, 2);
        short lx = BitConverter.ToInt16(f, 6), ly = BitConverter.ToInt16(f, 8);
        short rx = BitConverter.ToInt16(f, 10), ry = BitConverter.ToInt16(f, 12);
        byte l2 = f[14], r2 = f[15];
        // Phone Y axes are screen-down positive. XInput Y is up-positive; DS4 Y is down-positive.
        if (pad is IXbox360Controller x)
        {
            x.SetButtonsFull(X360Buttons(buttons));
            x.SetAxisValue(Xbox360Axis.LeftThumbX, lx);
            x.SetAxisValue(Xbox360Axis.LeftThumbY, NegateAxis(ly));
            x.SetAxisValue(Xbox360Axis.RightThumbX, rx);
            x.SetAxisValue(Xbox360Axis.RightThumbY, NegateAxis(ry));
            x.SetSliderValue(Xbox360Slider.LeftTrigger, l2);
            x.SetSliderValue(Xbox360Slider.RightTrigger, r2);
            x.SubmitReport();
        }
        else if (pad is IDualShock4Controller d)
        {
            d.SetButtonsFull(Ds4Buttons(buttons, l2, r2));
            d.SetSpecialButtonsFull((byte)((Bit(buttons, 16) ? 1 : 0) | (Bit(buttons, 17) ? 2 : 0)));   // PS, touchpad click
            d.SetAxisValue(DualShock4Axis.LeftThumbX, ToByteAxis(lx));
            d.SetAxisValue(DualShock4Axis.LeftThumbY, ToByteAxis(ly));
            d.SetAxisValue(DualShock4Axis.RightThumbX, ToByteAxis(rx));
            d.SetAxisValue(DualShock4Axis.RightThumbY, ToByteAxis(ry));
            d.SetSliderValue(DualShock4Slider.LeftTrigger, l2);
            d.SetSliderValue(DualShock4Slider.RightTrigger, r2);
            d.SubmitReport();
        }
    }
}
