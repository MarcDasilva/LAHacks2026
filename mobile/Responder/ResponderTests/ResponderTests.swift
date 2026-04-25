import XCTest
@testable import Responder

final class ResponderTests: XCTestCase {
    func testInferenceSettingsPreferPersonalKeyOverToken() {
        let settings = InferenceModelSettings.fromEnvironment([
            "ZETIC_PERSONAL_KEY": "dev_key",
            "ZETIC_TOKEN": "ztp_token"
        ])
        XCTAssertEqual(settings.personalKey, "dev_key")
    }

    func testInferenceSettingsChunkDefaults() {
        let settings = InferenceModelSettings.fromEnvironment([
            "RESPONDER_CHUNK_FRAMES": "45",
            "RESPONDER_AUDIO_SAMPLES_PER_CHUNK": "32000"
        ])
        XCTAssertEqual(settings.maxFramesPerChunk, 45)
        XCTAssertEqual(settings.audioSamplesPerChunk, 32000)
    }
}
