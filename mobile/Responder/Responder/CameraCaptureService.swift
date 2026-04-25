import AVFoundation
import CoreMedia
import Foundation

protocol CameraCaptureServiceDelegate: AnyObject {
    func cameraCaptureService(_ service: CameraCaptureService, didOutputVideo sampleBuffer: CMSampleBuffer)
    func cameraCaptureService(_ service: CameraCaptureService, didOutputAudio sampleBuffer: CMSampleBuffer)
}

final class CameraCaptureService: NSObject, ObservableObject {
    enum CameraCaptureError: LocalizedError {
        case permissionDenied
        case microphonePermissionDenied
        case noCameraDevice
        case noMicrophoneDevice
        case cannotAddInput
        case cannotAddAudioInput
        case cannotAddOutput
        case cannotAddAudioOutput

        var errorDescription: String? {
            switch self {
            case .permissionDenied:
                return "Camera access was denied."
            case .microphonePermissionDenied:
                return "Microphone access was denied."
            case .noCameraDevice:
                return "No suitable camera device was found."
            case .noMicrophoneDevice:
                return "No suitable microphone device was found."
            case .cannotAddInput:
                return "Unable to add the camera input."
            case .cannotAddAudioInput:
                return "Unable to add the microphone input."
            case .cannotAddOutput:
                return "Unable to add the video output."
            case .cannotAddAudioOutput:
                return "Unable to add the audio output."
            }
        }
    }

    @Published private(set) var isSessionRunning = false
    @Published private(set) var authorizationStatus = AVCaptureDevice.authorizationStatus(for: .video)
    @Published private(set) var audioAuthorizationStatus = AVCaptureDevice.authorizationStatus(for: .audio)

    let session = AVCaptureSession()
    weak var delegate: CameraCaptureServiceDelegate?

    private let sessionQueue = DispatchQueue(label: "com.lahacks.responder.camera.session")
    private let videoOutputQueue = DispatchQueue(label: "com.lahacks.responder.camera.frames")
    private let audioOutputQueue = DispatchQueue(label: "com.lahacks.responder.audio.frames")
    private var isConfigured = false

    func requestPermissionIfNeeded() async -> Bool {
        let currentStatus = AVCaptureDevice.authorizationStatus(for: .video)
        let currentAudioStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        await MainActor.run {
            authorizationStatus = currentStatus
            audioAuthorizationStatus = currentAudioStatus
        }

        let videoGranted: Bool
        switch currentStatus {
        case .authorized:
            videoGranted = true
        case .notDetermined:
            videoGranted = await AVCaptureDevice.requestAccess(for: .video)
            await MainActor.run {
                authorizationStatus = videoGranted ? .authorized : .denied
            }
        case .denied, .restricted:
            videoGranted = false
        @unknown default:
            videoGranted = false
        }

        // Video-only inference path (YOLO) should not be blocked by microphone permission.
        return videoGranted
    }

    func startRunning() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            do {
                try self.configureSessionIfNeeded()
                if !self.session.isRunning {
                    self.session.startRunning()
                }
                DispatchQueue.main.async {
                    self.isSessionRunning = self.session.isRunning
                }
            } catch {
                DispatchQueue.main.async {
                    self.isSessionRunning = false
                }
            }
        }
    }

    func stopRunning() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if self.session.isRunning {
                self.session.stopRunning()
            }
            self.deactivateAudioSession()
            DispatchQueue.main.async {
                self.isSessionRunning = false
            }
        }
    }

    private func configureAudioSession() throws {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(
            .playAndRecord,
            mode: .measurement,
            options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP]
        )
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
    }

    private func deactivateAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            // Keep teardown resilient if audio session is already inactive.
        }
    }

    private func configureSessionIfNeeded() throws {
        guard !isConfigured else { return }

        let status = AVCaptureDevice.authorizationStatus(for: .video)
        guard status == .authorized else {
            throw CameraCaptureError.permissionDenied
        }

        session.beginConfiguration()
        session.sessionPreset = .high

        guard
            let cameraDevice = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
            ?? AVCaptureDevice.default(for: .video)
        else {
            session.commitConfiguration()
            throw CameraCaptureError.noCameraDevice
        }

        let cameraInput = try AVCaptureDeviceInput(device: cameraDevice)
        guard session.canAddInput(cameraInput) else {
            session.commitConfiguration()
            throw CameraCaptureError.cannotAddInput
        }
        session.addInput(cameraInput)

        let videoOutput = AVCaptureVideoDataOutput()
        videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        videoOutput.alwaysDiscardsLateVideoFrames = true
        videoOutput.setSampleBufferDelegate(self, queue: videoOutputQueue)

        guard session.canAddOutput(videoOutput) else {
            session.commitConfiguration()
            throw CameraCaptureError.cannotAddOutput
        }
        session.addOutput(videoOutput)

        if let connection = videoOutput.connection(with: .video), connection.isVideoOrientationSupported {
            connection.videoOrientation = .portrait
        }

        session.commitConfiguration()
        isConfigured = true
    }
}

extension CameraCaptureService: AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        switch output {
        case is AVCaptureVideoDataOutput:
            delegate?.cameraCaptureService(self, didOutputVideo: sampleBuffer)
        case is AVCaptureAudioDataOutput:
            delegate?.cameraCaptureService(self, didOutputAudio: sampleBuffer)
        default:
            break
        }
    }
}
