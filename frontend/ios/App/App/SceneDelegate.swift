import UIKit
import Capacitor

// iOS 27 refuses to launch an app built with its SDK unless it adopts the UIScene life cycle
// (Apple TN3187): without a scene manifest the process dies before the first frame, which is
// what the app did on every phone the moment it updated. The window itself still comes from
// Main.storyboard — the manifest names it as the scene's storyboard — so this file only has
// to carry what UIKit stopped delivering to the app delegate once scenes are on: URL opens
// and continued user activities. Both go to Capacitor's proxy exactly as AppDelegate used to
// send them, because that is where the App plugin and Google's sign-in callback listen.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        // A cold launch from a link arrives here rather than in openURLContexts. Forwarding it
        // now lets the proxy remember it, which is what App.getLaunchUrl() reads later.
        connectionOptions.urlContexts.forEach(openURL)
        connectionOptions.userActivities.forEach(continueActivity)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        URLContexts.forEach(openURL)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        continueActivity(userActivity)
    }

    private func openURL(_ context: UIOpenURLContext) {
        var options: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: context.options.openInPlace]
        if let source = context.options.sourceApplication { options[.sourceApplication] = source }
        if let annotation = context.options.annotation { options[.annotation] = annotation }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: context.url, options: options)
    }

    private func continueActivity(_ activity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
    }
}
