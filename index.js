const express = require('express');
const { createClient } = require('redis');
const { list } = require('@vercel/blob');

// Инициализация Express
const app = express();
const port = process.env.PORT || 3000;

// Логирование для отладки
console.log('Starting server...');

// Проверка переменных окружения
const REDIS_URL = process.env.REDIS_URL;
const BLOB_READ_WRITE_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

if (!REDIS_URL) {
  console.error('REDIS_URL is not defined in environment variables');
  process.exit(1);
}

if (!BLOB_READ_WRITE_TOKEN) {
  console.error(
    'BLOB_READ_WRITE_TOKEN is not defined in environment variables'
  );
  process.exit(1);
}

// Инициализация Redis клиента
const redisClient = createClient({
  url: REDIS_URL,
});

redisClient.on('error', err => {
  console.error('Redis Client Error:', err);
});

// Функция для подключения к Redis
async function connectToRedis() {
  try {
    console.log('Connecting to Redis...');
    await redisClient.connect();
    console.log('Connected to Redis successfully');
  } catch (err) {
    console.error('Failed to connect to Redis:', err);
    process.exit(1);
  }
}

// Функция для проверки Vercel Blob Storage
async function checkBlobStorage() {
  try {
    console.log('Checking Vercel Blob Storage...');
    // Простой запрос к Blob Storage для проверки токена
    const { blobs } = await list({ token: BLOB_READ_WRITE_TOKEN });
    console.log(
      'Vercel Blob Storage is accessible. Found blobs:',
      blobs.length
    );
  } catch (err) {
    console.error('Failed to access Vercel Blob Storage:', err.message);
    process.exit(1);
  }
}

// Функции для загрузки данных (пример)
async function loadUsers() {
  try {
    console.log('Loading users from Blob Storage...');
    const { blobs } = await list({ token: BLOB_READ_WRITE_TOKEN });
    // Здесь должна быть логика для загрузки пользователей
    return blobs; // Пример
  } catch (err) {
    console.error('Error loading users:', err);
    throw err;
  }
}

async function loadTestNames() {
  try {
    console.log('Loading test names from Redis...');
    const testNames = await redisClient.get('testNames');
    return testNames ? JSON.parse(testNames) : [];
  } catch (err) {
    console.error('Error loading test names:', err);
    throw err;
  }
}

// Инициализация сервисов
async function initializeServices() {
  await connectToRedis();
  await checkBlobStorage();
}

// Маршруты
app.get('/', async (req, res) => {
  try {
    console.log('Handling request to /');
    const users = await loadUsers();
    const testNames = await loadTestNames();
    res.json({ message: 'Hello from alphatest2!', users, testNames });
  } catch (err) {
    console.error('Error handling / route:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Обработка favicon маршрутов
app.get('/favicon.ico', (req, res) => {
  console.log('Handling /favicon.ico request');
  res.status(204).end();
});

app.get('/favicon.png', (req, res) => {
  console.log('Handling /favicon.png request');
  res.status(204).end();
});

// Глобальный обработчик ошибок
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Запуск сервера
(async () => {
  try {
    await initializeServices();
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
})();
