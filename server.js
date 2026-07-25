const path = require('path');
const express = require('express');
const { Bot, InlineKeyboard } = require('grammy');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BOT_TOKEN = '8863594563:AAHKQ2kvcUmkjIowvOwxoqrVhg8vq0ZQOy4';

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

// 2. Start Telegram Bot polling
bot.start();

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

// 5. Serve Web Interface from static file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(3000, () => {
  console.log('Сервер запущен на http://localhost:3000');
});