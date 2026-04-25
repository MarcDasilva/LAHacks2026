import AVFoundation
import SwiftUI

@MainActor
final class CameraViewModel: NSObject, ObservableObject {
    @Published private(set) var capturedFrameCount = 0
    @Published private(set) var capturedAudioBufferCount = 0
    @Published private(set) var lastFrameTimestamp: Date?
    @Published private(set) var permissionDenied = false
    @Published private(set) var inferenceModelName = ""
    @Published private(set) var latestTranscript = "Waiting for transcript..."
    @Published private(set) var latestDetections = "Waiting for detections..."
    @Published private(set) var lastInferenceError: String?
    @Published private(set) var sttError: String?
    @Published private(set) var yoloError: String?
    @Published private(set) var sttPipelineStatus = "Idle"
    @Published var speakTranscript = true
    @Published private(set) var sttOnHold = false
    @Published private(set) var yoloOnHold = false
    @Published private(set) var frameStreamStatus = "idle"
    @Published private(set) var streamedFrameCount = 0

    let captureService = CameraCaptureService()
    let frameStreamSettings = FrameStreamSettings.fromEnvironment()
    private var yoloPipeline: ChunkedTranscriptPipeline!
    private var audioPipeline: ChunkedAudioTranscriptionPipeline!
    private let speechPlayer = SpeechPlaybackService()
    nonisolated(unsafe) private var frameStreamClient: FrameStreamClient!

    override init() {
        let inference = InferenceEngineFactory.makeEngines()
        super.init()
        print("[Responder][STT] ViewModel initialized. sttOnHold=\(inference.sttOnHold)")
        self.inferenceModelName = "\(inference.yoloEngine.modelMetadata.name) + \(inference.sttEngine.modelMetadata.name)"
        self.sttOnHold = inference.sttOnHold
        self.latestTranscript = inference.sttOnHold ? "STT is currently on hold." : "Waiting for transcript..."
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
            onTranscript: { [weak self] payload in
                Task { @MainActor in
                    let text = payload.output.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    print("[Responder][STT] Transcript chunk=\(payload.chunk.chunkID) text=\(text)")
                    self?.latestTranscript = text.isEmpty ? "[empty transcript]" : text
                    self?.sttError = nil
                    self?.lastInferenceError = self?.yoloError
                    if self?.speakTranscript == true,
                       text != "[stt_unavailable] Decoder returned no tokens.",
                       text != "[stt_unavailable] Encoder returned no embeddings." {
                        self?.speechPlayer.speak(text)
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
    }

    func startCamera() {
        print("[Responder] startCamera called")
        Task {
            let granted = await captureService.requestPermissionIfNeeded()
            print("[Responder] Camera permission granted=\(granted) audioAuth=\(captureService.audioAuthorizationStatus.rawValue)")
            guard granted else {
                permissionDenied = true
                return
            }
            permissionDenied = false
            if captureService.audioAuthorizationStatus != .authorized {
                latestTranscript = "[stt_unavailable] Microphone permission not granted."
                sttPipelineStatus = "No microphone permission"
            } else if !sttOnHold {
                sttPipelineStatus = "Listening..."
            }
            captureService.startRunning()
            frameStreamClient.start()
            startSTTWatchdog()
        }
    }

    func stopCamera() {
        captureService.stopRunning()
        frameStreamClient.stop()
    }

    func setSTTEnabled(_ enabled: Bool) {
        print("[Responder][STT] Toggle requested enabled=\(enabled)")
        sttOnHold = !enabled
        if sttOnHold {
            latestTranscript = "STT is currently on hold."
            sttPipelineStatus = "Paused"
            print("[Responder][STT] Paused")
        } else if latestTranscript == "STT is currently on hold." {
            latestTranscript = "Waiting for transcript..."
            sttPipelineStatus = "Listening..."
            print("[Responder][STT] Resumed and listening")
            startSTTWatchdog()
        }
    }

    func setYOLOEnabled(_ enabled: Bool) {
        yoloOnHold = !enabled
        if yoloOnHold {
            latestDetections = "YOLO is currently on hold."
        } else if latestDetections == "YOLO is currently on hold." {
            latestDetections = "Waiting for detections..."
        }
    }

    private func startSTTWatchdog() {
        print("[Responder][STT] Watchdog armed")
        Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !self.sttOnHold else { return }
            if self.captureService.audioAuthorizationStatus != .authorized {
                self.latestTranscript = "[stt_unavailable] Microphone permission not granted."
                self.sttPipelineStatus = "No microphone permission"
                print("[Responder][STT][WATCHDOG] No mic permission")
                return
            }
            if let setupError = self.captureService.audioSetupErrorMessage {
                self.latestTranscript = "[stt_unavailable] \(setupError)"
                self.sttPipelineStatus = "Audio setup failed"
                print("[Responder][STT][WATCHDOG] Audio setup error: \(setupError)")
                return
            }
            if !self.captureService.isAudioCaptureConfigured {
                self.latestTranscript = "[stt_unavailable] Audio capture pipeline is not configured."
                self.sttPipelineStatus = "Audio capture not configured"
                print("[Responder][STT][WATCHDOG] Audio capture not configured")
                return
            }
            if self.capturedAudioBufferCount == 0 {
                self.latestTranscript = "[stt_unavailable] No microphone audio buffers received after start."
                self.sttPipelineStatus = "No audio buffers"
                print("[Responder][STT][WATCHDOG] No audio buffers received")
            } else {
                print("[Responder][STT][WATCHDOG] Audio buffers seen count=\(self.capturedAudioBufferCount)")
            }
        }
    }
}

extension CameraViewModel: CameraCaptureServiceDelegate {
    nonisolated func cameraCaptureService(_ service: CameraCaptureService, didOutputVideo sampleBuffer: CMSampleBuffer) {
        frameStreamClient.sendVideoSampleBuffer(sampleBuffer)
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.capturedFrameCount += 1
            self.lastFrameTimestamp = Date()
            if self.yoloOnHold { return }
            self.yoloPipeline.ingestFrame(
                capturedAt: self.lastFrameTimestamp ?? Date(),
                pixelBuffer: pixelBuffer,
                audioSamples: []
            )
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
            if !self.sttOnHold {
                self.sttPipelineStatus = "Receiving audio buffers: \(self.capturedAudioBufferCount)"
            }
            if !self.yoloOnHold {
                self.yoloPipeline.ingestAudioSamples(samples)
            }
            if self.sttOnHold { return }
            self.audioPipeline.ingestAudioSamples(samples)
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
            .frame(maxWidth: .infinity, alignment: .leading)

            Toggle("Speak transcript (TTS)", isOn: $viewModel.speakTranscript)
            Button(viewModel.sttOnHold ? "Enable STT" : "Pause STT") {
                viewModel.setSTTEnabled(viewModel.sttOnHold)
            }
            .buttonStyle(.borderedProminent)
            .tint(viewModel.sttOnHold ? .green : .orange)

            Button(viewModel.yoloOnHold ? "Enable YOLO" : "Pause YOLO") {
                viewModel.setYOLOEnabled(viewModel.yoloOnHold)
            }
            .buttonStyle(.borderedProminent)
            .tint(viewModel.yoloOnHold ? .green : .blue)

            VStack(spacing: 12) {
                pipelineCard(
                    title: "Audio Pipeline (Qwen STT)",
                    subtitle: "Microphone -> Mel -> Audio Encoder -> LLM Decoder",
                    status: sttStatusLabel,
                    statusColor: sttStatusColor,
                    bodyText: "\(viewModel.latestTranscript)\n\nStatus: \(viewModel.sttPipelineStatus)"
                )

                pipelineCard(
                    title: "Vision Pipeline (YOLO)",
                    subtitle: "Camera Frame -> YOLO Inference -> Detections",
                    status: yoloStatusLabel,
                    statusColor: yoloStatusColor,
                    bodyText: viewModel.latestDetections
                )
            }
            .frame(maxWidth: .infinity, alignment: .leading)

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
        }
        .padding()
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
        bodyText: String
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
        }
        .padding(12)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

#Preview {
    ContentView()
}

final class SpeechPlaybackService {
    private let synthesizer = AVSpeechSynthesizer()

    func speak(_ text: String) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = 0.48
        synthesizer.stopSpeaking(at: .immediate)
        synthesizer.speak(utterance)
    }
}
