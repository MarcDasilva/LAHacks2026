import Foundation
#if canImport(ZeticMLange)
import ZeticMLange
#endif

struct MemoryLLMProbeResult: Sendable {
    let success: Bool
    let status: String
    let response: String
}

actor ZeticMemoryAnswerService {
    private let settings: InferenceModelSettings
    #if canImport(ZeticMLange)
    private var model: ZeticMLangeLLMModel?
    #endif

    init(settings: InferenceModelSettings = .fromEnvironment()) {
        self.settings = settings
    }

    func runLaunchTest() async -> MemoryLLMProbeResult {
        guard settings.memoryLLMEnabled else {
            return MemoryLLMProbeResult(
                success: false,
                status: "Memory LLM launch test skipped: LLM disabled.",
                response: "LLM disabled"
            )
        }
        guard !settings.personalKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return MemoryLLMProbeResult(
                success: false,
                status: "Memory LLM launch test skipped: missing personal key.",
                response: "Missing personal key"
            )
        }

        #if canImport(ZeticMLange)
        do {
            let response = try run(prompt: Self.makeLaunchTestPrompt())
            let cleaned = Self.normalizeOutput(response)
            guard !cleaned.isEmpty else {
                return MemoryLLMProbeResult(
                    success: false,
                    status: "Memory LLM launch test failed: empty response.",
                    response: "Empty response"
                )
            }

            let expected = "memory llm launch test ready"
            let success = cleaned.caseInsensitiveCompare(expected) == .orderedSame
            return MemoryLLMProbeResult(
                success: success,
                status: success ? "Memory LLM launch test passed." : "Memory LLM launch test responded, but not with the expected phrase.",
                response: cleaned
            )
        } catch {
            return MemoryLLMProbeResult(
                success: false,
                status: "Memory LLM launch test failed: \((error as NSError).localizedDescription)",
                response: "Launch test failed"
            )
        }
        #else
        return MemoryLLMProbeResult(
            success: false,
            status: "Memory LLM launch test unavailable: ZeticMLange not linked.",
            response: "ZeticMLange unavailable"
        )
        #endif
    }

    func summarize(query: String, fallback: MemorySearchAnswer) async -> MemorySearchAnswer {
        guard !fallback.consolidatedResults.isEmpty else {
            print("[Responder][MemoryLLM][DEFAULT] No relevant memory results. Attempting fallback enhancement.")
            return await summarizeDefaultFallback(query: query)
        }
        guard settings.memoryLLMEnabled else { return fallback }
        guard !settings.personalKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return fallback }

        #if canImport(ZeticMLange)
        do {
            let prompt = Self.makePrompt(
                query: query,
                results: Array(fallback.consolidatedResults.prefix(settings.memoryLLMMaxMemories)),
                maxAnswerWords: settings.memoryLLMMaxAnswerWords,
                defaultFallbackMessage: settings.memoryDefaultFallbackMessage
            )
            let summary = try run(prompt: prompt)
            guard !summary.isEmpty else { return fallback }

            return MemorySearchAnswer(
                summaryText: summary,
                spokenText: summary,
                consolidatedResults: fallback.consolidatedResults
            )
        } catch {
            print("[Responder][MemoryLLM][ERROR] \(error.localizedDescription)")
            return fallback
        }
        #else
        return fallback
        #endif
    }

    #if canImport(ZeticMLange)
    private func loadModel() throws -> ZeticMLangeLLMModel {
        if let model {
            return model
        }

        print("[Responder][MemoryLLM] Loading model=\(settings.memoryLLMModelName)")
        let loadedModel = try ZeticMLangeLLMModel(
            personalKey: settings.personalKey,
            name: settings.memoryLLMModelName,
            version: settings.memoryLLMModelVersion,
            modelMode: Self.modelMode(from: settings.modelMode),
            onDownload: { progress in
                let percent = Int(progress * 100)
                print("[Responder][MemoryLLM] Download progress \(percent)%")
            }
        )
        model = loadedModel
        return loadedModel
    }

    private static func modelMode(from rawValue: String) -> LLMModelMode {
        switch rawValue.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() {
        case "RUN_SPEED":
            return .RUN_SPEED
        case "RUN_ACCURACY":
            return .RUN_ACCURACY
        default:
            return .RUN_AUTO
        }
    }

    private func run(prompt: String) throws -> String {
        let llm = try loadModel()
        _ = try llm.run(prompt)

        var buffer = ""
        while true {
            let waitResult = llm.waitForNextToken()
            if waitResult.generatedTokens == 0 || waitResult.isFinished {
                break
            }
            buffer.append(waitResult.token)
        }

        return Self.normalizeOutput(buffer)
    }
    #endif

    private func summarizeDefaultFallback(query: String) async -> MemorySearchAnswer {
        guard settings.memoryLLMEnabled else {
            print("[Responder][MemoryLLM][DEFAULT] LLM disabled. Using raw fallback message.")
            return Self.defaultFallbackAnswer(message: settings.memoryDefaultFallbackMessage)
        }
        guard !settings.personalKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            print("[Responder][MemoryLLM][DEFAULT] Missing personal key. Using raw fallback message.")
            return Self.defaultFallbackAnswer(message: settings.memoryDefaultFallbackMessage)
        }

        #if canImport(ZeticMLange)
        do {
            let maxWords = min(settings.memoryLLMMaxAnswerWords, 18)
            let prompt = Self.makeDefaultPrompt(
                query: query,
                defaultFallbackMessage: settings.memoryDefaultFallbackMessage,
                maxAnswerWords: maxWords
            )
            let summary = try run(prompt: prompt)
            guard !summary.isEmpty, Self.wordCount(summary) <= maxWords else {
                print("[Responder][MemoryLLM][DEFAULT] Enhancement rejected. summary='\(summary)' maxWords=\(maxWords). Using raw fallback message.")
                return Self.defaultFallbackAnswer(message: settings.memoryDefaultFallbackMessage)
            }
            print("[Responder][MemoryLLM][DEFAULT] Enhancement accepted. summary='\(summary)'")

            return MemorySearchAnswer(
                summaryText: summary,
                spokenText: summary,
                consolidatedResults: []
            )
        } catch {
            print("[Responder][MemoryLLM][DEFAULT][ERROR] \(error.localizedDescription)")
            return Self.defaultFallbackAnswer(message: settings.memoryDefaultFallbackMessage)
        }
        #else
        print("[Responder][MemoryLLM][DEFAULT] ZeticMLange unavailable. Using raw fallback message.")
        return Self.defaultFallbackAnswer(message: settings.memoryDefaultFallbackMessage)
        #endif
    }

    private static func makePrompt(
        query: String,
        results: [ConsolidatedMemoryResult],
        maxAnswerWords: Int,
        defaultFallbackMessage: String
    ) -> String {
        let evidence = results.enumerated().map { index, result in
            [
                "Memory \(index + 1):",
                "time: \(result.timeRangeLabel)",
                "camera: \(result.cameraName)",
                "where: \(result.bestWhereAnswer)",
                "seen: \(orPlaceholder(result.detectionSummary))",
                "heard: \(orPlaceholder(result.transcriptSummary))",
                "sound: \(orPlaceholder(result.audioSummary))",
                "occurrences: \(result.occurrenceCount)"
            ]
            .joined(separator: "\n")
        }
        .joined(separator: "\n\n")

        return """
        You are summarizing retrieved camera memories for a user query.
        Answer in plain English with no markdown, no bullet points, and no JSON.
        Use only the evidence provided below. Do not invent details.
        If the retrieved memories are not relevant enough to answer the user query, respond exactly with: \(defaultFallbackMessage)
        Mention when it happened and where the person or object appeared in the image if that information exists.
        Keep the answer under \(maxAnswerWords) words and make it sound natural for text to speech.

        User query: \(query)

        Retrieved memories:
        \(evidence)
        """
    }

    private static func makeLaunchTestPrompt() -> String {
        """
        Reply with exactly this phrase and nothing else:
        memory llm launch test ready
        """
    }

    private static func makeDefaultPrompt(
        query: String,
        defaultFallbackMessage: String,
        maxAnswerWords: Int
    ) -> String {
        """
        You are rewriting a fallback response for text to speech.
        No relevant memories were found for this query.
        Rewrite the fallback message below as one short, natural, friendly sentence.
        Keep the same meaning as the fallback message.
        Do not mention databases, vectors, embeddings, or missing search results.
        Use plain English with no markdown, no bullet points, and no JSON.
        Keep it under \(maxAnswerWords) words.

        User query: \(query)
        Fallback message: \(defaultFallbackMessage)
        """
    }

    private static func orPlaceholder(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "none" : trimmed
    }

    private static func defaultFallbackAnswer(message: String) -> MemorySearchAnswer {
        let cleaned = sanitizeModelOutput(message)
        let fallback = cleaned.isEmpty ? "default" : cleaned
        return MemorySearchAnswer(
            summaryText: fallback,
            spokenText: fallback,
            consolidatedResults: []
        )
    }

    static func sanitizeModelOutput(_ text: String) -> String {
        text
            .replacingOccurrences(of: "(?is)<think>.*?</think>", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "(?is)<analysis>.*?</analysis>", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "(?is)<reasoning>.*?</reasoning>", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "<\\|[^>]+\\|>", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\r", with: " ")
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: CharacterSet(charactersIn: "\"' ").union(.whitespacesAndNewlines))
    }

    private static func normalizeOutput(_ text: String) -> String {
        sanitizeModelOutput(text)
    }

    private static func wordCount(_ text: String) -> Int {
        normalizeOutput(text)
            .split(whereSeparator: \.isWhitespace)
            .count
    }

}
