import Foundation

struct AudioMelSpectrogram {
    private let sampleRate = 16_000
    private let fftSize = 400
    private let hopSize = 160
    private let melBands = 128
    private let framesPerChunk = 200
    private let melFilterRows = 128
    private let melFilterCols = 201

    func makeMelChunks(from pcm16kMono: [Float]) -> [[Float]] {
        guard !pcm16kMono.isEmpty else { return [] }
        let frames = stftPowerFrames(samples: pcm16kMono)
        guard !frames.isEmpty else { return [] }

        let melFilters = makeMelFilterBank()
        var melFrames = [[Float]]()
        melFrames.reserveCapacity(frames.count)

        for power in frames {
            var mel = [Float](repeating: 0, count: melBands)
            for m in 0..<melBands {
                var sum: Float = 0
                let filter = melFilters[m]
                for k in 0..<filter.count {
                    sum += filter[k] * power[k]
                }
                mel[m] = max(sum, 1e-10)
            }
            melFrames.append(normalizeLogMel(mel))
        }

        var chunks = [[Float]]()
        var start = 0
        while start < melFrames.count {
            let end = min(start + framesPerChunk, melFrames.count)
            let span = end - start
            var chunk = [Float](repeating: 0, count: melBands * framesPerChunk)
            for frameIdx in 0..<span {
                let frame = melFrames[start + frameIdx]
                for melIdx in 0..<melBands {
                    chunk[melIdx * framesPerChunk + frameIdx] = frame[melIdx]
                }
            }
            chunks.append(chunk)
            start += framesPerChunk
        }
        return chunks
    }

    private func stftPowerFrames(samples: [Float]) -> [[Float]] {
        let window = periodicHann(count: fftSize)
        let bins = fftSize / 2 + 1
        guard samples.count >= fftSize else { return [] }

        var frames = [[Float]]()
        var offset = 0
        while offset + fftSize <= samples.count {
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

    private func normalizeLogMel(_ mel: [Float]) -> [Float] {
        let logs = mel.map { log10f($0) }
        let maxLog = logs.max() ?? 0
        return logs.map { max($0, maxLog - 8) / 4 + 1 }
    }

    private func makeMelFilterBank() -> [[Float]] {
        if let bundled = loadBundledMelFilterBank() {
            return bundled
        }

        let fftBins = fftSize / 2 + 1
        let fMin: Float = 0
        let fMax: Float = Float(sampleRate) / 2

        let mMin = hzToMel(fMin)
        let mMax = hzToMel(fMax)
        let melPoints = (0..<(melBands + 2)).map { i -> Float in
            mMin + Float(i) * (mMax - mMin) / Float(melBands + 1)
        }
        let hzPoints = melPoints.map(melToHz)
        let binPoints = hzPoints.map { hz in
            Int(floor((Float(fftSize + 1) * hz) / Float(sampleRate)))
        }

        var filters = Array(repeating: Array(repeating: Float(0), count: fftBins), count: melBands)
        for m in 1...melBands {
            let left = max(0, min(fftBins - 1, binPoints[m - 1]))
            let center = max(0, min(fftBins - 1, binPoints[m]))
            let right = max(0, min(fftBins - 1, binPoints[m + 1]))
            if left == center || center == right { continue }

            for k in left..<center {
                filters[m - 1][k] = Float(k - left) / Float(center - left)
            }
            for k in center..<right {
                filters[m - 1][k] = Float(right - k) / Float(right - center)
            }

            // Slaney-style area normalization.
            let enorm = 2.0 / (hzPoints[m + 1] - hzPoints[m - 1])
            for k in 0..<fftBins {
                filters[m - 1][k] *= enorm
            }
        }

        return filters
    }

    private func loadBundledMelFilterBank() -> [[Float]]? {
        guard let url = Bundle.main.url(forResource: "mel_filterbank", withExtension: "bin"),
              let data = try? Data(contentsOf: url)
        else {
            return nil
        }

        let expectedFloatCount = melFilterRows * melFilterCols
        let expectedByteCount = expectedFloatCount * MemoryLayout<Float>.size
        guard data.count == expectedByteCount else {
            print("[Responder][Preprocess] mel_filterbank.bin size mismatch. expectedBytes=\(expectedByteCount) actualBytes=\(data.count). Falling back to generated filter bank.")
            return nil
        }

        let values: [Float] = data.withUnsafeBytes { rawBuffer in
            guard let base = rawBuffer.bindMemory(to: Float.self).baseAddress else { return [] }
            return Array(UnsafeBufferPointer(start: base, count: expectedFloatCount))
        }
        guard values.count == expectedFloatCount else { return nil }

        var filters = Array(repeating: Array(repeating: Float(0), count: melFilterCols), count: melFilterRows)
        for row in 0..<melFilterRows {
            let start = row * melFilterCols
            filters[row] = Array(values[start..<(start + melFilterCols)])
        }
        print("[Responder][Preprocess] Loaded bundled mel_filterbank.bin")
        return filters
    }

    private func hzToMel(_ hz: Float) -> Float {
        2595 * log10f(1 + hz / 700)
    }

    private func melToHz(_ mel: Float) -> Float {
        700 * (powf(10, mel / 2595) - 1)
    }
}
