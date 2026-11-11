// Full-screen immersive WebView hosting the laptop's controller page, with the PCNative JS bridge.
package com.phoneascontroller.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

public class ControllerActivity extends Activity {

    static final String EXTRA_HOST = "host", EXTRA_URL = "url";
    private static final int HTTPS_PORT = 8443, HTTP_PORT = 8080;
    private static final long HTTPS_WATCHDOG_MS = 5000, BACK_WINDOW_MS = 2000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private String host, fallbackUrl;
    private boolean pageVisible, fellBack;
    private long lastBackAt;
    private volatile boolean volumeCapture;

    private Vibrator vibrator;
    private boolean hasAmplitude;
    private final Object vibLock = new Object();
    private int rumbleAmp; // effective amplitude currently playing (0 = off)

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        host = getIntent().getStringExtra(EXTRA_HOST);
        String url = getIntent().getStringExtra(EXTRA_URL);
        if (host == null) { finish(); return; }

        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= 30
                    ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                    : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            w.setAttributes(lp);
        }

        initVibrator();

        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(ConnectActivity.BG);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setLayoutAlgorithm(WebSettings.LayoutAlgorithm.NORMAL); // no text autosizing
        s.setTextZoom(100);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setUserAgentString(s.getUserAgentString() + " PhoneAsControllerApp/" + BuildInfo.VERSION_NAME);
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "PCNative");
        web.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> updateGestureExclusion());
        setContentView(web);
        applyImmersive();

        fallbackUrl = "http://" + hostForUrl(host) + ":" + HTTP_PORT + "/";
        String first = url != null ? url : "https://" + hostForUrl(host) + ":" + HTTPS_PORT + "/";
        if (first.startsWith("https://")) main.postDelayed(httpsWatchdog, HTTPS_WATCHDOG_MS);
        else fellBack = true;
        web.loadUrl(first);
    }

    private static String hostForUrl(String h) {
        return h.indexOf(':') >= 0 && !h.startsWith("[") ? "[" + h + "]" : h;
    }

    /** If the secure page hasn't shown anything in time, try plain http. */
    private final Runnable httpsWatchdog = () -> {
        if (!pageVisible) fallBackToHttp();
    };

    private void fallBackToHttp() {
        if (fellBack || web == null) return;
        fellBack = true;
        main.removeCallbacks(httpsWatchdog);
        web.stopLoading();
        web.loadUrl(fallbackUrl);
    }

    private final class Client extends WebViewClient {
        @SuppressLint("WebViewClientOnReceivedSslError")
        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            // Self-signed per-IP certificate: trust it only for the laptop we connected to.
            String u = error != null ? error.getUrl() : null;
            String h = u != null ? Uri.parse(u).getHost() : null;
            if (h != null && h.equalsIgnoreCase(host)) handler.proceed();
            else handler.cancel();
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            pageVisible = false;
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            pageVisible = true;
            main.removeCallbacks(httpsWatchdog);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (!req.isForMainFrame()) return;
            boolean https = "https".equals(req.getUrl().getScheme());
            if (https) {
                fallBackToHttp(); // no-op if already fell back (e.g. the aborted https load reporting late)
            } else {
                Toast.makeText(ControllerActivity.this, "Could not reach the laptop at " + host, Toast.LENGTH_LONG).show();
                finish();
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // Renderer crashed or was killed: drop this WebView instead of crashing the app.
            if (web != null) {
                ((ViewGroup) web.getParent()).removeView(web);
                web.destroy();
                web = null;
            }
            finish();
            return true;
        }
    }

    // ---- JavaScript bridge: window.PCNative (called on a binder thread) ----

    private final class Bridge {
        @JavascriptInterface
        public String version() {
            return BuildInfo.VERSION_NAME;
        }

        @JavascriptInterface
        public void setVolumeCapture(boolean on) {
            volumeCapture = on;
        }

        @JavascriptInterface
        public void vibrate(int ms, int amplitude) {
            if (vibrator == null) return;
            int dur = Math.max(1, Math.min(ms, 10000));
            synchronized (vibLock) {
                rumbleAmp = 0; // a one-shot replaces any rumble
                vibrator.vibrate(VibrationEffect.createOneShot(dur, effectiveAmp(Math.max(1, amplitude))));
            }
        }

        @JavascriptInterface
        public void rumble(int amplitude) {
            setRumble(amplitude);
        }

        @JavascriptInterface
        public void disconnect() {
            main.post(() -> {
                ConnectActivity.suppressAutoConnect = true;
                finish();
            });
        }
    }

    @SuppressWarnings("deprecation")
    private void initVibrator() {
        if (Build.VERSION.SDK_INT >= 31) {
            VibratorManager vm = getSystemService(VibratorManager.class);
            vibrator = vm != null ? vm.getDefaultVibrator() : null;
        } else {
            vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
        }
        if (vibrator != null && !vibrator.hasVibrator()) vibrator = null;
        hasAmplitude = vibrator != null && vibrator.hasAmplitudeControl();
    }

    private int effectiveAmp(int a) {
        return hasAmplitude ? Math.max(1, Math.min(a, 255)) : VibrationEffect.DEFAULT_AMPLITUDE;
    }

    /** Continuous vibration at {@code amplitude} (0 stops); identical calls don't restart the motor. */
    private void setRumble(int amplitude) {
        if (vibrator == null) return;
        int eff = amplitude <= 0 ? 0 : effectiveAmp(amplitude);
        synchronized (vibLock) {
            if (eff == rumbleAmp) return;
            rumbleAmp = eff;
            if (eff == 0) {
                vibrator.cancel();
            } else {
                // A single 5 s segment repeated forever: continuous until cancelled or changed.
                vibrator.vibrate(VibrationEffect.createWaveform(new long[]{5000}, new int[]{eff}, 0));
            }
        }
    }

    // ---- Keys ----

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int code = e.getKeyCode();
        if (volumeCapture && (code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            int a = e.getAction();
            if (web != null && (a == KeyEvent.ACTION_DOWN || a == KeyEvent.ACTION_UP)) {
                web.evaluateJavascript("window.__pcNativeKey&&window.__pcNativeKey('"
                        + (code == KeyEvent.KEYCODE_VOLUME_UP ? "up" : "down") + "',"
                        + (a == KeyEvent.ACTION_DOWN) + "," + (e.getRepeatCount() > 0) + ")", null);
            }
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        long now = SystemClock.uptimeMillis();
        if (now - lastBackAt <= BACK_WINDOW_MS) {
            ConnectActivity.suppressAutoConnect = true;
            finish();
        } else {
            lastBackAt = now;
            Toast.makeText(this, "Press back again to disconnect", Toast.LENGTH_SHORT).show();
        }
    }

    // ---- Full screen + edge gestures ----

    @SuppressWarnings("deprecation")
    private void applyImmersive() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN);
        }
    }

    /** Exclude a 200 dp band (the system cap per edge) on both edges, centred on the lower-middle where thumbs sit. */
    private void updateGestureExclusion() {
        if (Build.VERSION.SDK_INT < 29 || web == null) return;
        int wpx = web.getWidth(), hpx = web.getHeight();
        if (wpx == 0 || hpx == 0) return;
        float d = getResources().getDisplayMetrics().density;
        int band = Math.min(hpx, (int) (200 * d));
        int edge = (int) (64 * d);
        int top = Math.max(0, Math.min(hpx - band, (int) (hpx * 0.62f) - band / 2));
        List<Rect> rects = new ArrayList<>(2);
        rects.add(new Rect(0, top, edge, top + band));
        rects.add(new Rect(wpx - edge, top, wpx, top + band));
        web.setSystemGestureExclusionRects(rects);
    }

    // ---- Lifecycle ----

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive();
    }

    @Override
    protected void onResume() {
        super.onResume();
        applyImmersive();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        setRumble(0);
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        setRumble(0);
        if (web != null) {
            web.removeJavascriptInterface("PCNative");
            ViewGroup parent = (ViewGroup) web.getParent();
            if (parent != null) parent.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
