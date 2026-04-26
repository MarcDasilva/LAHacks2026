import Foundation
import CoreGraphics
import CoreImage
import CoreVideo

#if canImport(ZeticMLange)
import ZeticMLange
#endif

private struct YOLODetectionLogItem: Codable {
    let item: String
    let confidence: Double
}

private struct YOLOLogBody: Codable {
    struct YOLOPayload: Codable {
        let model: String
        let version: Int?
        let chunkID: String
        let detections: [YOLODetectionLogItem]
        let metadata: [String: String]
    }

    let timestamp: Date
    let event: String
    let yolo: YOLOPayload
    let metadata: [String: String]
}

private enum TensorLayout {
    case nchw
    case nhwc
}

private struct YOLODetection {
    let classID: Int
    let confidence: Float
    let x1: Float
    let y1: Float
    let x2: Float
    let y2: Float
}

final class ZeticMLInferenceEngine: MLInferenceEngine {
    let modelMetadata: TranscriptChunk.ModelMetadata
    private let settings: InferenceModelSettings
    private let debugJSONEncoder: JSONEncoder
    private let ciContext = CIContext(options: nil)
    private let yoloInputSize = 640
    private let scoreThreshold: Float = 0.35
    private let iouThreshold: Float = 0.45

    private let cocoLabels = [
        "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light",
        "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
        "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
        "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle",
        "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
        "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant", "bed",
        "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave", "oven",
        "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush"
    ]

    init(settings: InferenceModelSettings) {
        self.settings = settings
        self.modelMetadata = TranscriptChunk.ModelMetadata(
            provider: "zetic-ai",
            name: settings.yoloModelName,
            version: settings.modelVersion,
            mode: settings.modelMode,
            latencyMS: 0
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        self.debugJSONEncoder = encoder
    }

    func runInference(for chunk: TranscriptChunk.ChunkMetadata, pixelBuffer: CVPixelBuffer, audioSamples: [Float]) async throws -> TranscriptChunk.TranscriptOutput {
        #if canImport(ZeticMLange)
        let modelMode: ModelMode
        switch settings.modelMode.uppercased() {
        case "RUN_SPEED":
            modelMode = .RUN_SPEED
        case "RUN_ACCURACY":
            modelMode = .RUN_ACCURACY
        default:
            modelMode = .RUN_AUTO
        }

        do {
            let model = try loadModelWithRetry(
                candidateKeys: settings.credentialCandidates,
                chunkID: chunk.chunkID,
                modelName: settings.yoloModelName,
                version: settings.modelVersion,
                mode: modelMode
            )

            let inputTensorNCHW = try makeYOLOInputTensor(from: pixelBuffer, layout: .nchw)

            let outputs: [Tensor]
            do {
                outputs = try model.run(inputs: [inputTensorNCHW])
            } catch {
                let inputTensorNHWC = try makeYOLOInputTensor(from: pixelBuffer, layout: .nhwc)
                outputs = try model.run(inputs: [inputTensorNHWC])
            }

            let detections = parseYOLODetections(from: outputs, sourcePixelBuffer: pixelBuffer)
            publishDetectionOverlay(detections)
            logDetectionJSON(chunkID: chunk.chunkID, detections: detections)

            let text = detections.isEmpty
                ? "No objects detected."
                : detections.map { detection in
                    "\(label(for: detection.classID)) \(Int(detection.confidence * 100))%"
                }.joined(separator: ", ")
            let confidence = Double(detections.first?.confidence ?? 0)

            return TranscriptChunk.TranscriptOutput(
                text: text,
                confidence: confidence,
                tensorCount: outputs.count
            )
        } catch {
            throw makeStageError(
                stage: "model_run",
                modelName: settings.yoloModelName,
                underlying: error
            )
        }
        #else
        throw NSError(
            domain: "Responder.Inference",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: "ZeticMLange package is not available in this build."]
        )
        #endif
    }

    #if canImport(ZeticMLange)
    private func loadModelWithRetry(
        candidateKeys: [String],
        chunkID: String,
        modelName: String,
        version: Int?,
        mode: ModelMode
    ) throws -> ZeticMLangeModel {
        var lastError: Error?
        let keys = candidateKeys.isEmpty ? [settings.personalKey] : candidateKeys
        for key in keys {
            for attempt in 1...3 {
                do {
                    return try ZeticMLangeModel(
                        personalKey: key,
                        name: modelName,
                        version: version,
                        modelMode: mode,
                        onDownload: { _ in }
                    )
                } catch {
                    lastError = error
                    if attempt < 3, isLikelyNetworkError(error) {
                        Thread.sleep(forTimeInterval: Double(attempt))
                        continue
                    }
                }
            }
        }
        throw lastError ?? NSError(domain: "Responder.Inference", code: -20, userInfo: [NSLocalizedDescriptionKey: "Failed to load model."])
    }

    private func makeYOLOInputTensor(from pixelBuffer: CVPixelBuffer, layout: TensorLayout) throws -> Tensor {
        let resized = try resizePixelBuffer(pixelBuffer, width: yoloInputSize, height: yoloInputSize)
        CVPixelBufferLockBaseAddress(resized, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(resized, .readOnly) }

        guard let baseAddress = CVPixelBufferGetBaseAddress(resized) else {
            throw NSError(domain: "Responder.Inference", code: -30, userInfo: [NSLocalizedDescriptionKey: "Failed to access resized pixel buffer memory."])
        }

        let width = CVPixelBufferGetWidth(resized)
        let height = CVPixelBufferGetHeight(resized)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(resized)
        let bytes = baseAddress.assumingMemoryBound(to: UInt8.self)

        let rgbCount = width * height * 3
        var floats = Array(repeating: Float(0), count: rgbCount)

        switch layout {
        case .nchw:
            let plane = width * height
            for y in 0..<height {
                let row = bytes + y * bytesPerRow
                for x in 0..<width {
                    let offset = x * 4
                    let b = Float(row[offset]) / 255.0
                    let g = Float(row[offset + 1]) / 255.0
                    let r = Float(row[offset + 2]) / 255.0
                    let index = y * width + x
                    floats[index] = r
                    floats[plane + index] = g
                    floats[2 * plane + index] = b
                }
            }
            return makeTensor(from: floats, shape: [1, 3, yoloInputSize, yoloInputSize])

        case .nhwc:
            for y in 0..<height {
                let row = bytes + y * bytesPerRow
                for x in 0..<width {
                    let offset = x * 4
                    let b = Float(row[offset]) / 255.0
                    let g = Float(row[offset + 1]) / 255.0
                    let r = Float(row[offset + 2]) / 255.0
                    let index = (y * width + x) * 3
                    floats[index] = r
                    floats[index + 1] = g
                    floats[index + 2] = b
                }
            }
            return makeTensor(from: floats, shape: [1, yoloInputSize, yoloInputSize, 3])
        }
    }

    private func makeTensor(from floats: [Float], shape: [Int]) -> Tensor {
        let data = floats.withUnsafeBufferPointer { Data(buffer: $0) }
        return Tensor(data: data, dataType: BuiltinDataType.float32, shape: shape)
    }

    private func resizePixelBuffer(_ pixelBuffer: CVPixelBuffer, width: Int, height: Int) throws -> CVPixelBuffer {
        var resizedBuffer: CVPixelBuffer?
        let attributes: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
            kCVPixelBufferMetalCompatibilityKey: true,
            kCVPixelBufferIOSurfacePropertiesKey: [:],
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey: width,
            kCVPixelBufferHeightKey: height
        ]
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_32BGRA,
            attributes as CFDictionary,
            &resizedBuffer
        )
        guard status == kCVReturnSuccess, let resizedBuffer else {
            throw NSError(domain: "Responder.Inference", code: -31, userInfo: [NSLocalizedDescriptionKey: "Failed to allocate resized pixel buffer."])
        }

        let sourceImage = CIImage(cvPixelBuffer: pixelBuffer)
        let sx = CGFloat(width) / sourceImage.extent.width
        let sy = CGFloat(height) / sourceImage.extent.height
        let resizedImage = sourceImage.transformed(by: CGAffineTransform(scaleX: sx, y: sy))
        ciContext.render(resizedImage, to: resizedBuffer)
        return resizedBuffer
    }

    private func parseYOLODetections(from outputs: [Tensor], sourcePixelBuffer: CVPixelBuffer) -> [YOLODetection] {
        guard let candidateTensor = outputs.max(by: { $0.data.count < $1.data.count }) else {
            return []
        }

        let shape = candidateTensor.shape
        guard !shape.isEmpty else { return [] }
        let values = tensorToFloatArray(candidateTensor)
        guard !values.isEmpty else { return [] }

        let sourceWidth = Float(CVPixelBufferGetWidth(sourcePixelBuffer))
        let sourceHeight = Float(CVPixelBufferGetHeight(sourcePixelBuffer))

        let detections: [YOLODetection]
        if shape.count == 3 && shape[0] == 1 {
            let d1 = shape[1]
            let d2 = shape[2]
            if d1 <= 256 && d2 > 100 {
                detections = decodeDetections(values: values, anchors: d2, channels: d1, channelsFirst: true, sourceWidth: sourceWidth, sourceHeight: sourceHeight)
            } else if d2 <= 256 && d1 > 100 {
                detections = decodeDetections(values: values, anchors: d1, channels: d2, channelsFirst: false, sourceWidth: sourceWidth, sourceHeight: sourceHeight)
            } else {
                detections = []
            }
        } else if shape.count == 2 {
            let d0 = shape[0]
            let d1 = shape[1]
            if d1 <= 256 && d0 > 100 {
                detections = decodeDetections(values: values, anchors: d0, channels: d1, channelsFirst: false, sourceWidth: sourceWidth, sourceHeight: sourceHeight)
            } else if d0 <= 256 && d1 > 100 {
                detections = decodeDetections(values: values, anchors: d1, channels: d0, channelsFirst: true, sourceWidth: sourceWidth, sourceHeight: sourceHeight)
            } else {
                detections = []
            }
        } else {
            detections = []
        }

        return nonMaximumSuppression(detections)
    }

    private func decodeDetections(
        values: [Float],
        anchors: Int,
        channels: Int,
        channelsFirst: Bool,
        sourceWidth: Float,
        sourceHeight: Float
    ) -> [YOLODetection] {
        guard channels > 5 else { return [] }
        var decoded: [YOLODetection] = []
        decoded.reserveCapacity(64)

        for anchor in 0..<anchors {
            let cx = value(values, anchor: anchor, channel: 0, anchors: anchors, channels: channels, channelsFirst: channelsFirst)
            let cy = value(values, anchor: anchor, channel: 1, anchors: anchors, channels: channels, channelsFirst: channelsFirst)
            let w = value(values, anchor: anchor, channel: 2, anchors: anchors, channels: channels, channelsFirst: channelsFirst)
            let h = value(values, anchor: anchor, channel: 3, anchors: anchors, channels: channels, channelsFirst: channelsFirst)

            var bestClass = 0
            var bestScore: Float = 0
            for classID in 0..<(channels - 4) {
                let score = value(values, anchor: anchor, channel: classID + 4, anchors: anchors, channels: channels, channelsFirst: channelsFirst)
                if score > bestScore {
                    bestScore = score
                    bestClass = classID
                }
            }
            if bestScore < scoreThreshold { continue }

            let box = convertBox(cx: cx, cy: cy, w: w, h: h, sourceWidth: sourceWidth, sourceHeight: sourceHeight)
            decoded.append(
                YOLODetection(
                    classID: bestClass,
                    confidence: bestScore,
                    x1: box.x1,
                    y1: box.y1,
                    x2: box.x2,
                    y2: box.y2
                )
            )
        }

        return decoded.sorted { $0.confidence > $1.confidence }
    }

    private func value(
        _ values: [Float],
        anchor: Int,
        channel: Int,
        anchors: Int,
        channels: Int,
        channelsFirst: Bool
    ) -> Float {
        let index: Int
        if channelsFirst {
            index = channel * anchors + anchor
        } else {
            index = anchor * channels + channel
        }
        guard index >= 0, index < values.count else { return 0 }
        return values[index]
    }

    private func convertBox(cx: Float, cy: Float, w: Float, h: Float, sourceWidth: Float, sourceHeight: Float) -> (x1: Float, y1: Float, x2: Float, y2: Float) {
        let normalized = max(max(abs(cx), abs(cy)), max(abs(w), abs(h))) <= 2.0
        let inX = normalized ? cx * Float(yoloInputSize) : cx
        let inY = normalized ? cy * Float(yoloInputSize) : cy
        let inW = normalized ? w * Float(yoloInputSize) : w
        let inH = normalized ? h * Float(yoloInputSize) : h

        let scaleX = sourceWidth / Float(yoloInputSize)
        let scaleY = sourceHeight / Float(yoloInputSize)

        var x1 = (inX - inW / 2) * scaleX
        var y1 = (inY - inH / 2) * scaleY
        var x2 = (inX + inW / 2) * scaleX
        var y2 = (inY + inH / 2) * scaleY

        x1 = max(0, min(x1, sourceWidth))
        y1 = max(0, min(y1, sourceHeight))
        x2 = max(0, min(x2, sourceWidth))
        y2 = max(0, min(y2, sourceHeight))
        return (x1, y1, x2, y2)
    }

    private func nonMaximumSuppression(_ detections: [YOLODetection]) -> [YOLODetection] {
        var kept: [YOLODetection] = []
        let sorted = detections.sorted { $0.confidence > $1.confidence }

        for candidate in sorted {
            var overlaps = false
            for existing in kept where iou(candidate, existing) > iouThreshold {
                overlaps = true
                break
            }
            if !overlaps {
                kept.append(candidate)
            }
        }

        return kept
    }

    private func iou(_ a: YOLODetection, _ b: YOLODetection) -> Float {
        let interX1 = max(a.x1, b.x1)
        let interY1 = max(a.y1, b.y1)
        let interX2 = min(a.x2, b.x2)
        let interY2 = min(a.y2, b.y2)
        let interW = max(0, interX2 - interX1)
        let interH = max(0, interY2 - interY1)
        let interArea = interW * interH
        let areaA = max(0, a.x2 - a.x1) * max(0, a.y2 - a.y1)
        let areaB = max(0, b.x2 - b.x1) * max(0, b.y2 - b.y1)
        let denom = areaA + areaB - interArea
        guard denom > 0 else { return 0 }
        return interArea / denom
    }

    private func tensorToFloatArray(_ tensor: Tensor) -> [Float] {
        let byteCount = tensor.data.count
        let stride = MemoryLayout<Float>.size
        let count = byteCount / stride
        guard count > 0 else { return [] }

        var floats = Array(repeating: Float(0), count: count)
        tensor.data.withUnsafeBytes { rawBuffer in
            guard let base = rawBuffer.baseAddress else { return }
            for index in 0..<count {
                let offset = index * stride
                let bits = base.loadUnaligned(fromByteOffset: offset, as: UInt32.self)
                floats[index] = Float(bitPattern: UInt32(littleEndian: bits))
            }
        }
        return floats
    }

    private func label(for classID: Int) -> String {
        if classID >= 0 && classID < cocoLabels.count {
            return cocoLabels[classID]
        }
        return "class_\(classID)"
    }

    private func publishDetectionOverlay(_ detections: [YOLODetection]) {
        let boxes = detections.map { detection in
            DetectedBoundingBox(
                label: label(for: detection.classID),
                confidence: detection.confidence,
                rect: CGRect(
                    x: CGFloat(detection.x1),
                    y: CGFloat(detection.y1),
                    width: CGFloat(max(0, detection.x2 - detection.x1)),
                    height: CGFloat(max(0, detection.y2 - detection.y1))
                )
            )
        }
        DetectionOverlayStore.shared.update(boxes)
    }

    private func logDetectionJSON(chunkID: String, detections: [YOLODetection]) {
        let payload = YOLOLogBody(
            timestamp: Date(),
            event: "yolo_detection",
            yolo: YOLOLogBody.YOLOPayload(
                model: settings.yoloModelName,
                version: settings.modelVersion,
                chunkID: chunkID,
                detections: detections.map { detection in
                    YOLODetectionLogItem(
                        item: label(for: detection.classID),
                        confidence: Double(detection.confidence)
                    )
                },
                metadata: [
                    "scoreThreshold": "\(scoreThreshold)",
                    "iouThreshold": "\(iouThreshold)"
                ]
            ),
            metadata: [
                "schemaVersion": "1",
                "source": "Responder.YOLO"
            ]
        )
        guard let jsonData = try? debugJSONEncoder.encode(payload),
              let json = String(data: jsonData, encoding: .utf8) else {
            return
        }
        print(json)
    }

    private func isLikelyNetworkError(_ error: Error) -> Bool {
        let nsError = error as NSError
        let text = "\(nsError.domain) \(nsError.localizedDescription)".lowercased()
        return text.contains("network") || text.contains("timed out") || text.contains("offline")
    }

    private func keyPrefix(_ key: String) -> String {
        String(key.prefix(8))
    }

    private func makeStageError(stage: String, modelName: String, underlying: Error) -> NSError {
        let nsError = underlying as NSError
        var guidance = "Check model availability and key permissions in Melange dashboard."
        if nsError.domain.localizedCaseInsensitiveContains("NetworkError") || nsError.localizedDescription.localizedCaseInsensitiveContains("NetworkError") {
            guidance = "Network/auth failure while loading model. Confirm internet access and set a valid ZETIC_TOKEN or ZETIC_PERSONAL_KEY in the Xcode Run scheme."
        }

        return NSError(
            domain: "Responder.Inference",
            code: nsError.code == 0 ? -10 : nsError.code,
            userInfo: [
                NSLocalizedDescriptionKey:
                    "[\(stage)] Failed for model '\(modelName)': \(nsError.localizedDescription). \(guidance)"
            ]
        )
    }
    #endif
}

final class QwenOmniTranscriptionEngine: AudioTranscriptionEngine {
    let modelMetadata: TranscriptChunk.ModelMetadata

    private let settings: InferenceModelSettings
    private let melSpectrogram = AudioMelSpectrogram()

    init(settings: InferenceModelSettings) {
        self.settings = settings
        self.modelMetadata = TranscriptChunk.ModelMetadata(
            provider: "zetic-ai",
            name: settings.sttDecoderModelName,
            version: settings.modelVersion,
            mode: settings.modelMode,
            latencyMS: 0
        )
    }

    func transcribe(audioSamples16kMono: [Float]) async throws -> TranscriptChunk.TranscriptOutput {
        #if canImport(ZeticMLange)
        guard !effectiveCredentialKeys().isEmpty else {
            throw NSError(
                domain: "Responder.STT",
                code: -100,
                userInfo: [NSLocalizedDescriptionKey: "No ZETIC credentials configured. Set ZETIC_PERSONAL_KEY (or ZETIC_TOKEN) in the run scheme."]
            )
        }
        guard !audioSamples16kMono.isEmpty else {
            return TranscriptChunk.TranscriptOutput(text: "", confidence: 0, tensorCount: 0)
        }

        let melChunks = melSpectrogram.makeMelChunksWithMetadata(from: audioSamples16kMono)
        guard !melChunks.isEmpty else {
            return TranscriptChunk.TranscriptOutput(text: "", confidence: 0, tensorCount: 0)
        }

        let audioEmbeddings = try encodeAudioEmbeddings(melChunks: melChunks)
        guard !audioEmbeddings.isEmpty else {
            return TranscriptChunk.TranscriptOutput(
                text: "[stt_unavailable] Encoder returned no embeddings.",
                confidence: 0,
                tensorCount: 0
            )
        }

        let decoder = try loadDecoderWithRetry(candidateKeys: settings.credentialCandidates)
        defer {
            try? decoder.cleanUp()
        }

        try decoder.validate(profile: .qwenOmniAudio)
        let merged = try QwenOmniAudioChatTemplate().build(
            llm: decoder,
            audioEmbeddings: audioEmbeddings,
            userText: settings.userPrompt
        )
        _ = try decoder.runWithEmbeddings(merged)

        var response = ""
        var emittedTokenCount = 0
        while emittedTokenCount < settings.maxResponseTokens {
            let result = decoder.waitForNextToken()
            if result.generatedTokens == 0 {
                break
            }
            if !result.token.isEmpty {
                response += result.token
                emittedTokenCount += 1
            }
        }

        let trimmed = response.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return TranscriptChunk.TranscriptOutput(
                text: "[stt_unavailable] Decoder returned no tokens.",
                confidence: 0,
                tensorCount: melChunks.count
            )
        }

        return TranscriptChunk.TranscriptOutput(
            text: trimmed,
            confidence: 1,
            tensorCount: melChunks.count
        )
        #else
        throw NSError(
            domain: "Responder.STT",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: "ZeticMLange package is not available in this build."]
        )
        #endif
    }

    #if canImport(ZeticMLange)
    private func encodeAudioEmbeddings(melChunks: [AudioMelSpectrogram.MelChunk]) throws -> [Float] {
        let encoder = try loadAudioEncoderWithRetry(candidateKeys: settings.credentialCandidates)

        var mergedEmbeddings: [Float] = []
        mergedEmbeddings.reserveCapacity(melChunks.count * 50 * 2048)

        for melChunk in melChunks {
            let inputTensor = makeTensor(from: melChunk.values, shape: [1, 128, 200])
            let outputs = try encoder.run(inputs: [inputTensor])
            guard let embeddingTensor = outputs.max(by: { $0.data.count < $1.data.count }) else {
                continue
            }

            let rawEmbeddings = tensorToFloatArray(embeddingTensor)
            guard !rawEmbeddings.isEmpty else { continue }

            let embeddingDim = 2048
            let chunkTokenCount = min(50, max(1, Int(ceil(Double(melChunk.validFrameCount) / 4.0))))
            let expectedCount = chunkTokenCount * embeddingDim

            if rawEmbeddings.count >= expectedCount {
                mergedEmbeddings.append(contentsOf: rawEmbeddings.prefix(expectedCount))
            } else {
                mergedEmbeddings.append(contentsOf: rawEmbeddings)
            }
        }

        return mergedEmbeddings
    }

    private func loadAudioEncoderWithRetry(candidateKeys: [String]) throws -> ZeticMLangeModel {
        var lastError: Error?
        let keys = candidateKeys.isEmpty ? [settings.personalKey] : candidateKeys

        for key in keys {
            for attempt in 1...3 {
                do {
                    print("[Responder][STT] Loading encoder model=\(settings.sttAudioEncoderModelName) attempt=\(attempt) keyPrefix=\(keyPrefix(key))")
                    return try ZeticMLangeModel(
                        personalKey: key,
                        name: settings.sttAudioEncoderModelName,
                        target: .ZETIC_MLANGE_TARGET_COREML
                    )
                } catch {
                    lastError = error
                    print("[Responder][STT][ERROR] Encoder load failed attempt=\(attempt): \(error.localizedDescription)")
                    if attempt < 3, isLikelyNetworkError(error) {
                        Thread.sleep(forTimeInterval: Double(attempt))
                        continue
                    }
                }
            }
        }

        throw makeSTTStageError(
            stage: "load_audio_encoder",
            modelName: settings.sttAudioEncoderModelName,
            underlying: lastError ?? NSError(
            domain: "Responder.STT",
            code: -10,
            userInfo: [NSLocalizedDescriptionKey: "Failed to load STT audio encoder model."]
        )
        )
    }

    private func loadDecoderWithRetry(candidateKeys: [String]) throws -> ZeticMLangeLLMModel {
        var lastError: Error?
        let keys = candidateKeys.isEmpty ? [settings.personalKey] : candidateKeys

        for key in keys {
            for attempt in 1...3 {
                do {
                    print("[Responder][STT] Loading decoder model=\(settings.sttDecoderModelName) attempt=\(attempt) keyPrefix=\(keyPrefix(key))")
                    return try ZeticMLangeLLMModel(
                        personalKey: key,
                        name: settings.sttDecoderModelName
                    )
                } catch {
                    lastError = error
                    print("[Responder][STT][ERROR] Decoder load failed attempt=\(attempt): \(error.localizedDescription)")
                    if attempt < 3, isLikelyNetworkError(error) {
                        Thread.sleep(forTimeInterval: Double(attempt))
                        continue
                    }
                }
            }
        }

        throw makeSTTStageError(
            stage: "load_decoder",
            modelName: settings.sttDecoderModelName,
            underlying: lastError ?? NSError(
            domain: "Responder.STT",
            code: -11,
            userInfo: [NSLocalizedDescriptionKey: "Failed to load STT decoder model."]
        )
        )
    }

    private func makeTensor(from floats: [Float], shape: [Int]) -> Tensor {
        let data = floats.withUnsafeBufferPointer { Data(buffer: $0) }
        return Tensor(data: data, dataType: BuiltinDataType.float32, shape: shape)
    }

    private func tensorToFloatArray(_ tensor: Tensor) -> [Float] {
        let byteCount = tensor.data.count
        let stride = MemoryLayout<Float>.size
        let count = byteCount / stride
        guard count > 0 else { return [] }

        var floats = Array(repeating: Float(0), count: count)
        tensor.data.withUnsafeBytes { rawBuffer in
            guard let base = rawBuffer.baseAddress else { return }
            for index in 0..<count {
                let offset = index * stride
                let bits = base.loadUnaligned(fromByteOffset: offset, as: UInt32.self)
                floats[index] = Float(bitPattern: UInt32(littleEndian: bits))
            }
        }
        return floats
    }

    private func isLikelyNetworkError(_ error: Error) -> Bool {
        let nsError = error as NSError
        let text = "\(nsError.domain) \(nsError.localizedDescription)".lowercased()
        return text.contains("network") || text.contains("timed out") || text.contains("offline")
    }

    private func keyPrefix(_ key: String) -> String {
        String(key.prefix(8))
    }

    private func effectiveCredentialKeys() -> [String] {
        let keys = settings.credentialCandidates.isEmpty ? [settings.personalKey] : settings.credentialCandidates
        return keys.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private func makeSTTStageError(stage: String, modelName: String, underlying: Error) -> NSError {
        let nsError = underlying as NSError
        let hasCredential = !effectiveCredentialKeys().isEmpty
        var guidance = "Verify internet connectivity and Melange access for this model."
        if !hasCredential {
            guidance = "No credential found. Set ZETIC_PERSONAL_KEY (or ZETIC_TOKEN) in the run scheme."
        } else if isLikelyNetworkError(underlying) {
            guidance = "Network/auth failure. Check Wi-Fi, VPN/firewall restrictions, and verify the key has access to \(modelName)."
        }
        return NSError(
            domain: "Responder.STT",
            code: nsError.code == 0 ? -120 : nsError.code,
            userInfo: [
                NSLocalizedDescriptionKey: "[\(stage)] STT failed for model '\(modelName)': \(nsError.localizedDescription). \(guidance)"
            ]
        )
    }
    #endif
}

final class YamnetAudioClassificationEngine: AudioTranscriptionEngine {
    let modelMetadata: TranscriptChunk.ModelMetadata
    private let settings: InferenceModelSettings
    private let yamnetLabels: [Int: String]
    private let silenceClassID: Int?

    init(settings: InferenceModelSettings) {
        self.settings = settings
        self.yamnetLabels = Self.loadYamnetLabels()
        self.silenceClassID = Self.findSilenceClassID(labels: self.yamnetLabels)
        self.modelMetadata = TranscriptChunk.ModelMetadata(
            provider: "zetic-ai",
            name: settings.yamnetModelName,
            version: settings.modelVersion,
            mode: settings.modelMode,
            latencyMS: 0
        )
    }

    func transcribe(audioSamples16kMono: [Float]) async throws -> TranscriptChunk.TranscriptOutput {
        #if canImport(ZeticMLange)
        guard !effectiveCredentialKeys().isEmpty else {
            throw NSError(
                domain: "Responder.YAMNet",
                code: -100,
                userInfo: [NSLocalizedDescriptionKey: "No ZETIC credentials configured. Set ZETIC_PERSONAL_KEY (or ZETIC_TOKEN) in the run scheme."]
            )
        }

        guard !audioSamples16kMono.isEmpty else {
            return TranscriptChunk.TranscriptOutput(text: "", confidence: 0, tensorCount: 0)
        }

        let mode: ModelMode
        switch settings.modelMode.uppercased() {
        case "RUN_SPEED":
            mode = .RUN_SPEED
        case "RUN_ACCURACY":
            mode = .RUN_ACCURACY
        default:
            mode = .RUN_AUTO
        }

        do {
            let model = try loadModelWithRetry(candidateKeys: settings.credentialCandidates, mode: mode)
            let outputs = try runYamnet(model: model, audioSamples16kMono: audioSamples16kMono)
            let rms = rmsEnergy(audioSamples16kMono)
            let topPredictions = topClassPredictions(from: outputs, topK: 3, rmsEnergy: rms)

            let text: String
            let confidence: Double
            if topPredictions.isEmpty {
                text = "[yamnet_unavailable] No class scores produced."
                confidence = 0
            } else {
                text = topPredictions
                    .map { (classID, score) in "\(yamnetLabel(for: classID)) \(String(format: "%.1f%%", score * 100))" }
                    .joined(separator: ", ")
                confidence = Double(topPredictions[0].1)
            }

            return TranscriptChunk.TranscriptOutput(
                text: text,
                confidence: confidence,
                tensorCount: outputs.count
            )
        } catch {
            throw makeYamnetStageError(stage: "model_run", modelName: settings.yamnetModelName, underlying: error)
        }
        #else
        throw NSError(
            domain: "Responder.YAMNet",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: "ZeticMLange package is not available in this build."]
        )
        #endif
    }

    #if canImport(ZeticMLange)
    private func runYamnet(model: ZeticMLangeModel, audioSamples16kMono: [Float]) throws -> [Tensor] {
        // Try common waveform tensor shapes because model wrappers vary by backend export.
        let candidateShapes: [[Int]] = [
            [1, audioSamples16kMono.count],
            [audioSamples16kMono.count],
            [audioSamples16kMono.count, 1]
        ]

        var lastError: Error?
        for shape in candidateShapes {
            do {
                let input = makeTensor(from: audioSamples16kMono, shape: shape)
                return try model.run(inputs: [input])
            } catch {
                lastError = error
            }
        }

        throw lastError ?? NSError(
            domain: "Responder.YAMNet",
            code: -20,
            userInfo: [NSLocalizedDescriptionKey: "Failed to run YAMNet with supported input shapes."]
        )
    }

    private func topClassPredictions(from outputs: [Tensor], topK: Int, rmsEnergy: Float) -> [(Int, Float)] {
        var rawScores = selectYamnetScoreVector(from: outputs)
        guard !rawScores.isEmpty else { return [] }

        // YAMNet scores are typically already class confidences in [0, 1].
        // If not, fall back to sigmoid to keep values readable and bounded.
        let minScore = rawScores.min() ?? 0
        let maxScore = rawScores.max() ?? 1
        let looksProbabilistic = minScore >= 0 && maxScore <= 1.2
        if !looksProbabilistic {
            rawScores = rawScores.map { 1 / (1 + expf(-$0)) }
        }

        // If there is strong input energy, dampen silence so obvious non-silent events can surface.
        if rmsEnergy > 0.025, let silenceClassID, silenceClassID < rawScores.count {
            rawScores[silenceClassID] *= 0.2
        }

        return rawScores
            .enumerated()
            .sorted { lhs, rhs in lhs.element > rhs.element }
            .prefix(max(topK, 1))
            .map { ($0.offset, $0.element) }
    }

    private func selectYamnetScoreVector(from outputs: [Tensor]) -> [Float] {
        let classCount = 521
        var best: [Float] = []
        var bestFrameCount = 0

        for tensor in outputs {
            let values = tensorToFloatArray(tensor)
            guard !values.isEmpty else { continue }

            // Prefer tensors whose shape explicitly includes the 521 class dimension.
            let shape = tensor.shape
            let hasClassDim = shape.contains(classCount)
            guard hasClassDim || values.count % classCount == 0 else { continue }

            let frames = max(values.count / classCount, 1)
            var aggregated = [Float](repeating: 0, count: classCount)
            for f in 0..<frames {
                let base = f * classCount
                guard base + classCount <= values.count else { break }
                for c in 0..<classCount {
                    // Max over frames catches short events better than mean.
                    aggregated[c] = max(aggregated[c], values[base + c])
                }
            }

            // Keep the candidate with the richest temporal signal.
            if frames >= bestFrameCount {
                best = aggregated
                bestFrameCount = frames
            }
        }

        // Fallback: if no tensor matches expected score shape, use largest tensor.
        if !best.isEmpty {
            return best
        }
        guard let fallbackTensor = outputs.max(by: { $0.data.count < $1.data.count }) else {
            return []
        }
        return tensorToFloatArray(fallbackTensor)
    }

    private static func loadYamnetLabels() -> [Int: String] {
        guard let url = Bundle.main.url(forResource: "yamnet_class_map", withExtension: "csv"),
              let text = try? String(contentsOf: url, encoding: .utf8) else {
            return [:]
        }

        var labels: [Int: String] = [:]
        let lines = text.split(whereSeparator: \.isNewline)
        for line in lines.dropFirst() {
            let columns = parseCSVLine(String(line))
            guard columns.count >= 3, let idx = Int(columns[0]) else { continue }
            labels[idx] = columns[2]
        }
        return labels
    }

    private static func parseCSVLine(_ line: String) -> [String] {
        var result: [String] = []
        var current = ""
        var inQuotes = false
        var i = line.startIndex

        while i < line.endIndex {
            let ch = line[i]
            if ch == "\"" {
                let next = line.index(after: i)
                if inQuotes, next < line.endIndex, line[next] == "\"" {
                    current.append("\"")
                    i = next
                } else {
                    inQuotes.toggle()
                }
            } else if ch == ",", !inQuotes {
                result.append(current)
                current.removeAll(keepingCapacity: true)
            } else {
                current.append(ch)
            }
            i = line.index(after: i)
        }
        result.append(current)
        return result
    }

    private static func findSilenceClassID(labels: [Int: String]) -> Int? {
        labels.first { _, value in
            value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "silence"
        }?.key
    }

    private func rmsEnergy(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var acc: Float = 0
        for s in samples {
            acc += s * s
        }
        return sqrtf(acc / Float(samples.count))
    }

    private func yamnetLabel(for classID: Int) -> String {
        yamnetLabels[classID] ?? "class_\(classID)"
    }

    private func loadModelWithRetry(candidateKeys: [String], mode: ModelMode) throws -> ZeticMLangeModel {
        var lastError: Error?
        let keys = candidateKeys.isEmpty ? [settings.personalKey] : candidateKeys

        for key in keys {
            for attempt in 1...3 {
                do {
                    return try ZeticMLangeModel(
                        personalKey: key,
                        name: settings.yamnetModelName,
                        version: settings.modelVersion,
                        modelMode: mode,
                        onDownload: { _ in }
                    )
                } catch {
                    lastError = error
                    if attempt < 3, isLikelyNetworkError(error) {
                        Thread.sleep(forTimeInterval: Double(attempt))
                        continue
                    }
                }
            }
        }

        throw lastError ?? NSError(
            domain: "Responder.YAMNet",
            code: -11,
            userInfo: [NSLocalizedDescriptionKey: "Failed to load YAMNet model."]
        )
    }

    private func makeTensor(from floats: [Float], shape: [Int]) -> Tensor {
        let data = floats.withUnsafeBufferPointer { Data(buffer: $0) }
        return Tensor(data: data, dataType: BuiltinDataType.float32, shape: shape)
    }

    private func tensorToFloatArray(_ tensor: Tensor) -> [Float] {
        let byteCount = tensor.data.count
        let stride = MemoryLayout<Float>.size
        let count = byteCount / stride
        guard count > 0 else { return [] }

        var floats = Array(repeating: Float(0), count: count)
        tensor.data.withUnsafeBytes { rawBuffer in
            guard let base = rawBuffer.baseAddress else { return }
            for index in 0..<count {
                let offset = index * stride
                let bits = base.loadUnaligned(fromByteOffset: offset, as: UInt32.self)
                floats[index] = Float(bitPattern: UInt32(littleEndian: bits))
            }
        }
        return floats
    }

    private func isLikelyNetworkError(_ error: Error) -> Bool {
        let nsError = error as NSError
        let text = "\(nsError.domain) \(nsError.localizedDescription)".lowercased()
        return text.contains("network") || text.contains("timed out") || text.contains("offline")
    }

    private func effectiveCredentialKeys() -> [String] {
        let keys = settings.credentialCandidates.isEmpty ? [settings.personalKey] : settings.credentialCandidates
        return keys.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private func makeYamnetStageError(stage: String, modelName: String, underlying: Error) -> NSError {
        let nsError = underlying as NSError
        let hasCredential = !effectiveCredentialKeys().isEmpty
        var guidance = "Verify internet connectivity and Melange access for this model."
        if !hasCredential {
            guidance = "No credential found. Set ZETIC_PERSONAL_KEY (or ZETIC_TOKEN) in the run scheme."
        } else if isLikelyNetworkError(underlying) {
            guidance = "Network/auth failure. Check Wi-Fi, VPN/firewall restrictions, and verify the key has access to \(modelName)."
        }
        return NSError(
            domain: "Responder.YAMNet",
            code: nsError.code == 0 ? -120 : nsError.code,
            userInfo: [
                NSLocalizedDescriptionKey: "[\(stage)] YAMNet failed for model '\(modelName)': \(nsError.localizedDescription). \(guidance)"
            ]
        )
    }
    #endif
}
