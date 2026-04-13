/**
 * Batch Transcribe - Transcribes all pending audio uploads
 * 
 * Usage: node batch-transcribe.js
 * 
 * Requires environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENAI_API_KEY
 */

require('dotenv').config();
const { supabase } = require('./supabase');
const { transcribeUpload } = require('./transcription');

const BATCH_DELAY_MS = 2000; // Pause between transcriptions to avoid rate limits

async function batchTranscribe() {
  console.log('[batch] Fetching pending uploads...');

  const { data: pending, error } = await supabase
    .from('audio_uploads')
    .select('id, file_path, file_name')
    .eq('transcription_status', 'pending')
    .order('uploaded_at', { ascending: true });

  if (error) {
    console.error('[batch] Failed to fetch pending uploads:', error.message);
    process.exit(1);
  }

  if (!pending || pending.length === 0) {
    console.log('[batch] No pending uploads found. Done.');
    return;
  }

  console.log(`[batch] Found ${pending.length} pending uploads. Starting...`);

  let completed = 0;
  let failed = 0;

  for (let i = 0; i < pending.length; i++) {
    const upload = pending[i];
    const progress = `[${i + 1}/${pending.length}]`;

    console.log(`${progress} Transcribing: ${upload.file_name || upload.file_path}`);

    const result = await transcribeUpload(upload.id, upload.file_path, upload.file_name || 'audio.mp3');

    if (result.status === 'completed') {
      completed++;
      console.log(`${progress} OK (${result.text.length} chars)`);
    } else {
      failed++;
      console.log(`${progress} FAILED: ${result.error}`);
    }

    // Pause between transcriptions
    if (i < pending.length - 1) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log(`\n[batch] Done. Completed: ${completed}, Failed: ${failed}, Total: ${pending.length}`);
}

batchTranscribe().catch(err => {
  console.error('[batch] Fatal error:', err.message);
  process.exit(1);
});
