const express = require('express');
const session = require('express-session');
const path = require('path');
const ExcelJS = require('exceljs');
const app = express();

const validPasswords = {
  'user1': 'pass123',
  'user2': 'pass456',
  'user3': 'pass789'
};

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
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
      user: req.session.user,
      score,
      totalPoints,
      answers,
      timestamp: new Date().toISOString()
    };
    req.session.results.push(resultData);
    res.json({ score, totalPoints });
  } catch (error) {
    res.status(500).json({ error: 'Помилка при підрахунку результатів', details: error.message });
  }
});

app.get('/results', (req, res) => {
  const adminPassword = 'admin123';
  if (req.query.admin !== adminPassword) {
    return res.status(403).json({ error: 'Доступ заборонено' });
  }
  try {
    const allResults = req.session.results || [];
    res.json(allResults);
  } catch (error) {
    res.status(500).json({ error: 'Помилка при завантаженні результатів', details: error.message });
  }
});

module.exports = app;