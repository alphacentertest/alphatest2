const express = require('express');
const session = require('express-session');
const path = require('path');
const XLSX = require('xlsx');
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.header('Access-Control-Allow-Origin', '*'); // Для тестов
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  console.log('Session:', req.session);
  next();
});

const loadQuestions = () => {
  try {
    const workbook = XLSX.readFile('questions.xlsx');
    const sheet = workbook.Sheets['Questions'];
    if (!sheet) throw new Error('Лист "Questions" не найден');
    const jsonData = XLSX.utils.sheet_to_json(sheet);
    return jsonData.map(row => ({
      question: row.Question,
      options: [row['Option 1'], row['Option 2'], row['Option 3'], row['Option 4'], row['Option 5'], row['Option 6']].filter(Boolean),
      correctAnswers: [row.CorrectAnswer1, row.CorrectAnswer2, row.CorrectAnswer3].filter(Boolean),
      type: row.Type,
      points: row.Points || 0
    }));
  } catch (error) {
    console.error('Ошибка при загрузке questions.xlsx:', error.message);
    throw new Error('Не удалось загрузить вопросы');
  }
};

app.post('/login', (req, res) => {
  req.session.loggedIn = true;
  res.json({ success: true });
});

app.get('/questions', (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(403).send('Будь ласка, увійдіть спочатку');
  }
  try {
    const questions = loadQuestions();
    res.json(questions);
  } catch (error) {
    res.status(500).send('Помилка сервера при завантаженні питань');
  }
});

app.post('/answer', (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(403).send('Не авторизовано');
  }
  if (!req.session.answers) req.session.answers = {};
  const { index, answer } = req.body;
  req.session.answers[index] = answer;
  res.json({ success: true });
});

app.get('/result', (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(403).send('Будь ласка, увійдіть спочатку');
  }
  try {
    const questions = loadQuestions();
    let score = 0;
    const totalPoints = questions.reduce((sum, q) => sum + q.points, 0);
    const answers = req.session.answers || {};

    questions.forEach((q, index) => {
      const userAnswer = answers[index];
      if (q.type === 'multiple' && userAnswer) {
        const correctAnswers = q.correctAnswers;
        const userAnswersArray = Array.isArray(userAnswer) ? userAnswer : [userAnswer];
        if (userAnswersArray.length === correctAnswers.length && 
            userAnswersArray.every(val => correctAnswers.includes(q.options[val]))) {
          score += q.points;
        }
      } else if (q.type === 'input' && userAnswer) {
        if (typeof userAnswer === 'string' && 
            userAnswer.trim().toLowerCase() === q.correctAnswers[0].toLowerCase()) {
          score += q.points;
        }
      }
    });
    res.json({ score, totalPoints });
  } catch (error) {
    console.error('Ошибка при подсчёте результатов:', error.message);
    res.status(500).send('Помилка при підрахунку результатів');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});