import Foundation
#if canImport(ZeticMLange)
import ZeticMLange
#endif

actor ZeticMemoryAnswerService {
    private let settings: InferenceModelSettings
    #if canImport(ZeticMLange)
    private var model: ZeticMLangeLLMModel?
    #endif

    init(settings: InferenceModelSettings = .fromEnvironment()) {
        self.settings = settings
    }

    func summarize(query: String, fallback: MemorySearchAnswer) async -> MemorySearchAnswer {
        guard settings.memoryLLMEnabled else { return fallback }
        guard !settings.personalKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return fallback }
        guard !fallback.consolidatedResults.isEmpty else { return fallback }

        #if canImport(ZeticMLange)
        do {
            let llm = try loadModel()
            let prompt = Self.makePrompt(
                query: query,
                results: Array(fallback.consolidatedResults.prefix(settings.memoryLLMMaxMemories)),
                maxAnswerWords: settings.memoryLLMMaxAnswerWords
            )
            _ = try llm.run(prompt)

            var buffer = ""
            while true {
                let waitResult = llm.waitForNextToken()
                if waitResult.generatedTokens == 0 || waitResult.isFinished {
                    break
                }
                buffer.append(waitResult.token)
            }

            let summary = Self.normalizeOutput(buffer)
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
    #endif

    private static func makePrompt(
        query: String,
        results: [ConsolidatedMemoryResult],
        maxAnswerWords: Int
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
        Mention when it happened and where the person or object appeared in the image if that information exists.
        Keep the answer under \(maxAnswerWords) words and make it sound natural for text to speech.

        User query: \(query)

        Retrieved memories:
        \(evidence)
        """
    }

    private static func orPlaceholder(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "none" : trimmed
    }

    private static func normalizeOutput(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\r", with: " ")
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: CharacterSet(charactersIn: "\"' ").union(.whitespacesAndNewlines))
    }
}
