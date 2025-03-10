const express = require('express');
const session = require('express-session');
const RedisStore = require('connect-redis').default;
const { createClient } = require('redis');
const path = require('path');
const ExcelJS = require('exceljs');
const app = express();

const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://default:BnB234v9OBeTLYbpIm2TWGXjnu8hqXO3@redis-13808.c1.us-west-2-2.ec2.redns.redis-cloud.com:13808'
});
redisClient.on('error', err => console.error('Redis Error:', err));
redisClient.on('connect', () => console.log('Redis Connected')); // Отладка
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

app.post('/login', (req, res) => {
  const { password } = req.body;
  const user = Object.keys(validPasswords).find(u => validPasswords[u] === password);
  if (user) {
    req.session.loggedIn = true;
    req.session.user = user;
    req.session.results = req.session.results || [];
    req.session.answers = req.session.answers || {};
    console.log('Login successful, session ID:', req.sessionID, 'session:', req.session);
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Невірний пароль' });
  }
});

const loadQuestions = async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(__dirname, 'questions.xlsx'));
  const sheet = workbook.getWorksheet('Questions');
  const jsonData = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > 1) {
      const rowValues = row.values.slice(1);
      jsonData.push({
        question: rowValues[0],
        options: rowValues.slice(1, 7).filter(Boolean),
        correctAnswers: rowValues.slice(7, 10).filter(Boolean),
        type: rowValues[10],
        points: rowValues[11] || 0
      });
    }
  });
  return jsonData;
};

app.get('/questions', async (req, res) => {
  console.log('GET /questions, session ID:', req.sessionID, 'session:', req.session);
  if (!req.session.loggedIn) {
    return res.status(403).json({ error: 'Будь ласка, увійдіть спочатку' });
  }
  try {
    const questions = await loadQuestions();
    res.json(questions);
  } catch (error) {
    res.status(500).json({ error: 'Помилка при завантаженні питань', details: error.message });
  }
});

app.post('/answer', (req, res) => {
  console.log('POST /answer, session ID:', req.sessionID, 'session:', req.session, 'body:', req.body);
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
  console.log('GET /result, session ID:', req.sessionID, 'session:', req.session);
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
        const correctAnswers = q.correctAnswers;
        if (Array.isArray(userAnswer) ? 
            userAnswer.every(val => correctAnswers.includes(val)) && 
            userAnswer.length === correctAnswers.length : 
            correctAnswers.includes(userAnswer)) {
          score += q.points;
        }
      } else if (q.type === 'input' && userAnswer) {
        if (userAnswer.trim().toLowerCase() === q.correctAnswers[0].toLowerCase()) {
          score += q.points;
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
    req.session.results = req.session.results || [];
    req.session.results.push(resultData);
    console.log('Saved result:', resultData);

    res.json({ score, totalPoints });
  } catch (error) {
    console.error('Ошибка в /result:', error.message);
    res.status(500).json({ error: 'Помилка при підрахунку результатів', details: error.message });
  }
});

app.get('/results', async (req, res) => {
  const adminPassword = 'admin123';
  console.log('GET /results, session ID:', req.sessionID, 'query:', req.query);
  if (req.query.admin !== adminPassword) {
    return res.status(403).json({ error: 'Доступ заборонено' });
  }
  try {
    const allResults = req.session.results || [];
    console.log('Results to send:', allResults);
    res.json(allResults);
  } catch (error) {
    console.error('Ошибка в /results:', error.message);
    res.status(500).json({ error: 'Помилка при завантаженні результатів', details: error.message });
  }
});

module.exports = app;