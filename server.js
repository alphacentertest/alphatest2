const express = require('express');
const session = require('express-session');
const app = express();
const port = 3000;

app.use(express.json());
app.use(express.static('public'));
app.use(session({
    secret: 'mysecretkey', // Секретний ключ для сессій
    resave: false,
    saveUninitialized: false
}));

const correctPassword = 'test123'; // Пароль для входу

// Головна страниця — логін
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/login.html');
});

// Перевірка паролю
app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === correctPassword) {
        req.session.authenticated = true;
        res.status(200).send('OK');
    } else {
        res.status(401).send('Невірний пароль');
    }
});

// Страниця теста — тільки після авторизації
app.get('/quiz', (req, res) => {
    if (!req.session.authenticated) {
        return res.redirect('/');
    }
    res.send(`
        <!DOCTYPE html>
        <html lang="ru">
        <head>
            <meta charset="UTF-8">
            <title>Тест</title>
            <link rel="stylesheet" href="/styles.css">
        </head>
        <body>
            <div class="container">
                <h1>Тест по математике</h1>
                <form id="quizForm">
                    <div>
                        <p>1. Сколько будет 2 + 2?</p>
                        <input type="radio" name="q1" value="3"> 3<br>
                        <input type="radio" name="q1" value="4"> 4<br>
                        <input type="radio" name="q1" value="5"> 5
                    </div>
                    <div>
                        <p>2. Чему равно 5 × 3?</p>
                        <input type="text" name="q2">
                    </div>
                    <button type="submit">Проверить ответы</button>
                </form>
                <div id="results"></div>
            </div>
            <script>
                document.getElementById('quizForm').addEventListener('submit', function(event) {
                    event.preventDefault();
                    let score = 0;
                    const q1 = document.querySelector('input[name="q1"]:checked');
                    if (q1 && q1.value === '4') score++;
                    const q2 = document.querySelector('input[name="q2"]').value.trim();
                    if (q2 === '15') score++;
                    document.getElementById('results').textContent = 'Вы набрали ' + score + ' из 2 баллов!';
                });
            </script>
        </body>
        </html>
    `);
});

app.listen(port, () => {
    console.log(`Сервер запущен на http://localhost:${port}`);
});
