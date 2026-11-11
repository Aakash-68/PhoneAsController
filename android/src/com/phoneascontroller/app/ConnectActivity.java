// Launcher screen: discovers laptops, takes a manual address, remembers the last laptop and auto-connects to it.
package com.phoneascontroller.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.HashSet;
import java.util.Set;

public class ConnectActivity extends Activity {

    static final int BG = 0xFF0E0F11, FG = 0xFFE9EAEE, ACCENT = 0xFFC8714F, MUTED = 0xFF9A9CA3, CARD = 0xFF1A1C20;
    private static final String PREFS = "pc", KEY_LAST = "last", KEY_AUTO = "auto";

    /** Once the user has been connected (or disconnected) in this process, don't auto-connect again. */
    static boolean suppressAutoConnect;

    private final Handler main = new Handler(Looper.getMainLooper());
    private Discovery discovery;
    private SharedPreferences prefs;
    private TextView status;
    private LinearLayout list;
    private EditText address;
    private CheckBox autoBox;
    private final Set<String> shown = new HashSet<>();
    private int scanId;

    /** A parsed address: host plus an optional explicit page URL. */
    static final class Target {
        final String host;
        final String url;   // null = default (https :8443 with http :8080 fallback)
        final int pingPort;

        Target(String host, String url, int pingPort) {
            this.host = host;
            this.url = url;
            this.pingPort = pingPort;
        }

        /** Accepts "192.168.137.1", "192.168.137.1:8080" or "http(s)://ip:port[/path]". */
        static Target parse(String input) {
            if (input == null) return null;
            String s = input.trim();
            if (s.isEmpty()) return null;
            boolean explicit = s.startsWith("http://") || s.startsWith("https://");
            Uri u = Uri.parse(explicit ? s : "http://" + s);
            String host = u.getHost();
            if (host == null || host.isEmpty()) return null;
            int port = u.getPort();
            if (!explicit && port <= 0) return new Target(host, null, Discovery.API_PORT);
            String scheme = explicit ? u.getScheme() : "http";
            String path = u.getEncodedPath();
            String url = scheme + "://" + host + (port > 0 ? ":" + port : "") + (path == null || path.isEmpty() ? "/" : path);
            int pingPort = "http".equals(scheme) && port > 0 ? port : Discovery.API_PORT;
            return new Target(host, url, pingPort);
        }
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        discovery = new Discovery(this);
        setContentView(buildUi());
        address.setText(prefs.getString(KEY_LAST, ""));
    }

    @Override
    protected void onResume() {
        super.onResume();
        startScan();
    }

    @Override
    protected void onPause() {
        super.onPause();
        scanId++;
        discovery.cancel();
    }

    private void startScan() {
        final int id = ++scanId;
        shown.clear();
        list.removeAllViews();
        status.setText("Searching for laptops…");
        final Target saved = Target.parse(prefs.getString(KEY_LAST, ""));
        final boolean auto = saved != null && !suppressAutoConnect && autoBox.isChecked();
        discovery.start(saved != null ? saved.host : null, saved != null ? saved.pingPort : Discovery.API_PORT,
                new Discovery.Listener() {
                    @Override
                    public void onFound(final String host) {
                        main.post(() -> {
                            if (id != scanId) return;
                            if (auto && host.equals(saved.host)) {
                                status.setText("Connecting to " + host + "…");
                                connect(prefs.getString(KEY_LAST, host));
                                return;
                            }
                            addLaptop(host);
                        });
                    }

                    @Override
                    public void onDone(final int count) {
                        main.post(() -> {
                            if (id != scanId) return;
                            status.setText(count == 0
                                    ? "No laptop found. Join the laptop's Wi-Fi / hotspot and start the server, or type its address."
                                    : "Found " + count + (count == 1 ? " laptop" : " laptops") + ". Tap to connect.");
                        });
                    }
                });
    }

    private void addLaptop(final String host) {
        if (!shown.add(host)) return;
        TextView row = new TextView(this);
        row.setText("Laptop  ·  " + host);
        row.setTextColor(FG);
        row.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        row.setPadding(dp(16), dp(14), dp(16), dp(14));
        row.setBackground(rounded(CARD, dp(10)));
        row.setOnClickListener(v -> connect(host));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.bottomMargin = dp(8);
        list.addView(row, lp);
    }

    /** Saves the address and opens the controller. */
    private void connect(String input) {
        Target t = Target.parse(input);
        if (t == null) {
            Toast.makeText(this, "Enter the laptop address, e.g. 192.168.137.1", Toast.LENGTH_SHORT).show();
            return;
        }
        prefs.edit().putString(KEY_LAST, input.trim()).apply();
        address.setText(input.trim());
        suppressAutoConnect = true;
        scanId++;
        discovery.cancel();
        Intent i = new Intent(this, ControllerActivity.class);
        i.putExtra(ControllerActivity.EXTRA_HOST, t.host);
        if (t.url != null) i.putExtra(ControllerActivity.EXTRA_URL, t.url);
        startActivity(i);
    }

    // ---- UI (built in code: no layout XML) ----

    private View buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(28), dp(20), dp(20));
        root.setBackgroundColor(BG);
        root.setFitsSystemWindows(true);

        TextView title = new TextView(this);
        title.setText("PhoneAsController");
        title.setTextColor(FG);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);

        status = new TextView(this);
        status.setTextColor(MUTED);
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        status.setPadding(0, dp(6), 0, dp(16));
        root.addView(status);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        address = new EditText(this);
        address.setHint("192.168.137.1 or https://ip:8443");
        address.setHintTextColor(0xFF5E6067);
        address.setTextColor(FG);
        address.setSingleLine(true);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setImeOptions(EditorInfo.IME_ACTION_GO);
        address.setBackgroundTintList(ColorStateList.valueOf(ACCENT));
        address.setOnEditorActionListener((v, actionId, e) -> {
            connect(address.getText().toString());
            return true;
        });
        row.addView(address, new LinearLayout.LayoutParams(0, -2, 1));
        Button go = button("Connect", ACCENT, Color.WHITE);
        go.setOnClickListener(v -> connect(address.getText().toString()));
        LinearLayout.LayoutParams glp = new LinearLayout.LayoutParams(-2, -2);
        glp.leftMargin = dp(10);
        row.addView(go, glp);
        root.addView(row);

        LinearLayout row2 = new LinearLayout(this);
        row2.setOrientation(LinearLayout.HORIZONTAL);
        row2.setGravity(Gravity.CENTER_VERTICAL);
        row2.setPadding(0, dp(8), 0, dp(12));
        autoBox = new CheckBox(this);
        autoBox.setText("Auto-connect to last laptop");
        autoBox.setTextColor(FG);
        autoBox.setButtonTintList(ColorStateList.valueOf(ACCENT));
        autoBox.setChecked(prefs.getBoolean(KEY_AUTO, true));
        autoBox.setOnCheckedChangeListener((b, on) -> prefs.edit().putBoolean(KEY_AUTO, on).apply());
        row2.addView(autoBox, new LinearLayout.LayoutParams(0, -2, 1));
        Button rescan = button("Rescan", CARD, FG);
        rescan.setOnClickListener(v -> startScan());
        row2.addView(rescan);
        root.addView(row2);

        TextView found = new TextView(this);
        found.setText("FOUND ON THIS NETWORK");
        found.setTextColor(MUTED);
        found.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        found.setLetterSpacing(0.08f);
        found.setPadding(0, 0, 0, dp(8));
        root.addView(found);

        ScrollView scroll = new ScrollView(this);
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(list);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        return root;
    }

    private Button button(String text, int bg, int fg) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextColor(fg);
        b.setBackground(rounded(bg, dp(10)));
        b.setPadding(dp(18), 0, dp(18), 0);
        b.setStateListAnimator(null);
        return b;
    }

    private static GradientDrawable rounded(int color, int radius) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(radius);
        return d;
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
