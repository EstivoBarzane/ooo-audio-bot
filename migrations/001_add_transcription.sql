-- Migration 001: Add transcription support + multi-tenant preparation
-- Target: Supabase ooo-audio-bot (ifikwaymnmouvpmbvuqz)
-- Date: 2026-04-13

-- 1. Transcription columns
ALTER TABLE audio_uploads
  ADD COLUMN IF NOT EXISTS transcription text,
  ADD COLUMN IF NOT EXISTS transcription_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS transcription_error text,
  ADD COLUMN IF NOT EXISTS transcribed_at timestamptz;

-- 2. Multi-tenant preparation (nullable for now, required when integrated with Experiences)
ALTER TABLE audio_uploads
  ADD COLUMN IF NOT EXISTS tenant_id uuid;

-- 3. Index for processing queue (find pending transcriptions efficiently)
CREATE INDEX IF NOT EXISTS idx_audio_uploads_transcription_status
  ON audio_uploads (transcription_status)
  WHERE transcription_status IN ('pending', 'processing');

-- 4. Index for future multi-tenant queries
CREATE INDEX IF NOT EXISTS idx_audio_uploads_tenant_id
  ON audio_uploads (tenant_id)
  WHERE tenant_id IS NOT NULL;

-- 5. Constraint on valid statuses
ALTER TABLE audio_uploads
  ADD CONSTRAINT chk_transcription_status
  CHECK (transcription_status IN ('pending', 'processing', 'completed', 'failed', 'skipped'));

-- 6. Reload PostgREST schema
NOTIFY pgrst, 'reload schema';
