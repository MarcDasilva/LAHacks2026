import AVFoundation
import CoreImage
import Foundation
import QuartzCore
import UIKit

struct FrameStreamSettings {
    let enabled: Bool
    let wsURLString: String
    let roomID: String
    let targetFPS: Int
    let jpegQuality: CGFloat

    static func fromEnvironment(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> FrameStreamSettings {
        let wsURLString = sanitizeEnvValue(environment["RESPONDER_FRAME_STREAM_WS_URL"]) ?? "ws://localhost:8787"
        let roomID = sanitizeEnvValue(environment["RESPONDER_FRAME_STREAM_ROOM_ID"]) ?? "main-camera"
        let enabled = Self.parseBool(sanitizeEnvValue(environment["RESPONDER_FRAME_STREAM_ENABLED"]), defaultValue: true)
        let targetFPS = max(sanitizeEnvValue(environment["RESPONDER_FRAME_STREAM_FPS"]).flatMap(Int.init) ?? 10, 1)
        let qualityRaw = sanitizeEnvValue(environment["RESPONDER_FRAME_STREAM_JPEG_QUALITY"]).flatMap(Double.init) ?? 0.65
        let jpegQuality = CGFloat(min(max(qualityRaw, 0.1), 0.95))

        return FrameStreamSettings(
            enabled: enabled,
            wsURLString: wsURLString,
            roomID: roomID,
            targetFPS: targetFPS,
            jpegQuality: jpegQuality
        )
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

    private static func sanitizeEnvValue(_ value: String?) -> String? {
        guard var value else { return nil }
        value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("=") {
            value.removeFirst()
            value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        value = value.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
        return value.isEmpty ? nil : value
    }
}

final class FrameStreamClient: NSObject {
    private enum State: String {
        case idle
        case disabled
        case connecting
        case connected
        case disconnected
        case invalidURL
    }

    private let settings: FrameStreamSettings
    private let stateHandler: @MainActor (String) -> Void
    private let frameSentHandler: @MainActor () -> Void

    private let sendQueue = DispatchQueue(label: "com.lahacks.responder.frame-stream.send")
    private let ciContext = CIContext()
    private var urlSession: URLSession?
    private var webSocketTask: URLSessionWebSocketTask?
    private var reconnectWorkItem: DispatchWorkItem?
    private var isRunning = false
    private var isConnected = false
    private var lastSentUptime: CFTimeInterval = 0

    init(
        settings: FrameStreamSettings,
        stateHandler: @escaping @MainActor (String) -> Void,
        frameSentHandler: @escaping @MainActor () -> Void
    ) {
        self.settings = settings
        self.stateHandler = stateHandler
        self.frameSentHandler = frameSentHandler
        super.init()

        Task { @MainActor in
            stateHandler(settings.enabled ? State.idle.rawValue : State.disabled.rawValue)
        }
    }

    func start() {
        sendQueue.async { [weak self] in
            guard let self else { return }
            guard settings.enabled else {
                self.publishState(.disabled)
                return
            }
            guard !isRunning else { return }

            isRunning = true
            connect()
        }
    }

    func stop() {
        sendQueue.async { [weak self] in
            guard let self else { return }
            isRunning = false
            isConnected = false
            reconnectWorkItem?.cancel()
            reconnectWorkItem = nil
            webSocketTask?.cancel(with: .goingAway, reason: nil)
            webSocketTask = nil
            urlSession?.invalidateAndCancel()
            urlSession = nil
            publishState(.idle)
        }
    }

    func sendVideoSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        guard settings.enabled else { return }
        var canSend = false
        sendQueue.sync {
            canSend = isRunning && isConnected && webSocketTask != nil
        }
        guard canSend else { return }

        let now = CACurrentMediaTime()
        let minInterval = 1.0 / Double(settings.targetFPS)
        if now - lastSentUptime < minInterval {
            return
        }

        guard let jpegData = Self.encodeJPEG(sampleBuffer: sampleBuffer, quality: settings.jpegQuality, ciContext: ciContext) else {
            return
        }
        lastSentUptime = now

        sendQueue.async { [weak self] in
            guard let self else { return }
            guard isRunning, isConnected, let webSocketTask else { return }

            webSocketTask.send(.data(jpegData)) { [weak self] error in
                guard let self else { return }
                if error == nil {
                    Task { @MainActor in
                        self.frameSentHandler()
                    }
                } else {
                    self.publishState(.disconnected)
                }
            }
        }
    }

    private func connect() {
        guard let url = URL(string: settings.wsURLString) else {
            publishState(.invalidURL)
            return
        }

        publishState(.connecting)
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: url)
        urlSession = session
        webSocketTask = task
        task.resume()
        receiveMessages()
    }

    private func receiveMessages() {
        webSocketTask?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    if text.contains("\"sender-replaced\"") {
                        self.publishState(.disconnected)
                    }
                case .data:
                    break
                @unknown default:
                    break
                }

                self.receiveMessages()
            case .failure:
                self.isConnected = false
                self.publishState(.disconnected)
                self.scheduleReconnect()
            }
        }
    }

    private func sendJoinMessage() {
        let payload = #"{"type":"join","role":"sender","roomId":"\#(settings.roomID)"}"#
        webSocketTask?.send(.string(payload)) { [weak self] error in
            guard let self else { return }
            if error != nil {
                self.isConnected = false
                self.publishState(.disconnected)
                self.scheduleReconnect()
            }
        }
    }

    private func scheduleReconnect() {
        sendQueue.async { [weak self] in
            guard let self else { return }
            guard isRunning else { return }

            reconnectWorkItem?.cancel()
            let item = DispatchWorkItem { [weak self] in
                guard let self else { return }
                guard self.isRunning else { return }
                self.connect()
            }
            reconnectWorkItem = item
            sendQueue.asyncAfter(deadline: .now() + 1.0, execute: item)
        }
    }

    private func publishState(_ state: State) {
        Task { @MainActor in
            stateHandler(state.rawValue)
        }
    }

    private static func encodeJPEG(sampleBuffer: CMSampleBuffer, quality: CGFloat, ciContext: CIContext) -> Data? {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = ciContext.createCGImage(image, from: image.extent) else { return nil }
        return autoreleasepool {
            UIImage(cgImage: cgImage).jpegData(compressionQuality: quality)
        }
    }
}

extension FrameStreamClient: URLSessionWebSocketDelegate {
    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol `protocol`: String?
    ) {
        sendQueue.async { [weak self] in
            guard let self else { return }
            guard isRunning else { return }
            isConnected = true
            publishState(.connected)
            sendJoinMessage()
        }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        sendQueue.async { [weak self] in
            guard let self else { return }
            self.isConnected = false
            self.publishState(.disconnected)
            self.scheduleReconnect()
        }
    }
}
