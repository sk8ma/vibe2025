require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { URL } = require('url');
const TelegramBot = require('node-telegram-bot-api');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;
const TELEGRAM_BOT_USERNAME = 'sk8matodobot';
const DOMAIN = process.env.DOMAIN;

const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const pool = mysql.createPool(dbConfig);
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

async function hashPassword(password) {
    return await bcrypt.hash(password, 10);
}

async function comparePasswords(password, hash) {
    return await bcrypt.compare(password, hash);
}

function generateToken(user) {
    return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
}

function verifyToken(token) {
    return jwt.verify(token, JWT_SECRET);
}

async function getItems(userId) {
    const connection = await pool.getConnection();
    try {
        const [rows] = await connection.query('SELECT id, text FROM items WHERE user_id = ? ORDER BY id', [userId]);
        return rows;
    } finally {
        connection.release();
    }
}

async function addItem(text, userId) {
    const connection = await pool.getConnection();
    try {
        const [result] = await connection.query('INSERT INTO items (text, user_id) VALUES (?, ?)', [text, userId]);
        return result.insertId;
    } finally {
        connection.release();
    }
}

async function deleteItem(id, userId) {
    const connection = await pool.getConnection();
    try {
        await connection.query('DELETE FROM items WHERE id = ? AND user_id = ?', [id, userId]);
    } finally {
        connection.release();
    }
}

async function updateItem(id, text, userId) {
    const connection = await pool.getConnection();
    try {
        await connection.query('UPDATE items SET text = ? WHERE id = ? AND user_id = ?', [text, id, userId]);
    } finally {
        connection.release();
    }
}

async function getUserByEmail(email) {
    const connection = await pool.getConnection();
    try {
        const [rows] = await connection.query('SELECT * FROM users WHERE email = ?', [email]);
        return rows[0];
    } finally {
        connection.release();
    }
}

async function getUserById(id) {
    const connection = await pool.getConnection();
    try {
        const [rows] = await connection.query('SELECT * FROM users WHERE id = ?', [id]);
        return rows[0];
    } finally {
        connection.release();
    }
}

async function getUserByTelegramId(telegramId) {
    const connection = await pool.getConnection();
    try {
        const [rows] = await connection.query('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
        return rows[0];
    } finally {
        connection.release();
    }
}

async function createUser(email, password, firstName, lastName) {
    const connection = await pool.getConnection();
    try {
        const passwordHash = await hashPassword(password);
        const [result] = await connection.query(
            'INSERT INTO users (email, password_hash, first_name, last_name) VALUES (?, ?, ?, ?)',
            [email, passwordHash, firstName, lastName]
        );
        return { id: result.insertId, email, first_name: firstName, last_name: lastName };
    } finally {
        connection.release();
    }
}

async function linkTelegramAccount(userId, telegramUser) {
    const connection = await pool.getConnection();
    try {
        await connection.query(
            'UPDATE users SET telegram_id = ?, first_name = ?, last_name = ?, username = ?, auth_date = ?, hash = ? WHERE id = ?',
            [
                telegramUser.id,
                telegramUser.first_name,
                telegramUser.last_name || '',
                telegramUser.username || '',
                telegramUser.auth_date,
                telegramUser.hash,
                userId
            ]
        );
    } finally {
        connection.release();
    }
}

async function generateListRows(userId) {
    const items = await getItems(userId);
    return items.map((item, index) => `
        <tr id="row-${item.id}">
            <td>${index + 1}</td>
            <td>${item.text}</td>
            <td>
                <button class="action-btn edit-btn" onclick="enableEdit(${item.id}, '${item.text.replace(/'/g, "\\'")}')">Изменить</button>
                <button class="action-btn delete-btn" onclick="deleteItem(${item.id})">Удалить</button>
            </td>
        </tr>
    `).join('');
}

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const welcomeMessage = `👋 Привет, ${msg.from.first_name}! Я бот для управления списком дел.\n\n` +
        'Для начала работы привяжите свой аккаунт на сайте.\n\n' +
        'Доступные команды:\n' +
        '/list - Показать все задачи\n' +
        '/add [текст] - Добавить новую задачу\n' +
        '/delete [номер] - Удалить задачу\n' +
        '/edit [номер] [новый текст] - Изменить задачу';
    
    bot.sendMessage(chatId, welcomeMessage);
});

bot.onText(/\/list/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const user = await getUserByTelegramId(msg.from.id);
        if (!user) {
            bot.sendMessage(chatId, 'Для работы с задачами сначала привяжите свой аккаунт на сайте');
            return;
        }
        
        const items = await getItems(user.id);
        if (items.length === 0) {
            bot.sendMessage(chatId, 'У вас пока нет задач. Добавьте первую с помощью /add [текст]');
            return;
        }
        
        const tasksList = items.map((item, index) => `${index + 1}. ${item.text}`).join('\n');
        bot.sendMessage(chatId, `Ваши задачи:\n\n${tasksList}`);
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, 'Произошла ошибка при получении списка задач');
    }
});

bot.onText(/\/add (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const text = match[1];
    
    try {
        const user = await getUserByTelegramId(msg.from.id);
        if (!user) {
            bot.sendMessage(chatId, 'Для работы с задачами сначала привяжите свой аккаунт на сайте');
            return;
        }
        
        await addItem(text, user.id);
        bot.sendMessage(chatId, `Задача "${text}" успешно добавлена!`);
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, 'Произошла ошибка при добавлении задачи');
    }
});

bot.onText(/\/delete (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const id = parseInt(match[1]);
    
    try {
        const user = await getUserByTelegramId(msg.from.id);
        if (!user) {
            bot.sendMessage(chatId, 'Для работы с задачами сначала привяжите свой аккаунт на сайте');
            return;
        }
        
        const items = await getItems(user.id);
        if (id < 1 || id > items.length) {
            bot.sendMessage(chatId, 'Неверный номер задачи');
            return;
        }
        
        const itemToDelete = items[id - 1];
        await deleteItem(itemToDelete.id, user.id);
        bot.sendMessage(chatId, `Задача "${itemToDelete.text}" успешно удалена!`);
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, 'Произошла ошибка при удалении задачи');
    }
});

bot.onText(/\/edit (\d+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const id = parseInt(match[1]);
    const newText = match[2];
    
    try {
        const user = await getUserByTelegramId(msg.from.id);
        if (!user) {
            bot.sendMessage(chatId, 'Для работы с задачами сначала привяжите свой аккаунт на сайте');
            return;
        }
        
        const items = await getItems(user.id);
        if (id < 1 || id > items.length) {
            bot.sendMessage(chatId, 'Неверный номер задачи');
            return;
        }
        
        const itemToEdit = items[id - 1];
        await updateItem(itemToEdit.id, newText, user.id);
        bot.sendMessage(chatId, `Задача изменена с "${itemToEdit.text}" на "${newText}"`);
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, 'Произошла ошибка при изменении задачи');
    }
});

async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    try {
        if (url.pathname === '/' && req.method === 'GET') {
            const html = await fs.promises.readFile(path.join(__dirname, 'index.html'), 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
        }
        else if (url.pathname === '/login' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            
            req.on('end', async () => {
                try {
                    const { email, password } = JSON.parse(body);
                    const user = await getUserByEmail(email);
                    
                    if (!user || !(await comparePasswords(password, user.password_hash))) {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Неверный email или пароль' }));
                        return;
                    }
                    
                    const token = generateToken(user);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: true, 
                        token,
                        user: {
                            id: user.id,
                            email: user.email,
                            firstName: user.first_name,
                            lastName: user.last_name,
                            telegramLinked: !!user.telegram_id
                        }
                    }));
                } catch (error) {
                    console.error('Login error:', error);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Invalid data' }));
                }
            });
        }
        else if (url.pathname === '/register' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            
            req.on('end', async () => {
                try {
                    const { email, password, firstName, lastName } = JSON.parse(body);
                    
                    if (await getUserByEmail(email)) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Email уже зарегистрирован' }));
                        return;
                    }
                    
                    const user = await createUser(email, password, firstName, lastName);
                    const token = generateToken(user);
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: true, 
                        token,
                        user: {
                            id: user.id,
                            email: user.email,
                            firstName: user.first_name,
                            lastName: user.last_name,
                            telegramLinked: false
                        }
                    }));
                } catch (error) {
                    console.error('Register error:', error);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Ошибка регистрации' }));
                }
            });
        }
        else if (url.pathname === '/auth/check' && req.method === 'GET') {
            const token = req.headers.authorization?.split(' ')[1];
            
            if (!token) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ authenticated: false }));
                return;
            }
            
            try {
                const decoded = verifyToken(token);
                const user = await getUserById(decoded.id);
                
                if (!user) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ authenticated: false }));
                    return;
                }
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    authenticated: true,
                    user: {
                        id: user.id,
                        email: user.email,
                        firstName: user.first_name,
                        lastName: user.last_name,
                        telegramLinked: !!user.telegram_id
                    }
                }));
            } catch (error) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ authenticated: false }));
            }
        }
        else if (url.pathname === '/telegram-login' && req.method === 'GET') {
            const loginHtml = await fs.promises.readFile(path.join(__dirname, 'telegram-login.html'), 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(loginHtml);
        }
        else if (url.pathname === '/telegram-callback' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            
            req.on('end', async () => {
                try {
                    const { user, token } = JSON.parse(body);
                    if (!user || !user.id || !token) {
                        throw new Error('Invalid data');
                    }
                    
                    const decoded = verifyToken(token);
                    const dbUser = await getUserById(decoded.id);
                    
                    if (!dbUser) {
                        throw new Error('User not found');
                    }
                    
                    await linkTelegramAccount(dbUser.id, user);
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: true,
                        telegramLinked: true
                    }));
                } catch (error) {
                    console.error('Telegram callback error:', error);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Invalid data' }));
                }
            });
        }
        else if (url.pathname === '/list' && req.method === 'GET') {
            const token = req.headers.authorization?.split(' ')[1];
            
            if (!token) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }
            
            try {
                const decoded = verifyToken(token);
                const rows = await generateListRows(decoded.id);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ rows }));
            } catch (error) {
                console.error(error);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
            }
        }
        else if (url.pathname === '/add' && req.method === 'POST') {
            const token = req.headers.authorization?.split(' ')[1];
            
            if (!token) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }
            
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            
            req.on('end', async () => {
                try {
                    const decoded = verifyToken(token);
                    const { text } = JSON.parse(body);
                    
                    if (!text) {
                        throw new Error('Invalid input');
                    }
                    
                    await addItem(text, decoded.id);
                    const rows = await generateListRows(decoded.id);
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, rows }));
                } catch (error) {
                    console.error(error);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: error.message }));
                }
            });
        }
        else if (url.pathname.startsWith('/delete/') && req.method === 'DELETE') {
            const token = req.headers.authorization?.split(' ')[1];
            
            if (!token) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }
            
            const id = parseInt(url.pathname.split('/')[2]);
            
            if (isNaN(id)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid ID' }));
                return;
            }
            
            try {
                const decoded = verifyToken(token);
                await deleteItem(id, decoded.id);
                const rows = await generateListRows(decoded.id);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, rows }));
            } catch (error) {
                console.error(error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: error.message }));
            }
        }
        else if (url.pathname.startsWith('/edit/') && req.method === 'PUT') {
            const token = req.headers.authorization?.split(' ')[1];
            
            if (!token) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized' }));
                return;
            }
            
            const id = parseInt(url.pathname.split('/')[2]);
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            
            req.on('end', async () => {
                try {
                    const decoded = verifyToken(token);
                    const { text } = JSON.parse(body);
                    
                    if (!text) {
                        throw new Error('Invalid input');
                    }
                    
                    await updateItem(id, text, decoded.id);
                    const rows = await generateListRows(decoded.id);
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, rows }));
                } catch (error) {
                    console.error(error);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: error.message }));
                }
            });
        }
        else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    } catch (error) {
        console.error(error);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
    }
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}/`);
    console.log(`🤖 Telegram bot @${TELEGRAM_BOT_USERNAME} is running`);
});

process.on('SIGINT', async () => {
    console.log('\nClosing database pool and shutting down server...');
    await pool.end();
    server.close(() => {
        console.log('Server has been stopped');
        process.exit(0);
    });
});
