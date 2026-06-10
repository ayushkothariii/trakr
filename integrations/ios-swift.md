# iOS — wiring up install attribution (probabilistic)

Apple gives apps **no install referrer**, so iOS attribution is inherently
best-effort for everyone (Branch, AppsFlyer, Adjust all do the same thing under
the hood). On first launch your app pings the platform; the server matches your
device to a recent click from the same network within a 24-hour window.

Expect this to attribute **most**, not all, iOS installs. It is for understanding
which organic posts drive installs — not for billing an ad network to the cent.
Do **not** add an `IDFA` / ATT prompt for this; the match uses only coarse,
first-party signals (hashed IP + user-agent).

## 1. On first launch, ask the platform if this install matches a recent click

```swift
import UIKit

let trackrBase = "https://YOUR-DOMAIN"   // where you deployed the platform

func checkDeferredAttribution() {
    let key = "trackr_attribution_done"
    guard !UserDefaults.standard.bool(forKey: key) else { return }   // once only

    var req = URLRequest(url: URL(string: "\(trackrBase)/api/attribute/ios")!)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    // Send the same UA the click carried so the server can match it.
    let ua = "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)"
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["ua": ua])

    URLSession.shared.dataTask(with: req) { data, _, _ in
        UserDefaults.standard.set(true, forKey: key)
        guard let data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["attributed"] as? Bool == true else { return }

        // Matched. The dashboard now counts this install under its alias.
        if let path = json["deep_link_path"] as? String, !path.isEmpty {
            DispatchQueue.main.async { route(to: path) }   // deferred deep link, optional
        }
    }.resume()
}
```

Call `checkDeferredAttribution()` from `application(_:didFinishLaunchingWithOptions:)`
or your SwiftUI `App` init.

## Improving the match rate
- The match keys on the **public IP** of the click vs. the install. On cellular,
  iOS often keeps the same IP for a while → good match. On Wi-Fi behind shared
  NAT, several devices share an IP → weaker match (the server takes the most
  recent unmatched click, so call this promptly on first launch).
- For installs where the user already had the app, use **Universal Links** for
  direct (non-deferred) deep linking — that path is exact and unrelated to this.

## Tuning the window
The 24-hour matching window lives in `server.js` as `IOS_MATCH_WINDOW_MS`.
Shorter window = fewer false matches but more misses; longer = the reverse.
