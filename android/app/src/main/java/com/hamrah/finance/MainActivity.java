package com.hamrah.finance;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Full-screen content behind status bar, navigation bar stays visible
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);

        if (getBridge() != null) {
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
                // Reserve space at the bottom so content is not hidden by the Android nav bar
                ViewCompat.setOnApplyWindowInsetsListener(webView, (v, insets) -> {
                    Insets bars = insets.getInsets(
                            WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                    v.setPadding(0, 0, 0, bars.bottom);
                    return insets;
                });
            }
        }
    }
}
