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

    func testInferenceSettingsDefaultToAppleSTT() {
        let settings = InferenceModelSettings.fromEnvironment([:])
        XCTAssertEqual(settings.audioEngine, "APPLE")
        XCTAssertEqual(settings.whisperEncoderModelName, "OpenAI/whisper-tiny-encoder")
        XCTAssertEqual(settings.whisperDecoderModelName, "OpenAI/whisper-tiny-decoder")
        XCTAssertEqual(settings.sttTimeoutSeconds, 12)
        XCTAssertEqual(settings.memoryDefaultFallbackMessage, "default")
    }

    func testInferenceSettingsReadsMemoryDefaultMessage() {
        let settings = InferenceModelSettings.fromEnvironment([
            "RESPONDER_MEMORY_DEFAULT_MESSAGE": "I couldn't find anything relevant."
        ])

        XCTAssertEqual(settings.memoryDefaultFallbackMessage, "I couldn't find anything relevant.")
    }

    func testInferenceSettingsReadsMemoryRelevanceDistanceThreshold() {
        let settings = InferenceModelSettings.fromEnvironment([
            "RESPONDER_MEMORY_RELEVANCE_DISTANCE_THRESHOLD": "0.42"
        ])

        XCTAssertEqual(settings.memoryRelevantDistanceThreshold, 0.42, accuracy: 0.0001)
    }

    func testRelevantResultsRequireHighConfidenceMatch() {
        let now = Date(timeIntervalSince1970: 1_000)
        let strong = MemorySearchResult(
            id: 1,
            semanticDistance: 0.31,
            startedAt: now,
            endedAt: now,
            cameraName: "Rear Camera",
            locationSummary: "",
            detectionText: "person",
            transcriptText: "",
            audioText: "",
            searchText: "person"
        )
        let weak = MemorySearchResult(
            id: 2,
            semanticDistance: 0.93,
            startedAt: now,
            endedAt: now,
            cameraName: "Rear Camera",
            locationSummary: "",
            detectionText: "door",
            transcriptText: "",
            audioText: "",
            searchText: "door"
        )

        let filtered = MemorySearchSummarizer.relevantResults([strong, weak], maxDistance: 0.5)
        XCTAssertEqual(filtered.map(\.id), [1])
        XCTAssertTrue(MemorySearchSummarizer.relevantResults([weak], maxDistance: 0.5).isEmpty)
    }

    func testMemoryAnswerServiceLaunchTestSkipsWhenLLMDisabled() async {
        let service = ZeticMemoryAnswerService(settings: InferenceModelSettings.fromEnvironment([
            "RESPONDER_MEMORY_LLM_ENABLED": "false"
        ]))

        let result = await service.runLaunchTest()

        XCTAssertFalse(result.success)
        XCTAssertEqual(result.status, "Memory LLM launch test skipped: LLM disabled.")
        XCTAssertEqual(result.response, "LLM disabled")
    }

    func testMemoryAnswerServiceSanitizesThinkBlocks() {
        let raw = """
        <think>
        Okay, the user wants me to reply with exactly the phrase "memory llm launch test ready" and nothing else.
        </think>
        memory llm launch test ready
        """

        XCTAssertEqual(
            ZeticMemoryAnswerService.sanitizeModelOutput(raw),
            "memory llm launch test ready"
        )
    }

    func testMemoryAnswerServiceReturnsExactDefaultMessageWhenNoResultsAndLLMDisabled() async {
        let service = ZeticMemoryAnswerService(settings: InferenceModelSettings.fromEnvironment([
            "RESPONDER_MEMORY_DEFAULT_MESSAGE": "NO_MEMORY_MATCH",
            "RESPONDER_MEMORY_LLM_ENABLED": "false"
        ]))

        let answer = await service.summarize(
            query: "where did i see a cat",
            fallback: MemorySearchAnswer(
                summaryText: "",
                spokenText: "",
                consolidatedResults: []
            )
        )

        XCTAssertEqual(answer.summaryText, "NO_MEMORY_MATCH")
        XCTAssertEqual(answer.spokenText, "NO_MEMORY_MATCH")
        XCTAssertTrue(answer.consolidatedResults.isEmpty)
    }

    func testImpulseWakePhraseCapturesPromptUntilStop() {
        var controller = ImpulseVoiceCommandController()
        let start = Date(timeIntervalSince1970: 100)
        let middle = Date(timeIntervalSince1970: 101)
        let end = Date(timeIntervalSince1970: 102)

        let activation = controller.processTranscript("Hello Impulse", startedAt: start, endedAt: start)
        XCTAssertTrue(activation.shouldSuppressTranscript)
        XCTAssertEqual(activation.spokenReply, "Yes?")
        XCTAssertEqual(activation.captureStatus, "Listening for prompt until STOP.")
        XCTAssertNil(activation.savedPrompt)

        let capture = controller.processTranscript("draft a reminder for the team", startedAt: middle, endedAt: middle)
        XCTAssertTrue(capture.shouldSuppressTranscript)
        XCTAssertNil(capture.savedPrompt)
        XCTAssertEqual(capture.captureStatus, "Capturing prompt: draft a reminder for the team")

        let completion = controller.processTranscript("to review the demo stop", startedAt: end, endedAt: end)
        XCTAssertTrue(completion.shouldSuppressTranscript)
        XCTAssertNil(completion.spokenReply)
        XCTAssertEqual(completion.captureStatus, "Saved voice prompt locally.")
        XCTAssertEqual(
            completion.savedPrompt,
            CapturedLLMPrompt(
                text: "draft a reminder for the team to review the demo",
                startedAt: start,
                endedAt: end
            )
        )
    }

    func testImpulseWakePhraseCanCaptureSingleChunkPrompt() {
        var controller = ImpulseVoiceCommandController()
        let now = Date(timeIntervalSince1970: 200)

        let result = controller.processTranscript(
            "Hello Impulse summarize the last whiteboard session stop",
            startedAt: now,
            endedAt: now
        )

        XCTAssertTrue(result.shouldSuppressTranscript)
        XCTAssertEqual(result.spokenReply, "Yes?")
        XCTAssertEqual(result.captureStatus, "Saved voice prompt locally.")
        XCTAssertEqual(
            result.savedPrompt,
            CapturedLLMPrompt(
                text: "summarize the last whiteboard session",
                startedAt: now,
                endedAt: now
            )
        )
    }

    func testImpulseWakePhraseTreatsStoppedAsStopKeyword() {
        var controller = ImpulseVoiceCommandController()
        let now = Date(timeIntervalSince1970: 250)

        let result = controller.processTranscript(
            "Hello Impulse summarize the whiteboard session stopped",
            startedAt: now,
            endedAt: now
        )

        XCTAssertTrue(result.shouldSuppressTranscript)
        XCTAssertEqual(result.spokenReply, "Yes?")
        XCTAssertEqual(result.captureStatus, "Saved voice prompt locally.")
        XCTAssertEqual(
            result.savedPrompt,
            CapturedLLMPrompt(
                text: "summarize the whiteboard session",
                startedAt: now,
                endedAt: now
            )
        )
    }

    func testImpulseWakePhraseReturnsEmptyPromptForDefaultResponse() {
        var controller = ImpulseVoiceCommandController()
        let now = Date(timeIntervalSince1970: 275)

        let result = controller.processTranscript(
            "Hello Impulse stop",
            startedAt: now,
            endedAt: now
        )

        XCTAssertTrue(result.shouldSuppressTranscript)
        XCTAssertEqual(result.spokenReply, "Yes?")
        XCTAssertEqual(result.captureStatus, "Stopped listening. Using default response.")
        XCTAssertEqual(
            result.savedPrompt,
            CapturedLLMPrompt(
                text: "",
                startedAt: now,
                endedAt: now
            )
        )
    }

    func testImpulsePromptCaptureDeduplicatesOverlappingChunks() {
        var controller = ImpulseVoiceCommandController()
        let start = Date(timeIntervalSince1970: 300)
        let overlap = Date(timeIntervalSince1970: 301)
        let end = Date(timeIntervalSince1970: 302)

        _ = controller.processTranscript("Hello Impulse", startedAt: start, endedAt: start)
        _ = controller.processTranscript("build a checklist for launch", startedAt: overlap, endedAt: overlap)
        let result = controller.processTranscript("for launch stop", startedAt: end, endedAt: end)

        XCTAssertEqual(
            result.savedPrompt,
            CapturedLLMPrompt(
                text: "build a checklist for launch",
                startedAt: start,
                endedAt: end
            )
        )
    }
}
