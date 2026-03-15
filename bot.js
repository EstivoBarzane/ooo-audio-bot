/**
 * OOO Audio Bot - VOX
 * Bot Telegram per raccolta file audio
 * 
 * Attivazione: "vox" o "@OOOaudioBot"
 * Flow: Nome → Email → Location → Audio → Note (opzionali) → Fine
 */

require('dotenv').config();
const { Bot, InlineKeyboard, session } = require('grammy');
const { 
  saveUploadMeta, 
  uploadAudioFile,
  checkStorageAlert,
  getRecentUploads,
  getStats 
} = require('./supabase');

// Inizializza bot
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// Locations dal .env
const LOCATIONS = (process.env.LOCATIONS || 'Location 1,Location 2,Location 3')
  .split(',')
  .map(l => l.trim());

// Admin chat ID per notifiche
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';

// Keyword di attivazione
const ACTIVATION_KEYWORD = 'vox';

// Session middleware - traccia stato per ogni utente
bot.use(session({
  initial: () => ({
    step: 'idle',
    name: null,
    email: null,
    location: null,
    uploadedFiles: [],
    notes: null,
    notesAudioPath: null
  })
}));

// ============================================
// ATTIVAZIONE: "vox" o menzione
// ============================================

bot.on('message:text', async (ctx, next) => {
  const text = ctx.message.text.toLowerCase().trim();
  
  // Ignora comandi
  if (text.startsWith('/')) {
    return next();
  }
  
  // Check se siamo gia in una sessione attiva
  if (ctx.session.step !== 'idle') {
    return next();
  }
  
  // Check attivazione: "vox" o menzione del bot
  const botUsername = ctx.me.username.toLowerCase();
  const isActivation = 
    text.includes(ACTIVATION_KEYWORD) || 
    text.includes(`@${botUsername}`);
  
  if (isActivation) {
    // Avvia sessione
    ctx.session.step = 'awaiting_name';
    ctx.session.name = null;
    ctx.session.email = null;
    ctx.session.location = null;
    ctx.session.uploadedFiles = [];
    ctx.session.notes = null;
    ctx.session.notesAudioPath = null;
    
    await ctx.reply('Sono pronto a caricare l\'audio. Il tuo nome?');
    return;
  }
  
  return next();
});

// ============================================
// COMANDI
// ============================================

// /start - Inizia il flow (alternativa a "vox")
bot.command('start', async (ctx) => {
  ctx.session.step = 'awaiting_name';
  ctx.session.name = null;
  ctx.session.email = null;
  ctx.session.location = null;
  ctx.session.uploadedFiles = [];
  ctx.session.notes = null;
  ctx.session.notesAudioPath = null;

  await ctx.reply('Sono pronto a caricare l\'audio. Il tuo nome?');
});

// /cancel - Annulla operazione
bot.command('cancel', async (ctx) => {
  ctx.session.step = 'idle';
  ctx.session.uploadedFiles = [];
  await ctx.reply('Operazione annullata. Scrivi "vox" per ricominciare.');
});

// /done - Completa upload audio, passa alle note
bot.command('done', async (ctx) => {
  if (ctx.session.step !== 'awaiting_audio') {
    return;
  }
  
  if (ctx.session.uploadedFiles.length === 0) {
    await ctx.reply('Non hai ancora caricato nessun file audio.');
    return;
  }
  
  // Passa alla fase note
  ctx.session.step = 'awaiting_notes_choice';
  
  const keyboard = new InlineKeyboard()
    .text('Si, voglio aggiungere note', 'notes:yes')
    .row()
    .text('No, ho finito', 'notes:no');
  
  await ctx.reply(
    `Hai caricato ${ctx.session.uploadedFiles.length} file audio.\n\n` +
    'Vuoi aggiungere delle note o considerazioni?',
    { reply_markup: keyboard }
  );
});

// /skip - Salta le note
bot.command('skip', async (ctx) => {
  if (ctx.session.step === 'awaiting_notes') {
    await completeSession(ctx);
  }
});

// /list - Lista upload recenti (solo admin)
bot.command('list', async (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_CHAT_ID)) {
    return;
  }

  try {
    const uploads = await getRecentUploads(10);
    
    if (uploads.length === 0) {
      await ctx.reply('Nessun upload recente.');
      return;
    }

    let message = '*Ultimi 10 upload:*\n\n';
    uploads.forEach((u, i) => {
      const date = new Date(u.uploaded_at).toLocaleString('it-IT');
      message += `${i + 1}. *${u.name}* (${u.location})\n`;
      message += `   ${u.file_name}\n`;
      message += `   ${date}\n\n`;
    });

    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    await ctx.reply('Errore nel recupero degli upload.');
    console.error(error);
  }
});

// /stats - Statistiche (solo admin)
bot.command('stats', async (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_CHAT_ID)) {
    return;
  }

  try {
    const stats = await getStats();
    
    let message = '*Statistiche Upload*\n\n';
    message += `Totale: *${stats.total}* file\n`;
    message += `Oggi: *${stats.today}* file\n\n`;
    message += '*Per location:*\n';
    
    Object.entries(stats.byLocation).forEach(([loc, count]) => {
      message += `- ${loc}: ${count}\n`;
    });

    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    await ctx.reply('Errore nel calcolo statistiche.');
    console.error(error);
  }
});

// ============================================
// FLOW CONVERSAZIONALE
// ============================================

// Gestisce messaggi di testo
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();
  
  // Ignora comandi
  if (text.startsWith('/')) return;

  switch (ctx.session.step) {
    case 'awaiting_name':
      ctx.session.name = text;
      ctx.session.step = 'awaiting_email';
      await ctx.reply('La tua email?');
      break;

    case 'awaiting_email':
      if (!text.includes('@')) {
        await ctx.reply('Mmh, non sembra un\'email valida. Riprova:');
        return;
      }
      ctx.session.email = text.toLowerCase();
      ctx.session.step = 'awaiting_location';
      
      // Mostra bottoni location (uno sotto l'altro)
      const keyboard = new InlineKeyboard();
      LOCATIONS.forEach((loc) => {
        keyboard.text(loc, `location:${loc}`).row();
      });

      await ctx.reply('Location?', {
        reply_markup: keyboard
      });
      break;

    case 'awaiting_notes':
      // Raccoglie note testuali
      ctx.session.notes = text;
      await ctx.reply('Grazie!');
      await completeSession(ctx, true); // true = silent mode
      break;

    case 'awaiting_audio':
      // Check se l'utente vuole aggiungere note
      const lowerText = text.toLowerCase();
      if (lowerText.includes('nota') || lowerText.includes('note') || lowerText.includes('aggiung')) {
        if (ctx.session.uploadedFiles.length === 0) {
          await ctx.reply('Prima carica almeno un file audio.');
          return;
        }
        ctx.session.step = 'awaiting_notes';
        await ctx.reply('Scrivi le tue note, oppure invia un messaggio vocale.');
        return;
      }
      
      // Altrimenti ricorda di caricare audio
      if (ctx.session.uploadedFiles.length === 0) {
        await ctx.reply('Mandami i tuoi file audio!');
      } else {
        const actionKeyboard = new InlineKeyboard()
          .text('📁  Carico un altro file  📁', 'action:another')
          .row()
          .text('📝  Aggiungo una nota  📝', 'action:add_note')
          .row()
          .text('✅  Finito!  ✅', 'action:done');
        
        await ctx.reply(
          `Hai caricato ${ctx.session.uploadedFiles.length} file audio.`,
          { reply_markup: actionKeyboard }
        );
      }
      break;

    default:
      // Utente non in sessione - ignora (in gruppo) o suggerisci attivazione (in privato)
      if (ctx.chat.type === 'private') {
        await ctx.reply('Scrivi "vox" per iniziare a caricare i tuoi audio.');
      }
  }
});

// Gestisce selezione location (callback query)
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  
  if (data.startsWith('location:')) {
    const location = data.replace('location:', '');
    ctx.session.location = location;
    ctx.session.step = 'awaiting_audio';

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`Location: *${location}*`, { 
      parse_mode: 'Markdown' 
    });
    
    await ctx.reply('Puoi inviare file audio, messaggi vocali o note testuali.');
  }
  
  if (data === 'notes:yes') {
    ctx.session.step = 'awaiting_notes';
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('Aggiungi note o considerazioni:');
    await ctx.reply(
      'Scrivi le tue note, oppure invia un messaggio vocale.'
    );
  }
  
  if (data === 'notes:no') {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('Nessuna nota aggiunta.');
    await completeSession(ctx);
  }
  
  // Nuovi bottoni azione dopo upload file
  if (data === 'action:another') {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`Hai caricato ${ctx.session.uploadedFiles.length} file audio. In attesa di altri...`);
    // Resta in awaiting_audio, l'utente manderà altri file
  }
  
  if (data === 'action:add_note') {
    ctx.session.step = 'awaiting_notes';
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`Hai caricato ${ctx.session.uploadedFiles.length} file audio.`);
    await ctx.reply('Scrivi le tue note, oppure invia un messaggio vocale.');
  }
  
  if (data === 'action:done') {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`Hai caricato ${ctx.session.uploadedFiles.length} file audio.`);
    await completeSession(ctx);
  }
});

// ============================================
// GESTIONE FILE AUDIO
// ============================================

// Audio file
bot.on('message:audio', handleAudioUpload);
bot.on('message:voice', handleAudioUpload);
bot.on('message:video_note', handleAudioUpload);

// Document audio
bot.on('message:document', async (ctx) => {
  const doc = ctx.message.document;
  const mimeType = doc.mime_type || '';
  
  if (mimeType.startsWith('audio/')) {
    await handleAudioUpload(ctx);
  }
});

async function handleAudioUpload(ctx) {
  // Check se in fase note - salva come nota audio
  if (ctx.session.step === 'awaiting_notes') {
    await handleNotesAudio(ctx);
    return;
  }
  
  // Verifica che l'utente abbia completato il form
  if (!ctx.session.name || !ctx.session.email || !ctx.session.location) {
    if (ctx.chat.type === 'private') {
      await ctx.reply(
        'Prima di inviare file audio, completa la registrazione.\n' +
        'Scrivi "vox" per iniziare.'
      );
    }
    return;
  }

  try {
    // Determina il tipo di file
    let file, fileName, mimeType;
    
    if (ctx.message.audio) {
      file = ctx.message.audio;
      fileName = file.file_name || `audio_${Date.now()}.mp3`;
      mimeType = file.mime_type || 'audio/mpeg';
    } else if (ctx.message.voice) {
      file = ctx.message.voice;
      fileName = `voice_${Date.now()}.ogg`;
      mimeType = file.mime_type || 'audio/ogg';
    } else if (ctx.message.video_note) {
      file = ctx.message.video_note;
      fileName = `videonote_${Date.now()}.mp4`;
      mimeType = 'video/mp4';
    } else if (ctx.message.document) {
      file = ctx.message.document;
      fileName = file.file_name || `document_${Date.now()}`;
      mimeType = file.mime_type || 'audio/mpeg';
    }

    // Feedback immediato
    const statusMsg = await ctx.reply('Caricamento in corso...');

    // Scarica file da Telegram
    const fileData = await ctx.api.getFile(file.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileData.file_path}`;
    
    // Fetch del file
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());

    // Upload su Supabase Storage
    const filePath = await uploadAudioFile(buffer, fileName, mimeType, 'uploads');

    // Salva metadata
    const uploadRecord = await saveUploadMeta({
      telegramUserId: ctx.from.id,
      telegramUsername: ctx.from.username || null,
      name: ctx.session.name,
      email: ctx.session.email,
      location: ctx.session.location,
      fileName: fileName,
      filePath: filePath,
      fileSize: file.file_size,
      mimeType: mimeType,
      chatType: ctx.chat.type,
      chatId: ctx.chat.id
    });

    ctx.session.uploadedFiles.push({
      id: uploadRecord.id,
      fileName: fileName,
      filePath: filePath
    });

    // Conferma con bottoni
    await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
    
    const actionKeyboard = new InlineKeyboard()
      .text('📁  Carico un altro file  📁', 'action:another')
      .row()
      .text('📝  Aggiungo una nota  📝', 'action:add_note')
      .row()
      .text('✅  Finito!  ✅', 'action:done');
    
    await ctx.reply(
      `Hai caricato ${ctx.session.uploadedFiles.length} file audio.`,
      { reply_markup: actionKeyboard }
    );

    // Check storage alert
    await checkAndSendStorageAlert(ctx);

    // Notifica admin (primo file)
    if (ctx.session.uploadedFiles.length === 1) {
      await notifyAdmin(ctx, 'new_upload');
    }

  } catch (error) {
    console.error('Upload error:', error);
    await ctx.reply(
      'Errore durante il caricamento. Riprova.\n' +
      `Dettaglio: ${error.message}`
    );
  }
}

async function handleNotesAudio(ctx) {
  try {
    let file, fileName, mimeType;
    
    if (ctx.message.voice) {
      file = ctx.message.voice;
      fileName = `notes_voice_${Date.now()}.ogg`;
      mimeType = 'audio/ogg';
    } else if (ctx.message.audio) {
      file = ctx.message.audio;
      fileName = file.file_name || `notes_audio_${Date.now()}.mp3`;
      mimeType = file.mime_type || 'audio/mpeg';
    } else {
      return;
    }
    
    const statusMsg = await ctx.reply('Salvo la nota vocale...');
    
    // Scarica e upload
    const fileData = await ctx.api.getFile(file.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileData.file_path}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    
    const filePath = await uploadAudioFile(buffer, fileName, mimeType, 'notes');
    ctx.session.notesAudioPath = filePath;
    
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      'Grazie!'
    );
    
    // Completa sessione in silent mode
    await completeSession(ctx, true);
    
  } catch (error) {
    console.error('Notes audio error:', error);
    await ctx.reply('Errore nel salvataggio della nota vocale.');
  }
}

// ============================================
// COMPLETAMENTO SESSIONE
// ============================================

async function completeSession(ctx, silent = false) {
  const filesCount = ctx.session.uploadedFiles.length;
  
  if (!silent) {
    await ctx.reply(
      `Perfetto! Hai caricato ${filesCount} file audio.\n\n` +
      'Grazie per il tuo contributo!'
    );
  }
  
  // Notifica admin completamento
  await notifyAdmin(ctx, 'completed');
  
  // Reset session
  ctx.session.step = 'idle';
  ctx.session.uploadedFiles = [];
  ctx.session.notes = null;
  ctx.session.notesAudioPath = null;
}

// ============================================
// NOTIFICHE E ALERT
// ============================================

async function notifyAdmin(ctx, type) {
  if (!ADMIN_CHAT_ID) return;

  try {
    let message;
    
    if (type === 'new_upload') {
      message = 
        '*Nuovo upload in corso*\n\n' +
        `Nome: ${ctx.session.name}\n` +
        `Email: ${ctx.session.email}\n` +
        `Location: ${ctx.session.location}\n` +
        `Chat: ${ctx.chat.type === 'private' ? 'Privata' : 'Gruppo'}`;
    } else if (type === 'completed') {
      let noteInfo = '';
      if (ctx.session.notes) {
        noteInfo = `\nNote: "${ctx.session.notes.substring(0, 50)}${ctx.session.notes.length > 50 ? '...' : ''}"`;
      }
      if (ctx.session.notesAudioPath) {
        noteInfo += '\nNota vocale: Si';
      }
      
      message = 
        '*Upload completato*\n\n' +
        `Nome: ${ctx.session.name}\n` +
        `Email: ${ctx.session.email}\n` +
        `Location: ${ctx.session.location}\n` +
        `File: ${ctx.session.uploadedFiles.length}` +
        noteInfo;
    }

    await bot.api.sendMessage(ADMIN_CHAT_ID, message, { 
      parse_mode: 'Markdown' 
    });
  } catch (error) {
    console.error('Error notifying admin:', error);
  }
}

async function checkAndSendStorageAlert(ctx) {
  try {
    const alert = await checkStorageAlert();
    
    if (alert) {
      const message = 
        `*Storage Alert*\n\n` +
        `Utilizzo: ${alert.usagePercent}%\n` +
        `Spazio: ${alert.usedMB} MB / ${alert.limitMB} MB\n` +
        `File: ${alert.fileCount}\n\n` +
        `Consigliato: scarica e archivia i file piu vecchi.`;
      
      // Invia alert via Telegram
      if (ADMIN_CHAT_ID) {
        await bot.api.sendMessage(ADMIN_CHAT_ID, message, { 
          parse_mode: 'Markdown' 
        });
      }
      
      // TODO: Invia alert via email (implementare con Resend o altro servizio)
    }
  } catch (error) {
    console.error('Error checking storage alert:', error);
  }
}

// ============================================
// ERROR HANDLING
// ============================================

bot.catch((err) => {
  console.error('Bot error:', err);
});

// ============================================
// START BOT
// ============================================

console.log('VOX - OOO Audio Bot starting...');
bot.start();
console.log('VOX is running! Activation: "vox" or @OOOaudioBot');
