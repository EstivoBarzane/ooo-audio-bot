/**
 * OOO Audio Bot - Supabase Client
 * Gestisce storage audio, metadata, e statistiche
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Limite storage in bytes (1 GB per piano free)
const STORAGE_LIMIT_BYTES = 1 * 1024 * 1024 * 1024;
const ALERT_THRESHOLD = 0.70; // 70%

/**
 * Salva i metadata di un upload
 */
async function saveUploadMeta(data) {
  const { data: result, error } = await supabase
    .from('audio_uploads')
    .insert({
      telegram_user_id: data.telegramUserId,
      telegram_username: data.telegramUsername,
      name: data.name,
      email: data.email,
      location: data.location,
      file_name: data.fileName,
      file_path: data.filePath,
      file_size: data.fileSize,
      mime_type: data.mimeType,
      chat_type: data.chatType,
      chat_id: data.chatId,
      notes: data.notes || null,
      notes_audio_path: data.notesAudioPath || null,
      uploaded_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    console.error('Error saving metadata:', error);
    throw error;
  }

  return result;
}

/**
 * Aggiorna le note di un upload esistente
 */
async function updateUploadNotes(uploadId, notes, notesAudioPath) {
  const { data, error } = await supabase
    .from('audio_uploads')
    .update({ 
      notes: notes,
      notes_audio_path: notesAudioPath 
    })
    .eq('id', uploadId)
    .select()
    .single();

  if (error) {
    console.error('Error updating notes:', error);
    throw error;
  }

  return data;
}

/**
 * Carica un file audio nello storage
 */
async function uploadAudioFile(buffer, fileName, mimeType, folder = 'uploads') {
  const timestamp = Date.now();
  const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  const filePath = `${folder}/${timestamp}_${safeName}`;

  const { data, error } = await supabase.storage
    .from('audio-files')
    .upload(filePath, buffer, {
      contentType: mimeType,
      upsert: false
    });

  if (error) {
    console.error('Error uploading file:', error);
    throw error;
  }

  return filePath;
}

/**
 * Elimina un file dallo storage
 */
async function deleteAudioFile(filePath) {
  const { error } = await supabase.storage
    .from('audio-files')
    .remove([filePath]);

  if (error) {
    console.error('Error deleting file:', error);
    throw error;
  }

  return true;
}

/**
 * Elimina un upload (file + metadata)
 */
async function deleteUpload(uploadId) {
  // Prima recupera i path dei file
  const { data: upload, error: fetchError } = await supabase
    .from('audio_uploads')
    .select('file_path, notes_audio_path')
    .eq('id', uploadId)
    .single();

  if (fetchError) {
    console.error('Error fetching upload:', fetchError);
    throw fetchError;
  }

  // Elimina file principale
  if (upload.file_path) {
    await deleteAudioFile(upload.file_path).catch(console.error);
  }

  // Elimina note audio se presente
  if (upload.notes_audio_path) {
    await deleteAudioFile(upload.notes_audio_path).catch(console.error);
  }

  // Elimina record dal database
  const { error: deleteError } = await supabase
    .from('audio_uploads')
    .delete()
    .eq('id', uploadId);

  if (deleteError) {
    console.error('Error deleting upload record:', deleteError);
    throw deleteError;
  }

  return true;
}

/**
 * Ottiene URL pubblico di un file
 */
function getPublicUrl(filePath) {
  const { data } = supabase.storage
    .from('audio-files')
    .getPublicUrl(filePath);

  return data.publicUrl;
}

/**
 * Lista upload recenti (per admin)
 */
async function getRecentUploads(limit = 20) {
  const { data, error } = await supabase
    .from('audio_uploads')
    .select('*')
    .order('uploaded_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error fetching uploads:', error);
    throw error;
  }

  return data;
}

/**
 * Ottiene tutti gli upload
 */
async function getAllUploads() {
  const { data, error } = await supabase
    .from('audio_uploads')
    .select('*')
    .order('uploaded_at', { ascending: false });

  if (error) {
    console.error('Error fetching all uploads:', error);
    throw error;
  }

  return data;
}

/**
 * Ottiene statistiche storage
 */
async function getStorageStats() {
  const { data, error } = await supabase
    .from('storage_stats')
    .select('*')
    .eq('id', 1)
    .single();

  if (error) {
    console.error('Error fetching storage stats:', error);
    // Ritorna valori default se errore
    return { total_bytes: 0, file_count: 0 };
  }

  return data;
}

/**
 * Controlla se serve inviare alert storage
 * Ritorna oggetto alert se siamo sopra la soglia e non abbiamo gia inviato alert nelle ultime 24h
 */
async function checkStorageAlert() {
  const stats = await getStorageStats();
  const usagePercent = stats.total_bytes / STORAGE_LIMIT_BYTES;

  if (usagePercent < ALERT_THRESHOLD) {
    return null; // Sotto soglia, nessun alert
  }

  // Controlla se abbiamo gia inviato alert nelle ultime 24h
  if (stats.last_alert_sent) {
    const lastAlert = new Date(stats.last_alert_sent);
    const hoursSinceLastAlert = (Date.now() - lastAlert.getTime()) / (1000 * 60 * 60);
    if (hoursSinceLastAlert < 24) {
      return null; // Alert gia inviato di recente
    }
  }

  // Aggiorna timestamp ultimo alert
  await supabase
    .from('storage_stats')
    .update({ last_alert_sent: new Date().toISOString() })
    .eq('id', 1);

  return {
    usagePercent: Math.round(usagePercent * 100),
    usedBytes: stats.total_bytes,
    usedMB: Math.round(stats.total_bytes / (1024 * 1024)),
    limitMB: Math.round(STORAGE_LIMIT_BYTES / (1024 * 1024)),
    fileCount: stats.file_count
  };
}

/**
 * Statistiche generali
 */
async function getStats() {
  const { data, error } = await supabase
    .from('audio_uploads')
    .select('location, uploaded_at');

  if (error) {
    console.error('Error fetching stats:', error);
    return { total: 0, today: 0, byLocation: {} };
  }

  const today = new Date().toISOString().split('T')[0];
  const byLocation = {};
  let todayCount = 0;

  data.forEach(row => {
    byLocation[row.location] = (byLocation[row.location] || 0) + 1;
    if (row.uploaded_at.startsWith(today)) {
      todayCount++;
    }
  });

  return {
    total: data.length,
    today: todayCount,
    byLocation
  };
}

/**
 * Download audio file buffer from Supabase Storage
 * @param {string} filePath - Path in the audio-files bucket
 * @returns {Promise<Buffer>}
 */
async function getAudioBuffer(filePath) {
  const { data, error } = await supabase.storage
    .from('audio-files')
    .download(filePath);

  if (error) {
    console.error('Error downloading audio file:', error);
    throw error;
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Update transcription data for an upload record
 * @param {string} uploadId - Row ID in audio_uploads
 * @param {Object} updates
 * @param {string} updates.status - Transcription status
 * @param {string} [updates.text] - Transcribed text
 * @param {string} [updates.error] - Error message if failed
 * @param {string} [updates.transcribedAt] - ISO timestamp
 * @param {string} [updates.tenantId] - Tenant context (future use)
 */
async function updateTranscription(uploadId, updates) {
  const payload = {
    transcription_status: updates.status
  };

  if (updates.text !== undefined) payload.transcription = updates.text;
  if (updates.error !== undefined) payload.transcription_error = updates.error;
  if (updates.transcribedAt) payload.transcribed_at = updates.transcribedAt;
  if (updates.tenantId) payload.tenant_id = updates.tenantId;

  const { error } = await supabase
    .from('audio_uploads')
    .update(payload)
    .eq('id', uploadId);

  if (error) {
    console.error('Error updating transcription:', error);
    throw error;
  }
}

module.exports = {
  supabase,
  saveUploadMeta,
  updateUploadNotes,
  uploadAudioFile,
  deleteAudioFile,
  deleteUpload,
  getPublicUrl,
  getRecentUploads,
  getAllUploads,
  getAudioBuffer,
  updateTranscription,
  getStorageStats,
  checkStorageAlert,
  getStats,
  STORAGE_LIMIT_BYTES,
  ALERT_THRESHOLD
};
