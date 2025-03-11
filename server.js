const express = require('express');
const session = require('express-session');
const RedisStore = require('connect-redis').default;
const { createClient } = require('redis');
const path = require('path');
const ExcelJS = require('exceljs');
const fs = require('fs').promises;
const app = express();

const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://default:BnB234v9OBeTLYbpIm2TWGXjnu8hqXO3@redis-13808.c1.us-west-2-2.ec2.redns.redis-cloud.com:13808'
});
redisClient.on('error', err => console.error('Redis Error:', err));
redisClient.on('connect', () => console.log('Redis Connected'));
redisClient.connect().catch(err => console.error('Redis Connect Error:', err));

const validPasswords = {
  'user1': 'pass123',
  'user2': 'pass456',
  'user3': 'pass789'
};

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/login', async (req, res) => {
  try {
    console.log('POST /login, body:', req.body); // Отладка
    const { password } = req.body;
    if (!password) {
      console.log('No password provided');
      return res.status(400).json({ success: false, message: 'Пароль не вказано' });
    }
    const user = Object.keys(validPasswords).find(u => validPasswords[u] === password);
    if (user) {
      req.session.loggedIn = true;
      req.session.user = user;
      req.session.results = req.session.results || [];
      req.session.answers = req.session.answers || {};
      await req.session.save(); // Явное сохранение сессии
      console.log('Login successful, session ID:', req.sessionID, 'session:', req.session);
      res.json({ success: true });
    } else {
      console.log('Invalid password:', password);
      res.status(401).json({ success: false, message: 'Невірний пароль' });
    }
  } catch (error) {
    console.error('Ошибка в /login:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка сервера', details: error.message });
  }
});

const loadQuestions = async () => {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(__dirname, 'questions.xlsx'));
    const jsonData = [];
    const sheet = workbook.getWorksheet('Questions');

    if (!sheet) throw new Error('Лист "Questions" не знайдено в questions.xlsx');

    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1) {
        const rowValues = row.values.slice(1);
        jsonData.push({
          question: rowValues[0] || '',
          options: rowValues.slice(1, 7).filter(Boolean),
          correctAnswers: rowValues.slice(7, 10).filter(Boolean),
          type: rowValues[10] || 'multiple',
          points: Number(rowValues[11]) || 0
        });
      }
    });

    const imagesDir = path.join(__dirname, 'public', 'images');
    await fs.mkdir(imagesDir, { recursive: true });

    for (let i = 1; i <= 10; i++) {
      const pictureSheet = workbook.getWorksheet(`Picture ${i}`);
      if (pictureSheet) {
        const images = pictureSheet.getImages();
        if (images.length > 0) {
          for (const imageRef of images) {
            const image = workbook.model.media.find(m => m.index === imageRef.imageId);
            if (image && image.buffer) {
              const imagePath = path.join(imagesDir, `picture${i}.${image.extension || 'png'}`);
              await fs.writeFile(imagePath, Buffer.from(image.buffer));
              console.log(`Saved image: ${imagePath}`);
            } else {
              console.log(`No valid image buffer for Picture ${i}`);
            }
          }
        } else {
          console.log(`No images found in Picture ${i}`);
        }
      }
    }

    return jsonData;
  } catch (error) {
    console.error('Error in loadQuestions:', error.stack);
    throw error;
  }
};

app.get('/questions', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(403).json({ error: 'Будь ласка, увійдіть спочатку' });
  }
  try {
    const questions = await loadQuestions();
    const enhancedQuestions = questions.map((q, index) => {
      const match = q.question.match(/Рисунок (\d+)/i);
      if (match) {
        const pictureNum = match[1];
        q.image = `/images/picture${pictureNum}.png`;
      }
      return q;
    });
    res.json(enhancedQuestions);
  } catch (error) {
    console.error('Ошибка в /questions:', error.stack);
    res.status(500).json({ error: 'Помилка при завантаженні питань', details: error.message });
  }
});

app.post('/answer', (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(403).json({ error: 'Не авторизовано' });
  }
  try {
    if (!req.session.answers) req.session.answers = {};
    const { index, answer } = req.body;
    if (index === undefined || answer === undefined) {
      throw new Error('Некорректные данные');
    }
    req.session.answers[index] = answer;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при сохранении ответа', details: error.message });
  }
});

app.get('/result', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(403).json({ error: 'Будь ласка, увійдіть спочатку' });
  }
  try {
    const questions = await loadQuestions();
    let score = 0;
    const totalPoints = questions.reduce((sum, q) => sum + q.points, 0);
    const answers = req.session.answers || {};

    questions.forEach((q, index) => {
      const userAnswer = answers[index];
      if (q.type === 'multiple' && userAnswer) {
        const correctAnswers = q.correctAnswers.map(String);
        console.log(`Question ${index}: userAnswer:`, userAnswer, 'correctAnswers:', correctAnswers);
        if (Array.isArray(userAnswer) && 
            userAnswer.length === correctAnswers.length && 
            userAnswer.every(val => correctAnswers.includes(String(val))) && 
            correctAnswers.every(val => userAnswer.includes(String(val)))) {
          score += q.points;
          console.log(`Question ${index}: scored ${q.points} points`);
        } else {
          console.log(`Question ${index}: no points, answers do not fully match`);
        }
      } else if (q.type === 'input' && userAnswer) {
        if (typeof userAnswer === 'string' && userAnswer.trim().toLowerCase() === q.correctAnswers[0].toLowerCase()) {
          score += q.points;
          console.log(`Question ${index}: scored ${q.points} points`);
        }
      }
    });

    const resultData = {
      user: req.session.user || 'unknown',
      score,
      totalPoints,
      answers,
      timestamp: new Date().toISOString()
    };
    const resultsKey = 'test_results';
    let results = [];
    const storedResults = await redisClient.get(resultsKey);
    if (storedResults) {
      results = JSON.parse(storedResults);
    }
    results.push(resultData);
    await redisClient.set(resultsKey, JSON.stringify(results));
    console.log('Saved result in Redis:', resultData);

    res.json({ score, totalPoints });
  } catch (error) {
    console.error('Ошибка в /result:', error.stack);
    res.status(500).json({ error: 'Помилка при підрахунку результатів', details: error.message });
  }
});

app.get('/results', async (req, res) => {
  const adminPassword = 'admin123';
  if (!req.query.admin) {
    return res.sendFile(path.join(__dirname, 'public', 'results.html'));
  }
  if (req.query.admin !== adminPassword) {
    return res.status(403).json({ error: 'Доступ заборонено' });
  }
  try {
    const resultsKey = 'test_results';
    const storedResults = await redisClient.get(resultsKey);
    const allResults = storedResults ? JSON.parse(storedResults) : [];
    res.json(allResults);
  } catch (error) {
    console.error('Ошибка в /results:', error.stack);
    res.status(500).json({ error: 'Помилка при завантаженні результатів', details: error.message });
  }
});

module.exports = app;