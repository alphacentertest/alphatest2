const express = require('express');
const session = require('express-session');
const path = require('path');
const XLSX = require('xlsx');
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // Додаємо для POST-запитів із JSON
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
<<<<<<< HEAD
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true
}));

const loadQuestions = () => {
  const workbook = XLSX.readFile('questions.xlsx');
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet);
};

app.get('/questions', (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(403).send('Будь ласка, увійдіть спочатку');
  }
  const questions = loadQuestions();
  res.json(questions);
});

// Збереження відповіді для конкретного питання
app.post('/answer', (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(403).send('Не авторизовано');
  }
  if (!req.session.answers) req.session.answers = {};
  const { index, answer } = req.body;
  req.session.answers[index] = answer;
  res.json({ success: true });
});

// Підрахунок результату
app.get('/result', (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(403).send('Будь ласка, увійдіть спочатку');
  }
  const questions = loadQuestions();
  let score = 0;
  const totalPoints = questions.reduce((sum, q) => sum + q.Points, 0);
  const answers = req.session.answers || {};

  questions.forEach((q, index) => {
    const userAnswer = answers[index];
    if (q.Type === 'multiple' && userAnswer) {
      const correctAnswers = q.CorrectAnswer.split('|');
      if (userAnswer.length === correctAnswers.length && userAnswer.every(val => correctAnswers.includes(val))) {
        score += q.Points;
      }
    } else if (q.Type === 'input' && userAnswer) {
      if (userAnswer.trim().toLowerCase() === q.CorrectAnswer.toLowerCase()) {
        score += q.Points;
      }
    }
  });
  res.json({ score, totalPoints });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'test' && password === 'password') {
    req.session.loggedIn = true;
    res.redirect('/test.html');
  } else {
    res.send('Неправильні дані!');
  }
});

app.get('/test.html', (req, res) => {
  if (req.session.loggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'test.html'));
  } else {
    res.redirect('/login.html');
  }
});

app.listen(3000, () => console.log('Server running on port 3000'));
