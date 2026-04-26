import Foundation
import CoreGraphics
import CoreVideo

struct DetectedBoundingBox: Sendable {
    let label: String
    let confidence: Float
    let rect: CGRect
}

final class DetectionOverlayStore {
    static let shared = DetectionOverlayStore()

    private let queue = DispatchQueue(label: "com.lahacks.responder.detection-overlay", attributes: .concurrent)
    private var boxes: [DetectedBoundingBox] = []

    private init() {}

    func update(_ nextBoxes: [DetectedBoundingBox]) {
        queue.sync(flags: .barrier) {
            self.boxes = nextBoxes
        }
    }

    func currentBoxes() -> [DetectedBoundingBox] {
        queue.sync { boxes }
    }

    func clear() {
        update([])
    }
}

struct InferenceModelSettings {
    let personalKey: String
    let credentialCandidates: [String]
    let yoloModelName: String
    let yamnetModelName: String
    let qwenAudioEncoderModelName: String
    let qwenDecoderModelName: String
    let whisperEncoderModelName: String
    let whisperDecoderModelName: String
    let modelVersion: Int?
    let modelMode: String
    let userPrompt: String
    let systemPrompt: String
    let maxResponseTokens: Int
    let maxFramesPerChunk: Int
    let audioSamplesPerChunk: Int
    let sttTimeoutSeconds: Int
    let sessionID: String
    let sttOnHold: Bool
    let yoloOnHold: Bool
    let yamnetOnHold: Bool
    let audioEngine: String
    let speechLocale: String

    static func fromEnvironment(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> InferenceModelSettings {
        let envPersonalKey = environment["ZETIC_PERSONAL_KEY"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let envToken = environment["ZETIC_TOKEN"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let credentialCandidates = [envPersonalKey, envToken]
            .compactMap { $0?.trimmingCharacters(in: CharacterSet(charactersIn: "\"'").union(.whitespacesAndNewlines)) }
            .filter { !$0.isEmpty }
            .reduce(into: [String]()) { acc, value in
                if !acc.contains(value) {
                    acc.append(value)
                }
            }
        let personalKey = credentialCandidates.first ?? ""
        let yoloModelName = environment["ZETIC_YOLO_MODEL_NAME"] ?? "vaibhav-zetic/YOLOv8m"
        let yamnetModelName = environment["ZETIC_YAMNET_MODEL_NAME"] ?? "google/Sound Classification(YAMNET)"
        let qwenAudioEncoderModelName = environment["ZETIC_AUDIO_ENCODER_MODEL_NAME"] ?? "zetic/qwen2.5_omni_audio_encoder_chunk_f16"
        let qwenDecoderModelName = environment["ZETIC_DECODER_MODEL_NAME"] ?? "zetic/QWEN_2.5_omni_3b_decoder"
        let whisperEncoderModelName = environment["ZETIC_WHISPER_ENCODER_MODEL_NAME"] ?? "OpenAI/whisper-tiny-encoder"
        let whisperDecoderModelName = environment["ZETIC_WHISPER_DECODER_MODEL_NAME"] ?? "OpenAI/whisper-tiny-decoder"
        let audioEngine = environment["RESPONDER_AUDIO_ENGINE"] ?? "APPLE"
        let modelMode = environment["ZETIC_MODEL_MODE"] ?? "RUN_AUTO"
        let modelVersion = environment["ZETIC_MODEL_VERSION"].flatMap(Int.init) ?? 1
        let userPrompt = environment["RESPONDER_AUDIO_USER_PROMPT"] ?? "Transcribe this audio in English."
        let systemPrompt = environment["RESPONDER_AUDIO_SYSTEM_PROMPT"] ?? "You are a precise audio transcription assistant."
        let maxResponseTokens = max(environment["RESPONDER_MAX_RESPONSE_TOKENS"].flatMap(Int.init) ?? 256, 32)
        let maxFramesPerChunk = max(environment["RESPONDER_CHUNK_FRAMES"].flatMap(Int.init) ?? 6, 1)
        let audioSamplesPerChunk = max(environment["RESPONDER_AUDIO_SAMPLES_PER_CHUNK"].flatMap(Int.init) ?? 8_000, 4_000)
        let sttTimeoutSeconds = max(environment["RESPONDER_STT_TIMEOUT_SECONDS"].flatMap(Int.init) ?? 12, 1)
        let sessionID = environment["RESPONDER_SESSION_ID"] ?? "optional-session-id"
        let sttOnHold = parseBool(environment["RESPONDER_STT_ON_HOLD"], defaultValue: true)
        let yoloOnHold = parseBool(environment["RESPONDER_YOLO_ON_HOLD"], defaultValue: true)
        let yamnetOnHold = parseBool(environment["RESPONDER_YAMNET_ON_HOLD"], defaultValue: true)
        let speechLocale = environment["RESPONDER_SPEECH_LOCALE"] ?? "en-US"

        let settings = InferenceModelSettings(
            personalKey: personalKey,
            credentialCandidates: credentialCandidates,
            yoloModelName: yoloModelName,
            yamnetModelName: yamnetModelName,
            qwenAudioEncoderModelName: qwenAudioEncoderModelName,
            qwenDecoderModelName: qwenDecoderModelName,
            whisperEncoderModelName: whisperEncoderModelName,
            whisperDecoderModelName: whisperDecoderModelName,
            modelVersion: modelVersion,
            modelMode: modelMode,
            userPrompt: userPrompt,
            systemPrompt: systemPrompt,
            maxResponseTokens: maxResponseTokens,
            maxFramesPerChunk: maxFramesPerChunk,
            audioSamplesPerChunk: audioSamplesPerChunk,
            sttTimeoutSeconds: sttTimeoutSeconds,
            sessionID: sessionID,
            sttOnHold: sttOnHold,
            yoloOnHold: yoloOnHold,
            yamnetOnHold: yamnetOnHold,
            audioEngine: audioEngine,
            speechLocale: speechLocale
        )
        return settings
    }

    private static func parseBool(_ value: String?, defaultValue: Bool) -> Bool {
        guard let value else { return defaultValue }
        switch value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "1", "true", "yes", "y", "on":
            return true
        case "0", "false", "no", "n", "off":
            return false
        default:
            return defaultValue
        }
    }
}

struct TranscriptChunk: Codable {
    struct ChunkMetadata: Codable {
        let chunkID: String
        let startedAt: Date
        let endedAt: Date
        let frameCount: Int
    }

    struct ModelMetadata: Codable {
        let provider: String
        let name: String
        let version: Int?
        let mode: String
        let latencyMS: Int
    }

    struct TranscriptOutput: Codable {
        let text: String
        let confidence: Double
        let tensorCount: Int
    }

    let sessionID: String
    let emittedAt: Date
    let chunk: ChunkMetadata
    let model: ModelMetadata
    let output: TranscriptOutput
}

protocol MLInferenceEngine {
    var modelMetadata: TranscriptChunk.ModelMetadata { get }
    func runInference(for chunk: TranscriptChunk.ChunkMetadata, pixelBuffer: CVPixelBuffer, audioSamples: [Float]) async throws -> TranscriptChunk.TranscriptOutput
}

protocol AudioTranscriptionEngine {
    var modelMetadata: TranscriptChunk.ModelMetadata { get }
    func transcribe(audioSamples16kMono: [Float]) async throws -> TranscriptChunk.TranscriptOutput
}

enum InferenceEngineFactory {
    static func makeEngines() -> (
        yoloEngine: MLInferenceEngine,
        sttEngine: AudioTranscriptionEngine,
        yamnetEngine: AudioTranscriptionEngine,
        maxFramesPerChunk: Int,
        audioSamplesPerChunk: Int,
        sessionID: String,
        sttOnHold: Bool,
        yoloOnHold: Bool,
        yamnetOnHold: Bool
    ) {
        let settings = InferenceModelSettings.fromEnvironment()
        let yoloEngine = ZeticMLInferenceEngine(settings: settings)
        let sttEngine: AudioTranscriptionEngine
        switch settings.audioEngine.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() {
        case "QWEN", "OMNI", "QWEN_OMNI":
            sttEngine = QwenOmniTranscriptionEngine(settings: settings)
        case "WHISPER":
            sttEngine = WhisperTinyTranscriptionEngine(settings: settings)
        case "APPLE", "SPEECH", "SFSPEECH":
            sttEngine = AppleSpeechTranscriptionEngine(settings: settings)
        case "HYBRID":
            sttEngine = HybridTranscriptionEngine(
                settings: settings,
                primary: WhisperTinyTranscriptionEngine(settings: settings),
                fallback: AppleSpeechTranscriptionEngine(settings: settings)
            )
        default:
            sttEngine = HybridTranscriptionEngine(
                settings: settings,
                primary: WhisperTinyTranscriptionEngine(settings: settings),
                fallback: AppleSpeechTranscriptionEngine(settings: settings)
            )
        }
        let yamnetEngine: AudioTranscriptionEngine = YamnetAudioClassificationEngine(settings: settings)
        return (
            yoloEngine,
            sttEngine,
            yamnetEngine,
            settings.maxFramesPerChunk,
            settings.audioSamplesPerChunk,
            settings.sessionID,
            settings.sttOnHold,
            settings.yoloOnHold,
            settings.yamnetOnHold
        )
    }
}

@MainActor
final class ChunkedTranscriptPipeline {
    private let engine: MLInferenceEngine
    private let maxFramesPerChunk: Int
    private let audioSamplesPerChunk: Int
    private let sessionID: String
    private let jsonEncoder: JSONEncoder

    private var chunkFrameCount = 0
    private var chunkStart: Date?
    private var chunkEnd: Date?
    private var audioSamples: [Float] = []
    private var latestPixelBuffer: CVPixelBuffer?
    private var lastPollLogAt: Date?
    private var isProcessingChunk = false
    private var isPaused = false
    private var deferredChunk: (metadata: TranscriptChunk.ChunkMetadata, pixelBuffer: CVPixelBuffer, audio: [Float])?
    private let onTranscript: ((TranscriptChunk) -> Void)?
    private let onError: ((String) -> Void)?

    init(
        engine: MLInferenceEngine,
        maxFramesPerChunk: Int,
        audioSamplesPerChunk: Int,
        sessionID: String,
        onTranscript: ((TranscriptChunk) -> Void)? = nil,
        onError: ((String) -> Void)? = nil
    ) {
        self.engine = engine
        self.maxFramesPerChunk = max(maxFramesPerChunk, 1)
        self.audioSamplesPerChunk = max(audioSamplesPerChunk, 16_000)
        self.sessionID = sessionID
        self.onTranscript = onTranscript
        self.onError = onError
        self.jsonEncoder = JSONEncoder()
        self.jsonEncoder.dateEncodingStrategy = .iso8601
        self.jsonEncoder.outputFormatting = [.sortedKeys]
    }

    func ingestAudioSamples(_ samples: [Float]) {
        guard !isPaused else { return }
        guard !samples.isEmpty else { return }
        audioSamples.append(contentsOf: samples)
        if audioSamples.count > audioSamplesPerChunk * 2 {
            audioSamples.removeFirst(audioSamples.count - audioSamplesPerChunk * 2)
        }
        logPollingStatusIfNeeded()
    }

    func ingestFrame(capturedAt: Date = Date(), pixelBuffer: CVPixelBuffer, audioSamples: [Float]) {
        guard !isPaused else { return }
        ingestAudioSamples(audioSamples)
        latestPixelBuffer = pixelBuffer
        if chunkStart == nil {
            chunkStart = capturedAt
        }
        chunkEnd = capturedAt
        chunkFrameCount += 1

        guard chunkFrameCount >= maxFramesPerChunk, let startedAt = chunkStart, let endedAt = chunkEnd else {
            logPollingStatusIfNeeded()
            return
        }
        guard let frameForInference = latestPixelBuffer else { return }

        let chunkMetadata = TranscriptChunk.ChunkMetadata(
            chunkID: UUID().uuidString,
            startedAt: startedAt,
            endedAt: endedAt,
            frameCount: chunkFrameCount
        )

        chunkFrameCount = 0
        chunkStart = nil
        chunkEnd = nil
        latestPixelBuffer = nil
        let chunkAudio = Array(self.audioSamples.suffix(audioSamplesPerChunk))
        self.audioSamples.removeAll(keepingCapacity: true)
        if isProcessingChunk {
            deferredChunk = (metadata: chunkMetadata, pixelBuffer: frameForInference, audio: chunkAudio)
            return
        }
        processChunk(metadata: chunkMetadata, pixelBuffer: frameForInference, audio: chunkAudio)
    }

    func setPaused(_ paused: Bool) {
        isPaused = paused
        if paused {
            chunkFrameCount = 0
            chunkStart = nil
            chunkEnd = nil
            audioSamples.removeAll(keepingCapacity: false)
            latestPixelBuffer = nil
            deferredChunk = nil
        }
    }

    private func logPollingStatusIfNeeded(force: Bool = false) {
        let now = Date()
        if !force, let lastPollLogAt, now.timeIntervalSince(lastPollLogAt) < 2 {
            return
        }
        lastPollLogAt = now
    }

    private func processChunk(metadata: TranscriptChunk.ChunkMetadata, pixelBuffer: CVPixelBuffer, audio: [Float]) {
        isProcessingChunk = true
        Task {
            defer {
                isProcessingChunk = false
                if let deferredChunk {
                    self.deferredChunk = nil
                    processChunk(metadata: deferredChunk.metadata, pixelBuffer: deferredChunk.pixelBuffer, audio: deferredChunk.audio)
                }
            }

            do {
                let output = try await engine.runInference(for: metadata, pixelBuffer: pixelBuffer, audioSamples: audio)
                guard !isPaused else { return }
                let payload = TranscriptChunk(
                    sessionID: sessionID,
                    emittedAt: Date(),
                    chunk: metadata,
                    model: engine.modelMetadata,
                    output: output
                )
                _ = try jsonEncoder.encode(payload)
                onTranscript?(payload)
            } catch {
                onError?(error.localizedDescription)
            }
        }
    }
}

@MainActor
final class ChunkedAudioTranscriptionPipeline {
    private let engine: AudioTranscriptionEngine
    private let windowSamples: Int
    private let hopSamples: Int
    private let maxPendingChunks: Int
    private let sessionID: String
    private let statusPrefix: String
    private let jsonEncoder: JSONEncoder

    private var buffer: [Float] = []
    private var pending: [[Float]] = []
    private var isProcessing = false
    private var isPaused = false
    private var cooldownUntil: Date?
    private let onTranscript: ((TranscriptChunk) -> Void)?
    private let onError: ((String) -> Void)?
    private let onStatus: ((String) -> Void)?

    init(
        engine: AudioTranscriptionEngine,
        audioSamplesPerChunk: Int,
        sessionID: String,
        statusPrefix: String = "STT",
        hopSamples: Int? = nil,
        maxPendingChunks: Int = 2,
        minimumWindowSamples: Int = 16_000,
        onTranscript: ((TranscriptChunk) -> Void)? = nil,
        onError: ((String) -> Void)? = nil,
        onStatus: ((String) -> Void)? = nil
    ) {
        self.engine = engine
        self.windowSamples = max(audioSamplesPerChunk, minimumWindowSamples)
        self.hopSamples = max(min(hopSamples ?? audioSamplesPerChunk, self.windowSamples), 1)
        self.maxPendingChunks = max(maxPendingChunks, 1)
        self.sessionID = sessionID
        self.statusPrefix = statusPrefix
        self.onTranscript = onTranscript
        self.onError = onError
        self.onStatus = onStatus
        self.jsonEncoder = JSONEncoder()
        self.jsonEncoder.dateEncodingStrategy = .iso8601
        self.jsonEncoder.outputFormatting = [.sortedKeys]
    }

    func ingestAudioSamples(_ samples: [Float]) {
        guard !isPaused else { return }
        guard !samples.isEmpty else { return }
        buffer.append(contentsOf: samples)

        while buffer.count >= windowSamples {
            let chunk = Array(buffer.prefix(windowSamples))
            buffer.removeFirst(min(hopSamples, buffer.count))
            pending.append(chunk)
        }

        if pending.isEmpty, !isProcessing, buffer.count < windowSamples {
            onStatus?("Buffered \(buffer.count)/\(windowSamples) samples, waiting for \(windowSamples - buffer.count) more")
        } else if isProcessing {
            onStatus?("\(statusPrefix) processing current chunk, buffered \(buffer.count) samples, queued \(pending.count) chunk(s)")
        } else {
            onStatus?("Buffered \(buffer.count) samples, queued \(pending.count) chunk(s)")
        }

        if pending.count > maxPendingChunks {
            pending.removeFirst(pending.count - maxPendingChunks)
        }

        processNextIfNeeded()
    }

    func setPaused(_ paused: Bool) {
        isPaused = paused
        if paused {
            buffer.removeAll(keepingCapacity: false)
            pending.removeAll(keepingCapacity: false)
            cooldownUntil = nil
            onStatus?("Paused")
        } else {
            onStatus?("Listening...")
            processNextIfNeeded()
        }
    }

    private func processNextIfNeeded() {
        guard !isPaused else { return }
        guard !isProcessing, !pending.isEmpty else { return }
        if let cooldownUntil, Date() < cooldownUntil {
            let seconds = Int(ceil(cooldownUntil.timeIntervalSinceNow))
            onStatus?("\(statusPrefix) cooling down after error (\(max(seconds, 1))s)")
            return
        }
        isProcessing = true
        let audioChunk = pending.removeFirst()
        let startedAt = Date()
        print("[Responder][\(statusPrefix)][Pipeline] Processing chunk samples=\(audioChunk.count), remaining=\(pending.count)")
        onStatus?("Transcribing \(audioChunk.count) samples...")

        Task {
            defer {
                isProcessing = false
                processNextIfNeeded()
            }

            do {
                let output = try await engine.transcribe(audioSamples16kMono: audioChunk)
                let endedAt = Date()
                let metadata = TranscriptChunk.ChunkMetadata(
                    chunkID: UUID().uuidString,
                    startedAt: startedAt,
                    endedAt: endedAt,
                    frameCount: 0
                )
                let payload = TranscriptChunk(
                    sessionID: sessionID,
                    emittedAt: endedAt,
                    chunk: metadata,
                    model: engine.modelMetadata,
                    output: output
                )
                _ = try jsonEncoder.encode(payload)
                onStatus?("\(statusPrefix) chunk complete")
                cooldownUntil = nil
                onTranscript?(payload)
            } catch {
                if isSoftTranscriptionMiss(error) {
                    cooldownUntil = nil
                    onStatus?("\(statusPrefix) listening...")
                    print("[Responder][\(statusPrefix)][INFO] Soft miss: \(error.localizedDescription)")
                } else {
                    cooldownUntil = Date().addingTimeInterval(10)
                    onStatus?("\(statusPrefix) failed")
                    onError?(error.localizedDescription)
                }
            }
        }
    }

    private func isSoftTranscriptionMiss(_ error: Error) -> Bool {
        let text = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return text.contains("no speech detected")
            || text.contains("speech recognizer returned an empty transcription")
    }
}

final class MockMLInferenceEngine: MLInferenceEngine {
    let modelMetadata = TranscriptChunk.ModelMetadata(
        provider: "mock",
        name: "Mock/Transcript-Model",
        version: nil,
        mode: "RUN_AUTO",
        latencyMS: 1
    )

    func runInference(for chunk: TranscriptChunk.ChunkMetadata, pixelBuffer: CVPixelBuffer, audioSamples: [Float]) async throws -> TranscriptChunk.TranscriptOutput {
        return TranscriptChunk.TranscriptOutput(
            text: "Mock transcript for \(chunk.frameCount) frames and \(audioSamples.count) audio samples.",
            confidence: 0.0,
            tensorCount: 0
        )
    }
}
