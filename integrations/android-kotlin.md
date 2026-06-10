# Android — wiring up install attribution (deterministic, 100% accurate)

This uses Google's **Play Install Referrer API**. It's free, official, and exact:
the `referrer` string your link put on the Play Store URL is handed back to your
app after install. No fingerprinting, no guessing.

> Works only for installs that come **through the Play Store**. Sideloaded / other
> app stores won't carry a referrer (true for every attribution provider, not just this one).

## 1. Add the dependency

```kotlin
// build.gradle (app module)
dependencies {
    implementation("com.android.installreferrer:installreferrer:2.2")
}
```

## 2. Read the referrer once, on first launch, and report it

```kotlin
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

const val TRACKR_BASE = "https://YOUR-DOMAIN"   // where you deployed the platform

fun captureInstallReferrer(context: Context) {
    val prefs = context.getSharedPreferences("trackr", Context.MODE_PRIVATE)
    if (prefs.getBoolean("referrer_done", false)) return   // run only once

    val client = InstallReferrerClient.newBuilder(context).build()
    client.startConnection(object : InstallReferrerStateListener {
        override fun onInstallReferrerSetupFinished(code: Int) {
            if (code == InstallReferrerClient.InstallReferrerResponse.OK) {
                val referrer = client.installReferrer.installReferrer ?: ""
                // e.g. "alias=diwali-insta&cid=1842"  (Play decodes it for you)
                reportToTrackr(referrer) { deepLinkPath ->
                    prefs.edit().putBoolean("referrer_done", true).apply()
                    deepLinkPath?.let { routeTo(it) }   // deferred deep link, optional
                }
            }
            client.endConnection()
        }
        override fun onInstallReferrerServiceDisconnected() {}
    })
}

private fun reportToTrackr(referrer: String, done: (String?) -> Unit) {
    val json = """{"referrer": ${org.json.JSONObject.quote(referrer)}}"""
    val req = Request.Builder()
        .url("$TRACKR_BASE/api/attribute/android")
        .post(json.toRequestBody("application/json".toMediaType()))
        .build()
    OkHttpClient().newCall(req).enqueue(object : Callback {
        override fun onFailure(call: Call, e: java.io.IOException) { done(null) }
        override fun onResponse(call: Call, resp: Response) {
            val path = resp.body?.string()
                ?.let { runCatching { org.json.JSONObject(it).optString("deep_link_path") }.getOrNull() }
            done(path?.ifBlank { null })
        }
    })
}
```

Call `captureInstallReferrer(this)` from your launcher Activity's `onCreate`
(or Application `onCreate`). That's it — every install that came from one of your
links now shows up in the dashboard under the right alias.

## How the round-trip works
1. Someone taps `https://YOUR-DOMAIN/l/diwali-insta` in an Instagram post.
2. The platform records the click and redirects to
   `play.google.com/store/apps/details?id=com.you.app&referrer=alias%3Ddiwali-insta%26cid%3D1842`.
3. They install. On first open, the code above reads `alias=diwali-insta&cid=1842`
   and POSTs it back.
4. The dashboard logs a **deterministic** install for `diwali-insta`.
