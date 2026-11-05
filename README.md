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
| **Hotspot** (default) | The laptop makes its own password-protected Wi-Fi. Scan **1 Join Wi-Fi**, then **2 Open app**, in the PhoneController window. | Laptop's Wi-Fi switched on. It doesn't have to be connected to anything. |
| **USB cable** | Plug in, turn on **USB tethering** on the phone, then scan the code under **USB cable**. | A data cable. No mobile data is used. |
| **Same Wi-Fi** | Scan the code under **Wi-Fi**. | A network both devices are already on. |

On the phone's first visit to each address, tap **Advanced → Proceed** on the security warning. The app makes its own certificate, because a public one can't exist offline. Motion features need this secure page.

**If the phone won't open the page on the hotspot:** Android may keep using mobile data because the hotspot has no internet. Choose to stay connected when it warns you, or turn mobile data off.

## Use it as a mouse

1. In the PhoneController window, turn on **Phone can be the mouse**.
2. On the phone open **Mouse** and lay it flat, screen up, on a hard table. Wait for **Ready**.
3. Slide it like a mouse. The big **L** and **R** areas are the buttons, and the middle strip scrolls. Lift it to reposition, as with a real mouse.

Phones have no mouse sensor, so the table mouse estimates movement from the accelerometer. Deliberate strokes work best. It can't match an optical mouse for slow, precise movement; use **Touch** mode (trackpad) for that. Adjust **Cursor speed** and **Sensitivity** in the phone's Mouse tab.

## Remove

Windows **Settings → Apps → Installed apps → PhoneController → Uninstall**. The controller driver is optional in that dialog, since other apps may share it.

## How it works

| Path | What |
|---|---|
| `testbench/` | The app's server (Node) and web pages. The name is historical: it started as the latency test bench. |
| `testbench/network.js` | Hotspot control, network detection |
| `testbench/public/tablemouse.js` | Table mouse tracking (no DOM; `testbench/tools/tablemouse-test.js` tests it against simulated sensors) |
| `testbench/public/app.*` | Manager window |
| `testbench/public/index.html`, `phone.css`, `hud.js`, `mouse.js`, `pad.js`, `wheel.js`, `keys.js` | Phone pages |
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
node tools/tablemouse-test.js                     # table mouse tests
```

## Build the download

```
powershell -ExecutionPolicy Bypass -File tools\build.ps1
```

Commit the new `Install.exe`, so GitHub's Download ZIP includes it, and attach `release\PhoneController-win-x64.zip` to a GitHub Release.

## Third-party software

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
