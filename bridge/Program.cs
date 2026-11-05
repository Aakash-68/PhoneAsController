// PhoneController.exe
//   (no args)    launcher: start the local server and open the manager window
//   --uninstall  launcher, opening the manager's uninstall dialog (Windows "Installed apps" uses this)
//   --bridge     virtual controller bridge, spawned by the server (see Bridge.cs)
//   --net        hotspot + network watcher, spawned by the server (see NetHelper.cs)
using System.Linq;
using PhoneController;

return args.Contains("--bridge") ? Bridge.Run()
     : args.Contains("--net") ? NetHelper.Run()
     : Launcher.Run(args.Contains("--uninstall") ? "#uninstall" : "");
