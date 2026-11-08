package bg.doroteya.pantrypals;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends Activity {
  private static final String BASE = "https://pantrypals.app/";
  private static final String REMOTE = "https://dstephanova.github.io/pantry-pals/";
  private static final String EBAG_HOME = "https://www.ebag.bg/";

  private WebView web;
  private String pendingShare;
  private boolean loaded;
  private boolean usingRemote;
  private SharedPreferences prefs;
  private final Handler ui = new Handler(Looper.getMainLooper());

  // eBag panel
  private LinearLayout ebagBox;
  private TextView ebagTitle;
  private Button ebagBtn;
  private WebView ebag;
  private boolean cartMode;
  private JSONArray queue;
  private JSONArray results;
  private int qi;
  private int runToken;

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    prefs = getSharedPreferences("pantry", MODE_PRIVATE);
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.parseColor("#F6F5F1"));
    web = new WebView(this);
    root.addView(web, new FrameLayout.LayoutParams(-1, -1));
    buildEbagPanel(root);
    setContentView(root);

    CookieManager.getInstance().setAcceptCookie(true);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setTextZoom(100);
    web.setWebChromeClient(new WebChromeClient());
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView v, String url) { return handle(url); }
      public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return handle(r.getUrl().toString()); }
      @Override public void onPageFinished(WebView v, String url) { loaded = true; flushShare(); }
      @Override public void onReceivedError(WebView v, int code, String desc, String url) {
        if (usingRemote && url != null && url.startsWith(REMOTE)) loadBundled();
      }
      public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
        if (usingRemote && r.isForMainFrame()) loadBundled();
      }
      public void onReceivedHttpError(WebView v, WebResourceRequest r, WebResourceResponse resp) {
        if (usingRemote && r.isForMainFrame() && resp.getStatusCode() >= 400) loadBundled();
      }
    });
    web.addJavascriptInterface(new Bridge(), "PantryNative");
    takeShare(getIntent());
    if ("1".equals(prefs.getString("migrated", null))) {
      usingRemote = true;
      web.loadUrl(REMOTE);
    } else {
      loadBundled();
    }
  }

  private void loadBundled() {
    usingRemote = false;
    loaded = false;
    web.loadDataWithBaseURL(BASE, readAsset("index.html"), "text/html", "utf-8", null);
  }

  private boolean handle(String url) {
    if (url.startsWith(BASE) || url.startsWith(REMOTE)) return false;
    openUrl(url);
    return true;
  }

  private void openUrl(String url) {
    try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); }
    catch (Exception e) { Toast.makeText(this, "Couldn't open the link", Toast.LENGTH_SHORT).show(); }
  }

  @Override protected void onNewIntent(Intent i) { super.onNewIntent(i); takeShare(i); flushShare(); }

  private void takeShare(Intent i) {
    if (i != null && Intent.ACTION_SEND.equals(i.getAction())) {
      String t = i.getStringExtra(Intent.EXTRA_TEXT);
      String sub = i.getStringExtra(Intent.EXTRA_SUBJECT);
      if (t != null) pendingShare = (sub != null && !t.contains(sub)) ? sub + " " + t : t;
    }
  }

  private void flushShare() {
    if (!loaded || pendingShare == null) return;
    String js = "(window.onSharedText||function(t){localStorage.setItem('pp_pending',t)})(" + JSONObject.quote(pendingShare) + ")";
    pendingShare = null;
    web.evaluateJavascript(js, null);
  }

  private void callJs(String js) { web.evaluateJavascript(js, null); }

  @Override public void onBackPressed() {
    if (ebagBox.getVisibility() == View.VISIBLE) {
      if (cartMode) { stopCart(); return; }
      if (ebag.canGoBack()) { ebag.goBack(); return; }
      closeEbag();
      return;
    }
    web.evaluateJavascript("(function(){var w=document.querySelector('.sheet-wrap.open');if(w){w.click();return 1}return 0})()",
      new ValueCallback<String>() {
        @Override public void onReceiveValue(String v) { if (!"1".equals(v)) MainActivity.super.onBackPressed(); }
      });
  }

  // ---------------- eBag panel ----------------
  private int dp(int v) { return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()); }

  private void buildEbagPanel(FrameLayout root) {
    ebagBox = new LinearLayout(this);
    ebagBox.setOrientation(LinearLayout.VERTICAL);
    ebagBox.setBackgroundColor(Color.parseColor("#F6F5F1"));
    ebagBox.setVisibility(View.GONE);

    LinearLayout bar = new LinearLayout(this);
    bar.setOrientation(LinearLayout.HORIZONTAL);
    bar.setGravity(Gravity.CENTER_VERTICAL);
    bar.setPadding(dp(16), dp(10), dp(10), dp(10));
    bar.setBackgroundColor(Color.parseColor("#2F7D5B"));
    ebagTitle = new TextView(this);
    ebagTitle.setTextColor(Color.WHITE);
    ebagTitle.setTextSize(15);
    ebagTitle.setTypeface(Typeface.DEFAULT_BOLD);
    bar.addView(ebagTitle, new LinearLayout.LayoutParams(0, -2, 1));
    ebagBtn = new Button(this);
    ebagBtn.setAllCaps(false);
    ebagBtn.setTextColor(Color.parseColor("#2F7D5B"));
    ebagBtn.setBackgroundColor(Color.WHITE);
    ebagBtn.setTypeface(Typeface.DEFAULT_BOLD);
    bar.addView(ebagBtn, new LinearLayout.LayoutParams(-2, dp(40)));
    ebagBox.addView(bar, new LinearLayout.LayoutParams(-1, -2));

    ebag = new WebView(this);
    WebSettings s = ebag.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setTextZoom(100);
    CookieManager.getInstance().setAcceptThirdPartyCookies(ebag, true);
    ebag.setWebChromeClient(new WebChromeClient());
    ebag.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView v, String url) { return !url.startsWith("http"); }
      public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return !r.getUrl().toString().startsWith("http"); }
      @Override public void onPageFinished(WebView v, String url) {
        if (cartMode) scheduleInject(runToken);
      }
    });
    ebag.addJavascriptInterface(new EbagBridge(), "EbagNative");
    ebagBox.addView(ebag, new LinearLayout.LayoutParams(-1, 0, 1));
    root.addView(ebagBox, new FrameLayout.LayoutParams(-1, -1));
  }

  private void showEbag(String title, String btn, View.OnClickListener l) {
    ebagTitle.setText(title);
    ebagBtn.setText(btn);
    ebagBtn.setOnClickListener(l);
    ebagBox.setVisibility(View.VISIBLE);
  }

  private void closeEbag() {
    ebagBox.setVisibility(View.GONE);
    CookieManager.getInstance().flush();
  }

  private void connectEbag() {
    cartMode = false;
    showEbag("Sign in to eBag, then tap Done", "Done", new View.OnClickListener() {
      @Override public void onClick(View v) {
        closeEbag();
        prefs.edit().putString("ebag", "1").apply();
        callJs("window.__ebagConnected&&window.__ebagConnected()");
      }
    });
    ebag.loadUrl(EBAG_HOME);
  }

  private void startCart(String json) {
    try { queue = new JSONArray(json); } catch (Exception e) { return; }
    results = new JSONArray();
    qi = -1;
    cartMode = true;
    showEbag("Adding to your eBag cart…", "Stop", new View.OnClickListener() {
      @Override public void onClick(View v) { stopCart(); }
    });
    nextItem();
  }

  private void stopCart() {
    if (!cartMode) return;
    try {
      for (int i = results.length(); i < queue.length(); i++) {
        JSONObject r = new JSONObject();
        r.put("id", queue.getJSONObject(i).optString("id"));
        r.put("status", "stopped");
        results.put(r);
      }
    } catch (Exception ignored) {}
    finishCart();
  }

  private void finishCart() {
    cartMode = false;
    runToken++;
    closeEbag();
    ebag.loadUrl("about:blank");
    callJs("window.__cartDone&&window.__cartDone(" + results.toString() + ")");
  }

  private void nextItem() {
    qi++;
    runToken++;
    if (qi >= queue.length()) { finishCart(); return; }
    final int token = runToken;
    try {
      JSONObject it = queue.getJSONObject(qi);
      ebagTitle.setText("Adding " + (qi + 1) + " of " + queue.length() + ": " + it.optString("name"));
      injected = false;
      ebag.loadUrl(it.getString("url"));
    } catch (Exception e) { record(token, "error", "bad item"); return; }
    ui.postDelayed(new Runnable() { public void run() {
      record(token, "timeout", "Page took too long");
    } }, 45000);
  }

  private boolean injected;

  private void scheduleInject(final int token) {
    if (injected) return;
    injected = true;
    ui.postDelayed(new Runnable() { public void run() {
      if (!cartMode || token != runToken) return;
      try {
        int qty = Math.max(1, queue.getJSONObject(qi).optInt("qty", 1));
        ebag.evaluateJavascript(readAsset("ebag-add.js").replace("__QTY__", String.valueOf(qty)).replace("__TOKEN__", String.valueOf(token)), null);
      } catch (Exception e) { record(token, "error", "inject failed"); }
    } }, 1200);
  }

  private void record(int token, String status, String detail) {
    if (!cartMode || token != runToken) return;
    runToken++;
    try {
      JSONObject r = new JSONObject();
      r.put("id", queue.getJSONObject(qi).optString("id"));
      r.put("status", status);
      r.put("detail", detail == null ? "" : detail);
      results.put(r);
    } catch (Exception ignored) {}
    final int t2 = runToken;
    ui.postDelayed(new Runnable() { public void run() { if (cartMode && t2 == runToken) nextItem(); } }, 600);
  }

  class EbagBridge {
    @JavascriptInterface public void result(final int token, final String status, final String detail) {
      ui.post(new Runnable() { public void run() { record(token, status, detail); } });
    }
  }

  // ---------------- helpers ----------------
  private String readAsset(String name) {
    try {
      InputStream in = getAssets().open(name);
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] buf = new byte[16384]; int n;
      while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
      in.close();
      return out.toString("UTF-8");
    } catch (Exception e) { return "<h1>Couldn't load the app</h1>"; }
  }

  private static String find(String html, String[] pats) {
    for (String p : pats) {
      Matcher m = Pattern.compile(p, Pattern.CASE_INSENSITIVE).matcher(html);
      if (m.find()) return m.group(1).replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'").trim();
    }
    return null;
  }

  private String fetchMetaJson(String url) {
    JSONObject o = new JSONObject();
    try {
      HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
      c.setInstanceFollowRedirects(true);
      c.setConnectTimeout(10000); c.setReadTimeout(15000);
      c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36");
      c.setRequestProperty("Accept-Language", "bg,en;q=0.8");
      InputStream in = c.getInputStream();
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] buf = new byte[16384]; int n;
      while ((n = in.read(buf)) > 0 && out.size() < 1500000) out.write(buf, 0, n);
      in.close();
      String html = out.toString("UTF-8");
      String img = find(html, new String[]{
        "<meta[^>]+property=[\"']og:image(?::secure_url)?[\"'][^>]+content=[\"']([^\"']+)",
        "<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+property=[\"']og:image",
        "\"image\"\\s*:\\s*\\[?\\s*\"(https?://[^\"]+)\"",
        "<meta[^>]+name=[\"']twitter:image[\"'][^>]+content=[\"']([^\"']+)"});
      String title = find(html, new String[]{
        "<meta[^>]+property=[\"']og:title[\"'][^>]+content=[\"']([^\"']+)",
        "<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+property=[\"']og:title",
        "<h1[^>]*>([^<]{3,200})</h1>",
        "<title>([^<]+)</title>"});
      String price = find(html, new String[]{
        "<meta[^>]+property=[\"'](?:product|og):price:amount[\"'][^>]+content=[\"']([0-9]+[.,]?[0-9]*)",
        "<meta[^>]+content=[\"']([0-9]+[.,]?[0-9]*)[\"'][^>]+property=[\"'](?:product|og):price:amount",
        "itemprop=[\"']price[\"'][^>]+content=[\"']([0-9]+[.,]?[0-9]*)",
        "\"price\"\\s*:\\s*\"?([0-9]+[.,][0-9]{1,2})"});
      String cur = find(html, new String[]{
        "(?:product|og):price:currency[\"'][^>]+content=[\"']([A-Z]{3})",
        "\"priceCurrency\"\\s*:\\s*\"([A-Z]{3})\""});
      o.put("price", price == null ? JSONObject.NULL : price.replace(',', '.'));
      o.put("currency", cur == null ? JSONObject.NULL : cur);
      if (img != null && img.startsWith("//")) img = "https:" + img;
      if (title != null) title = title.replaceAll("\\s*[|\\-–]\\s*eBag.*$", "").trim();
      o.put("img", img == null ? JSONObject.NULL : img);
      o.put("title", title == null ? JSONObject.NULL : title);
    } catch (Exception e) {
      try { o.put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) {}
    }
    return o.toString();
  }

  class Bridge {
    @JavascriptInterface public int version() { return 3; }
    @JavascriptInterface public boolean remote() { return usingRemote; }
    @JavascriptInterface public String getPref(String k) { return prefs.getString("js_" + k, null); }
    @JavascriptInterface public void setPref(String k, String v) {
      if (v == null) prefs.edit().remove("js_" + k).apply(); else prefs.edit().putString("js_" + k, v).apply();
    }
    @JavascriptInterface public void markMigrated() { prefs.edit().putString("migrated", "1").apply(); }
    @JavascriptInterface public boolean ebagConnected() { return "1".equals(prefs.getString("ebag", null)); }
    @JavascriptInterface public void connectEbag() {
      ui.post(new Runnable() { public void run() { MainActivity.this.connectEbag(); } });
    }
    @JavascriptInterface public void addToCart(final String json) {
      ui.post(new Runnable() { public void run() { startCart(json); } });
    }
    @JavascriptInterface public void openEbag() {
      ui.post(new Runnable() { public void run() {
        cartMode = false;
        showEbag("Your eBag", "Close", new View.OnClickListener() { @Override public void onClick(View v) { closeEbag(); } });
        ebag.loadUrl(EBAG_HOME);
      } });
    }
    @JavascriptInterface public void fetchMeta(final String url, final String id) {
      new Thread(new Runnable() { public void run() {
        final String json = fetchMetaJson(url);
        ui.post(new Runnable() { public void run() {
          callJs("window.__meta&&window.__meta(" + JSONObject.quote(id) + "," + json + ")");
        } });
      } }).start();
    }
    @JavascriptInterface public void openUrl(final String url) {
      ui.post(new Runnable() { public void run() { MainActivity.this.openUrl(url); } });
    }
    @JavascriptInterface public void shareText(final String text) {
      ui.post(new Runnable() { public void run() {
        Intent i = new Intent(Intent.ACTION_SEND); i.setType("text/plain"); i.putExtra(Intent.EXTRA_TEXT, text);
        startActivity(Intent.createChooser(i, "Share code"));
      } });
    }
    @JavascriptInterface public void copy(final String text) {
      ui.post(new Runnable() { public void run() {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        cm.setPrimaryClip(ClipData.newPlainText("Pantry Pals", text));
      } });
    }
  }
}
