import Foundation
import CoreGraphics
import CoreImage
import CoreVideo
import AVFoundation
import Speech

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

#if canImport(ZeticMLange)
private func responderModelMode(from rawValue: String) -> ModelMode {
    switch rawValue.uppercased() {
    case "RUN_SPEED":
        return .RUN_SPEED
    case "RUN_ACCURACY":
        return .RUN_ACCURACY
    default:
        return .RUN_AUTO
    }
}
#endif

private struct WhisperFeatureExtractor {
    private let sampleRate = 16_000
    private let fftSize = 400
    private let hopSize = 160
    private let melBands = 80
    private let chunkSampleCount = 30 * 16_000
    private let frameCount = 3000

    func process(_ pcm16kMono: [Float]) -> [Float] {
        let padded = padOrTrim(pcm16kMono)
        let frames = stftPowerFrames(samples: padded)
        guard !frames.isEmpty else {
            return [Float](repeating: 0, count: melBands * frameCount)
        }

        let melFilters = makeMelFilterBank()
        var logMel = [Float](repeating: 0, count: melBands * frameCount)

        for frameIdx in 0..<min(frames.count, frameCount) {
            let power = frames[frameIdx]
            var mel = [Float](repeating: 0, count: melBands)
            for m in 0..<melBands {
                var sum: Float = 0
                let filter = melFilters[m]
                for k in 0..<filter.count {
                    sum += filter[k] * power[k]
                }
                mel[m] = max(sum, 1e-10)
            }

            let logs = mel.map { log10f($0) }
            let maxLog = logs.max() ?? 0
            for melIdx in 0..<melBands {
                let normalized = max(logs[melIdx], maxLog - 8.0)
                logMel[melIdx * frameCount + frameIdx] = (normalized + 4.0) / 4.0
            }
        }

        return logMel
    }

    private func padOrTrim(_ samples: [Float]) -> [Float] {
        if samples.count == chunkSampleCount {
            return samples
        }
        if samples.count > chunkSampleCount {
            return Array(samples.prefix(chunkSampleCount))
        }
        return samples + [Float](repeating: 0, count: chunkSampleCount - samples.count)
    }

    private func stftPowerFrames(samples: [Float]) -> [[Float]] {
        let window = periodicHann(count: fftSize)
        let bins = fftSize / 2 + 1
        guard samples.count >= fftSize else { return [] }

        var frames = [[Float]]()
        frames.reserveCapacity(frameCount)
        var offset = 0
        while offset + fftSize <= samples.count, frames.count < frameCount {
            var real = [Float](repeating: 0, count: bins)
            var imag = [Float](repeating: 0, count: bins)

            for n in 0..<fftSize {
                let x = samples[offset + n] * window[n]
                for k in 0..<bins {
                    let angle = -2 * Float.pi * Float(k * n) / Float(fftSize)
                    real[k] += x * cos(angle)
                    imag[k] += x * sin(angle)
                }
            }

            var power = [Float](repeating: 0, count: bins)
            for k in 0..<bins {
                power[k] = real[k] * real[k] + imag[k] * imag[k]
            }
            frames.append(power)
            offset += hopSize
        }
        return frames
    }

    private func periodicHann(count: Int) -> [Float] {
        guard count > 0 else { return [] }
        return (0..<count).map { n in
            0.5 - 0.5 * cos(2 * Float.pi * Float(n) / Float(count))
        }
    }

    private func makeMelFilterBank() -> [[Float]] {
        let bins = fftSize / 2 + 1
        let fMin: Float = 0
        let fMax: Float = Float(sampleRate) / 2
        let mMin = hzToMel(fMin)
        let mMax = hzToMel(fMax)
        let melPoints = (0..<(melBands + 2)).map { i in
            mMin + Float(i) * (mMax - mMin) / Float(melBands + 1)
        }
        let hzPoints = melPoints.map(melToHz)
        let binPoints = hzPoints.map { hz in
            Int(floor((Float(fftSize + 1) * hz) / Float(sampleRate)))
        }

        var filters = Array(repeating: Array(repeating: Float(0), count: bins), count: melBands)
        for m in 1...melBands {
            let left = max(0, min(bins - 1, binPoints[m - 1]))
            let center = max(0, min(bins - 1, binPoints[m]))
            let right = max(0, min(bins - 1, binPoints[m + 1]))
            if left == center || center == right { continue }

            for k in left..<center {
                filters[m - 1][k] = Float(k - left) / Float(center - left)
            }
            for k in center..<right {
                filters[m - 1][k] = Float(right - k) / Float(right - center)
            }

            let enorm = 2.0 / (hzPoints[m + 1] - hzPoints[m - 1])
            for k in 0..<bins {
                filters[m - 1][k] *= enorm
            }
        }
        return filters
    }

    private func hzToMel(_ hz: Float) -> Float {
        2595 * log10f(1 + hz / 700)
    }

    private func melToHz(_ mel: Float) -> Float {
        700 * (powf(10, mel / 2595) - 1)
    }
}

private struct WhisperTokenizer {
    private let idToToken: [Int: String]
    private let byteDecoder: [Character: UInt8]
    private let timestampBegin = 50364

    init() throws {
        guard let url = Bundle.main.url(forResource: "vocab", withExtension: "json") else {
            throw NSError(
                domain: "Responder.STT",
                code: -130,
                userInfo: [NSLocalizedDescriptionKey: "vocab.json is missing from the app bundle."]
            )
        }

        let data = try Data(contentsOf: url)
        let vocab = try JSONDecoder().decode([String: Int].self, from: data)
        self.idToToken = Dictionary(uniqueKeysWithValues: vocab.map { ($1, $0) })
        self.byteDecoder = Self.makeByteDecoder()
    }

    func decode(_ tokenIDs: [Int32]) -> String {
        let filteredTokens = tokenIDs
            .map(Int.init)
            .filter { token in
                token >= 0 && token < timestampBegin
            }
            .compactMap { idToToken[$0] }
            .filter { token in
                !token.hasPrefix("<|") || !token.hasSuffix("|>")
            }
        guard !filteredTokens.isEmpty else { return "" }

        let merged = filteredTokens.joined()
        var bytes = [UInt8]()
        bytes.reserveCapacity(merged.utf8.count)
        for scalar in merged.unicodeScalars {
            let character = Character(scalar)
            if let byte = byteDecoder[character] {
                bytes.append(byte)
            } else {
                bytes.append(contentsOf: String(character).utf8)
            }
        }

        return String(decoding: bytes, as: UTF8.self)
    }

    private static func makeByteDecoder() -> [Character: UInt8] {
        let encodedBytes = Array(33...126) + Array(161...172) + Array(174...255)
        var byteToScalar: [UInt8: UnicodeScalar] = [:]

        for byte in encodedBytes {
            byteToScalar[UInt8(byte)] = UnicodeScalar(byte)!
        }

        var extra = 0
        for byte in 0...255 {
            let key = UInt8(byte)
            if byteToScalar[key] == nil {
                byteToScalar[key] = UnicodeScalar(UInt32(256 + extra))!
                extra += 1
            }
        }

        var decoder: [Character: UInt8] = [:]
        decoder.reserveCapacity(byteToScalar.count)
        for (byte, scalar) in byteToScalar {
            decoder[Character(scalar)] = byte
        }
        return decoder
    }
}

final class WhisperTinyTranscriptionEngine: AudioTranscriptionEngine {
    let modelMetadata: TranscriptChunk.ModelMetadata

    private let settings: InferenceModelSettings
    private let featureExtractor = WhisperFeatureExtractor()
    private let tokenizer: WhisperTokenizer
    private let decoderPrompt: [Int32] = [50258, 50259, 50359, 50363]
    private let decoderMaxLength = 448
    private let endToken = 50257

    init(settings: InferenceModelSettings) {
        self.settings = settings
        self.modelMetadata = TranscriptChunk.ModelMetadata(
            provider: "zetic-ai",
            name: settings.whisperDecoderModelName,
            version: settings.modelVersion,
            mode: settings.modelMode,
            latencyMS: 0
        )
        self.tokenizer = try! WhisperTokenizer()
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

        let features = featureExtractor.process(audioSamples16kMono)
        let encoderOutput = try runEncoder(features: features)
        let tokenIDs = try runDecoder(encoderOutput: encoderOutput)
        let transcript = tokenizer.decode(tokenIDs).trimmingCharacters(in: .whitespacesAndNewlines)

        if transcript.isEmpty {
            return TranscriptChunk.TranscriptOutput(
                text: "[stt_unavailable] Decoder produced no transcription.",
                confidence: 0,
                tensorCount: 0
            )
        }

        return TranscriptChunk.TranscriptOutput(
            text: transcript,
            confidence: 1,
            tensorCount: 2
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
    private func runEncoder(features: [Float]) throws -> Data {
        let encoder = try loadEncoderWithRetry(candidateKeys: settings.credentialCandidates)
        let tensor = rawTensor(from: features)
        let outputs = try encoder.run(inputs: [tensor])
        guard let output = outputs.first else {
            throw NSError(
                domain: "Responder.STT",
                code: -131,
                userInfo: [NSLocalizedDescriptionKey: "Whisper encoder returned no outputs."]
            )
        }
        return output.data
    }

    private func runDecoder(encoderOutput: Data) throws -> [Int32] {
        let decoder = try loadDecoderWithRetry(candidateKeys: settings.credentialCandidates)
        var tokenIDs = [Int32](repeating: 0, count: decoderMaxLength)
        var attentionMask = [Int32](repeating: 0, count: decoderMaxLength)

        for (index, token) in decoderPrompt.enumerated() where index < decoderMaxLength {
            tokenIDs[index] = token
            attentionMask[index] = 1
        }

        var generatedIDs: [Int32] = []
        var currentIndex = max(decoderPrompt.count - 1, 0)

        while currentIndex < decoderMaxLength - 1 && generatedIDs.count < settings.maxResponseTokens {
            let logits = try decodeStep(
                decoder: decoder,
                tokenIDs: tokenIDs,
                encoderOutput: encoderOutput,
                attentionMask: attentionMask
            )

            let vocabSize = logits.count / decoderMaxLength
            guard vocabSize > 0 else { break }
            let start = vocabSize * currentIndex
            let end = min(start + vocabSize, logits.count)
            guard start < end else { break }

            let nextToken = argmax(Array(logits[start..<end]))
            if nextToken == endToken {
                break
            }

            generatedIDs.append(Int32(nextToken))
            currentIndex += 1
            tokenIDs[currentIndex] = Int32(nextToken)
            attentionMask[currentIndex] = 1
        }

        return generatedIDs
    }

    private func decodeStep(
        decoder: ZeticMLangeModel,
        tokenIDs: [Int32],
        encoderOutput: Data,
        attentionMask: [Int32]
    ) throws -> [Float] {
        let outputs = try decoder.run(inputs: [
            rawTensor(from: tokenIDs),
            Tensor(data: encoderOutput, dataType: BuiltinDataType.int8, shape: [encoderOutput.count]),
            rawTensor(from: attentionMask),
        ])

        guard let logitsTensor = outputs.first else {
            throw NSError(
                domain: "Responder.STT",
                code: -132,
                userInfo: [NSLocalizedDescriptionKey: "Whisper decoder returned no logits."]
            )
        }
        return tensorToFloatArray(logitsTensor)
    }

    private func loadEncoderWithRetry(candidateKeys: [String]) throws -> ZeticMLangeModel {
        var lastError: Error?
        let keys = candidateKeys.isEmpty ? [settings.personalKey] : candidateKeys
        let mode = responderModelMode(from: settings.modelMode)

        for key in keys {
            for attempt in 1...3 {
                do {
                    print("[Responder][STT] Loading whisper encoder model=\(settings.whisperEncoderModelName) attempt=\(attempt) keyPrefix=\(keyPrefix(key))")
                    return try ZeticMLangeModel(
                        personalKey: key,
                        name: settings.whisperEncoderModelName,
                        version: settings.modelVersion,
                        modelMode: mode
                    )
                } catch {
                    lastError = error
                    print("[Responder][STT][ERROR] Whisper encoder load failed attempt=\(attempt): \(error.localizedDescription)")
                    if attempt < 3, isLikelyNetworkError(error) {
                        Thread.sleep(forTimeInterval: Double(attempt))
                        continue
                    }
                }
            }
        }

        throw makeSTTStageError(
            stage: "load_whisper_encoder",
            modelName: settings.whisperEncoderModelName,
            underlying: lastError ?? NSError(
                domain: "Responder.STT",
                code: -133,
                userInfo: [NSLocalizedDescriptionKey: "Failed to load Whisper encoder model."]
            )
        )
    }

    private func loadDecoderWithRetry(candidateKeys: [String]) throws -> ZeticMLangeModel {
        var lastError: Error?
        let keys = candidateKeys.isEmpty ? [settings.personalKey] : candidateKeys
        let mode = responderModelMode(from: settings.modelMode)

        for key in keys {
            for attempt in 1...3 {
                do {
                    print("[Responder][STT] Loading whisper decoder model=\(settings.whisperDecoderModelName) attempt=\(attempt) keyPrefix=\(keyPrefix(key))")
                    return try ZeticMLangeModel(
                        personalKey: key,
                        name: settings.whisperDecoderModelName,
                        version: settings.modelVersion,
                        modelMode: mode
                    )
                } catch {
                    lastError = error
                    print("[Responder][STT][ERROR] Whisper decoder load failed attempt=\(attempt): \(error.localizedDescription)")
                    if attempt < 3, isLikelyNetworkError(error) {
                        Thread.sleep(forTimeInterval: Double(attempt))
                        continue
                    }
                }
            }
        }

        throw makeSTTStageError(
            stage: "load_whisper_decoder",
            modelName: settings.whisperDecoderModelName,
            underlying: lastError ?? NSError(
                domain: "Responder.STT",
                code: -134,
                userInfo: [NSLocalizedDescriptionKey: "Failed to load Whisper decoder model."]
            )
        )
    }

    private func rawTensor<T>(from values: [T]) -> Tensor {
        let data = values.withUnsafeBufferPointer { Data(buffer: $0) }
        return Tensor(data: data, dataType: BuiltinDataType.int8, shape: [data.count])
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

    private func argmax(_ values: [Float]) -> Int {
        guard !values.isEmpty else { return 0 }
        var bestIndex = 0
        var bestValue = values[0]
        for (index, value) in values.enumerated() where value > bestValue {
            bestIndex = index
            bestValue = value
        }
        return bestIndex
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

final class AppleSpeechTranscriptionEngine: AudioTranscriptionEngine {
    let modelMetadata: TranscriptChunk.ModelMetadata

    private let settings: InferenceModelSettings
    private let locale: Locale
    private let timeoutSeconds: Int

    private final class SpeechRecognitionTaskBox: @unchecked Sendable {
        private let lock = NSLock()
        private var task: SFSpeechRecognitionTask?

        func set(_ task: SFSpeechRecognitionTask?) {
            lock.lock()
            self.task = task
            lock.unlock()
        }

        func cancel() {
            lock.lock()
            let task = self.task
            lock.unlock()
            task?.cancel()
        }
    }

    private final class SpeechRecognitionResultBox: @unchecked Sendable {
        private let lock = NSLock()
        private var transcript = ""

        func update(_ value: String) {
            lock.lock()
            transcript = value
            lock.unlock()
        }

        func current() -> String {
            lock.lock()
            let value = transcript
            lock.unlock()
            return value
        }
    }

    init(settings: InferenceModelSettings) {
        self.settings = settings
        self.locale = Locale(identifier: settings.speechLocale)
        self.timeoutSeconds = max(settings.sttTimeoutSeconds, 6)
        self.modelMetadata = TranscriptChunk.ModelMetadata(
            provider: "apple",
            name: "SFSpeechRecognizer(\(settings.speechLocale))",
            version: nil,
            mode: "FALLBACK",
            latencyMS: 0
        )
    }

    func transcribe(audioSamples16kMono: [Float]) async throws -> TranscriptChunk.TranscriptOutput {
        guard !audioSamples16kMono.isEmpty else {
            return TranscriptChunk.TranscriptOutput(text: "", confidence: 0, tensorCount: 0)
        }

        print("[Responder][STT][APPLE] Starting transcription samples=\(audioSamples16kMono.count)")

        let authorization = await Self.requestAuthorizationIfNeeded()
        guard authorization == .authorized else {
            throw NSError(
                domain: "Responder.STT",
                code: -210,
                userInfo: [NSLocalizedDescriptionKey: "Speech recognition permission is not authorized for Apple STT fallback."]
            )
        }

        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
            throw NSError(
                domain: "Responder.STT",
                code: -211,
                userInfo: [NSLocalizedDescriptionKey: "Apple speech recognizer is unavailable for locale \(settings.speechLocale)."]
            )
        }

        let audioURL = try writeTemporaryWAV(audioSamples16kMono)
        defer { try? FileManager.default.removeItem(at: audioURL) }

        let request = SFSpeechURLRecognitionRequest(url: audioURL)
        request.taskHint = .dictation
        request.shouldReportPartialResults = true
        if #available(iOS 13, *) {
            request.requiresOnDeviceRecognition = false
        }
        if #available(iOS 16, *) {
            request.addsPunctuation = true
        }

        let text = try await recognizeText(
            recognizer: recognizer,
            request: request,
            timeoutSeconds: timeoutSeconds
        )

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw NSError(
                domain: "Responder.STT",
                code: -212,
                userInfo: [NSLocalizedDescriptionKey: "Apple speech recognizer returned an empty transcription."]
            )
        }

        print("[Responder][STT][APPLE] Completed transcription text=\(trimmed)")

        return TranscriptChunk.TranscriptOutput(
            text: trimmed,
            confidence: 1,
            tensorCount: 1
        )
    }

    private func recognizeText(
        recognizer: SFSpeechRecognizer,
        request: SFSpeechURLRecognitionRequest,
        timeoutSeconds: Int
    ) async throws -> String {
        let taskBox = SpeechRecognitionTaskBox()
        let resultBox = SpeechRecognitionResultBox()

        return try await withThrowingTaskGroup(of: String.self) { group in
            group.addTask {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
                    var hasResumed = false

                    func resume(_ result: Result<String, Error>) {
                        guard !hasResumed else { return }
                        hasResumed = true
                        taskBox.cancel()
                        continuation.resume(with: result)
                    }

                    let task = recognizer.recognitionTask(with: request) { result, error in
                        if let error {
                            resume(.failure(error))
                            return
                        }
                        guard let result else { return }
                        let transcript = result.bestTranscription.formattedString
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                        if !transcript.isEmpty {
                            resultBox.update(transcript)
                            print("[Responder][STT][APPLE] Received transcript final=\(result.isFinal) text=\(transcript)")
                            if result.isFinal {
                                resume(.success(transcript))
                            }
                        }
                    }
                    taskBox.set(task)
                }
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeoutSeconds) * 1_000_000_000)
                let bestPartial = resultBox.current().trimmingCharacters(in: .whitespacesAndNewlines)
                if !bestPartial.isEmpty {
                    print("[Responder][STT][APPLE] Timeout reached, returning best partial text=\(bestPartial)")
                    return bestPartial
                }
                throw NSError(
                    domain: "Responder.STT",
                    code: -214,
                    userInfo: [NSLocalizedDescriptionKey: "Apple speech recognizer timed out after \(timeoutSeconds) seconds."]
                )
            }

            do {
                let result = try await group.next()!
                group.cancelAll()
                taskBox.cancel()
                return result
            } catch {
                group.cancelAll()
                taskBox.cancel()
                throw error
            }
        }
    }

    private static func requestAuthorizationIfNeeded() async -> SFSpeechRecognizerAuthorizationStatus {
        let current = SFSpeechRecognizer.authorizationStatus()
        if current != .notDetermined {
            return current
        }
        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    private func writeTemporaryWAV(_ samples: [Float]) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("wav")

        let int16Samples = samples.map { sample -> Int16 in
            let clamped = max(-1.0, min(1.0, sample))
            return Int16(clamped * Float(Int16.max))
        }

        let dataByteCount = int16Samples.count * MemoryLayout<Int16>.size
        let totalSize = 44 + dataByteCount
        var data = Data(capacity: totalSize)

        func appendASCII(_ string: String) {
            data.append(contentsOf: string.utf8)
        }

        func appendUInt32(_ value: UInt32) {
            var littleEndian = value.littleEndian
            withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
        }

        func appendUInt16(_ value: UInt16) {
            var littleEndian = value.littleEndian
            withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
        }

        appendASCII("RIFF")
        appendUInt32(UInt32(36 + dataByteCount))
        appendASCII("WAVE")
        appendASCII("fmt ")
        appendUInt32(16)
        appendUInt16(1)
        appendUInt16(1)
        appendUInt32(16_000)
        appendUInt32(16_000 * 2)
        appendUInt16(2)
        appendUInt16(16)
        appendASCII("data")
        appendUInt32(UInt32(dataByteCount))
        int16Samples.forEach { appendUInt16(UInt16(bitPattern: $0)) }

        try data.write(to: url, options: .atomic)
        return url
    }
}

final class HybridTranscriptionEngine: AudioTranscriptionEngine {
    let modelMetadata: TranscriptChunk.ModelMetadata

    private let settings: InferenceModelSettings
    private let primary: AudioTranscriptionEngine
    private let fallback: AudioTranscriptionEngine

    init(settings: InferenceModelSettings, primary: AudioTranscriptionEngine, fallback: AudioTranscriptionEngine) {
        self.settings = settings
        self.primary = primary
        self.fallback = fallback
        self.modelMetadata = TranscriptChunk.ModelMetadata(
            provider: "hybrid",
            name: "\(primary.modelMetadata.name) -> \(fallback.modelMetadata.name)",
            version: settings.modelVersion,
            mode: settings.modelMode,
            latencyMS: 0
        )
    }

    func transcribe(audioSamples16kMono: [Float]) async throws -> TranscriptChunk.TranscriptOutput {
        do {
            let primaryResult = try await runWithTimeout(
                seconds: settings.sttTimeoutSeconds,
                engine: primary,
                audioSamples16kMono: audioSamples16kMono
            )
            if shouldAccept(primaryResult.text) {
                return primaryResult
            }
            print("[Responder][STT] Primary STT returned fallback text, switching to Apple Speech.")
        } catch {
            print("[Responder][STT][WARN] Primary STT failed or timed out: \(error.localizedDescription)")
        }

        let fallbackResult = try await fallback.transcribe(audioSamples16kMono: audioSamples16kMono)
        return TranscriptChunk.TranscriptOutput(
            text: fallbackResult.text,
            confidence: fallbackResult.confidence,
            tensorCount: fallbackResult.tensorCount
        )
    }

    private func runWithTimeout(
        seconds: Int,
        engine: AudioTranscriptionEngine,
        audioSamples16kMono: [Float]
    ) async throws -> TranscriptChunk.TranscriptOutput {
        try await withThrowingTaskGroup(of: TranscriptChunk.TranscriptOutput.self) { group in
            group.addTask {
                try await engine.transcribe(audioSamples16kMono: audioSamples16kMono)
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds) * 1_000_000_000)
                throw NSError(
                    domain: "Responder.STT",
                    code: -213,
                    userInfo: [NSLocalizedDescriptionKey: "Primary STT timed out after \(seconds) seconds."]
                )
            }

            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }

    private func shouldAccept(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return !trimmed.hasPrefix("[stt_unavailable]")
    }
}

final class QwenOmniTranscriptionEngine: AudioTranscriptionEngine {
    let modelMetadata: TranscriptChunk.ModelMetadata

    private let settings: InferenceModelSettings

    init(settings: InferenceModelSettings) {
        self.settings = settings
        self.modelMetadata = TranscriptChunk.ModelMetadata(
            provider: "zetic-ai",
            name: settings.qwenDecoderModelName,
            version: settings.modelVersion,
            mode: settings.modelMode,
            latencyMS: 0
        )
    }

    func transcribe(audioSamples16kMono: [Float]) async throws -> TranscriptChunk.TranscriptOutput {
        guard !audioSamples16kMono.isEmpty else {
            return TranscriptChunk.TranscriptOutput(text: "", confidence: 0, tensorCount: 0)
        }

        return TranscriptChunk.TranscriptOutput(
            text: "[stt_unavailable] Qwen Omni STT requires newer ZeticMLange APIs than the pinned 1.6.0 package.",
            confidence: 0,
            tensorCount: 0
        )
    }
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
        // Use the known-good batch waveform shape. Probing alternate shapes can crash
        // inside the native runtime before Swift error handling gets a chance to recover.
        let input = makeTensor(from: audioSamples16kMono, shape: [1, audioSamples16kMono.count])
        return try model.run(inputs: [input])
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
