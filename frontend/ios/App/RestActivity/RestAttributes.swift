import Foundation
import ActivityKit

/// Shared between the app and its widget extension: both targets compile this file, and the
/// two copies must agree exactly or the system drops the activity without an error.
///
/// The countdown is NOT a number we push every second. `endsAt` is sent once and the system
/// renders the remaining time itself, which is why the timer stays accurate on the Lock
/// Screen with the app suspended — and why a rest timer belongs here rather than in a
/// notification. Live Activities are also rate-limited on updates; a per-second push would be
/// throttled away within a minute.
struct RestAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var endsAt: Date
        var exercise: String
        var setsDone: Int
        var setsTotal: Int
    }

    var workoutName: String
}
