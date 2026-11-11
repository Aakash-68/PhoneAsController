// Finds laptops running the PhoneController server by probing GET http://<ip>:8080/api/ping in parallel.
package com.phoneascontroller.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.DhcpInfo;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.RouteInfo;
import android.net.wifi.WifiManager;
import android.os.Build;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.Proxy;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

final class Discovery {

    /** Callbacks arrive on background threads. */
    interface Listener {
        void onFound(String host);
        void onDone(int foundCount);
    }

    static final int API_PORT = 8080;
    static final int TIMEOUT_MS = 400;
    private static final int THREADS = 64;
    private static final int MAX_SUBNETS = 4;
    static final String HOTSPOT_HOST = "192.168.137.1";

    private final Context ctx;
    private ExecutorService pool;
    private volatile boolean cancelled;

    Discovery(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    /** True if host:port answers /api/ping with {"ok":true,"app":"PhoneController"}. Blocking. */
    static boolean ping(String host, int port, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            URL u = new URL("http", host, port, "/api/ping");
            c = (HttpURLConnection) u.openConnection(Proxy.NO_PROXY);
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setUseCaches(false);
            c.setInstanceFollowRedirects(false);
            if (c.getResponseCode() != 200) return false;
            byte[] buf = new byte[512];
            int n = 0;
            try (InputStream in = c.getInputStream()) {
                int r;
                while (n < buf.length && (r = in.read(buf, n, buf.length - n)) > 0) n += r;
            }
            String body = new String(buf, 0, n, "UTF-8").replaceAll("\\s", "");
            return body.contains("\"ok\":true") && body.contains("\"app\":\"PhoneController\"");
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Starts a scan: priority hosts first, then every /24 the phone sits on. */
    void start(String savedHost, int savedPort, Listener listener) {
        cancel();
        cancelled = false;

        // Priority probes: saved laptop, Windows hotspot, gateway / DHCP server.
        LinkedHashSet<String> quick = new LinkedHashSet<>();
        if (savedHost != null && !savedHost.isEmpty()) quick.add(savedHost);
        quick.add(HOTSPOT_HOST);
        List<String> prefixes = new ArrayList<>();
        collectNetworkInfo(quick, prefixes);

        LinkedHashSet<String> sweep = new LinkedHashSet<>();
        for (String p : prefixes) for (int i = 1; i <= 254; i++) sweep.add(p + i);
        sweep.removeAll(quick);

        final ThreadPoolExecutor ex = new ThreadPoolExecutor(THREADS, THREADS, 1, TimeUnit.SECONDS,
                new LinkedBlockingQueue<Runnable>());
        ex.allowCoreThreadTimeOut(true);
        pool = ex;

        final Set<String> found = Collections.newSetFromMap(new ConcurrentHashMap<String, Boolean>());
        final AtomicInteger remaining = new AtomicInteger(quick.size() + sweep.size());
        List<String> order = new ArrayList<>(quick);
        order.addAll(sweep);
        for (final String host : order) {
            final int port = host.equals(savedHost) ? savedPort : API_PORT;
            ex.execute(() -> {
                if (!cancelled && ping(host, port, TIMEOUT_MS) && !cancelled && found.add(host)) {
                    listener.onFound(host);
                }
                if (remaining.decrementAndGet() == 0 && !cancelled) {
                    listener.onDone(found.size());
                    ex.shutdown();
                }
            });
        }
    }

    void cancel() {
        cancelled = true;
        if (pool != null) {
            pool.shutdownNow();
            pool = null;
        }
    }

    /** Adds gateway/DHCP hosts to {@code quick} and "a.b.c." /24 prefixes to {@code prefixes} (Wi-Fi first). */
    @SuppressWarnings("deprecation")
    private void collectNetworkInfo(Set<String> quick, List<String> prefixes) {
        LinkedHashSet<String> pre = new LinkedHashSet<>();
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) {
                for (Network n : cm.getAllNetworks()) {
                    NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                    if (caps == null || caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
                            || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue;
                    LinkProperties lp = cm.getLinkProperties(n);
                    if (lp == null) continue;
                    for (RouteInfo r : lp.getRoutes()) {
                        if (r.isDefaultRoute() && r.getGateway() instanceof Inet4Address) {
                            quick.add(r.getGateway().getHostAddress());
                        }
                    }
                    if (Build.VERSION.SDK_INT >= 30 && lp.getDhcpServerAddress() instanceof Inet4Address) {
                        quick.add(lp.getDhcpServerAddress().getHostAddress());
                    }
                    for (LinkAddress la : lp.getLinkAddresses()) {
                        String p = prefix24(la.getAddress());
                        if (p != null) pre.add(p);
                    }
                }
            }
        } catch (Exception ignored) { }
        try {
            WifiManager wm = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
            DhcpInfo d = wm != null ? wm.getDhcpInfo() : null;
            if (d != null) {
                if (d.gateway != 0) quick.add(intToIp(d.gateway));
                if (d.serverAddress != 0) quick.add(intToIp(d.serverAddress));
            }
        } catch (Exception ignored) { }
        // Own interfaces (covers USB tethering / phone hotspot, where the laptop is a host on our subnet).
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                String name = ni.getName();
                if (!ni.isUp() || ni.isLoopback() || name.startsWith("rmnet") || name.startsWith("ccmni")
                        || name.startsWith("v4-") || name.startsWith("tun") || name.startsWith("dummy")) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    String p = prefix24(a);
                    if (p != null) pre.add(p);
                }
            }
        } catch (Exception ignored) { }
        quick.remove("0.0.0.0");
        for (String p : pre) {
            if (prefixes.size() >= MAX_SUBNETS) break;
            prefixes.add(p);
        }
    }

    /** "a.b.c." for private IPv4 addresses, else null. */
    private static String prefix24(InetAddress a) {
        if (!(a instanceof Inet4Address) || !a.isSiteLocalAddress()) return null;
        byte[] b = a.getAddress();
        return (b[0] & 0xff) + "." + (b[1] & 0xff) + "." + (b[2] & 0xff) + ".";
    }

    private static String intToIp(int i) {
        return (i & 0xff) + "." + ((i >> 8) & 0xff) + "." + ((i >> 16) & 0xff) + "." + ((i >> 24) & 0xff);
    }
}
