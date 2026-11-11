# PhoneController

Use your phone as an Xbox / PS4 controller, racing wheel, keyboard or mouse for a Windows PC. No internet, no router and nothing to install on the phone.

## Install

1. Click **Code → Download ZIP** on this page (or get the zip from Releases) and extract it.
2. Double-click **Install.exe**. It installs everything and starts the app.
   - If Windows says *"Windows protected your PC"*, click **More info → Run anyway**. The app isn't commercially code-signed.
   - Say **Yes** when Windows asks for permission. This lets phones connect and installs the controller driver.

Requires Windows 10 or 11, 64-bit.

## Connect your phone

| | How | Needs |
|---|---|---|
| **Hotspot** (default) | The laptop makes its own password-protected Wi-Fi. Scan the **Step 1** code to join it, then the **Step 2** code to open the controller, or type `http://phonepad.local` (Android 13+; add `:8080` if the app shows it). | Laptop's Wi-Fi switched on, which Windows allows during aeroplane mode. It doesn't have to be connected to anything. |
| **USB cable** | Plug in, turn on **USB tethering** on the phone, then scan the code under **USB cable**. | A data cable. No mobile data is used. |
| **Same Wi-Fi** | Scan the code under **Wi-Fi**. | A network both devices are already on. |

The phone page is plain HTTP, so it opens with no security warning; Chrome just shows **Not secure** in the address bar. On the hotspot, the Wi-Fi password protects the traffic. On a shared Wi-Fi, other people on that network may be able to read it, so use the hotspot or USB for anything private typed on the Keyboard screen.

Tilt steering and controller motion need a secure page, which browsers require for motion sensors: open `https://<address>:8443` and tap **Advanced → Proceed** on the warning. The app makes its own certificate, because a public one can't exist offline. Fast touch input and precise timers also need that page, so the plain page can respond slightly later.

**If the phone won't open the page on the hotspot:** Android may keep using mobile data because the hotspot has no internet. Choose to stay connected when it warns you, or turn mobile data off.

## Closing it

Closing the PhoneController window stops everything within a few seconds: phones disconnect, and the hotspot, the network ports and all helper programs are gone. Nothing runs in the background or at startup. Only your settings stay on disk (hotspot name and password, phone names and colours). The controller driver stays installed but idle until you uninstall it.

## Use it as a mouse

1. In the PhoneController window, turn on **Phone can be the mouse**.
2. On the phone open **Mouse**.
3. Use it as a trackpad:

| Gesture | Does |
|---|---|
| One finger | Move the cursor |
| Tap | Left click |
| Double-tap, keep the finger down | Hold the left button and drag |
| Two-finger tap | Right click |
| Two-finger drag | Scroll |
| Three-finger tap | Show all open windows (Task View) |
| Three-finger swipe up | Show the desktop; again brings the windows back |
| Three-finger swipe left / right | Next / previous virtual desktop |

You can also hold **L**, **M** or **R** and drag with another finger.

Adjust speed, acceleration and scrolling in the phone's Mouse tab.

## Remove

Windows **Settings → Apps → Installed apps → PhoneController → Uninstall**. The controller driver is optional in that dialog, since other apps may share it.

## How it works

| Path | What |
|---|---|
| `testbench/` | The app's server (Node) and web pages. The name is historical: it started as the latency test bench. |
| `testbench/network.js` | Hotspot control, network detection |
| `testbench/hotspotname.js` | `phonepad.local` (mDNS) and port 80, on the hotspot only |
| `testbench/public/app.*` | Manager window |
| `testbench/public/index.html`, `phone.css`, `hud.js`, `mouse.js`, `pad.js`, `wheel.js`, `keys.js` | Phone pages |
| `testbench/public/sticks.js`, `look.js`, `tilt.js`, `volkeys.js`, `padsettings.js` | Gamepad features: sticks (floating centre, dead zone, L3/R3 double-tap), touch-look, tilt triggers, volume keys, live settings drawer |
| `bridge/` | `PhoneController.exe`: launcher, controller bridge (`--bridge`, ViGEm), hotspot helper (`--net`, Wi-Fi Direct) |
| `installer/` | `Install.exe` source |
| `vendor/` | Official signed ViGEmBus 1.22.0 installer |
| `tools/build.ps1` | Builds `Install.exe` and the release zip |

The hotspot is a Wi-Fi Direct group in legacy mode, which phones see as a normal WPA2 network. Unlike Windows Mobile Hotspot it needs no existing connection. Input goes over WebRTC (UDP-like) or WebSocket, straight from the phone's browser to the laptop. Settings live in `%LOCALAPPDATA%\PhoneController`.

## Develop

Needs the .NET 8 SDK and Node.js. The .NET runtime isn't needed on target PCs: the output targets .NET Framework 4.7.2, which ships with Windows.

```
dotnet build bridge -c Release -o bridge/out      # once, or after changing bridge/
cd testbench && npm install && node server.js     # manager: http://localhost:8080/app
```

## Build the download

```
powershell -ExecutionPolicy Bypass -File tools\build.ps1
```

Commit the new `Install.exe`, so GitHub's Download ZIP includes it, and attach `release\PhoneController-win-x64.zip` to a GitHub Release.

## Website

The landing page is in `docs/` and is live at https://aakash-68.github.io/PhoneAsController/, served from the `gh-pages` branch. To publish changes, commit them to `main`, then run:

```
git subtree push --prefix docs origin gh-pages
```

## Third-party software

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
