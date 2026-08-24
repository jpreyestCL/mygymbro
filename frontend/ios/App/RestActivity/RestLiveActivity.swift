import SwiftUI
import WidgetKit
import ActivityKit

/// Rest timer on the Lock Screen and in the Dynamic Island.
///
/// The problem it solves is the one the README already complains about: between sets you put
/// the phone down, and to know when to lift again you have to unlock it and find your place.
/// A glance at the Lock Screen is the whole feature.
@main
struct RestActivityBundle: WidgetBundle {
    var body: some Widget { RestLiveActivity() }
}

struct RestLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RestAttributes.self) { context in
            // Lock Screen / banner
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(context.attributes.workoutName)
                        .font(.caption).foregroundStyle(.secondary)
                    Text(context.state.exercise)
                        .font(.headline).lineLimit(1)
                    Text("\(context.state.setsDone)/\(context.state.setsTotal) sets")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                // .timer counts down on its own, with no updates from the app.
                Text(timerInterval: Date()...context.state.endsAt, countsDown: true)
                    .font(.system(.title, design: .rounded).weight(.semibold))
                    .monospacedDigit()
                    .frame(minWidth: 78)
            }
            .padding(.horizontal, 18).padding(.vertical, 14)
            .activityBackgroundTint(Color.black.opacity(0.55))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label(context.state.exercise, systemImage: "dumbbell.fill")
                        .font(.caption).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(timerInterval: Date()...context.state.endsAt, countsDown: true)
                        .font(.system(.body, design: .rounded).weight(.semibold))
                        .monospacedDigit().frame(minWidth: 56)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text("\(context.state.setsDone) of \(context.state.setsTotal) sets done")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            } compactLeading: {
                Image(systemName: "dumbbell.fill")
            } compactTrailing: {
                Text(timerInterval: Date()...context.state.endsAt, countsDown: true)
                    .monospacedDigit().frame(maxWidth: 44)
            } minimal: {
                Image(systemName: "dumbbell.fill")
            }
        }
    }
}
