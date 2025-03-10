const express = require('express');
const session = require('express-session');
const path = require('path');
const ExcelJS = require('exceljs');
const fs = require('fs').promises; // Для работы с файлами
const app = express();

// Список паролей (вы отправляете их пользователям)
const validPasswords = {
  'user1': 'pass123',
  'user2': 'pass456',
  'user3': 'pass789'
  // Добавляйте сюда новые пароли для каждого пользователя
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

// Главная страница
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Авторизация
app.post('/login', (req, res) => {
  const { password } = req.body;
  const user = Object.keys(validPasswords).find(u => validPasswords[u] === password);
  if (user) {
    req.session.loggedIn = true;
    req.session.user = user; // Сохраняем идентификатор пользователя
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Невірний пароль' });
  }
});

// Загрузка вопросов
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
    return res.status(403).send('Будь ласка, увійдіть спочатку');
  }
  const questions = await loadQuestions();
  res.json(questions);
});

// Сохранение ответа
app.post('/answer', (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(403).send('Не авторизовано');
  }
  try {
    if (!req.session.answers) req.session.answers = {};
    const { index, answer } = req.body;
    req.session.answers[index] = answer;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при сохранении ответа' });
  }
});

// Результат и сохранение
app.get('/result', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(403).send('Будь ласка, увійдіть спочатку');
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

    // Сохранение результата в файл
    const resultData = {
      user: req.session.user,
      score,
      totalPoints,
      answers,
      timestamp: new Date().toISOString()
    };
    const resultsFile = path.join(__dirname, 'results.json');
    let results = [];
    try {
      const data = await fs.readFile(resultsFile, 'utf8');
      results = JSON.parse(data);
    } catch (err) {
      // Если файла нет, создаём новый массив
    }
    results.push(resultData);
    await fs.writeFile(resultsFile, JSON.stringify(results, null, 2));

    res.json({ score, totalPoints });
  } catch (error) {
    console.error('Ошибка в /result:', error.message);
    res.status(500).json({ error: 'Помилка при підрахунку результатів' });
  }
});

// Просмотр результатов (доступ только для вас)
app.get('/results', async (req, res) => {
  // Добавьте проверку для администратора (например, пароль или IP)
  const adminPassword = 'admin123'; // Замените на свой пароль
  if (req.query.admin !== adminPassword) {
    return res.status(403).send('Доступ заборонено');
  }
  try {
    const resultsFile = path.join(__dirname, 'results.json');
    const data = await fs.readFile(resultsFile, 'utf8');
    const results = JSON.parse(data);
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: 'Помилка при завантаженні результатів' });
  }
});

module.exports = app;