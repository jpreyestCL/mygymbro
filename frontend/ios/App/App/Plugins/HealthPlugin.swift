import Foundation
import Capacitor
import HealthKit

/// Body weight, shared with Apple Health.
///
/// This is the feature that makes the app worth installing rather than bookmarking: a weight
/// logged on a bathroom scale that writes to Health shows up here without being retyped, and
/// a weigh-in taken before a workout goes back the other way. A web page cannot do it at all,
/// which is also the honest answer to App Review's "why is this not just your website".
///
/// Deliberately narrow: body mass only. HealthKit will happily grant workouts, heart rate and
/// more, and every extra type is another permission prompt to justify and another privacy
/// disclosure to make. Ask for the one thing the app actually uses.
@objc(HealthPlugin)
public class HealthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HealthPlugin"
    public let jsName = "Health"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readBodyWeight", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeBodyWeight", returnType: CAPPluginReturnPromise)
    ]

    private let store = HKHealthStore()
    private var bodyMass: HKQuantityType { HKQuantityType(.bodyMass) }

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": HKHealthStore.isHealthDataAvailable()])
    }

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.resolve(["granted": false, "reason": "unavailable"]); return
        }
        store.requestAuthorization(toShare: [bodyMass], read: [bodyMass]) { ok, err in
            if let err = err { call.reject(err.localizedDescription); return }
            // `ok` only means the sheet was answered. HealthKit deliberately never reveals
            // whether READ access was granted — that would leak the fact that a user has data
            // they chose not to share — so a read returning nothing is not an error, and the
            // UI must not present it as one.
            call.resolve(["granted": ok])
        }
    }

    /// Samples newest-first, as { date (ISO-8601), kg }.
    @objc func readBodyWeight(_ call: CAPPluginCall) {
        let limit = call.getInt("limit") ?? 400
        var predicate: NSPredicate?
        if let sinceISO = call.getString("since"), let since = ISO8601DateFormatter().date(from: sinceISO) {
            predicate = HKQuery.predicateForSamples(withStart: since, end: nil, options: .strictStartDate)
        }
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
        let query = HKSampleQuery(sampleType: bodyMass, predicate: predicate, limit: limit, sortDescriptors: [sort]) { _, samples, err in
            if let err = err { call.reject(err.localizedDescription); return }
            let iso = ISO8601DateFormatter()
            let out: [[String: Any]] = (samples as? [HKQuantitySample] ?? []).map { s in
                [
                    "date": iso.string(from: s.startDate),
                    // Always kilograms across the bridge. The app converts for display; a unit
                    // that changes with the phone's locale would silently rewrite a log.
                    "kg": s.quantity.doubleValue(for: .gramUnit(with: .kilo)),
                    "source": s.sourceRevision.source.name
                ]
            }
            call.resolve(["samples": out])
        }
        store.execute(query)
    }

    @objc func writeBodyWeight(_ call: CAPPluginCall) {
        guard let kg = call.getDouble("kg"), kg > 0 else {
            call.reject("kg is required"); return
        }
        let when = call.getString("date").flatMap { ISO8601DateFormatter().date(from: $0) } ?? Date()
        let quantity = HKQuantity(unit: .gramUnit(with: .kilo), doubleValue: kg)
        // Marked as entered by hand, because it was. Health treats typed and measured values
        // differently in its own charts, and claiming otherwise would pollute the user's data.
        let sample = HKQuantitySample(
            type: bodyMass, quantity: quantity, start: when, end: when,
            metadata: [HKMetadataKeyWasUserEntered: true]
        )
        store.save(sample) { ok, err in
            if let err = err { call.reject(err.localizedDescription); return }
            call.resolve(["saved": ok])
        }
    }
}
