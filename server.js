require('dotenv').config();
const path = require('path');
const express = require('express');
const { Bot, InlineKeyboard, webhookCallback } = require('grammy');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const DOMAIN = process.env.DOMAIN || process.env.RENDER_EXTERNAL_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

if (!BOT_TOKEN) {
  console.error('ОШИБКА: BOT_TOKEN не найден в .env файле!');
  process.exit(1);
}

// In-memory state (userId => { id, name, username, photoUrl, timeStr, timestamp })
const raisedHands = new Map();

// Initialize Telegram Bot & Error Handler
const bot = new Bot(BOT_TOKEN);
bot.catch((err) => {
  console.error('Ошибка обработки бота Telegram:', err.message);
});

// Helper to fetch user's Telegram profile photo URL
async function getTelegramPhotoUrl(userId) {
  try {
    const photos = await bot.api.getUserProfilePhotos(Number(userId), { limit: 1 });
    if (photos && photos.total_count > 0 && photos.photos && photos.photos[0] && photos.photos[0].length > 0) {
      const photoSizes = photos.photos[0];
      const photo = photoSizes[photoSizes.length - 1]; // Best quality photo
      const file = await bot.api.getFile(photo.file_id);
      return `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    }
  } catch (err) {
    console.error(`Не удалось загрузить аватар пользователя ${userId}:`, err.message);
  }
  return null;
}

// Keyboard with Toggle Button (Russian)
const getHandKeyboard = (isUp) => {
  const text = isUp ? '✋ Опустить руку' : '✋ Поднять руку';
  const data = isUp ? 'hand_down' : 'hand_up';
  return new InlineKeyboard().text(text, data);
};

// Helper to lower a user's hand and update Telegram inline keyboard
async function lowerUserHand(userId) {
  if (userId === undefined || userId === null) return false;

  let key = userId;
  let user = raisedHands.get(key);

  if (!user && !isNaN(Number(userId))) {
    key = Number(userId);
    user = raisedHands.get(key);
  } else if (!user && typeof userId === 'number') {
    key = String(userId);
    user = raisedHands.get(key);
  }

  if (!user) return false;

  raisedHands.delete(key);

  // Update Telegram inline keyboard back to "✋ Поднять руку" if from Telegram
  if (user.chatId && user.messageId) {
    try {
      await bot.api.editMessageReplyMarkup(user.chatId, user.messageId, {
        reply_markup: getHandKeyboard(false),
      });
    } catch (err) {
      console.warn(`Не удалось обновить Telegram клавиатуру для пользователя ${key}:`, err.message);
    }
  }

  return true;
}

// Helper to get target Webhook URL
function getTargetWebhookUrl() {
  if (!DOMAIN) return null;
  return DOMAIN.startsWith('http') ? `${DOMAIN}/webhook` : `https://${DOMAIN}/webhook`;
}

// Cached state updated by background sync
let lastWebhookStatus = { ok: false, checkedAt: null, url: null, pendingUpdates: 0 };

// Self-healing function to verify and restore webhook if it gets deleted or desynced
async function ensureWebhookConfigured() {
  const targetUrl = getTargetWebhookUrl();
  if (!targetUrl) {
    lastWebhookStatus = { ok: false, error: 'DOMAIN/RENDER_EXTERNAL_URL не настроен', checkedAt: new Date().toISOString() };
    return lastWebhookStatus;
  }

  try {
    const info = await bot.api.getWebhookInfo();
    const isMatched = info.url === targetUrl;
    if (!isMatched) {
      console.warn(`[Webhook Sync] Несоответствие URL: Текущий: "${info.url}", Ожидаемый: "${targetUrl}". Переподключение...`);
      await bot.api.setWebhook(targetUrl, {
        drop_pending_updates: false,
        allowed_updates: ['message', 'callback_query']
      });
      console.log(`[Webhook Sync] Webhook успешно восстановлен на: ${targetUrl}`);
      lastWebhookStatus = {
        ok: true,
        synced: true,
        url: targetUrl,
        previousUrl: info.url,
        pendingUpdates: info.pending_update_count,
        checkedAt: new Date().toISOString()
      };
    } else {
      lastWebhookStatus = {
        ok: true,
        synced: false,
        url: info.url,
        pendingUpdates: info.pending_update_count,
        checkedAt: new Date().toISOString()
      };
    }
  } catch (err) {
    console.error('[Webhook Sync] Ошибка проверки или установки Webhook:', err.message);
    lastWebhookStatus = { ok: false, error: err.message, checkedAt: new Date().toISOString() };
  }

  return lastWebhookStatus;
}

// 1. Bot Commands & Callbacks
bot.command('start', async (ctx) => {
  try {
    const isUp = raisedHands.has(ctx.from.id);
    await ctx.reply('Привет! Нажмите кнопку ниже, чтобы поднять или опустить руку:', {
      reply_markup: getHandKeyboard(isUp),
    });
  } catch (err) {
    console.error('Ошибка в bot.command("start"):', err.message);
  }
});

bot.callbackQuery('hand_up', async (ctx) => {
  const userId = ctx.from.id;

  // Answer callback immediately to prevent Telegram webhook timeout
  try {
    await ctx.answerCallbackQuery({ text: 'Рука поднята! ✋' });
  } catch (err) {
    console.error('Ошибка answerCallbackQuery:', err.message);
  }

  if (!raisedHands.has(userId)) {
    const photoUrl = await getTelegramPhotoUrl(userId);
    const now = new Date();
    const timeStr = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const user = {
      id: userId,
      name: `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || 'Пользователь',
      username: ctx.from.username || null,
      photoUrl: photoUrl,
      timeStr: timeStr,
      timestamp: now.getTime(),
      chatId: ctx.chat ? ctx.chat.id : userId,
      messageId: ctx.msg ? ctx.msg.message_id : null,
    };

    raisedHands.set(userId, user);
  }

  try {
    await ctx.editMessageReplyMarkup({
      reply_markup: getHandKeyboard(true),
    });
  } catch (err) {
    console.error('Ошибка editMessageReplyMarkup:', err.message);
  }
});

bot.callbackQuery('hand_down', async (ctx) => {
  const userId = ctx.from.id;

  // Answer callback immediately
  try {
    await ctx.answerCallbackQuery({ text: 'Рука опущена! 👇' });
  } catch (err) {
    console.error('Ошибка answerCallbackQuery:', err.message);
  }

  await lowerUserHand(userId);
});

// 2. Telegram Webhook vs Polling configuration
const USE_WEBHOOK = process.env.USE_WEBHOOK === 'true' || Boolean(DOMAIN);

if (USE_WEBHOOK) {
  app.post('/webhook', webhookCallback(bot, 'express'));

  if (DOMAIN) {
    // Initial webhook setup with retry logic
    let attempts = 0;
    const initWebhook = async () => {
      attempts++;
      const res = await ensureWebhookConfigured();
      if (!res.ok && attempts < 5) {
        console.warn(`[Webhook] Повторная попытка ${attempts}/5 через 5 секунд...`);
        setTimeout(initWebhook, 5000);
      }
    };
    initWebhook();

    // Self-healing: verify webhook once every 24 hours automatically
    setInterval(ensureWebhookConfigured, 24 * 60 * 60 * 1000);
  } else {
    console.log('Бот запущен в режиме Webhook на /webhook (для локального тестирования)');
  }
} else {
  console.log('DOMAIN не задан в окружении — запуск бота в режиме Polling...');
  // Only drop webhook if explicitly requested to avoid wiping production webhook
  if (process.env.FORCE_POLLING === 'true') {
    bot.api.deleteWebhook({ drop_pending_updates: true })
      .then(() => bot.start())
      .catch((err) => {
        console.warn('Не удалось удалить webhook перед polling:', err.message);
        bot.start();
      });
  } else {
    console.warn('ВНИМАНИЕ: Для запуска в режиме Polling с очисткой Webhook укажите FORCE_POLLING=true в .env');
    bot.start();
  }
}

// 3. Avatar Proxy Endpoint (secure, cached image proxying)
app.get('/api/avatar/:userId', async (req, res) => {
  const rawId = req.params.userId;
  const numId = Number(rawId);
  const user = raisedHands.get(rawId) || (!isNaN(numId) ? raisedHands.get(numId) : null);

  let photoUrl = user ? user.photoUrl : null;
  if (!photoUrl && !isNaN(numId) && rawId && !rawId.startsWith('web')) {
    photoUrl = await getTelegramPhotoUrl(numId);
  }

  if (photoUrl) {
    try {
      const response = await fetch(photoUrl);
      if (response.ok) {
        res.setHeader('Content-Type', response.headers.get('content-type') || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        const arrayBuffer = await response.arrayBuffer();
        return res.send(Buffer.from(arrayBuffer));
      }
    } catch (err) {
      console.error(`Ошибка при передаче аватара для ${rawId}:`, err.message);
    }
  }

  res.status(404).send('No avatar');
});

// 4. Backend Endpoint for Web Interface (All raised hands)
app.get('/api/hands', (req, res) => {
  res.json(Array.from(raisedHands.values()));
});

// Admin Authorization Middleware
const checkAdminAuth = (req, res, next) => {
  const password = req.headers['x-admin-password'] || (req.body && req.body.password);
  if (password && password === ADMIN_PASSWORD) {
    return next();
  }
  return res.status(401).json({ success: false, error: 'Неверный пароль' });
};

// Admin Endpoints
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false, error: 'Неверный пароль' });
});

app.post('/api/admin/lower-hand', checkAdminAuth, async (req, res) => {
  const userId = req.body.userId;
  if (userId !== undefined && userId !== null) {
    await lowerUserHand(userId);
  }
  return res.json({ success: true, count: raisedHands.size });
});

app.post('/api/admin/lower-all-hands', checkAdminAuth, async (req, res) => {
  const userIds = Array.from(raisedHands.keys());
  for (const userId of userIds) {
    await lowerUserHand(userId);
  }
  return res.json({ success: true, count: 0 });
});

// Admin Webhook Management
app.get('/api/admin/webhook-status', checkAdminAuth, async (req, res) => {
  try {
    const info = await bot.api.getWebhookInfo();
    const targetUrl = getTargetWebhookUrl();
    res.json({
      success: true,
      currentUrl: info.url || null,
      expectedUrl: targetUrl,
      isConfigured: Boolean(info.url && info.url === targetUrl),
      pendingUpdates: info.pending_update_count,
      lastErrorDate: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null,
      lastErrorMessage: info.last_error_message || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/fix-webhook', checkAdminAuth, async (req, res) => {
  const result = await ensureWebhookConfigured();
  if (result.ok) {
    return res.json({ success: true, ...result });
  } else {
    return res.status(500).json({ success: false, ...result });
  }
});

// Healthcheck & Keep-Alive Endpoint (Ultra-fast, non-blocking, returns cached status)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now(),
    handsCount: raisedHands.size,
    webhook: lastWebhookStatus
  });
});

// 5. Fallback Web Interface Endpoints (/raise-hand)
app.post('/api/web/raise-hand', (req, res) => {
  const { id, name } = req.body || {};
  const trimmedName = (name || '').trim();

  if (!trimmedName) {
    return res.status(400).json({ success: false, error: 'Пожалуйста, укажите ваше имя' });
  }

  const clientId = id && String(id).trim() ? String(id).trim() : `web_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const now = new Date();
  const timeStr = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  let existing = raisedHands.get(clientId);
  if (!existing) {
    const user = {
      id: clientId,
      name: trimmedName,
      username: null,
      photoUrl: null,
      timeStr: timeStr,
      timestamp: now.getTime(),
      isWeb: true,
    };
    raisedHands.set(clientId, user);
    existing = user;
  } else {
    existing.name = trimmedName;
  }

  const handsArray = Array.from(raisedHands.values());
  const queuePosition = handsArray.findIndex(u => String(u.id) === String(clientId)) + 1;

  return res.json({
    success: true,
    user: existing,
    queuePosition: queuePosition > 0 ? queuePosition : handsArray.length,
    totalCount: raisedHands.size
  });
});

app.post('/api/web/lower-hand', async (req, res) => {
  const { id } = req.body || {};
  if (!id) {
    return res.status(400).json({ success: false, error: 'ID клиента не указан' });
  }

  await lowerUserHand(id);
  return res.json({ success: true, count: raisedHands.size });
});

app.get('/api/web/status/:id', (req, res) => {
  const rawId = req.params.id;
  const handsArray = Array.from(raisedHands.values());
  const index = handsArray.findIndex(u => String(u.id) === String(rawId));
  const isRaised = index !== -1;
  const user = isRaised ? handsArray[index] : null;

  return res.json({
    isRaised,
    queuePosition: isRaised ? index + 1 : 0,
    totalCount: raisedHands.size,
    user
  });
});

// 6. Serve Web Interfaces
app.get('/raise-hand', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'raise-hand.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});