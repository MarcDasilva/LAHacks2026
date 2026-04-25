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
    @Published private(set) var lastInferenceError: String?
    @Published var speakTranscript = true
    @Published private(set) var sttOnHold = false
    @Published private(set) var frameStreamStatus = "idle"
    @Published private(set) var streamedFrameCount = 0

    let captureService = CameraCaptureService()
    let frameStreamSettings = FrameStreamSettings.fromEnvironment()
    private var transcriptPipeline: ChunkedTranscriptPipeline!
    private let speechPlayer = SpeechPlaybackService()
    nonisolated(unsafe) private var frameStreamClient: FrameStreamClient!

    override init() {
        let inference = InferenceEngineFactory.makeEngine()
        super.init()
        self.inferenceModelName = inference.engine.modelMetadata.name
        self.sttOnHold = inference.sttOnHold
        self.latestTranscript = inference.sttOnHold ? "STT is currently on hold." : "Waiting for transcript..."
        self.transcriptPipeline = ChunkedTranscriptPipeline(
            engine: inference.engine,
            maxFramesPerChunk: inference.maxFramesPerChunk,
            audioSamplesPerChunk: inference.audioSamplesPerChunk,
            sessionID: inference.sessionID,
            onTranscript: { [weak self] payload in
                Task { @MainActor in
                    let text = payload.output.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    self?.latestTranscript = text.isEmpty ? "[empty transcript]" : text
                    self?.lastInferenceError = nil
                    if self?.speakTranscript == true,
                       text != "[stt_unavailable] Decoder returned no tokens.",
                       text != "[stt_unavailable] Apple Speech returned no text." {
                        self?.speechPlayer.speak(text)
                    }
                }
            },
            onError: { [weak self] message in
                Task { @MainActor in
                    self?.lastInferenceError = message
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
        Task {
            let granted = await captureService.requestPermissionIfNeeded()
            guard granted else {
                permissionDenied = true
                return
            }
            permissionDenied = false
            captureService.startRunning()
            frameStreamClient.start()
        }
    }

    func stopCamera() {
        captureService.stopRunning()
        frameStreamClient.stop()
    }

    func setSTTEnabled(_ enabled: Bool) {
        sttOnHold = !enabled
        if sttOnHold {
            latestTranscript = "STT is currently on hold."
        } else if latestTranscript == "STT is currently on hold." {
            latestTranscript = "Waiting for transcript..."
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
            self.transcriptPipeline.ingestFrame(
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
            if self.sttOnHold { return }
            self.transcriptPipeline.ingestAudioSamples(samples)
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
        if localStreamDescription.mFormatFlags & kAudioFormatFlagIsFloat != 0 {
            let sampleCount = byteCount / MemoryLayout<Float>.size
            let raw = dataPointer.bindMemory(to: Float.self, capacity: sampleCount)
            let values = Array(UnsafeBufferPointer(start: raw, count: sampleCount))
            return downmixToMono(values, channelCount: channelCount)
        }

        if localStreamDescription.mBitsPerChannel == 16 {
            let sampleCount = byteCount / MemoryLayout<Int16>.size
            let raw = dataPointer.bindMemory(to: Int16.self, capacity: sampleCount)
            let values = Array(UnsafeBufferPointer(start: raw, count: sampleCount)).map { Float($0) / Float(Int16.max) }
            return downmixToMono(values, channelCount: channelCount)
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

            VStack(alignment: .leading, spacing: 6) {
                Text("Latest transcript:")
                    .font(.headline)
                Text(viewModel.latestTranscript)
                    .frame(maxWidth: .infinity, alignment: .leading)
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
