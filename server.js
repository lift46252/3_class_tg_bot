require('dotenv').config();
const path = require('path');
const express = require('express');
const { Bot, InlineKeyboard, webhookCallback } = require('grammy');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const DOMAIN = process.env.DOMAIN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

if (!BOT_TOKEN) {
  console.error('ОШИБКА: BOT_TOKEN не найден в .env файле!');
  process.exit(1);
}

// In-memory state (userId => { id, name, username, photoUrl, timeStr, timestamp })
const raisedHands = new Map();

// Initialize Telegram Bot
const bot = new Bot(BOT_TOKEN);

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

// 1. Bot Commands & Callbacks
bot.command('start', async (ctx) => {
  const isUp = raisedHands.has(ctx.from.id);
  await ctx.reply('Привет! Нажмите кнопку ниже, чтобы поднять или опустить руку:', {
    reply_markup: getHandKeyboard(isUp),
  });
});

bot.callbackQuery('hand_up', async (ctx) => {
  const userId = ctx.from.id;

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
    };

    raisedHands.set(userId, user);
  }

  await ctx.editMessageReplyMarkup({
    reply_markup: getHandKeyboard(true),
  });
  await ctx.answerCallbackQuery({ text: 'Рука поднята! ✋' });
});

bot.callbackQuery('hand_down', async (ctx) => {
  const userId = ctx.from.id;
  raisedHands.delete(userId);

  await ctx.editMessageReplyMarkup({
    reply_markup: getHandKeyboard(false),
  });
  await ctx.answerCallbackQuery({ text: 'Рука опущена! 👇' });
});

// 2. Telegram Webhook vs Polling configuration
if (DOMAIN) {
  app.post('/webhook', webhookCallback(bot, 'express'));
  const webhookUrl = DOMAIN.startsWith('http') ? `${DOMAIN}/webhook` : `https://${DOMAIN}/webhook`;
  bot.api.setWebhook(webhookUrl)
    .then(() => console.log(`Telegram Webhook успешно подключен к: ${webhookUrl}`))
    .catch((err) => console.error('Ошибка при установке Webhook:', err.message));
} else {
  console.log('DOMAIN не задан в окружении — запуск бота в режиме Polling...');
  bot.api.deleteWebhook({ drop_pending_updates: true })
    .then(() => {
      bot.start();
    })
    .catch((err) => {
      console.warn('Не удалось удалить webhook перед polling:', err.message);
      bot.start();
    });
}

// 3. Avatar Proxy Endpoint (secure, cached image proxying)
app.get('/api/avatar/:userId', async (req, res) => {
  const userId = Number(req.params.userId);
  const user = raisedHands.get(userId);

  let photoUrl = user ? user.photoUrl : null;
  if (!photoUrl && !isNaN(userId)) {
    photoUrl = await getTelegramPhotoUrl(userId);
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
      console.error(`Ошибка при передаче аватара для ${userId}:`, err.message);
    }
  }

  res.status(404).send('No avatar');
});

// 4. Backend Endpoint for Web Interface
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

app.post('/api/admin/lower-hand', checkAdminAuth, (req, res) => {
  const userId = Number(req.body.userId);
  if (!isNaN(userId) && raisedHands.has(userId)) {
    raisedHands.delete(userId);
  }
  return res.json({ success: true, count: raisedHands.size });
});

app.post('/api/admin/lower-all-hands', checkAdminAuth, (req, res) => {
  raisedHands.clear();
  return res.json({ success: true, count: 0 });
});

// 5. Serve Web Interface from static file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});