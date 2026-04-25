import AVFoundation
import CoreImage
import Foundation
import QuartzCore
import UIKit
#if canImport(WebRTC)
import WebRTC
#endif

enum FrameStreamTransport: String {
    case webrtc
    case jpeg
}

struct FrameStreamSettings {
    let enabled: Bool
    let wsURLString: String
    let roomID: String
    let targetFPS: Int
    let jpegQuality: CGFloat
    let maxFrameDimension: CGFloat
    let transport: FrameStreamTransport
    let maxBitrateKbps: Int

    static func fromEnvironment(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> FrameStreamSettings {
        let wsURLString = sanitizeEnvValue(environment["RESPONDER_FRAME_STREAM_WS_URL"]) ?? "ws://localhost:8787"
        let roomID = sanitizeEnvValue(environment["RESPONDER_FRAME_STREAM_ROOM_ID"]) ?? "main-camera"
        let enabled = Self.parseBool(sanitizeEnvValue(environment["RESPONDER_FRAME_STREAM_ENABLED"]), defaultValue: true)
        let targetFPS = max(sanitizeEnvValue(environment["RESPONDER_FRAME_STREAM_FPS"]).flatMap(Int.init) ?? 24, 1)
        let qualityRaw = sanitizeEnvValue(environment["RESPONDER_FRAME_STREAM_JPEG_QUALITY"]).flatMap(Double.init) ?? 0.65
        let jpegQuality = CGFloat(min(max(qualityRaw, 0.1), 0.95))
        let maxDimensionRaw = sanitizeEnvValue(environment["RESPONDER_FRAME_STREAM_MAX_DIMENSION"]).flatMap(Double.init) ?? 960
        let maxFrameDimension = CGFloat(max(maxDimensionRaw, 160))
        let transportValue = sanitizeEnvValue(environment["RESPONDER_FRAME_STREAM_TRANSPORT"])?.lowercased() ?? FrameStreamTransport.webrtc.rawValue
        let transport = FrameStreamTransport(rawValue: transportValue) ?? .webrtc
        let maxBitrateKbps = max(sanitizeEnvValue(environment["RESPONDER_FRAME_STREAM_MAX_BITRATE_KBPS"]).flatMap(Int.init) ?? 2200, 150)

        return FrameStreamSettings(
            enabled: enabled,
            wsURLString: wsURLString,
            roomID: roomID,
            targetFPS: targetFPS,
            jpegQuality: jpegQuality,
            maxFrameDimension: maxFrameDimension,
            transport: transport,
            maxBitrateKbps: maxBitrateKbps
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
    private var isSendInFlight = false
    private var lastSentUptime: CFTimeInterval = 0

    #if canImport(WebRTC)
    private var peerFactory: RTCPeerConnectionFactory?
    private var localVideoSource: RTCVideoSource?
    private var localVideoTrack: RTCVideoTrack?
    private var localVideoCapturer: RTCVideoCapturer?
    private var peerConnections: [String: RTCPeerConnection] = [:]
    private var peerLookup: [ObjectIdentifier: String] = [:]
    private var pendingIceCandidates: [String: [RTCIceCandidate]] = [:]
    #endif

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
                publishState(.disabled)
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
            isSendInFlight = false
            reconnectWorkItem?.cancel()
            reconnectWorkItem = nil
            webSocketTask?.cancel(with: .goingAway, reason: nil)
            webSocketTask = nil
            urlSession?.invalidateAndCancel()
            urlSession = nil
            closeAllPeers()
            publishState(.idle)
        }
    }

    func sendVideoSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        guard settings.enabled else { return }
        let now = CACurrentMediaTime()
        let minInterval = 1.0 / Double(settings.targetFPS)
        if now - lastSentUptime < minInterval {
            return
        }
        lastSentUptime = now

        switch settings.transport {
        case .webrtc:
            #if canImport(WebRTC)
            sendQueue.async { [weak self] in
                self?.sendWebRTCFrame(sampleBuffer)
            }
            #else
            sendQueue.async { [weak self] in
                self?.sendJPEGFrame(sampleBuffer)
            }
            #endif
        case .jpeg:
            sendQueue.async { [weak self] in
                self?.sendJPEGFrame(sampleBuffer)
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
                    self.sendQueue.async { [weak self] in
                        self?.handleSignalingMessage(text)
                    }
                case .data:
                    break
                @unknown default:
                    break
                }
                self.receiveMessages()
            case .failure:
                self.sendQueue.async { [weak self] in
                    guard let self else { return }
                    self.isConnected = false
                    self.isSendInFlight = false
                    self.closeAllPeers()
                    self.publishState(.disconnected)
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func handleSignalingMessage(_ text: String) {
        guard
            let data = text.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let type = json["type"] as? String
        else { return }

        switch type {
        case "sender-replaced":
            publishState(.disconnected)
        case "viewer-joined":
            guard let viewerID = json["viewerId"] as? String else { return }
            startPeerNegotiation(for: viewerID)
        case "viewer-left":
            guard let viewerID = json["viewerId"] as? String else { return }
            closePeer(viewerID: viewerID)
        case "signal":
            guard
                let fromID = json["fromId"] as? String,
                let signalData = json["data"] as? [String: Any]
            else { return }
            handleRemoteSignal(fromID: fromID, signalData: signalData)
        default:
            break
        }
    }

    private func sendJoinMessage() {
        let payload = #"{"type":"join","role":"sender","roomId":"\#(settings.roomID)"}"#
        webSocketTask?.send(.string(payload)) { [weak self] error in
            guard let self else { return }
            if error != nil {
                self.sendQueue.async { [weak self] in
                    guard let self else { return }
                    self.isConnected = false
                    self.isSendInFlight = false
                    self.closeAllPeers()
                    self.publishState(.disconnected)
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func scheduleReconnect() {
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

    private func publishState(_ state: State) {
        Task { @MainActor in
            stateHandler(state.rawValue)
        }
    }

    private func sendJPEGFrame(_ sampleBuffer: CMSampleBuffer) {
        guard isRunning, isConnected, webSocketTask != nil, !isSendInFlight else { return }
        guard let jpegData = Self.encodeJPEG(
            sampleBuffer: sampleBuffer,
            quality: settings.jpegQuality,
            maxDimension: settings.maxFrameDimension,
            ciContext: ciContext
        ) else { return }

        isSendInFlight = true
        webSocketTask?.send(.data(jpegData)) { [weak self] error in
            guard let self else { return }
            self.sendQueue.async {
                self.isSendInFlight = false
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

    private static func encodeJPEG(
        sampleBuffer: CMSampleBuffer,
        quality: CGFloat,
        maxDimension: CGFloat,
        ciContext: CIContext
    ) -> Data? {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = ciContext.createCGImage(image, from: image.extent) else { return nil }
        return autoreleasepool {
            let original = UIImage(cgImage: cgImage)
            let width = original.size.width
            let height = original.size.height
            let longest = max(width, height)
            guard longest > 0 else { return nil }
            let scale = min(1, maxDimension / longest)
            let output: UIImage
            if scale < 1 {
                let targetSize = CGSize(
                    width: max(1, floor(width * scale)),
                    height: max(1, floor(height * scale))
                )
                let format = UIGraphicsImageRendererFormat.default()
                format.opaque = true
                let renderer = UIGraphicsImageRenderer(size: targetSize, format: format)
                output = renderer.image { _ in
                    original.draw(in: CGRect(origin: .zero, size: targetSize))
                }
            } else {
                output = original
            }
            return output.jpegData(compressionQuality: quality)
        }
    }

    #if canImport(WebRTC)
    private func setupWebRTCIfNeeded() {
        guard peerFactory == nil else { return }
        RTCInitializeSSL()
        let encoderFactory = RTCDefaultVideoEncoderFactory()
        let decoderFactory = RTCDefaultVideoDecoderFactory()
        let factory = RTCPeerConnectionFactory(encoderFactory: encoderFactory, decoderFactory: decoderFactory)
        let source = factory.videoSource()
        let track = factory.videoTrack(with: source, trackId: "camera-video")
        let capturer = RTCVideoCapturer(delegate: source)
        peerFactory = factory
        localVideoSource = source
        localVideoTrack = track
        localVideoCapturer = capturer
    }

    private func createPeer(viewerID: String) -> RTCPeerConnection? {
        setupWebRTCIfNeeded()
        guard let factory = peerFactory, let track = localVideoTrack else { return nil }
        if let existing = peerConnections[viewerID] {
            return existing
        }

        let config = RTCConfiguration()
        config.iceServers = [RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])]
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherContinually
        let constraints = RTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: ["DtlsSrtpKeyAgreement": "true"]
        )
        guard let pc = factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
            return nil
        }

        if let sender = pc.add(track, streamIds: ["stream-main"]) {
            var parameters = sender.parameters
            if !parameters.encodings.isEmpty {
                parameters.encodings[0].maxBitrateBps = NSNumber(value: settings.maxBitrateKbps * 1000)
                parameters.encodings[0].maxFramerate = NSNumber(value: settings.targetFPS)
            }
            sender.parameters = parameters
        }

        peerConnections[viewerID] = pc
        peerLookup[ObjectIdentifier(pc)] = viewerID
        pendingIceCandidates[viewerID] = []
        return pc
    }

    private func startPeerNegotiation(for viewerID: String) {
        guard let pc = createPeer(viewerID: viewerID) else { return }
        let constraints = RTCMediaConstraints(
            mandatoryConstraints: ["OfferToReceiveAudio": "false", "OfferToReceiveVideo": "false"],
            optionalConstraints: nil
        )
        pc.offer(for: constraints) { [weak self] sdp, _ in
            guard let self, let sdp else { return }
            self.sendQueue.async { [weak self] in
                guard let self else { return }
                pc.setLocalDescription(sdp) { [weak self] _ in
                    guard let self else { return }
                    self.sendSignal(
                        targetID: viewerID,
                        data: ["description": ["type": sdp.type.stringValue, "sdp": sdp.sdp]]
                    )
                }
            }
        }
    }

    private func handleRemoteSignal(fromID: String, signalData: [String: Any]) {
        guard let pc = createPeer(viewerID: fromID) else { return }

        if let description = signalData["description"] as? [String: Any],
           let typeRaw = description["type"] as? String,
           let type = RTCSdpType.fromString(typeRaw),
           let sdpText = description["sdp"] as? String {
            let sdp = RTCSessionDescription(type: type, sdp: sdpText)
            pc.setRemoteDescription(sdp) { [weak self] _ in
                guard let self else { return }
                self.sendQueue.async { [weak self] in
                    guard let self else { return }
                    if type == .offer {
                        let constraints = RTCMediaConstraints(
                            mandatoryConstraints: ["OfferToReceiveAudio": "false", "OfferToReceiveVideo": "false"],
                            optionalConstraints: nil
                        )
                        pc.answer(for: constraints) { [weak self] answer, _ in
                            guard let self, let answer else { return }
                            self.sendQueue.async { [weak self] in
                                guard let self else { return }
                                pc.setLocalDescription(answer) { [weak self] _ in
                                    guard let self else { return }
                                    self.sendSignal(
                                        targetID: fromID,
                                        data: ["description": ["type": answer.type.stringValue, "sdp": answer.sdp]]
                                    )
                                }
                            }
                        }
                    }

                    let queued = self.pendingIceCandidates[fromID] ?? []
                    for candidate in queued {
                        pc.add(candidate)
                    }
                    self.pendingIceCandidates[fromID] = []
                }
            }
        }

        if let candidateJSON = signalData["candidate"] as? [String: Any],
           let candidateText = candidateJSON["candidate"] as? String {
            let sdpMid = candidateJSON["sdpMid"] as? String
            let sdpMLineIndex = Int32(candidateJSON["sdpMLineIndex"] as? Int ?? 0)
            let candidate = RTCIceCandidate(sdp: candidateText, sdpMLineIndex: sdpMLineIndex, sdpMid: sdpMid)
            if pc.remoteDescription != nil {
                pc.add(candidate)
            } else {
                var queue = pendingIceCandidates[fromID] ?? []
                queue.append(candidate)
                pendingIceCandidates[fromID] = queue
            }
        }
    }

    private func sendSignal(targetID: String, data: [String: Any]) {
        guard let payloadData = try? JSONSerialization.data(withJSONObject: [
            "type": "signal",
            "targetId": targetID,
            "data": data,
        ]) else { return }
        guard let payload = String(data: payloadData, encoding: .utf8) else { return }
        webSocketTask?.send(.string(payload)) { _ in }
    }

    private func sendWebRTCFrame(_ sampleBuffer: CMSampleBuffer) {
        guard isRunning, isConnected else { return }
        setupWebRTCIfNeeded()
        guard let source = localVideoSource, let capturer = localVideoCapturer else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let timeStamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let timeStampNs: Int64
        if timeStamp.isValid {
            timeStampNs = Int64(CMTimeGetSeconds(timeStamp) * 1_000_000_000)
        } else {
            timeStampNs = Int64(CACurrentMediaTime() * 1_000_000_000)
        }
        let rtcBuffer = RTCCVPixelBuffer(pixelBuffer: pixelBuffer)
        let frame = RTCVideoFrame(buffer: rtcBuffer, rotation: ._0, timeStampNs: timeStampNs)
        source.capturer(capturer, didCapture: frame)
        Task { @MainActor in
            frameSentHandler()
        }
    }

    private func closePeer(viewerID: String) {
        if let pc = peerConnections.removeValue(forKey: viewerID) {
            peerLookup.removeValue(forKey: ObjectIdentifier(pc))
            pc.close()
        }
        pendingIceCandidates.removeValue(forKey: viewerID)
    }

    private func closeAllPeers() {
        for pc in peerConnections.values {
            pc.close()
        }
        peerConnections.removeAll()
        peerLookup.removeAll()
        pendingIceCandidates.removeAll()
    }
    #else
    private func closeAllPeers() {}
    #endif
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
            isSendInFlight = false
            sendJoinMessage()
            publishState(.connected)
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
            isConnected = false
            isSendInFlight = false
            closeAllPeers()
            publishState(.disconnected)
            scheduleReconnect()
        }
    }
}

#if canImport(WebRTC)
extension FrameStreamClient: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didStartReceivingOn transceiver: RTCRtpTransceiver) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams: [RTCMediaStream]) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        sendQueue.async { [weak self] in
            guard let self else { return }
            guard let viewerID = self.peerLookup[ObjectIdentifier(peerConnection)] else { return }
            self.sendSignal(
                targetID: viewerID,
                data: [
                    "candidate": [
                        "candidate": candidate.sdp,
                        "sdpMid": candidate.sdpMid ?? "",
                        "sdpMLineIndex": Int(candidate.sdpMLineIndex),
                    ],
                ]
            )
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        if newState == .failed || newState == .closed || newState == .disconnected {
            sendQueue.async { [weak self] in
                guard let self else { return }
                guard let viewerID = self.peerLookup[ObjectIdentifier(peerConnection)] else { return }
                self.closePeer(viewerID: viewerID)
            }
        }
    }
}

private extension RTCSdpType {
    var stringValue: String {
        switch self {
        case .offer: return "offer"
        case .prAnswer: return "pranswer"
        case .answer: return "answer"
        case .rollback: return "rollback"
        @unknown default: return "offer"
        }
    }

    static func fromString(_ value: String) -> RTCSdpType? {
        switch value.lowercased() {
        case "offer": return .offer
        case "answer": return .answer
        case "pranswer": return .prAnswer
        case "rollback": return .rollback
        default: return nil
        }
    }
}
#endif
