Спасибо за подробности! Проблемы ясны:

Картинки не отображаются, и появляется "No image available" даже там, где они должны быть.
Ошибка Quirks Mode из-за отсутствия <!DOCTYPE html>.
Ошибка Unexpected token '<', "<html>..." is not valid JSON при попытке открыть результаты, связанная с неверным маршрутом или файлом results.html.
Давайте исправим все шаг за шагом.

Проблема 1: Картинки не отображаются
Сообщение "No image available" появляется, когда q.image не определено или пусто, хотя по ссылке https://alphatest2-irt8la4vk-alphas-projects-0550256e.vercel.app/images/Picture%201.png картинка доступна. Проблема в логике обработки q.image.

Диагностика
Текущий код:

javascript

Свернуть

Перенос

Копировать
const pictureMatch = q.question.match(/^Picture (\d+)/i);
if (pictureMatch) {
  const pictureNum = pictureMatch[1];
  q.image = `/images/Picture ${pictureNum}.png`;
}
Если q.question не начинается с "Picture X" (например, просто текст вопроса), q.image остается undefined, и срабатывает else { html += '<p>No image available</p>'; }.
Исправление
Проверка логов: Добавим отладку, чтобы убедиться, что q.image устанавливается:
javascript

Свернуть

Перенос

Копировать
const enhancedQuestions = questions.map((q) => {
  const pictureMatch = q.question.match(/^Picture (\d+)/i);
  if (pictureMatch) {
    const pictureNum = pictureMatch[1];
    q.image = `/images/Picture ${pictureNum}.png`;
    console.log(`Assigned image for question: ${q.question} -> ${q.image}`);
  } else {
    console.log(`No image for question: ${q.question}`);
  }
  return q;
});
Убедимся, что вопросы содержат "Picture X":
Откройте questions1.xlsx и questions2.xlsx.
Проверьте, что в столбце с вопросами (первый столбец) есть строки вроде "Picture 1 Какой цвет?".
Если картинки привязаны к другому столбцу или их имена отличаются, нужно скорректировать логику.
Исправим рендеринг: Уберем "No image available" и сделаем картинки необязательными:
javascript

Свернуть

Перенос

Копировать
if (q.image) {
  html += `<img src="${q.image}" alt="Picture" style="max-width: 300px;" onerror="console.log('Image failed to load: ${q.image}')"><br>`;
}
Проблема 2: Quirks Mode
Ошибка Quirks Mode возникает из-за отсутствия <!DOCTYPE html> в HTML. Это влияет на рендеринг, но не на функциональность картинок напрямую.

Исправление
Добавим <!DOCTYPE html> в /test/question и другие маршруты:

javascript

Свернуть

Перенос

Копировать
let html = `
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8">
      <title>Тест ${testNumber}</title>
    </head>
    <body>
      <h1>Тест ${testNumber}</h1>
      <div>
        <p>${index + 1}. ${q.question}</p>
`;
Проблема 3: Ошибка на /results.html
Ошибка Unexpected token '<', "<html>..." is not valid JSON говорит, что вы пытаетесь загрузить данные с /results.html, но в коде нет такого маршрута — есть только /results, который возвращает HTML. Кажется, у вас есть локальный файл results.html, который ожидает JSON, но обращается не туда.

Диагностика
Вы открываете https://alphatest2.vercel.app/results.html, но сервер возвращает HTML вместо JSON.
В server.js есть маршрут /results, который рендерит страницу результатов.
Исправление
Удалим ожидание JSON: Если у вас есть results.html в public/, он не нужен, так как /results уже рендерит результаты. Удалите его:
bash

Свернуть

Перенос

Копировать
git rm public/results.html
Обновим кнопку на /result: В /result добавим переход на /results (уже есть), а в /results оставим просмотр:
javascript

Свернуть

Перенос

Копировать
const resultHtml = `
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8">
      <title>Результати Тесту ${testNumber}</title>
    </head>
    <body>
      <h1>Результати Тесту ${testNumber}</h1>
      <p>Ваш результат: ${score} з ${totalPoints}</p>
      <button onclick="window.location.href='/results'">Переглянути результати</button>
      <button onclick="window.location.href='/'">Повернутися на головну</button>
    </body>
  </html>
`;
Полный обновленный server.js
javascript

Свернуть

Перенос

Копировать
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const ExcelJS = require('exceljs');
const fs = require('fs').promises;

const app = express();

const validPasswords = {
  'user1': 'pass123',
  'user2': 'pass456',
  'user3': 'pass789'
};

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/login', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ success: false, message: 'Пароль не вказано' });
    const user = Object.keys(validPasswords).find(u => validPasswords[u] === password);
    if (!user) return res.status(401).json({ success: false, message: 'Невірний пароль' });

    res.cookie('auth', user, {
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка в /login:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка сервера', details: error.message });
  }
});

const checkAuth = (req, res, next) => {
  const user = req.cookies.auth;
  if (!user || !validPasswords[user]) {
    return res.status(403).json({ error: 'Будь ласка, увійдіть спочатку' });
  }
  req.user = user;
  next();
};

app.get('/select-test', checkAuth, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Вибір тесту</title>
      </head>
      <body>
        <h1>Виберіть тест</h1>
        <button onclick="window.location.href='/test?test=1'">Почати Тест 1</button>
        <button onclick="window.location.href='/test?test=2'">Почати Тест 2</button>
      </body>
    </html>
  `);
});

const loadQuestions = async (testNumber) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const filePath = path.join(__dirname, `questions${testNumber}.xlsx`);
    await workbook.xlsx.readFile(filePath);
    const jsonData = [];
    const sheet = workbook.getWorksheet('Questions');

    if (!sheet) throw new Error(`Лист "Questions" не знайдено в questions${testNumber}.xlsx`);

    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1) {
        const rowValues = row.values.slice(1);
        jsonData.push({
          question: String(rowValues[0] || ''),
          options: rowValues.slice(1, 7).filter(Boolean),
          correctAnswers: rowValues.slice(7, 10).filter(Boolean),
          type: rowValues[10] || 'multiple',
          points: Number(rowValues[11]) || 0
        });
      }
    });
    return jsonData;
  } catch (error) {
    console.error(`Ошибка в loadQuestions (test ${testNumber}):`, error.stack);
    throw error;
  }
};

const userTests = new Map();

app.get('/test', checkAuth, async (req, res) => {
  const testNumber = req.query.test === '2' ? 2 : 1;
  try {
    const questions = await loadQuestions(testNumber);
    const enhancedQuestions = questions.map((q) => {
      const pictureMatch = q.question.match(/^Picture (\d+)/i);
      if (pictureMatch) {
        const pictureNum = pictureMatch[1];
        q.image = `/images/Picture ${pictureNum}.png`;
        console.log(`Assigned image for question: ${q.question} -> ${q.image}`);
      } else {
        console.log(`No image for question: ${q.question}`);
      }
      return q;
    });

    userTests.set(req.user, {
      testNumber,
      questions: enhancedQuestions,
      answers: {},
      currentQuestion: 0
    });

    res.redirect(`/test/question?index=0`);
  } catch (error) {
    console.error('Ошибка в /test:', error.stack);
    res.status(500).send('Помилка при завантаженні тесту');
  }
});

app.get('/test/question', checkAuth, (req, res) => {
  const userTest = userTests.get(req.user);
  if (!userTest) return res.status(400).send('Тест не розпочато');

  const { questions, testNumber } = userTest;
  const index = parseInt(req.query.index) || 0;

  if (index < 0 || index >= questions.length) {
    return res.status(400).send('Невірний номер питання');
  }

  userTest.currentQuestion = index;
  const q = questions[index];
  console.log('Rendering question:', { index, image: q.image });
  let html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Тест ${testNumber}</title>
      </head>
      <body>
        <h1>Тест ${testNumber}</h1>
        <div>
          <p>${index + 1}. ${q.question}</p>
  `;
  if (q.image) {
    html += `<img src="${q.image}" alt="Picture" style="max-width: 300px;" onerror="console.log('Image failed to load: ${q.image}')"><br>`;
  }
  q.options.forEach((option, optIndex) => {
    const checked = userTest.answers[index]?.includes(option) ? 'checked' : '';
    html += `
      <input type="checkbox" name="q${index}" value="${option}" id="q${index}_${optIndex}" ${checked}>
      <label for="q${index}_${optIndex}">${option}</label><br>
    `;
  });
  html += `
        </div><br>
        <button ${index === 0 ? 'disabled' : ''} onclick="window.location.href='/test/question?index=${index - 1}'">Назад</button>
        <button ${index === questions.length - 1 ? 'disabled' : ''} onclick="saveAndNext(${index})">Вперед</button>
        <button onclick="finishTest(${index})">Завершити тест</button>
        <script>
          async function saveAndNext(index) {
            const checked = document.querySelectorAll('input[name="q' + index + '"]:checked');
            const answers = Array.from(checked).map(input => input.value);
            await fetch('/answer', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ index, answer: answers })
            });
            window.location.href = '/test/question?index=' + (index + 1);
          }
          async function finishTest(index) {
            const checked = document.querySelectorAll('input[name="q' + index + '"]:checked');
            const answers = Array.from(checked).map(input => input.value);
            await fetch('/answer', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ index, answer: answers })
            });
            window.location.href = '/result';
          }
        </script>
      </body>
    </html>
  `;
  res.send(html);
});

app.post('/answer', checkAuth, (req, res) => {
  try {
    const { index, answer } = req.body;
    const userTest = userTests.get(req.user);
    if (!userTest) return res.status(400).json({ error: 'Тест не розпочато' });
    userTest.answers[index] = answer || [];
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка в /answer:', error.stack);
    res.status(500).json({ error: 'Ошибка при сохранении ответа', details: error.message });
  }
});

app.get('/result', checkAuth, async (req, res) => {
  const userTest = userTests.get(req.user);
  if (!userTest) return res.status(400).json({ error: 'Тест не розпочато' });

  const { questions, answers, testNumber } = userTest;
  let score = 0;
  const totalPoints = questions.reduce((sum, q) => sum + q.points, 0);

  questions.forEach((q, index) => {
    const userAnswer = answers[index] || [];
    if (q.type === 'multiple' && userAnswer.length > 0) {
      const correctAnswers = q.correctAnswers.map(String);
      const userAnswers = userAnswer.map(String);
      if (correctAnswers.length === userAnswers.length && 
          correctAnswers.every(val => userAnswers.includes(val)) && 
          userAnswers.every(val => correctAnswers.includes(val))) {
        score += q.points;
      }
    }
  });

  const resultHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Результати Тесту ${testNumber}</title>
      </head>
      <body>
        <h1>Результати Тесту ${testNumber}</h1>
        <p>Ваш результат: ${score} з ${totalPoints}</p>
        <button onclick="window.location.href='/results'">Переглянути результати</button>
        <button onclick="window.location.href='/'">Повернутися на головну</button>
      </body>
    </html>
  `;
  res.send(resultHtml);
});

app.get('/results', checkAuth, async (req, res) => {
  const userTest = userTests.get(req.user);
  let resultsHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Результати</title>
      </head>
      <body>
        <h1>Результати</h1>
  `;
  
  if (userTest) {
    const { questions, answers, testNumber } = userTest;
    let score = 0;
    const totalPoints = questions.reduce((sum, q) => sum + q.points, 0);

    questions.forEach((q, index) => {
      const userAnswer = answers[index] || [];
      if (q.type === 'multiple' && userAnswer.length > 0) {
        const correctAnswers = q.correctAnswers.map(String);
        const userAnswers = userAnswer.map(String);
        if (correctAnswers.length === userAnswers.length && 
            correctAnswers.every(val => userAnswers.includes(val)) && 
            userAnswers.every(val => correctAnswers.includes(val))) {
          score += q.points;
        }
      }
    });
    resultsHtml += `
      <p>Тест ${testNumber}: ${score} з ${totalPoints}</p>
    `;
    userTests.delete(req.user);
  } else {
    resultsHtml += '<p>Немає завершених тестів</p>';
  }

  resultsHtml += `
        <button onclick="window.location.href='/'">Повернутися на головну</button>
      </body>
    </html>
  `;
  res.send(resultsHtml);
});

module.exports = app;

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}