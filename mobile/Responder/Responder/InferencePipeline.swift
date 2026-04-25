import Foundation
import CoreVideo

struct InferenceModelSettings {
    let personalKey: String
    let credentialCandidates: [String]
    let yoloModelName: String
    let sttAudioEncoderModelName: String
    let sttDecoderModelName: String
    let modelVersion: Int?
    let modelMode: String
    let userPrompt: String
    let systemPrompt: String
    let maxResponseTokens: Int
    let maxFramesPerChunk: Int
    let audioSamplesPerChunk: Int
    let sessionID: String
    let sttOnHold: Bool

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
        let sttAudioEncoderModelName = environment["ZETIC_AUDIO_ENCODER_MODEL_NAME"] ?? "zetic/qwen2.5_omni_audio_encoder_chunk_f16"
        let sttDecoderModelName = environment["ZETIC_DECODER_MODEL_NAME"] ?? "zetic/QWEN_2.5_omni_3b_decoder"
        let modelMode = environment["ZETIC_MODEL_MODE"] ?? "RUN_AUTO"
        let modelVersion = environment["ZETIC_MODEL_VERSION"].flatMap(Int.init) ?? 1
        let userPrompt = environment["RESPONDER_AUDIO_USER_PROMPT"] ?? "Transcribe this audio in English."
        let systemPrompt = environment["RESPONDER_AUDIO_SYSTEM_PROMPT"] ?? "You are a precise audio transcription assistant."
        let maxResponseTokens = max(environment["RESPONDER_MAX_RESPONSE_TOKENS"].flatMap(Int.init) ?? 256, 32)
        let maxFramesPerChunk = max(environment["RESPONDER_CHUNK_FRAMES"].flatMap(Int.init) ?? 6, 1)
        let audioSamplesPerChunk = max(environment["RESPONDER_AUDIO_SAMPLES_PER_CHUNK"].flatMap(Int.init) ?? 8_000, 4_000)
        let sessionID = environment["RESPONDER_SESSION_ID"] ?? "optional-session-id"
        let sttOnHold = parseBool(environment["RESPONDER_STT_ON_HOLD"], defaultValue: false)

        let settings = InferenceModelSettings(
            personalKey: personalKey,
            credentialCandidates: credentialCandidates,
            yoloModelName: yoloModelName,
            sttAudioEncoderModelName: sttAudioEncoderModelName,
            sttDecoderModelName: sttDecoderModelName,
            modelVersion: modelVersion,
            modelMode: modelMode,
            userPrompt: userPrompt,
            systemPrompt: systemPrompt,
            maxResponseTokens: maxResponseTokens,
            maxFramesPerChunk: maxFramesPerChunk,
            audioSamplesPerChunk: audioSamplesPerChunk,
            sessionID: sessionID,
            sttOnHold: sttOnHold
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
        maxFramesPerChunk: Int,
        audioSamplesPerChunk: Int,
        sessionID: String,
        sttOnHold: Bool
    ) {
        let settings = InferenceModelSettings.fromEnvironment()
        let yoloEngine = ZeticMLInferenceEngine(settings: settings)
        let sttEngine = QwenOmniTranscriptionEngine(settings: settings)
        return (
            yoloEngine,
            sttEngine,
            settings.maxFramesPerChunk,
            settings.audioSamplesPerChunk,
            settings.sessionID,
            settings.sttOnHold
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
        guard !samples.isEmpty else { return }
        audioSamples.append(contentsOf: samples)
        if audioSamples.count > audioSamplesPerChunk * 2 {
            audioSamples.removeFirst(audioSamples.count - audioSamplesPerChunk * 2)
        }
        logPollingStatusIfNeeded()
    }

    func ingestFrame(capturedAt: Date = Date(), pixelBuffer: CVPixelBuffer, audioSamples: [Float]) {
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
    private let audioSamplesPerChunk: Int
    private let sessionID: String
    private let jsonEncoder: JSONEncoder

    private var buffer: [Float] = []
    private var pending: [[Float]] = []
    private var isProcessing = false
    private var cooldownUntil: Date?
    private let onTranscript: ((TranscriptChunk) -> Void)?
    private let onError: ((String) -> Void)?
    private let onStatus: ((String) -> Void)?

    init(
        engine: AudioTranscriptionEngine,
        audioSamplesPerChunk: Int,
        sessionID: String,
        onTranscript: ((TranscriptChunk) -> Void)? = nil,
        onError: ((String) -> Void)? = nil,
        onStatus: ((String) -> Void)? = nil
    ) {
        self.engine = engine
        self.audioSamplesPerChunk = max(audioSamplesPerChunk, 16_000)
        self.sessionID = sessionID
        self.onTranscript = onTranscript
        self.onError = onError
        self.onStatus = onStatus
        self.jsonEncoder = JSONEncoder()
        self.jsonEncoder.dateEncodingStrategy = .iso8601
        self.jsonEncoder.outputFormatting = [.sortedKeys]
    }

    func ingestAudioSamples(_ samples: [Float]) {
        guard !samples.isEmpty else { return }
        buffer.append(contentsOf: samples)

        while buffer.count >= audioSamplesPerChunk {
            let chunk = Array(buffer.prefix(audioSamplesPerChunk))
            buffer.removeFirst(audioSamplesPerChunk)
            pending.append(chunk)
            print("[Responder][STT][Pipeline] Queued chunk samples=\(chunk.count) pending=\(pending.count)")
        }

        onStatus?("Buffered \(buffer.count) samples, queued \(pending.count) chunk(s)")

        if pending.count > 2 {
            pending.removeFirst(pending.count - 2)
        }

        processNextIfNeeded()
    }

    private func processNextIfNeeded() {
        guard !isProcessing, !pending.isEmpty else { return }
        if let cooldownUntil, Date() < cooldownUntil {
            let seconds = Int(ceil(cooldownUntil.timeIntervalSinceNow))
            onStatus?("STT cooling down after error (\(max(seconds, 1))s)")
            return
        }
        isProcessing = true
        let audioChunk = pending.removeFirst()
        let startedAt = Date()
        print("[Responder][STT][Pipeline] Processing chunk samples=\(audioChunk.count), remaining=\(pending.count)")
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
                onStatus?("STT chunk complete")
                cooldownUntil = nil
                onTranscript?(payload)
            } catch {
                cooldownUntil = Date().addingTimeInterval(10)
                onStatus?("STT failed")
                onError?(error.localizedDescription)
            }
        }
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
