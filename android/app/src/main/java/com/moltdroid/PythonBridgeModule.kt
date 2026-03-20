package com.moltdroid

import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import com.facebook.react.bridge.*

class PythonBridgeModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "PythonBridgeModule"

    @ReactMethod
    fun runCode(code: String, dataDir: String, promise: Promise) {
        Thread {
            try {
                if (!Python.isStarted()) {
                    Python.start(AndroidPlatform(reactApplicationContext))
                }
                val py = Python.getInstance()
                val io  = py.getModule("io")
                val sys = py.getModule("sys")
                val builtins = py.getBuiltins()

                // Redirect stdout/stderr
                val buf = io.callAttr("StringIO")
                sys["stdout"] = buf
                sys["stderr"] = buf

                // Setup: working dir + DATA_DIR constant
                val setup = """
import os, sys
DATA_DIR = '$dataDir'
os.makedirs(DATA_DIR, exist_ok=True)
os.chdir(DATA_DIR)
""".trimIndent()
                builtins.callAttr("exec", setup)
                builtins.callAttr("exec", code)

                val output = buf.callAttr("getvalue").toString()
                promise.resolve(output)
            } catch (e: Exception) {
                promise.reject("PYTHON_ERROR", e.message ?: "Unknown Python error")
            }
        }.start()
    }
}
