package com.rafitol.ytdownloader;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must be registered before the bridge starts.
        registerPlugin(FileSaverPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
