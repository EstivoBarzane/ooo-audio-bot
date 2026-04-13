/**
 * VOX Transcription Module
 * 
 * Handles audio-to-text transcription via OpenAI GPT-4o Transcribe.
 * Designed for future integration with OOO Experiences platform.
 * 
 * @module transcription
 */

const OpenAI = require('openai');
const { toFile } = require('openai');
const { Readable } = require('stream');
const {
  getAudioBuffer,
  uploadTranscriptionFile,
  updateTranscription
} = require('./supabase');

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // OpenAI limit
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

let _client = null;

/**
 * Lazy-init OpenAI client (fails fast if key missing)
 */
function getClient() {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

/**
 * Transcribe an audio file stored in Supabase Storage.
 * 
 * @param {string} uploadId - Row ID in audio_uploads
 * @param {string} filePath - Path in Supabase Storage bucket
 * @param {string} fileName - Original file name (used for format detection)
 * @param {Object} [options]
 * @param {string} [options.language='it'] - ISO 639-1 language code
 * @param {string} [options.tenantId] - Tenant context (for future use)
 * @returns {Promise<{text: string, status: string}>}
 */
async function transcribeUpload(uploadId, filePath, fileName, options = {}) {
  const { language = 'it', tenantId = null } = options;

  await updateTranscription(uploadId, {
    status: 'processing',
    tenantId
  });

  try {
    const buffer = await getAudioBuffer(filePath);

    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
      throw new Error(`File too large for transcription: ${sizeMB}MB (max 25MB)`);
    }

    const text = await callTranscribeAPI(buffer, fileName, language);

    // Save .txt file to Storage alongside the audio
    const txtFilePath = await uploadTranscriptionFile(filePath, text);

    await updateTranscription(uploadId, {
      status: 'completed',
      text,
      filePath: txtFilePath,
      transcribedAt: new Date().toISOString(),
      tenantId
    });

    console.log(`[transcription] completed: upload=${uploadId} chars=${text.length}`);
    return { text, status: 'completed' };

  } catch (err) {
    const errorMsg = err.message || 'Unknown transcription error';
    console.error(`[transcription] failed: upload=${uploadId} error=${errorMsg}`);

    await updateTranscription(uploadId, {
      status: 'failed',
      error: errorMsg.slice(0, 500),
      tenantId
    }).catch(dbErr => {
      console.error(`[transcription] failed to update status: ${dbErr.message}`);
    });

    return { text: null, status: 'failed', error: errorMsg };
  }
}

/**
 * Call OpenAI GPT-4o Transcribe API with retry logic.
 * 
 * @param {Buffer} buffer - Audio file buffer
 * @param {string} fileName - File name for format detection
 * @param {string} language - ISO 639-1 language code
 * @returns {Promise<string>} Transcribed text
 */
async function callTranscribeAPI(buffer, fileName, language) {
  const client = getClient();
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const delay = RETRY_DELAY_MS * attempt;
        console.log(`[transcription] retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
        await sleep(delay);
      }

      const file = await toFile(buffer, fileName, {
        type: getMimeType(fileName)
      });

      const response = await client.audio.transcriptions.create({
        model: 'gpt-4o-transcribe',
        file,
        language,
        response_format: 'text'
      });

      const text = typeof response === 'string' ? response : response.text;

      if (!text || text.trim().length === 0) {
        throw new Error('Transcription returned empty text');
      }

      return text.trim();

    } catch (err) {
      lastError = err;

      // Don't retry on client errors (bad file, invalid format)
      if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw err;
      }
    }
  }

  throw lastError;
}

/**
 * Infer MIME type from file extension.
 */
function getMimeType(fileName) {
  const ext = (fileName || '').split('.').pop().toLowerCase();
  const types = {
    mp3: 'audio/mpeg',
    mp4: 'audio/mp4',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    webm: 'audio/webm',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    flac: 'audio/flac'
  };
  return types[ext] || 'audio/mpeg';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  transcribeUpload,
  // Exported for testing
  _internal: {
    callTranscribeAPI,
    getClient,
    getMimeType
  }
};
