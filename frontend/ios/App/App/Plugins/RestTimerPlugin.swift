import Foundation
import Capacitor
import ActivityKit

/// Bridges the app's rest timer to a Live Activity.
///
/// Only `endsAt` and the labels cross the bridge — never a per-second tick. The system owns
/// the countdown (see RestAttributes), so `update` is called when something actually changes:
/// the timer is extended, or the next set starts.
@objc(RestTimerPlugin)
public class RestTimerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RestTimerPlugin"
    public let jsName = "RestTimer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private var activity: Any?

    @objc func isSupported(_ call: CAPPluginCall) {
        if #available(iOS 16.2, *) {
            call.resolve(["supported": ActivityAuthorizationInfo().areActivitiesEnabled])
        } else {
            call.resolve(["supported": false])
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { call.resolve(["started": false]); return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            // Switched off in Settings. Not an error: the in-app timer still runs, and the
            // app must not nag about a permission the user already declined.
            call.resolve(["started": false, "reason": "disabled"]); return
        }
        let seconds = call.getDouble("seconds") ?? 90
        let state = RestAttributes.ContentState(
            endsAt: Date().addingTimeInterval(seconds),
            exercise: call.getString("exercise") ?? "",
            setsDone: call.getInt("setsDone") ?? 0,
            setsTotal: call.getInt("setsTotal") ?? 0
        )
        do {
            // One activity at a time: starting a new rest ends the previous one rather than
            // stacking two countdowns on the Lock Screen.
            endCurrent()
            let a = try Activity.request(
                attributes: RestAttributes(workoutName: call.getString("workout") ?? "Workout"),
                content: .init(state: state, staleDate: state.endsAt.addingTimeInterval(60)),
                pushType: nil
            )
            activity = a
            call.resolve(["started": true, "id": a.id])
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *), let a = activity as? Activity<RestAttributes> else {
            call.resolve(["updated": false]); return
        }
        let seconds = call.getDouble("seconds") ?? 0
        let state = RestAttributes.ContentState(
            endsAt: seconds > 0 ? Date().addingTimeInterval(seconds) : a.content.state.endsAt,
            exercise: call.getString("exercise") ?? a.content.state.exercise,
            setsDone: call.getInt("setsDone") ?? a.content.state.setsDone,
            setsTotal: call.getInt("setsTotal") ?? a.content.state.setsTotal
        )
        Task {
            await a.update(.init(state: state, staleDate: state.endsAt.addingTimeInterval(60)))
            call.resolve(["updated": true])
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        endCurrent()
        call.resolve(["stopped": true])
    }

    private func endCurrent() {
        guard #available(iOS 16.2, *), let a = activity as? Activity<RestAttributes> else { return }
        activity = nil
        // .immediate: the rest is over the moment the user taps the next set. Leaving it to
        // fade would keep a dead countdown on the Lock Screen.
        Task { await a.end(nil, dismissalPolicy: .immediate) }
    }
}
