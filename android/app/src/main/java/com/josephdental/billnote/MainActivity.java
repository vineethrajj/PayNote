package com.josephdental.billnote;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Bill Note — thin, configurable WebView shell around the deployed Apps
 * Script web app (Joseph Dental & Aesthetic Wellness).
 *
 * Why a WebView shell (not a PWA install): Apps Script serves its web apps
 * inside a sandboxed iframe, which blocks true Android PWA/WebAPK install.
 * This shell loads the same live app full-screen, supports the file picker
 * the statement-import feature needs, and ships as a normal sideloadable APK.
 *
 * The deployed URL is NOT hard-coded — it is entered once on first launch and
 * saved on the device, so a single APK works for any deployment and can be
 * changed later from the menu.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "billnote";
    private static final String KEY_URL = "app_url";
    private static final int FILECHOOSER_RESULT = 0x1001;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String url = prefs().getString(KEY_URL, "");
        if (url == null || url.isEmpty()) {
            showConfigScreen();
        } else {
            showWebApp(url);
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    // ---- First-run / change-URL configuration screen ----------------------

    private void showConfigScreen() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_VERTICAL);
        int pad = dp(24);
        root.setPadding(pad, pad, pad, pad);
        root.setBackgroundColor(Color.parseColor("#0d9488"));

        TextView title = new TextView(this);
        title.setText("Bill Note");
        title.setTextColor(Color.WHITE);
        title.setTextSize(28);
        title.setGravity(Gravity.CENTER);

        TextView sub = new TextView(this);
        sub.setText("Paste the clinic's app link to connect this device.");
        sub.setTextColor(Color.parseColor("#d1faf4"));
        sub.setTextSize(15);
        sub.setGravity(Gravity.CENTER);
        sub.setPadding(0, dp(8), 0, dp(24));

        final EditText input = new EditText(this);
        input.setHint("https://script.google.com/.../exec");
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setBackgroundColor(Color.WHITE);
        input.setPadding(dp(16), dp(16), dp(16), dp(16));
        String existing = prefs().getString(KEY_URL, "");
        if (existing != null && !existing.isEmpty()) input.setText(existing);

        Button save = new Button(this);
        save.setText("Connect");
        save.setAllCaps(false);
        save.setTextSize(17);

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(16);

        root.addView(title);
        root.addView(sub);
        root.addView(input);
        root.addView(save, lp);
        setContentView(root);

        save.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                String url = input.getText().toString().trim();
                if (!(url.startsWith("http://") || url.startsWith("https://"))) {
                    Toast.makeText(MainActivity.this, "Enter a link starting with https://", Toast.LENGTH_LONG).show();
                    return;
                }
                prefs().edit().putString(KEY_URL, url).apply();
                showWebApp(url);
            }
        });
    }

    // ---- The web app ------------------------------------------------------

    private void showWebApp(String url) {
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);

        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, String u) {
                // Keep Google/Apps Script navigation inside the app.
                if (u.startsWith("http")) { view.loadUrl(u); return true; }
                return false;
            }
        });

        // Enable <input type="file"> (needed by the statement-import feature).
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) { fileCallback.onReceiveValue(null); }
                fileCallback = cb;
                try {
                    Intent intent = params.createIntent();
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(Intent.createChooser(intent, "Choose statement files"), FILECHOOSER_RESULT);
                } catch (Exception e) {
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, "No file picker available.", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });

        setContentView(web);
        web.loadUrl(url);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILECHOOSER_RESULT) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    // ---- Menu: change link / reload --------------------------------------

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 1, 0, "Reload");
        menu.add(0, 2, 1, "Change app link");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) {
            if (web != null) web.reload();
            return true;
        }
        if (item.getItemId() == 2) {
            showConfigScreen();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }
}
