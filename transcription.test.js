/**
 * Transcription Module Tests
 * 
 * Tests for audio transcription via OpenAI GPT-4o Transcribe.
 * Run with: node --test transcription.test.js
 */

const { describe, it, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ─────────────────────────────────────────────────────────────
// MOCKS
// ─────────────────────────────────────────────────────────────

const mockSupabase = {
  downloadResult: { data: null, error: null },
  updateResult: { error: null }
};

// Mock supabase module
mock.module('./supabase', {
  namedExports: {
    getAudioBuffer: mock.fn(async () => {
      if (mockSupabase.downloadResult.error) {
        throw mockSupabase.downloadResult.error;
      }
      return Buffer.from('fake-audio-data');
    }),
    updateTranscription: mock.fn(async () => {
      if (mockSupabase.updateResult.error) {
        throw mockSupabase.updateResult.error;
      }
    })
  }
});

// Mock openai module
const mockCreate = mock.fn(async () => 'Testo trascritto di esempio.');

mock.module('openai', {
  defaultExport: class MockOpenAI {
    constructor() {
      this.audio = {
        transcriptions: { create: mockCreate }
      };
    }
  }
});

// Set env before requiring module
process.env.OPENAI_API_KEY = 'test-key-123';

const { transcribeUpload, _internal } = require('./transcription');
const { getAudioBuffer, updateTranscription } = require('./supabase');

// ─────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────

describe('transcription module', () => {

  beforeEach(() => {
    mockCreate.mock.resetCalls();
    getAudioBuffer.mock.resetCalls();
    updateTranscription.mock.resetCalls();
    mockSupabase.downloadResult = { data: null, error: null };
    mockSupabase.updateResult = { error: null };
  });

  describe('transcribeUpload', () => {

    // SUCCESS
    it('should transcribe audio and update DB with completed status', async () => {
      const result = await transcribeUpload(
        'upload-123',
        'uploads/test.mp3',
        'test.mp3'
      );

      assert.equal(result.status, 'completed');
      assert.equal(result.text, 'Testo trascritto di esempio.');

      // Verify status was set to processing first, then completed
      const statusCalls = updateTranscription.mock.calls;
      assert.equal(statusCalls.length, 2);
      assert.equal(statusCalls[0].arguments[1].status, 'processing');
      assert.equal(statusCalls[1].arguments[1].status, 'completed');
      assert.ok(statusCalls[1].arguments[1].text);
      assert.ok(statusCalls[1].arguments[1].transcribedAt);
    });

    // ERROR: OpenAI failure
    it('should handle OpenAI API errors and set failed status', async () => {
      const apiError = new Error('OpenAI service unavailable');
      apiError.status = 503;
      mockCreate.mock.mockImplementation(async () => { throw apiError; });

      const result = await transcribeUpload(
        'upload-456',
        'uploads/test.mp3',
        'test.mp3'
      );

      assert.equal(result.status, 'failed');
      assert.equal(result.text, null);
      assert.ok(result.error.includes('service unavailable'));

      // Verify failed status was saved
      const lastCall = updateTranscription.mock.calls.at(-1);
      assert.equal(lastCall.arguments[1].status, 'failed');
      assert.ok(lastCall.arguments[1].error);
    });

    // ERROR: Storage download failure
    it('should handle storage download errors', async () => {
      mockSupabase.downloadResult.error = new Error('Storage not found');
      getAudioBuffer.mock.mockImplementation(async () => {
        throw new Error('Storage not found');
      });

      const result = await transcribeUpload(
        'upload-789',
        'uploads/missing.mp3',
        'missing.mp3'
      );

      assert.equal(result.status, 'failed');
      assert.ok(result.error.includes('Storage not found'));
    });

    // EDGE: Empty transcription
    it('should handle empty transcription result', async () => {
      mockCreate.mock.mockImplementation(async () => '   ');

      const result = await transcribeUpload(
        'upload-empty',
        'uploads/silence.mp3',
        'silence.mp3'
      );

      assert.equal(result.status, 'failed');
      assert.ok(result.error.includes('empty text'));
    });

    // EDGE: tenant_id propagation
    it('should pass tenant_id through to DB updates', async () => {
      await transcribeUpload(
        'upload-tenant',
        'uploads/test.mp3',
        'test.mp3',
        { tenantId: 'tenant-abc' }
      );

      const calls = updateTranscription.mock.calls;
      assert.equal(calls[0].arguments[1].tenantId, 'tenant-abc');
      assert.equal(calls[1].arguments[1].tenantId, 'tenant-abc');
    });
  });

  describe('getMimeType', () => {
    it('should return correct MIME types', () => {
      assert.equal(_internal.getMimeType('test.mp3'), 'audio/mpeg');
      assert.equal(_internal.getMimeType('test.wav'), 'audio/wav');
      assert.equal(_internal.getMimeType('test.m4a'), 'audio/mp4');
      assert.equal(_internal.getMimeType('test.ogg'), 'audio/ogg');
      assert.equal(_internal.getMimeType('test.flac'), 'audio/flac');
      assert.equal(_internal.getMimeType('test.webm'), 'audio/webm');
    });

    it('should default to audio/mpeg for unknown extensions', () => {
      assert.equal(_internal.getMimeType('test.xyz'), 'audio/mpeg');
      assert.equal(_internal.getMimeType(''), 'audio/mpeg');
    });
  });
});
