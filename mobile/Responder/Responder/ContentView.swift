import AVFoundation
import SwiftUI

struct CapturedLLMPrompt: Equatable {
    let text: String
    let startedAt: Date
    let endedAt: Date
}

struct ImpulseVoiceCommandResult {
    let shouldSuppressTranscript: Bool
    let spokenReply: String?
    let captureStatus: String?
    let savedPrompt: CapturedLLMPrompt?
}

struct ImpulseVoiceCommandController {
    static let idleStatus = "Say \"Hello Impulse\" to capture a local LLM prompt until STOP."

    private var isCapturingPrompt = false
    private var capturedPromptText = ""
    private var promptStartedAt: Date?
    private var recentCommandEndedAt: Date?

    mutating func processTranscript(_ rawText: String, startedAt: Date, endedAt: Date) -> ImpulseVoiceCommandResult {
        let cleanedText = Self.normalizedSpacing(rawText)
        guard !cleanedText.isEmpty else {
            return ImpulseVoiceCommandResult(
                shouldSuppressTranscript: isCapturingPrompt,
                spokenReply: nil,
                captureStatus: isCapturingPrompt ? captureStatusText() : nil,
                savedPrompt: nil
            )
        }

        if let recentCommandEndedAt,
           startedAt.timeIntervalSince(recentCommandEndedAt) <= 2.5,
           Self.containsStopKeyword(cleanedText) {
            self.recentCommandEndedAt = nil
            return ImpulseVoiceCommandResult(
                shouldSuppressTranscript: true,
                spokenReply: nil,
                captureStatus: Self.idleStatus,
                savedPrompt: nil
            )
        }

        if isCapturingPrompt {
            return continueCapturing(with: cleanedText, startedAt: startedAt, endedAt: endedAt)
        }

        guard let wakeRange = Self.wakePhraseRange(in: cleanedText) else {
            return ImpulseVoiceCommandResult(
                shouldSuppressTranscript: false,
                spokenReply: nil,
                captureStatus: nil,
                savedPrompt: nil
            )
        }

        isCapturingPrompt = true
        promptStartedAt = startedAt
        capturedPromptText = ""

        let remainder = Self.normalizedSpacing(String(cleanedText[wakeRange.upperBound...]))
        if remainder.isEmpty {
            return ImpulseVoiceCommandResult(
                shouldSuppressTranscript: true,
                spokenReply: "Yes?",
                captureStatus: captureStatusText(),
                savedPrompt: nil
            )
        }

        let captureResult = continueCapturing(with: remainder, startedAt: startedAt, endedAt: endedAt)
        return ImpulseVoiceCommandResult(
            shouldSuppressTranscript: true,
            spokenReply: "Yes?",
            captureStatus: captureResult.captureStatus,
            savedPrompt: captureResult.savedPrompt
        )
    }

    private mutating func continueCapturing(with rawSegment: String, startedAt: Date, endedAt: Date) -> ImpulseVoiceCommandResult {
        let segment = Self.removingLeadingWakePhrase(from: rawSegment)

        if let stopRange = Self.stopKeywordRange(in: segment) {
            let promptPrefix = Self.normalizedSpacing(String(segment[..<stopRange.lowerBound]))
            appendCapturedText(promptPrefix)
            let finalizedPrompt = finalizePrompt(endedAt: endedAt)
            return ImpulseVoiceCommandResult(
                shouldSuppressTranscript: true,
                spokenReply: nil,
                captureStatus: finalizedPrompt.text.isEmpty ? "Stopped listening. Using default response." : "Saved voice prompt locally.",
                savedPrompt: finalizedPrompt
            )
        }

        appendCapturedText(segment)
        return ImpulseVoiceCommandResult(
            shouldSuppressTranscript: true,
            spokenReply: nil,
            captureStatus: captureStatusText(),
            savedPrompt: nil
        )
    }

    private mutating func appendCapturedText(_ segment: String) {
        let cleanedSegment = Self.normalizedSpacing(segment)
        guard !cleanedSegment.isEmpty else { return }
        capturedPromptText = Self.mergeTranscript(existing: capturedPromptText, next: cleanedSegment)
    }

    private mutating func finalizePrompt(endedAt: Date) -> CapturedLLMPrompt {
        defer {
            isCapturingPrompt = false
            capturedPromptText = ""
            promptStartedAt = nil
            recentCommandEndedAt = endedAt
        }

        let cleanedPrompt = Self.normalizedSpacing(capturedPromptText)
        return CapturedLLMPrompt(
            text: cleanedPrompt,
            startedAt: promptStartedAt ?? endedAt,
            endedAt: endedAt
        )
    }

    private func captureStatusText() -> String {
        let preview = Self.preview(capturedPromptText)
        if preview.isEmpty {
            return "Listening for prompt until STOP."
        }
        return "Capturing prompt: \(preview)"
    }

    private static func mergeTranscript(existing: String, next: String) -> String {
        guard !next.isEmpty else { return existing }
        guard !existing.isEmpty else { return next }
        if existing.caseInsensitiveCompare(next) == .orderedSame {
            return existing
        }
        if existing.localizedCaseInsensitiveContains(next) {
            return existing
        }

        let existingWords = words(in: existing)
        let nextWords = words(in: next)
        let overlapCount = overlapWordCount(existingWords: existingWords, nextWords: nextWords)
        if overlapCount > 0 {
            let remainingWords = nextWords.dropFirst(overlapCount)
            if remainingWords.isEmpty {
                return existing
            }
            return "\(existing) \(remainingWords.joined(separator: " "))"
        }

        return "\(existing) \(next)"
    }

    private static func overlapWordCount(existingWords: [String], nextWords: [String]) -> Int {
        guard !existingWords.isEmpty, !nextWords.isEmpty else { return 0 }
        let maxOverlap = min(existingWords.count, nextWords.count)
        for count in stride(from: maxOverlap, through: 1, by: -1) {
            let existingSlice = existingWords.suffix(count)
            let nextSlice = nextWords.prefix(count)
            if zip(existingSlice, nextSlice).allSatisfy({ lhs, rhs in
                lhs.caseInsensitiveCompare(rhs) == .orderedSame
            }) {
                return count
            }
        }
        return 0
    }

    private static func words(in text: String) -> [String] {
        text
            .split(whereSeparator: \.isWhitespace)
            .map { token in
                token.trimmingCharacters(in: .punctuationCharacters)
            }
            .filter { !$0.isEmpty }
    }

    private static func preview(_ text: String, limit: Int = 72) -> String {
        let cleaned = normalizedSpacing(text)
        guard !cleaned.isEmpty else { return "" }
        if cleaned.count <= limit {
            return cleaned
        }
        let index = cleaned.index(cleaned.startIndex, offsetBy: limit)
        return "\(cleaned[..<index])..."
    }

    private static func normalizedSpacing(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func containsStopKeyword(_ text: String) -> Bool {
        stopKeywordRange(in: text) != nil
    }

    private static func wakePhraseRange(in text: String) -> Range<String.Index>? {
        text.range(
            of: "\\bhello\\s+impulse\\b[[:punct:]]*",
            options: [.caseInsensitive, .regularExpression]
        )
    }

    private static func stopKeywordRange(in text: String) -> Range<String.Index>? {
        text.range(of: "\\bstop(?:ped)?\\b", options: [.caseInsensitive, .regularExpression])
    }

    private static func removingLeadingWakePhrase(from text: String) -> String {
        guard let wakeRange = text.range(
            of: "^\\bhello\\s+impulse\\b[[:punct:]]*\\s*",
            options: [.caseInsensitive, .regularExpression]
        ) else {
            return normalizedSpacing(text)
        }
        return normalizedSpacing(String(text[wakeRange.upperBound...]))
    }
}

@MainActor
final class CameraViewModel: NSObject, ObservableObject {
    private static let sttPlaceholder = "Waiting for transcript..."
    private static let sttOnHoldMessage = "STT is currently on hold."

    @Published private(set) var capturedFrameCount = 0
    @Published private(set) var capturedAudioBufferCount = 0
    @Published private(set) var lastFrameTimestamp: Date?
    @Published private(set) var permissionDenied = false
    @Published private(set) var inferenceModelName = ""
    @Published private(set) var latestTranscript = "Waiting for transcript..."
    @Published private(set) var latestYamnetOutput = "Waiting for YAMNet output..."
    @Published private(set) var latestDetections = "Waiting for detections..."
    @Published private(set) var lastInferenceError: String?
    @Published private(set) var sttError: String?
    @Published private(set) var yamnetError: String?
    @Published private(set) var yoloError: String?
    @Published private(set) var sttPipelineStatus = "Idle"
    @Published private(set) var yamnetPipelineStatus = "Idle"
    @Published var speakTranscript = true
    @Published private(set) var sttOnHold = false
    @Published private(set) var yamnetOnHold = false
    @Published private(set) var yoloOnHold = false
    @Published private(set) var sttModelName = ""
    @Published private(set) var yamnetModelName = ""
    @Published private(set) var frameStreamStatus = "idle"
    @Published private(set) var streamedFrameCount = 0
    @Published private(set) var memoryIndexStatus = "Starting local memory index..."
    @Published private(set) var memoryDatabasePath = ""
    @Published private(set) var indexedMemoryCount = 0
    @Published private(set) var latestMemorySummary = "No memories indexed yet."
    @Published private(set) var savedPromptCount = 0
    @Published private(set) var latestSavedPrompt = "No voice prompts saved yet."
    @Published private(set) var voicePromptStatus = ImpulseVoiceCommandController.idleStatus
    @Published private(set) var memorySearchResults: [MemorySearchResult] = []
    @Published private(set) var consolidatedMemoryResults: [ConsolidatedMemoryResult] = []
    @Published private(set) var memoryAnswerSummary: String?
    @Published private(set) var memoryError: String?
    @Published var memoryQuery = ""
    @Published var speakMemoryAnswers = true
    private var lastStatusUpdateAudioBufferCount = 0
    private var transcriptLines: [String] = []
    private var impulseVoiceCommandController = ImpulseVoiceCommandController()
    private var hasRunLaunchMemoryLLMTest = false

    let captureService = CameraCaptureService()
    let frameStreamSettings = FrameStreamSettings.fromEnvironment()
    private let inferenceSettings: InferenceModelSettings
    private let memoryIndex = try? OnDeviceMemoryIndex(cameraName: "Rear Camera")
    private let memoryAnswerService: ZeticMemoryAnswerService
    private var yoloPipeline: ChunkedTranscriptPipeline!
    private var audioPipeline: ChunkedAudioTranscriptionPipeline!
    private var yamnetPipeline: ChunkedAudioTranscriptionPipeline!
    private let speechPlayer = SpeechPlaybackService()
    nonisolated(unsafe) private var frameStreamClient: FrameStreamClient!

    override init() {
        let inferenceSettings = InferenceModelSettings.fromEnvironment()
        self.inferenceSettings = inferenceSettings
        self.memoryAnswerService = ZeticMemoryAnswerService(settings: inferenceSettings)
        let inference = InferenceEngineFactory.makeEngines()
        super.init()
        print("[Responder][STT] ViewModel initialized. sttOnHold=\(inference.sttOnHold)")
        self.inferenceModelName = "\(inference.yoloEngine.modelMetadata.name) + \(inference.sttEngine.modelMetadata.name) + \(inference.yamnetEngine.modelMetadata.name)"
        self.sttModelName = inference.sttEngine.modelMetadata.name
        self.yamnetModelName = inference.yamnetEngine.modelMetadata.name
        self.sttOnHold = inference.sttOnHold
        self.yamnetOnHold = inference.yamnetOnHold
        self.yoloOnHold = inference.yoloOnHold
        self.latestTranscript = inference.sttOnHold ? Self.sttOnHoldMessage : Self.sttPlaceholder
        self.latestYamnetOutput = inference.yamnetOnHold ? "YAMNet is currently on hold." : "Waiting for YAMNet output..."
        self.latestDetections = inference.yoloOnHold ? "YOLO is currently on hold." : "Waiting for detections..."
        self.yoloPipeline = ChunkedTranscriptPipeline(
            engine: inference.yoloEngine,
            maxFramesPerChunk: inference.maxFramesPerChunk,
            audioSamplesPerChunk: inference.audioSamplesPerChunk,
            sessionID: inference.sessionID,
            onTranscript: { [weak self] payload in
                Task { @MainActor in
                    let text = payload.output.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    print("[Responder][YOLO] Detection output chunk=\(payload.chunk.chunkID) text=\(text)")
                    self?.latestDetections = text.isEmpty ? "[no detections]" : text
                    self?.yoloError = nil
                    self?.lastInferenceError = self?.sttError
                    self?.ingestVisionMemory(payload)
                    self?.frameStreamClient.sendModelOutput(kind: "yolo", payload: payload)
                }
            },
            onError: { [weak self] message in
                Task { @MainActor in
                    print("[Responder][YOLO][ERROR] \(message)")
                    let tagged = "[YOLO] \(message)"
                    self?.yoloError = tagged
                    self?.lastInferenceError = tagged
                }
            }
        )
        self.audioPipeline = ChunkedAudioTranscriptionPipeline(
            engine: inference.sttEngine,
            audioSamplesPerChunk: inference.audioSamplesPerChunk,
            sessionID: inference.sessionID,
            statusPrefix: "STT",
            hopSamples: 24_000,
            minimumWindowSamples: 48_000,
            onTranscript: { [weak self] payload in
                Task { @MainActor in
                    let text = payload.output.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    print("[Responder][STT] Transcript chunk=\(payload.chunk.chunkID) text=\(text)")
                    guard let self else { return }
                    let voiceCommand = self.impulseVoiceCommandController.processTranscript(
                        text,
                        startedAt: payload.chunk.startedAt,
                        endedAt: payload.chunk.endedAt
                    )
                    if let captureStatus = voiceCommand.captureStatus {
                        self.voicePromptStatus = captureStatus
                    }
                    if let spokenReply = voiceCommand.spokenReply {
                        self.speechPlayer.speak(spokenReply)
                    }
                    if let savedPrompt = voiceCommand.savedPrompt {
                        self.handleImpulseVoiceQuery(savedPrompt)
                    }
                    if voiceCommand.shouldSuppressTranscript {
                        self.sttError = nil
                        self.lastInferenceError = self.yoloError ?? self.yamnetError
                        return
                    }
                    let displayText = self.appendTranscriptLine(text)
                    self.latestTranscript = displayText
                    self.sttError = nil
                    self.lastInferenceError = self.yoloError ?? self.yamnetError
                    let frontendPayload = TranscriptChunk(
                        sessionID: payload.sessionID,
                        emittedAt: payload.emittedAt,
                        chunk: payload.chunk,
                        model: payload.model,
                        output: TranscriptChunk.TranscriptOutput(
                            text: displayText,
                            confidence: payload.output.confidence,
                            tensorCount: payload.output.tensorCount
                        )
                    )
                    self.ingestTranscriptMemory(payload)
                    self.frameStreamClient.sendModelOutput(kind: "stt", payload: frontendPayload)
                    if self.speakTranscript == true,
                       text != "[stt_unavailable] Decoder returned no tokens.",
                       text != "[stt_unavailable] Encoder returned no embeddings.",
                       text != "[stt_unavailable] Decoder produced no transcription." {
                        self.speechPlayer.speak(text)
                    }
                }
            },
            onError: { [weak self] message in
                Task { @MainActor in
                    print("[Responder][STT][ERROR] \(message)")
                    let tagged = "[STT] \(message)"
                    self?.sttError = tagged
                    self?.lastInferenceError = tagged
                }
            },
            onStatus: { [weak self] status in
                Task { @MainActor in
                    print("[Responder][STT][STATUS] \(status)")
                    self?.sttPipelineStatus = status
                }
            }
        )
        self.yamnetPipeline = ChunkedAudioTranscriptionPipeline(
            engine: inference.yamnetEngine,
            audioSamplesPerChunk: 15_600,
            sessionID: inference.sessionID,
            statusPrefix: "YAMNet",
            hopSamples: 8_000,
            maxPendingChunks: 1,
            onTranscript: { [weak self] payload in
                Task { @MainActor in
                    let text = payload.output.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    print("[Responder][YAMNET] Output chunk=\(payload.chunk.chunkID) text=\(text)")
                    self?.latestYamnetOutput = text.isEmpty ? "[empty yamnet output]" : text
                    self?.yamnetError = nil
                    self?.lastInferenceError = self?.sttError ?? self?.yoloError
                    self?.ingestAudioMemory(payload)
                    self?.frameStreamClient.sendModelOutput(kind: "yamnet", payload: payload)
                }
            },
            onError: { [weak self] message in
                Task { @MainActor in
                    print("[Responder][YAMNET][ERROR] \(message)")
                    let tagged = "[YAMNET] \(message)"
                    self?.yamnetError = tagged
                    self?.lastInferenceError = tagged
                }
            },
            onStatus: { [weak self] status in
                Task { @MainActor in
                    self?.yamnetPipelineStatus = status
                }
            }
        )
        self.yoloPipeline.setPaused(self.yoloOnHold)
        self.audioPipeline.setPaused(self.sttOnHold)
        self.yamnetPipeline.setPaused(self.yamnetOnHold)
        self.frameStreamClient = FrameStreamClient(
            settings: frameStreamSettings,
            stateHandler: { [weak self] status in
                self?.frameStreamStatus = status
            },
            frameSentHandler: { [weak self] in
                self?.streamedFrameCount += 1
            }
        )
        captureService.delegate = self
        bootstrapMemoryIndex()
    }

    func startCamera() {
        print("[Responder] startCamera called")
        runLaunchMemoryLLMTestIfNeeded()
        Task {
            let granted = await captureService.requestPermissionIfNeeded()
            print("[Responder] Camera permission granted=\(granted) audioAuth=\(captureService.audioAuthorizationStatus.rawValue)")
            guard granted else {
                permissionDenied = true
                return
            }
            permissionDenied = false
            if captureService.audioAuthorizationStatus != .authorized {
                resetTranscriptDisplay("[stt_unavailable] Microphone permission not granted.")
                sttPipelineStatus = "No microphone permission"
                latestYamnetOutput = "[yamnet_unavailable] Microphone permission not granted."
                yamnetPipelineStatus = "No microphone permission"
            } else if !sttOnHold {
                sttPipelineStatus = "Listening..."
            }
            if captureService.audioAuthorizationStatus == .authorized, !yamnetOnHold {
                yamnetPipelineStatus = "Listening..."
            }
            captureService.startRunning()
            frameStreamClient.start()
            startSTTWatchdog()
        }
    }

    func stopCamera() {
        captureService.stopRunning()
        frameStreamClient.stop()
        DetectionOverlayStore.shared.clear()
    }

    func setSTTEnabled(_ enabled: Bool) {
        print("[Responder][STT] Toggle requested enabled=\(enabled)")
        sttOnHold = !enabled
        audioPipeline.setPaused(sttOnHold)
        if sttOnHold {
            resetTranscriptDisplay(Self.sttOnHoldMessage)
            sttPipelineStatus = "Paused"
            print("[Responder][STT] Paused")
        } else if latestTranscript == Self.sttOnHoldMessage {
            resetTranscriptDisplay(Self.sttPlaceholder)
            sttPipelineStatus = "Listening..."
            print("[Responder][STT] Resumed and listening")
            startSTTWatchdog()
        }
    }

    func setYamnetEnabled(_ enabled: Bool) {
        yamnetOnHold = !enabled
        yamnetPipeline.setPaused(yamnetOnHold)
        if yamnetOnHold {
            latestYamnetOutput = "YAMNet is currently on hold."
            yamnetPipelineStatus = "Paused"
        } else if latestYamnetOutput == "YAMNet is currently on hold." {
            latestYamnetOutput = "Waiting for YAMNet output..."
            yamnetPipelineStatus = "Listening..."
        }
    }

    func setYOLOEnabled(_ enabled: Bool) {
        yoloOnHold = !enabled
        yoloPipeline.setPaused(yoloOnHold)
        if yoloOnHold {
            latestDetections = "YOLO is currently on hold."
            DetectionOverlayStore.shared.clear()
        } else if latestDetections == "YOLO is currently on hold." {
            latestDetections = "Waiting for detections..."
        }
    }

    private func runLaunchMemoryLLMTestIfNeeded() {
        guard !hasRunLaunchMemoryLLMTest else { return }
        hasRunLaunchMemoryLLMTest = true
        print("[Responder][MemoryLLM][TEST] Starting launch test")

        Task { @MainActor [weak self] in
            guard let self else { return }
            let result = await self.memoryAnswerService.runLaunchTest()
            print("[Responder][MemoryLLM][TEST] status=\(result.status) response=\(result.response)")
            self.memoryAnswerSummary = "Launch test: \(result.response)"
            self.memoryIndexStatus = result.status
            if result.success {
                if self.memoryError?.hasPrefix("Memory LLM launch test") == true {
                    self.memoryError = nil
                }
            } else {
                self.memoryError = result.status
            }
        }
    }

    private func startSTTWatchdog() {
        print("[Responder][STT] Watchdog armed")
        Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !self.sttOnHold else { return }
            if self.captureService.audioAuthorizationStatus != .authorized {
                self.resetTranscriptDisplay("[stt_unavailable] Microphone permission not granted.")
                self.sttPipelineStatus = "No microphone permission"
                print("[Responder][STT][WATCHDOG] No mic permission")
                return
            }
            if let setupError = self.captureService.audioSetupErrorMessage {
                self.resetTranscriptDisplay("[stt_unavailable] \(setupError)")
                self.sttPipelineStatus = "Audio setup failed"
                print("[Responder][STT][WATCHDOG] Audio setup error: \(setupError)")
                return
            }
            if !self.captureService.isAudioCaptureConfigured {
                self.resetTranscriptDisplay("[stt_unavailable] Audio capture pipeline is not configured.")
                self.sttPipelineStatus = "Audio capture not configured"
                print("[Responder][STT][WATCHDOG] Audio capture not configured")
                return
            }
            if self.capturedAudioBufferCount == 0 {
                self.resetTranscriptDisplay("[stt_unavailable] No microphone audio buffers received after start.")
                self.sttPipelineStatus = "No audio buffers"
                print("[Responder][STT][WATCHDOG] No audio buffers received")
            } else {
                print("[Responder][STT][WATCHDOG] Audio buffers seen count=\(self.capturedAudioBufferCount)")
            }
        }
    }

    private func appendTranscriptLine(_ text: String) -> String {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else {
            return transcriptLines.isEmpty ? "[empty transcript]" : transcriptLines.joined(separator: "\n")
        }

        if normalized.hasPrefix("[stt_unavailable]") {
            resetTranscriptDisplay(normalized)
            return latestTranscript
        }

        if transcriptLines.last == normalized {
            return transcriptLines.joined(separator: "\n")
        }

        if transcriptLines.count >= 3 {
            transcriptLines.removeAll(keepingCapacity: true)
        }
        transcriptLines.append(normalized)
        return transcriptLines.joined(separator: "\n")
    }

    private func resetTranscriptDisplay(_ text: String) {
        transcriptLines.removeAll(keepingCapacity: true)
        latestTranscript = text
    }

    func runMemorySearch() {
        let query = memoryQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            memorySearchResults = []
            consolidatedMemoryResults = []
            memoryAnswerSummary = nil
            memoryError = nil
            return
        }

        guard let memoryIndex else {
            memoryError = "Local memory index failed to initialize."
            return
        }

        memoryIndexStatus = "Searching on-device memories..."
        memoryError = nil

        Task { [weak self] in
            guard let self else { return }
            let defaultSpokenFallback = self.inferenceSettings.memoryDefaultFallbackMessage
            do {
                let results = try await memoryIndex.search(query)
                let fallbackAnswer = MemorySearchSummarizer.makeAnswer(
                    for: query,
                    results: results,
                    defaultFallbackMessage: self.inferenceSettings.memoryDefaultFallbackMessage
                )
                let snapshot = try await memoryIndex.prepare()
                await MainActor.run {
                    self.memorySearchResults = results
                    self.consolidatedMemoryResults = fallbackAnswer.consolidatedResults
                    self.memoryAnswerSummary = fallbackAnswer.summaryText
                    self.applyMemorySnapshot(snapshot, fallbackStatus: results.isEmpty ? "No matching memories yet" : "Summarizing with Zetic LLM...")
                }

                let answer = await self.memoryAnswerService.summarize(query: query, fallback: fallbackAnswer)

                await MainActor.run {
                    self.consolidatedMemoryResults = answer.consolidatedResults
                    self.memoryAnswerSummary = answer.summaryText
                    self.applyMemorySnapshot(snapshot, fallbackStatus: results.isEmpty ? "No matching memories yet" : "Semantic search complete")
                    if self.speakMemoryAnswers {
                        let spokenText = answer.spokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ? defaultSpokenFallback
                            : answer.spokenText
                        self.speechPlayer.speak(spokenText)
                    }
                }
            } catch {
                await MainActor.run {
                    self.memoryError = Self.describeMemoryError(error)
                    self.memoryIndexStatus = "Search failed"
                }
            }
        }
    }

    func clearMemoryDatabase() {
        guard let memoryIndex else {
            memoryError = "Local memory index failed to initialize."
            return
        }

        memoryIndexStatus = "Clearing local memories..."
        memoryError = nil

        Task { [weak self] in
            guard let self else { return }
            do {
                let snapshot = try await memoryIndex.clearAllMemories()
                await MainActor.run {
                    self.memoryQuery = ""
                    self.memorySearchResults = []
                    self.consolidatedMemoryResults = []
                    self.memoryAnswerSummary = nil
                    self.applyMemorySnapshot(snapshot, fallbackStatus: "Local memory database cleared")
                }
            } catch {
                await MainActor.run {
                    self.memoryError = Self.describeMemoryError(error)
                    self.memoryIndexStatus = "Clear failed"
                }
            }
        }
    }

    private func bootstrapMemoryIndex() {
        guard let memoryIndex else {
            memoryIndexStatus = "Local memory index unavailable"
            memoryError = "Unable to start the on-device SQLite vector database."
            return
        }

        Task { [weak self] in
            guard let self else { return }
            do {
                let snapshot = try await memoryIndex.prepare()
                await MainActor.run {
                    self.applyMemorySnapshot(snapshot, fallbackStatus: "Ready for semantic search")
                }
            } catch {
                await MainActor.run {
                    self.memoryIndexStatus = "Memory bootstrap failed"
                    self.memoryError = Self.describeMemoryError(error)
                }
            }
        }
    }

    private func ingestVisionMemory(_ payload: TranscriptChunk) {
        guard let memoryIndex else { return }
        let boxes = DetectionOverlayStore.shared.currentBoxes()

        Task { [weak self] in
            guard let self else { return }
            do {
                let snapshot = try await memoryIndex.ingestVision(payload, boxes: boxes)
                await MainActor.run {
                    self.applyMemorySnapshot(snapshot)
                }
            } catch {
                await MainActor.run {
                    self.memoryError = Self.describeMemoryError(error)
                    self.memoryIndexStatus = "Vision memory ingest failed"
                }
            }
        }
    }

    private func ingestTranscriptMemory(_ payload: TranscriptChunk) {
        guard let memoryIndex else { return }

        Task { [weak self] in
            guard let self else { return }
            do {
                let snapshot = try await memoryIndex.ingestTranscript(payload)
                await MainActor.run {
                    self.applyMemorySnapshot(snapshot)
                }
            } catch {
                await MainActor.run {
                    self.memoryError = Self.describeMemoryError(error)
                    self.memoryIndexStatus = "Transcript memory ingest failed"
                }
            }
        }
    }

    private func ingestAudioMemory(_ payload: TranscriptChunk) {
        guard let memoryIndex else { return }

        Task { [weak self] in
            guard let self else { return }
            do {
                let snapshot = try await memoryIndex.ingestAudioClassification(payload)
                await MainActor.run {
                    self.applyMemorySnapshot(snapshot)
                }
            } catch {
                await MainActor.run {
                    self.memoryError = Self.describeMemoryError(error)
                    self.memoryIndexStatus = "Audio memory ingest failed"
                }
            }
        }
    }

    private func applyMemorySnapshot(_ snapshot: MemoryIndexSnapshot, fallbackStatus: String? = nil) {
        applyMemorySnapshot(snapshot, fallbackStatus: fallbackStatus, preserveLatestMemorySummary: false)
    }

    private func applyMemorySnapshot(
        _ snapshot: MemoryIndexSnapshot,
        fallbackStatus: String? = nil,
        preserveLatestMemorySummary: Bool
    ) {
        indexedMemoryCount = snapshot.indexedCount
        savedPromptCount = snapshot.promptCount
        latestSavedPrompt = snapshot.latestPromptPreview
        memoryDatabasePath = snapshot.databasePath
        if !preserveLatestMemorySummary {
            latestMemorySummary = snapshot.latestSummary
        }
        memoryIndexStatus = fallbackStatus ?? "Indexed \(snapshot.indexedCount) memories locally with sqlite-vec \(snapshot.vectorVersion)"
        memoryError = nil
    }

    private func handleImpulseVoiceQuery(_ prompt: CapturedLLMPrompt) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.runImpulseVoiceQuery(prompt)
        }
    }

    private func runImpulseVoiceQuery(_ prompt: CapturedLLMPrompt) async {
        let shouldResumeSTT = !sttOnHold
        let cleanedPrompt = prompt.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let defaultSpokenFallback = inferenceSettings.memoryDefaultFallbackMessage
        if shouldResumeSTT {
            setSTTEnabled(false)
        }

        memoryQuery = cleanedPrompt
        voicePromptStatus = cleanedPrompt.isEmpty
            ? "Speaking default response."
            : "Searching memories for: \(Self.previewText(cleanedPrompt))"
        memoryIndexStatus = cleanedPrompt.isEmpty
            ? "No prompt captured. Using default response."
            : "Running semantic voice query..."
        memoryError = nil

        defer {
            voicePromptStatus = ImpulseVoiceCommandController.idleStatus
            if shouldResumeSTT {
                setSTTEnabled(true)
            }
        }

        if cleanedPrompt.isEmpty {
            let fallbackAnswer = MemorySearchAnswer(
                summaryText: defaultSpokenFallback,
                spokenText: defaultSpokenFallback,
                consolidatedResults: []
            )
            memorySearchResults = []
            consolidatedMemoryResults = []
            memoryAnswerSummary = fallbackAnswer.summaryText
            await speechPlayer.speakAndWait(
                fallbackAnswer.spokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? defaultSpokenFallback
                    : fallbackAnswer.spokenText
            )
            return
        }

        guard let memoryIndex else {
            memoryError = "Local memory index failed to initialize."
            let fallbackAnswer = await memoryAnswerService.summarize(
                query: cleanedPrompt,
                fallback: MemorySearchSummarizer.makeAnswer(
                    for: cleanedPrompt,
                    results: [],
                    defaultFallbackMessage: inferenceSettings.memoryDefaultFallbackMessage
                )
            )
            voicePromptStatus = "Speaking default response."
            memoryAnswerSummary = fallbackAnswer.summaryText
            await speechPlayer.speakAndWait(
                fallbackAnswer.spokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? defaultSpokenFallback
                    : fallbackAnswer.spokenText
            )
            return
        }

        do {
            let savedPromptSnapshot = try await memoryIndex.saveLLMPrompt(
                cleanedPrompt,
                startedAt: prompt.startedAt,
                endedAt: prompt.endedAt
            )
            let rawResults = try await memoryIndex.search(cleanedPrompt)
            let relevantResults = MemorySearchSummarizer.relevantResults(
                rawResults,
                maxDistance: inferenceSettings.memoryRelevantDistanceThreshold
            )
            let fallbackAnswer = MemorySearchSummarizer.makeAnswer(
                for: cleanedPrompt,
                results: relevantResults,
                defaultFallbackMessage: inferenceSettings.memoryDefaultFallbackMessage
            )
            let answer = await memoryAnswerService.summarize(query: cleanedPrompt, fallback: fallbackAnswer)

            memorySearchResults = relevantResults
            consolidatedMemoryResults = answer.consolidatedResults
            memoryAnswerSummary = answer.summaryText
            applyMemorySnapshot(
                savedPromptSnapshot,
                fallbackStatus: relevantResults.isEmpty ? "No relevant memory match. Used default response." : "Semantic voice query complete",
                preserveLatestMemorySummary: true
            )
            voicePromptStatus = relevantResults.isEmpty ? "Speaking default response." : "Speaking memory answer."
            await speechPlayer.speakAndWait(
                answer.spokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? defaultSpokenFallback
                    : answer.spokenText
            )
        } catch {
            memoryError = Self.describeMemoryError(error)
            memoryIndexStatus = "Voice query failed"

            let fallbackAnswer = await memoryAnswerService.summarize(
                query: cleanedPrompt,
                fallback: MemorySearchSummarizer.makeAnswer(
                    for: cleanedPrompt,
                    results: [],
                    defaultFallbackMessage: inferenceSettings.memoryDefaultFallbackMessage
                )
            )
            memorySearchResults = []
            consolidatedMemoryResults = []
            memoryAnswerSummary = fallbackAnswer.summaryText
            voicePromptStatus = "Speaking default response."
            await speechPlayer.speakAndWait(
                fallbackAnswer.spokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? defaultSpokenFallback
                    : fallbackAnswer.spokenText
            )
        }
    }

    private static func describeMemoryError(_ error: Error) -> String {
        let described = String(describing: error)
        if described.contains("SQLiteVec") || described.contains("Error ") {
            return described
        }
        return (error as NSError).localizedDescription
    }

    private static func previewText(_ text: String, limit: Int = 48) -> String {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleaned.count > limit else { return cleaned }
        let index = cleaned.index(cleaned.startIndex, offsetBy: limit)
        return "\(cleaned[..<index])..."
    }
}

extension CameraViewModel: CameraCaptureServiceDelegate {
    nonisolated func cameraCaptureService(_ service: CameraCaptureService, didOutputVideo sampleBuffer: CMSampleBuffer) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.capturedFrameCount += 1
            self.lastFrameTimestamp = Date()
            if !self.yoloOnHold {
                self.yoloPipeline.ingestFrame(
                    capturedAt: self.lastFrameTimestamp ?? Date(),
                    pixelBuffer: pixelBuffer,
                    audioSamples: []
                )
            }
            self.frameStreamClient.sendVideoSampleBuffer(sampleBuffer)
        }
    }

    nonisolated func cameraCaptureService(_ service: CameraCaptureService, didOutputAudio sampleBuffer: CMSampleBuffer) {
        guard let samples = Self.audioFloatSamples(from: sampleBuffer), !samples.isEmpty else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.capturedAudioBufferCount += 1
            if self.capturedAudioBufferCount <= 5 || self.capturedAudioBufferCount % 20 == 0 {
                print("[Responder][AudioCapture] Received audio buffer #\(self.capturedAudioBufferCount) samples=\(samples.count)")
            }
            if self.capturedAudioBufferCount - self.lastStatusUpdateAudioBufferCount >= 20 {
                self.lastStatusUpdateAudioBufferCount = self.capturedAudioBufferCount
                if !self.sttOnHold {
                    self.sttPipelineStatus = "Receiving audio buffers: \(self.capturedAudioBufferCount)"
                }
                if !self.yamnetOnHold {
                    self.yamnetPipelineStatus = "Receiving audio buffers: \(self.capturedAudioBufferCount)"
                }
            }
            if !self.sttOnHold {
                self.audioPipeline.ingestAudioSamples(samples)
            }
            if !self.yamnetOnHold {
                self.yamnetPipeline.ingestAudioSamples(samples)
            }
        }
    }

    nonisolated private static func audioFloatSamples(from sampleBuffer: CMSampleBuffer) -> [Float]? {
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let streamBasicDescription = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)
        else {
            return nil
        }

        var blockBuffer: CMBlockBuffer?
        var audioBufferList = AudioBufferList()
        let localStreamDescription = streamBasicDescription.pointee
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &audioBufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return nil }

        let audioBuffer = audioBufferList.mBuffers
        guard let dataPointer = audioBuffer.mData else { return nil }
        let byteCount = Int(audioBuffer.mDataByteSize)
        guard byteCount > 0 else { return nil }

        let channelCount = max(Int(localStreamDescription.mChannelsPerFrame), 1)
        let sampleRate = localStreamDescription.mSampleRate
        if localStreamDescription.mFormatFlags & kAudioFormatFlagIsFloat != 0 {
            let sampleCount = byteCount / MemoryLayout<Float>.size
            let raw = dataPointer.bindMemory(to: Float.self, capacity: sampleCount)
            let values = Array(UnsafeBufferPointer(start: raw, count: sampleCount))
            let mono = downmixToMono(values, channelCount: channelCount)
            return resampleTo16kMono(mono, sourceSampleRate: sampleRate)
        }

        if localStreamDescription.mBitsPerChannel == 16 {
            let sampleCount = byteCount / MemoryLayout<Int16>.size
            let raw = dataPointer.bindMemory(to: Int16.self, capacity: sampleCount)
            let values = Array(UnsafeBufferPointer(start: raw, count: sampleCount)).map { Float($0) / Float(Int16.max) }
            let mono = downmixToMono(values, channelCount: channelCount)
            return resampleTo16kMono(mono, sourceSampleRate: sampleRate)
        }

        return nil
    }

    nonisolated private static func downmixToMono(_ samples: [Float], channelCount: Int) -> [Float] {
        guard channelCount > 1 else { return samples }
        var mono: [Float] = []
        mono.reserveCapacity(samples.count / channelCount)
        var index = 0
        while index + channelCount <= samples.count {
            let frame = samples[index..<(index + channelCount)]
            let avg = frame.reduce(0, +) / Float(channelCount)
            mono.append(avg)
            index += channelCount
        }
        return mono
    }

    nonisolated private static func resampleTo16kMono(_ samples: [Float], sourceSampleRate: Float64) -> [Float] {
        let targetRate: Float64 = 16_000
        guard !samples.isEmpty else { return [] }
        guard sourceSampleRate > 0 else { return samples }
        if abs(sourceSampleRate - targetRate) < 1 {
            return samples
        }

        let ratio = targetRate / sourceSampleRate
        let outputCount = max(1, Int((Double(samples.count) * ratio).rounded(.toNearestOrAwayFromZero)))
        if outputCount == samples.count { return samples }

        var output = [Float](repeating: 0, count: outputCount)
        for index in 0..<outputCount {
            let sourcePosition = Double(index) / ratio
            let left = Int(floor(sourcePosition))
            let right = min(left + 1, samples.count - 1)
            let alpha = Float(sourcePosition - Double(left))
            let lhs = samples[min(left, samples.count - 1)]
            let rhs = samples[right]
            output[index] = lhs + (rhs - lhs) * alpha
        }
        return output
    }
}

struct ContentView: View {
    @StateObject private var viewModel = CameraViewModel()

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                CameraPreviewView(session: viewModel.captureService.session)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(alignment: .topLeading) {
                        Label(
                            viewModel.captureService.isSessionRunning ? "Live" : "Idle",
                            systemImage: "dot.circle.fill"
                        )
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(.ultraThinMaterial, in: Capsule())
                        .padding(12)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 360)

                VStack(alignment: .leading, spacing: 4) {
                    Text("Frames received: \(viewModel.capturedFrameCount)")
                    Text("Frames streamed: \(viewModel.streamedFrameCount)")
                    Text("Audio buffers received: \(viewModel.capturedAudioBufferCount)")
                    Text(lastFrameLabel)
                        .foregroundStyle(.secondary)
                    Text("Inference model: \(viewModel.inferenceModelName)")
                        .foregroundStyle(.secondary)
                    Text("Frame stream status: \(viewModel.frameStreamStatus)")
                        .foregroundStyle(.secondary)
                    Text("Frame stream server: \(viewModel.frameStreamSettings.wsURLString)")
                        .foregroundStyle(.secondary)
                    if viewModel.sttOnHold {
                        Text("STT status: On Hold")
                            .foregroundStyle(.orange)
                    }
                }
                .frame(maxWidth: .infinity)

                Toggle("Speak transcript (TTS)", isOn: $viewModel.speakTranscript)
                Toggle("Speak memory answers (TTS)", isOn: $viewModel.speakMemoryAnswers)

                VStack(spacing: 12) {
                    pipelineCard(
                        title: "STT Pipeline",
                        subtitle: "Model: \(viewModel.sttModelName)",
                        status: sttStatusLabel,
                        statusColor: sttStatusColor,
                        bodyText: "Voice prompt: \(viewModel.voicePromptStatus)\n\nLatest STT Output:\n\(viewModel.latestTranscript)\n\nStatus: \(viewModel.sttPipelineStatus)",
                        actionTitle: viewModel.sttOnHold ? "Resume STT Model" : "Pause STT Model",
                        actionTint: viewModel.sttOnHold ? .green : .orange,
                        action: { viewModel.setSTTEnabled(viewModel.sttOnHold) }
                    )

                    pipelineCard(
                        title: "Audio Classification (YAMNet)",
                        subtitle: "Model: \(viewModel.yamnetModelName)",
                        status: yamnetStatusLabel,
                        statusColor: yamnetStatusColor,
                        bodyText: "Latest YAMNet Output:\n\(viewModel.latestYamnetOutput)\n\nStatus: \(viewModel.yamnetPipelineStatus)",
                        actionTitle: viewModel.yamnetOnHold ? "Resume YAMNet Model" : "Pause YAMNet Model",
                        actionTint: viewModel.yamnetOnHold ? .green : .orange,
                        action: { viewModel.setYamnetEnabled(viewModel.yamnetOnHold) }
                    )

                    pipelineCard(
                        title: "Vision Pipeline (YOLO)",
                        subtitle: "Camera Frame -> YOLO Inference -> Detections",
                        status: yoloStatusLabel,
                        statusColor: yoloStatusColor,
                        bodyText: viewModel.latestDetections,
                        actionTitle: viewModel.yoloOnHold ? "Resume YOLO Model" : "Pause YOLO Model",
                        actionTint: viewModel.yoloOnHold ? .green : .blue,
                        action: { viewModel.setYOLOEnabled(viewModel.yoloOnHold) }
                    )
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("On-Device Memory Search")
                                .font(.headline)
                            Text("SQLite + vector search on the phone. Ask things like “where did I see a person?”")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text("\(viewModel.indexedMemoryCount) memories / \(viewModel.savedPromptCount) prompts")
                            .font(.caption.bold())
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(Color.black.opacity(0.08), in: Capsule())
                    }

                    TextField("Where did I see a person near the door?", text: $viewModel.memoryQuery)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit {
                            viewModel.runMemorySearch()
                        }

                    Button("Search Memories") {
                        viewModel.runMemorySearch()
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.indigo)

                    Button("Clear DB") {
                        viewModel.clearMemoryDatabase()
                    }
                    .buttonStyle(.bordered)
                    .tint(.red)

                    Text(viewModel.memoryIndexStatus)
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    Text("Latest memory summary: \(viewModel.latestMemorySummary)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    Text("Latest saved prompt: \(viewModel.latestSavedPrompt)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    if !viewModel.memoryDatabasePath.isEmpty {
                        Text("Database: \(viewModel.memoryDatabasePath)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }

                    if let memoryAnswerSummary = viewModel.memoryAnswerSummary, !memoryAnswerSummary.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Summary")
                                .font(.subheadline.weight(.semibold))
                            Text(memoryAnswerSummary)
                                .font(.footnote)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(Color.indigo.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }

                    if !viewModel.consolidatedMemoryResults.isEmpty {
                        ForEach(viewModel.consolidatedMemoryResults) { result in
                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    Text(result.timeRangeLabel)
                                        .font(.subheadline.weight(.semibold))
                                    Spacer()
                                    Text(result.bestWhereAnswer)
                                        .font(.caption.weight(.semibold))
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 4)
                                        .background(Color.blue.opacity(0.12), in: Capsule())
                                }

                                Text(result.occurrenceCount == 1 ? "1 memory" : "\(result.occurrenceCount) merged memories")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)

                                if !result.detectionSummary.isEmpty {
                                    Text("Seen: \(result.detectionSummary)")
                                        .font(.footnote)
                                }

                                if !result.transcriptSummary.isEmpty {
                                    Text("Heard: \(result.transcriptSummary)")
                                        .font(.footnote)
                                }

                                if !result.audioSummary.isEmpty {
                                    Text("Ambient: \(result.audioSummary)")
                                        .font(.footnote)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .background(Color.black.opacity(0.04), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        }
                    } else if !viewModel.memoryQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text("No matching memories yet.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(12)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                if viewModel.permissionDenied {
                    Text("Camera or microphone permission denied. Enable access in Settings to continue.")
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                if let lastInferenceError = viewModel.lastInferenceError {
                    Text(lastInferenceError)
                        .foregroundStyle(.red)
                        .font(.footnote)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                if let memoryError = viewModel.memoryError {
                    Text(memoryError)
                        .foregroundStyle(.red)
                        .font(.footnote)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding()
        }
        .onAppear {
            viewModel.startCamera()
        }
        .onDisappear {
            viewModel.stopCamera()
        }
    }

    private var lastFrameLabel: String {
        guard let lastFrameTimestamp = viewModel.lastFrameTimestamp else {
            return "Waiting for frames..."
        }
        return "Last frame: \(lastFrameTimestamp.formatted(date: .omitted, time: .standard))"
    }

    private var sttStatusLabel: String {
        if viewModel.sttOnHold { return "PAUSED" }
        if viewModel.capturedAudioBufferCount == 0 { return "WAITING FOR AUDIO" }
        return "RUNNING"
    }

    private var sttStatusColor: Color {
        if viewModel.sttOnHold { return .orange }
        if viewModel.capturedAudioBufferCount == 0 { return .gray }
        return .green
    }

    private var yamnetStatusLabel: String {
        if viewModel.yamnetOnHold { return "PAUSED" }
        if viewModel.capturedAudioBufferCount == 0 { return "WAITING FOR AUDIO" }
        return "RUNNING"
    }

    private var yamnetStatusColor: Color {
        if viewModel.yamnetOnHold { return .orange }
        if viewModel.capturedAudioBufferCount == 0 { return .gray }
        return .green
    }

    private var yoloStatusLabel: String {
        if viewModel.yoloOnHold { return "PAUSED" }
        if !viewModel.captureService.isSessionRunning { return "IDLE" }
        if viewModel.capturedFrameCount == 0 { return "WAITING FOR FRAMES" }
        return "RUNNING"
    }

    private var yoloStatusColor: Color {
        if viewModel.yoloOnHold { return .orange }
        if !viewModel.captureService.isSessionRunning { return .gray }
        if viewModel.capturedFrameCount == 0 { return .yellow }
        return .blue
    }

    @ViewBuilder
    private func pipelineCard(
        title: String,
        subtitle: String,
        status: String,
        statusColor: Color,
        bodyText: String,
        actionTitle: String,
        actionTint: Color,
        action: @escaping () -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.headline)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(status)
                    .font(.caption.bold())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(statusColor, in: Capsule())
            }

            Text(bodyText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .font(.body)

            Button(actionTitle, action: action)
                .buttonStyle(.borderedProminent)
                .tint(actionTint)
        }
        .padding(12)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

#Preview {
    ContentView()
}

@MainActor
final class SpeechPlaybackService: NSObject, @preconcurrency AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private var currentUtterance: AVSpeechUtterance?
    private var currentContinuation: CheckedContinuation<Void, Never>?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func speak(_ text: String) {
        guard let cleaned = Self.preparedSpeechText(text, fallback: "Yes?") else {
            print("[Responder][TTS] Skipping empty speech request.")
            return
        }
        currentContinuation?.resume()
        currentContinuation = nil
        let utterance = AVSpeechUtterance(string: cleaned)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = 0.48
        currentUtterance = utterance
        synthesizer.stopSpeaking(at: .immediate)
        synthesizer.speak(utterance)
    }

    func speakAndWait(_ text: String) async {
        guard let cleaned = Self.preparedSpeechText(text, fallback: "default") else {
            print("[Responder][TTS] Skipping empty speech request.")
            return
        }

        currentContinuation?.resume()
        currentContinuation = nil

        let utterance = AVSpeechUtterance(string: cleaned)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = 0.48
        currentUtterance = utterance
        synthesizer.stopSpeaking(at: .immediate)

        await withCheckedContinuation { continuation in
            currentContinuation = continuation
            synthesizer.speak(utterance)
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        resolveContinuationIfCurrent(utterance)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        resolveContinuationIfCurrent(utterance)
    }

    private func resolveContinuationIfCurrent(_ utterance: AVSpeechUtterance) {
        guard currentUtterance === utterance else { return }
        currentUtterance = nil
        currentContinuation?.resume()
        currentContinuation = nil
    }

    private static func preparedSpeechText(_ text: String, fallback: String? = nil) -> String? {
        let cleaned = sanitizeSpeechText(text)
        if !cleaned.isEmpty {
            return cleaned
        }

        guard let fallback else { return nil }
        let cleanedFallback = sanitizeSpeechText(fallback)
        return cleanedFallback.isEmpty ? nil : cleanedFallback
    }

    private static func sanitizeSpeechText(_ text: String) -> String {
        text
            .replacingOccurrences(of: "(?is)<think>.*?</think>", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "(?is)<analysis>.*?</analysis>", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "(?is)<reasoning>.*?</reasoning>", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "<\\|[^>]+\\|>", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "[\\u0000-\\u001F]+", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "\"' ").union(.whitespacesAndNewlines))
    }
}
