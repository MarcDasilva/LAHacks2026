import CoreGraphics
import Foundation
import NaturalLanguage
import SQLiteVec

struct MemorySearchResult: Identifiable, Sendable {
    let id: Int
    let semanticDistance: Double
    let startedAt: Date
    let endedAt: Date
    let cameraName: String
    let locationSummary: String
    let detectionText: String
    let transcriptText: String
    let audioText: String
    let searchText: String

    var timeRangeLabel: String {
        let start = startedAt.formatted(date: .omitted, time: .standard)
        let end = endedAt.formatted(date: .omitted, time: .standard)
        if Calendar.current.isDate(startedAt, equalTo: endedAt, toGranularity: .second) {
            return start
        }
        return "\(start) - \(end)"
    }

    var bestWhereAnswer: String {
        if locationSummary.isEmpty {
            return cameraName
        }
        return "\(cameraName), \(locationSummary)"
    }
}

struct ConsolidatedMemoryResult: Identifiable, Sendable {
    let id: String
    let startedAt: Date
    let endedAt: Date
    let cameraName: String
    let whereSummary: String
    let detectionSummary: String
    let transcriptSummary: String
    let audioSummary: String
    let occurrenceCount: Int
    let bestDistance: Double

    var timeRangeLabel: String {
        let formatterDate: Date.FormatStyle.DateStyle = Calendar.current.isDateInToday(startedAt) ? .omitted : .abbreviated
        let start = startedAt.formatted(date: formatterDate, time: .shortened)
        let end = endedAt.formatted(date: formatterDate, time: .shortened)
        if Calendar.current.isDate(startedAt, equalTo: endedAt, toGranularity: .minute) {
            return start
        }
        return "\(start) - \(end)"
    }

    var bestWhereAnswer: String {
        if whereSummary.isEmpty {
            return cameraName
        }
        return "\(cameraName), \(whereSummary)"
    }
}

struct MemorySearchAnswer: Sendable {
    let summaryText: String
    let spokenText: String
    let consolidatedResults: [ConsolidatedMemoryResult]
}

struct MemoryIndexSnapshot: Sendable {
    let indexedCount: Int
    let promptCount: Int
    let databasePath: String
    let vectorVersion: String
    let latestSummary: String
    let latestPromptPreview: String
}

enum MemorySearchSummarizer {
    static func relevantResults(_ results: [MemorySearchResult], maxDistance: Double) -> [MemorySearchResult] {
        guard let best = results.min(by: { $0.semanticDistance < $1.semanticDistance }) else {
            return []
        }
        guard best.semanticDistance <= maxDistance else {
            return []
        }
        return results.filter { $0.semanticDistance <= maxDistance }
    }

    static func makeAnswer(
        for query: String,
        results: [MemorySearchResult],
        defaultFallbackMessage: String
    ) -> MemorySearchAnswer {
        let consolidated = consolidate(results)
        guard let strongest = consolidated.first else {
            return MemorySearchAnswer(
                summaryText: defaultFallbackMessage,
                spokenText: defaultFallbackMessage,
                consolidatedResults: []
            )
        }

        let strongestSeen = strongest.detectionSummary.isEmpty ? "I did not capture a visual object label for it." : "I saw \(strongest.detectionSummary)."
        let strongestWhere = strongest.bestWhereAnswer
        let strongestWhen = strongest.startedAt.formatted(date: .abbreviated, time: .shortened)

        var summaryParts = [
            "I found \(consolidated.count) consolidated \(consolidated.count == 1 ? "memory" : "memories") for \"\(query)\".",
            "Best match: \(strongestWhen) on \(strongestWhere).",
            strongestSeen
        ]

        if !strongest.transcriptSummary.isEmpty {
            summaryParts.append("I heard: \(strongest.transcriptSummary).")
        }
        if !strongest.audioSummary.isEmpty {
            summaryParts.append("Ambient sound: \(strongest.audioSummary).")
        }
        if consolidated.count > 1 {
            let extra = consolidated
                .dropFirst()
                .prefix(2)
                .map { "\($0.startedAt.formatted(date: .abbreviated, time: .shortened)) at \($0.bestWhereAnswer)" }
                .joined(separator: "; ")
            if !extra.isEmpty {
                summaryParts.append("Other similar memories: \(extra).")
            }
        }

        var spokenParts = [
            "I found \(consolidated.count) matching \(consolidated.count == 1 ? "memory" : "memories").",
            "Best match was \(strongestWhen) on \(strongestWhere).",
        ]
        if !strongest.detectionSummary.isEmpty {
            spokenParts.append("I saw \(strongest.detectionSummary).")
        }
        if !strongest.transcriptSummary.isEmpty {
            spokenParts.append("I heard \(strongest.transcriptSummary).")
        }

        return MemorySearchAnswer(
            summaryText: summaryParts.joined(separator: " "),
            spokenText: spokenParts.joined(separator: " "),
            consolidatedResults: consolidated
        )
    }

    private static func consolidate(_ results: [MemorySearchResult]) -> [ConsolidatedMemoryResult] {
        let sorted = results.sorted {
            if $0.semanticDistance == $1.semanticDistance {
                return $0.startedAt < $1.startedAt
            }
            return $0.semanticDistance < $1.semanticDistance
        }

        var groups: [[MemorySearchResult]] = []
        for result in sorted {
            if var lastGroup = groups.last, shouldMerge(result, into: lastGroup) {
                lastGroup.append(result)
                groups[groups.count - 1] = lastGroup
            } else {
                groups.append([result])
            }
        }

        return groups.map { group in
            let ordered = group.sorted { $0.startedAt < $1.startedAt }
            let first = ordered.first!
            let last = ordered.last!
            return ConsolidatedMemoryResult(
                id: ordered.map { String($0.id) }.joined(separator: "-"),
                startedAt: first.startedAt,
                endedAt: last.endedAt,
                cameraName: first.cameraName,
                whereSummary: mergedSummary(ordered.map(\.locationSummary)),
                detectionSummary: mergedSummary(ordered.map(\.detectionText)),
                transcriptSummary: mergedSummary(ordered.map(\.transcriptText)),
                audioSummary: mergedSummary(ordered.map(\.audioText)),
                occurrenceCount: ordered.count,
                bestDistance: ordered.map(\.semanticDistance).min() ?? first.semanticDistance
            )
        }
    }

    private static func shouldMerge(_ candidate: MemorySearchResult, into group: [MemorySearchResult]) -> Bool {
        guard let last = group.max(by: { $0.endedAt < $1.endedAt }) else { return false }
        guard candidate.cameraName == last.cameraName else { return false }

        let gap = abs(candidate.startedAt.timeIntervalSince(last.endedAt))
        let sameWhere = normalizedLocation(candidate.locationSummary) == normalizedLocation(last.locationSummary)
        let sameSubject = normalizedSubject(candidate) == normalizedSubject(last)

        return gap <= 30 && (sameWhere || sameSubject)
    }

    private static func normalizedLocation(_ location: String) -> String {
        location
            .split(separator: ",")
            .first
            .map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""
    }

    private static func normalizedSubject(_ result: MemorySearchResult) -> String {
        if let fromLocation = result.locationSummary
            .split(separator: ",")
            .first
            .map(String.init)?
            .components(separatedBy: " at ")
            .first {
            let text = fromLocation.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if !text.isEmpty { return text }
        }

        if let fromDetection = result.detectionText
            .split(separator: ",")
            .first?
            .split(separator: " ")
            .first {
            let text = String(fromDetection).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if !text.isEmpty { return text }
        }

        return result.cameraName.lowercased()
    }

    private static func mergedSummary(_ values: [String]) -> String {
        var unique: [String] = []
        for value in values {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            if !unique.contains(where: { $0.caseInsensitiveCompare(trimmed) == .orderedSame }) {
                unique.append(trimmed)
            }
        }
        return unique.joined(separator: ". ")
    }
}

private struct PendingMemoryMoment: Sendable {
    let bucketKey: String
    let sessionID: String
    let cameraName: String
    var startedAt: Date
    var endedAt: Date
    var transcriptText: String = ""
    var detectionText: String = ""
    var audioText: String = ""
    var locationSummary: String = ""

    var searchText: String {
        [
            transcriptText,
            detectionText,
            audioText,
            locationSummary,
            cameraName
        ]
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
        .joined(separator: ". ")
    }

    var latestSummary: String {
        let seen = detectionText.isEmpty ? "No object summary yet" : detectionText
        let whereText = locationSummary.isEmpty ? cameraName : "\(cameraName), \(locationSummary)"
        return "\(whereText) | \(seen)"
    }
}

private struct MemoryLocationDescriptor {
    static func summarize(_ boxes: [DetectedBoundingBox]) -> String {
        let prominent = boxes
            .sorted { lhs, rhs in
                if lhs.confidence == rhs.confidence {
                    return lhs.label < rhs.label
                }
                return lhs.confidence > rhs.confidence
            }
            .prefix(3)

        guard !prominent.isEmpty else { return "" }

        return prominent.map { box in
            "\(box.label) at \(regionDescription(for: box.rect))"
        }
        .joined(separator: ", ")
    }

    private static func regionDescription(for rect: CGRect) -> String {
        let x = rect.midX
        let y = rect.midY

        let horizontal: String
        switch x {
        case ..<0.33:
            horizontal = "left"
        case 0.66...:
            horizontal = "right"
        default:
            horizontal = "center"
        }

        let vertical: String
        switch y {
        case ..<0.33:
            vertical = "top"
        case 0.66...:
            vertical = "bottom"
        default:
            vertical = "middle"
        }

        if horizontal == "center", vertical == "middle" {
            return "center"
        }
        if horizontal == "center" {
            return "\(vertical) center"
        }
        if vertical == "middle" {
            return "center \(horizontal)"
        }
        return "\(vertical) \(horizontal)"
    }
}

private final class OnDeviceSentenceEmbedder {
    private let embedding: NLEmbedding

    init(language: NLLanguage = .english) throws {
        guard let embedding = NLEmbedding.sentenceEmbedding(for: language) else {
            throw NSError(
                domain: "Responder.Memory",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Unable to load the on-device English sentence embedding model."]
            )
        }
        self.embedding = embedding
    }

    var dimension: Int {
        embedding.dimension
    }

    func vector(for text: String) -> [Float]? {
        let normalized = text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\n", with: " ")

        guard !normalized.isEmpty,
              let vector = embedding.vector(for: normalized)
        else {
            return nil
        }

        return vector.map(Float.init)
    }
}

actor OnDeviceMemoryIndex {
    private static let memoryWindowSeconds: TimeInterval = 8
    private static let schemaVersion = 1

    private let cameraName: String
    private let embedder: OnDeviceSentenceEmbedder
    private let databaseURL: URL
    private let databasePath: String

    private var database: Database
    private var isPrepared = false
    private var pendingMoments: [String: PendingMemoryMoment] = [:]

    init(cameraName: String = "Rear Camera") throws {
        self.cameraName = cameraName
        self.embedder = try OnDeviceSentenceEmbedder()

        try SQLiteVec.initialize()

        let databaseURL = try Self.databaseURL()
        self.databaseURL = databaseURL
        self.databasePath = databaseURL.path
        self.database = try Database(.uri(databaseURL.path))
    }

    func prepare() async throws -> MemoryIndexSnapshot {
        try await prepareIfNeeded()
        return try await snapshot(latestSummary: "On-device memory index ready")
    }

    func ingestVision(_ payload: TranscriptChunk, boxes: [DetectedBoundingBox]) async throws -> MemoryIndexSnapshot {
        try await prepareIfNeeded()

        var moment = loadMoment(for: payload)
        moment.startedAt = min(moment.startedAt, payload.chunk.startedAt)
        moment.endedAt = max(moment.endedAt, payload.chunk.endedAt)
        moment.detectionText = mergeUnique(moment.detectionText, with: sanitized(payload.output.text))
        moment.locationSummary = mergeUnique(moment.locationSummary, with: MemoryLocationDescriptor.summarize(boxes))

        pendingMoments[moment.bucketKey] = moment
        try await upsert(moment: moment)
        return try await snapshot(latestSummary: moment.latestSummary)
    }

    func ingestTranscript(_ payload: TranscriptChunk) async throws -> MemoryIndexSnapshot {
        try await prepareIfNeeded()

        var moment = loadMoment(for: payload)
        moment.startedAt = min(moment.startedAt, payload.chunk.startedAt)
        moment.endedAt = max(moment.endedAt, payload.chunk.endedAt)
        moment.transcriptText = mergeUnique(moment.transcriptText, with: sanitized(payload.output.text))

        pendingMoments[moment.bucketKey] = moment
        try await upsert(moment: moment)
        return try await snapshot(latestSummary: moment.latestSummary)
    }

    func ingestAudioClassification(_ payload: TranscriptChunk) async throws -> MemoryIndexSnapshot {
        try await prepareIfNeeded()

        var moment = loadMoment(for: payload)
        moment.startedAt = min(moment.startedAt, payload.chunk.startedAt)
        moment.endedAt = max(moment.endedAt, payload.chunk.endedAt)
        moment.audioText = mergeUnique(moment.audioText, with: sanitized(payload.output.text))

        pendingMoments[moment.bucketKey] = moment
        try await upsert(moment: moment)
        return try await snapshot(latestSummary: moment.latestSummary)
    }

    func search(_ query: String, limit: Int = 6) async throws -> [MemorySearchResult] {
        try await prepareIfNeeded()

        let normalized = sanitized(query)
        guard !normalized.isEmpty else { return [] }

        if let queryVector = embedder.vector(for: normalized) {
            let rowLimit = min(max(limit, 1), 12)
            let rows = try await database.query(
                """
                SELECT
                    m.id,
                    m.started_at,
                    m.ended_at,
                    m.camera_name,
                    m.location_summary,
                    m.detection_text,
                    m.transcript_text,
                    m.audio_text,
                    m.search_text,
                    e.distance
                FROM (
                    SELECT
                        rowid,
                        distance
                    FROM memory_embeddings
                    WHERE embedding MATCH ? AND k = ?
                ) e
                JOIN memories m ON m.id = e.rowid
                ORDER BY e.distance ASC
                """,
                params: [queryVector, rowLimit]
            )

            if !rows.isEmpty {
                return rows.compactMap(Self.makeSearchResult)
            }
        }

        let lexicalRows = try await database.query(
            """
            SELECT
                id,
                started_at,
                ended_at,
                camera_name,
                location_summary,
                detection_text,
                transcript_text,
                audio_text,
                search_text,
                999.0 AS distance
            FROM memories
            WHERE lower(search_text) LIKE lower(?)
            ORDER BY started_at DESC
            LIMIT \(min(max(limit, 1), 12))
            """,
            params: ["%\(normalized)%"]
        )

        return lexicalRows.compactMap(Self.makeSearchResult)
    }

    func clearAllMemories() async throws -> MemoryIndexSnapshot {
        try await recreateDatabase()
        try await prepareSchema()
        isPrepared = true
        return try await snapshot(latestSummary: "Local memory database cleared")
    }

    func saveLLMPrompt(_ promptText: String, startedAt: Date, endedAt: Date) async throws -> MemoryIndexSnapshot {
        try await prepareIfNeeded()

        let cleanedPrompt = sanitizedPrompt(promptText)
        guard !cleanedPrompt.isEmpty else {
            return try await snapshot(latestSummary: "Voice prompt was empty")
        }

        let now = Date().timeIntervalSince1970
        try await database.execute(
            """
            INSERT INTO llm_prompts (
                prompt_text,
                started_at,
                ended_at,
                created_at
            ) VALUES (?, ?, ?, ?)
            """,
            params: [
                cleanedPrompt,
                startedAt.timeIntervalSince1970,
                endedAt.timeIntervalSince1970,
                now
            ]
        )

        return try await snapshot(latestSummary: "Saved voice prompt locally")
    }

    private func prepareIfNeeded() async throws {
        guard !isPrepared else { return }

        do {
            try await prepareSchema()
            isPrepared = true
        } catch {
            let existingTables = try await database.query(
                """
                SELECT name
                FROM sqlite_master
                WHERE type IN ('table', 'view')
                  AND name IN ('memories', 'memory_embeddings')
                """
            )

            guard !existingTables.isEmpty else {
                throw error
            }

            try await recreateDatabase()
            try await prepareSchema()
            isPrepared = true
        }
    }

    private func prepareSchema() async throws {
        try await database.execute("PRAGMA journal_mode = WAL")
        try await database.execute("PRAGMA synchronous = NORMAL")

        let versionRows = try await database.query("PRAGMA user_version")
        let currentVersion = Self.intValue(versionRows.first?["user_version"]) ?? 0
        if currentVersion != Self.schemaVersion {
            let existingTables = try await database.query(
                """
                SELECT name
                FROM sqlite_master
                WHERE type IN ('table', 'view')
                  AND name IN ('memories', 'memory_embeddings')
                """
            )

            if !existingTables.isEmpty {
                try await recreateDatabase()
                try await database.execute("PRAGMA journal_mode = WAL")
                try await database.execute("PRAGMA synchronous = NORMAL")
            }
        }

        try await database.execute(
            """
            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bucket_key TEXT NOT NULL UNIQUE,
                session_id TEXT NOT NULL,
                camera_name TEXT NOT NULL,
                started_at REAL NOT NULL,
                ended_at REAL NOT NULL,
                transcript_text TEXT NOT NULL DEFAULT '',
                detection_text TEXT NOT NULL DEFAULT '',
                audio_text TEXT NOT NULL DEFAULT '',
                location_summary TEXT NOT NULL DEFAULT '',
                search_text TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )
        try await database.execute(
            "CREATE INDEX IF NOT EXISTS idx_memories_started_at ON memories(started_at DESC)"
        )
        try await database.execute(
            """
            CREATE TABLE IF NOT EXISTS llm_prompts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                prompt_text TEXT NOT NULL,
                started_at REAL NOT NULL,
                ended_at REAL NOT NULL,
                created_at REAL NOT NULL
            )
            """
        )
        try await database.execute(
            "CREATE INDEX IF NOT EXISTS idx_llm_prompts_created_at ON llm_prompts(created_at DESC)"
        )

        let vectorTable = try await database.query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_embeddings'"
        )
        if vectorTable.isEmpty {
            try await database.execute(
                "CREATE VIRTUAL TABLE memory_embeddings USING vec0(embedding float[\(embedder.dimension)])"
            )
        }
        try await database.execute("PRAGMA user_version = \(Self.schemaVersion)")
    }

    private func recreateDatabase() async throws {
        isPrepared = false
        pendingMoments.removeAll(keepingCapacity: true)
        database = try Database(.inMemory)

        let fileManager = FileManager.default
        let sidecars = [
            databaseURL,
            databaseURL.appendingPathExtension("wal"),
            databaseURL.appendingPathExtension("shm")
        ]
        for url in sidecars where fileManager.fileExists(atPath: url.path) {
            try fileManager.removeItem(at: url)
        }

        database = try Database(.uri(databaseURL.path))
    }

    private func loadMoment(for payload: TranscriptChunk) -> PendingMemoryMoment {
        let key = bucketKey(for: payload.chunk.startedAt, sessionID: payload.sessionID)
        if let existing = pendingMoments[key] {
            return existing
        }

        return PendingMemoryMoment(
            bucketKey: key,
            sessionID: payload.sessionID,
            cameraName: cameraName,
            startedAt: payload.chunk.startedAt,
            endedAt: payload.chunk.endedAt
        )
    }

    private func bucketKey(for date: Date, sessionID: String) -> String {
        let seconds = Int(date.timeIntervalSince1970 / Self.memoryWindowSeconds) * Int(Self.memoryWindowSeconds)
        return "\(sessionID)-\(seconds)"
    }

    private func upsert(moment: PendingMemoryMoment) async throws {
        let searchText = moment.searchText
        guard let vector = embedder.vector(for: searchText) else { return }

        let now = Date().timeIntervalSince1970
        let existingRows = try await database.query(
            "SELECT id, created_at FROM memories WHERE bucket_key = ? LIMIT 1",
            params: [moment.bucketKey]
        )

        let memoryID: Int
        if let row = existingRows.first, let existingID = Self.intValue(row["id"]) {
            let createdAt = Self.doubleValue(row["created_at"]) ?? now
            try await database.execute(
                """
                UPDATE memories
                SET
                    session_id = ?,
                    camera_name = ?,
                    started_at = ?,
                    ended_at = ?,
                    transcript_text = ?,
                    detection_text = ?,
                    audio_text = ?,
                    location_summary = ?,
                    search_text = ?,
                    created_at = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                params: [
                    moment.sessionID,
                    moment.cameraName,
                    moment.startedAt.timeIntervalSince1970,
                    moment.endedAt.timeIntervalSince1970,
                    moment.transcriptText,
                    moment.detectionText,
                    moment.audioText,
                    moment.locationSummary,
                    searchText,
                    createdAt,
                    now,
                    existingID
                ]
            )
            memoryID = existingID
        } else {
            try await database.execute(
                """
                INSERT INTO memories (
                    bucket_key,
                    session_id,
                    camera_name,
                    started_at,
                    ended_at,
                    transcript_text,
                    detection_text,
                    audio_text,
                    location_summary,
                    search_text,
                    created_at,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                params: [
                    moment.bucketKey,
                    moment.sessionID,
                    moment.cameraName,
                    moment.startedAt.timeIntervalSince1970,
                    moment.endedAt.timeIntervalSince1970,
                    moment.transcriptText,
                    moment.detectionText,
                    moment.audioText,
                    moment.locationSummary,
                    searchText,
                    now,
                    now
                ]
            )
            memoryID = await database.lastInsertRowId
        }

        try await database.execute("DELETE FROM memory_embeddings WHERE rowid = ?", params: [memoryID])
        try await database.execute(
            "INSERT INTO memory_embeddings(rowid, embedding) VALUES (?, ?)",
            params: [memoryID, vector]
        )
    }

    private func snapshot(latestSummary: String) async throws -> MemoryIndexSnapshot {
        let countRows = try await database.query("SELECT COUNT(*) AS count FROM memories")
        let indexedCount = Self.intValue(countRows.first?["count"]) ?? 0
        let promptCountRows = try await database.query("SELECT COUNT(*) AS count FROM llm_prompts")
        let promptCount = Self.intValue(promptCountRows.first?["count"]) ?? 0
        let latestPromptRows = try await database.query(
            """
            SELECT prompt_text
            FROM llm_prompts
            ORDER BY created_at DESC
            LIMIT 1
            """
        )
        let vectorVersion = await database.version() ?? "unknown"
        return MemoryIndexSnapshot(
            indexedCount: indexedCount,
            promptCount: promptCount,
            databasePath: databasePath,
            vectorVersion: vectorVersion,
            latestSummary: latestSummary,
            latestPromptPreview: Self.promptPreview(from: Self.stringValue(latestPromptRows.first?["prompt_text"]))
        )
    }

    private func mergeUnique(_ current: String, with addition: String) -> String {
        guard !addition.isEmpty else { return current }
        if current.isEmpty { return addition }
        if current.localizedCaseInsensitiveContains(addition) {
            return current
        }
        return "\(current). \(addition)"
    }

    private func sanitized(_ text: String) -> String {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.hasPrefix("[stt_unavailable]") || cleaned.hasPrefix("[yamnet_unavailable]") {
            return ""
        }
        if cleaned == "Waiting for transcript..." ||
            cleaned == "Waiting for detections..." ||
            cleaned == "Waiting for YAMNet output..." {
            return ""
        }
        return cleaned
    }

    private func sanitizedPrompt(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func promptPreview(from text: String) -> String {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return "No voice prompts saved yet." }
        if cleaned.count <= 120 {
            return cleaned
        }
        let index = cleaned.index(cleaned.startIndex, offsetBy: 120)
        return "\(cleaned[..<index])..."
    }

    private static func databaseURL() throws -> URL {
        guard let baseURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw NSError(
                domain: "Responder.Memory",
                code: -2,
                userInfo: [NSLocalizedDescriptionKey: "Application Support directory is unavailable."]
            )
        }

        let directory = baseURL.appendingPathComponent("ResponderMemory", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("memory.sqlite")
    }

    private static func makeSearchResult(from row: [String: any Sendable]) -> MemorySearchResult? {
        guard
            let id = intValue(row["id"]),
            let startedAt = doubleValue(row["started_at"]),
            let endedAt = doubleValue(row["ended_at"])
        else {
            return nil
        }

        return MemorySearchResult(
            id: id,
            semanticDistance: doubleValue(row["distance"]) ?? 999,
            startedAt: Date(timeIntervalSince1970: startedAt),
            endedAt: Date(timeIntervalSince1970: endedAt),
            cameraName: stringValue(row["camera_name"]),
            locationSummary: stringValue(row["location_summary"]),
            detectionText: stringValue(row["detection_text"]),
            transcriptText: stringValue(row["transcript_text"]),
            audioText: stringValue(row["audio_text"]),
            searchText: stringValue(row["search_text"])
        )
    }

    private static func intValue(_ value: Any?) -> Int? {
        switch value {
        case let value as Int:
            return value
        case let value as Int64:
            return Int(value)
        case let value as Double:
            return Int(value)
        case let value as String:
            return Int(value)
        default:
            return nil
        }
    }

    private static func doubleValue(_ value: Any?) -> Double? {
        switch value {
        case let value as Double:
            return value
        case let value as Float:
            return Double(value)
        case let value as Int:
            return Double(value)
        case let value as Int64:
            return Double(value)
        case let value as String:
            return Double(value)
        default:
            return nil
        }
    }

    private static func stringValue(_ value: Any?) -> String {
        switch value {
        case let value as String:
            return value
        case let value as CustomStringConvertible:
            return value.description
        default:
            return ""
        }
    }
}
