// server.js - Backend для шахового сайту
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const https = require('https'); 
const { URL } = require('url'); 
const mongoose = require('mongoose'); // ✅ ДОДАНО: MongoDB Mongoose

const app = express();
// Порт береться зі змінної середовища (важливо для хостингу!)
const PORT = process.env.PORT || 3000; 
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'chess2024'; // ✅ ДОДАНО: Пароль з ENV
const MONGODB_URI = process.env.MONGODB_URI; // ✅ ДОДАНО: URI бази даних з ENV


// ============================================================
// НАЛАШТУВАННЯ MONGOOSE ТА СХЕМИ

if (MONGODB_URI) {
    mongoose.connect(MONGODB_URI)
        .then(() => console.log('✅ Підключено до MongoDB Atlas'))
        .catch(err => console.error('❌ Помилка підключення до MongoDB:', err.message));
} else {
    console.warn('⚠️ MONGODB_URI не встановлено. Використовується локальне файлове сховище (не рекомендовано для Render).');
}

// 1. Схема для Новин
const NewsSchema = new mongoose.Schema({
    title: String,
    description: String,
    date: String,
    image: String 
}, { timestamps: true });
const News = mongoose.model('News', NewsSchema);

// 2. Схема для Домашнього Завдання
const HomeworkSchema = new mongoose.Schema({
    title: String,
    image: String 
});
const Homework = mongoose.model('Homework', HomeworkSchema);

// 3. Схема для Подій
const EventSchema = new mongoose.Schema({
    title: String,
    date: String,
    location: String,
    description: String
}, { timestamps: true });
const Event = mongoose.model('Event', EventSchema);

// 4. Схема для Конфігурації (Посилання на Google Sheets та Турніри)
const ConfigSchema = new mongoose.Schema({
    key: { type: String, unique: true }, // 'sheets-url', 'tournaments'
    value: mongoose.Schema.Types.Mixed
});
const Config = mongoose.model('Config', ConfigSchema);


// ============================================================
// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
// Ми залишаємо static для демонстрації, але завантажені файли будуть тимчасовими!
app.use('/uploads', express.static('uploads')); 

// Створення папок при старті (залишаємо для Multer, але пам'ятаємо, що вони ефемерні)
const createDirs = async () => {
    await fs.mkdir('uploads', { recursive: true });
    // Папка data більше не потрібна!
};

// Multer для завантаження файлів (залишаємо, але пам'ятаємо, що файли ефемерні!)
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, unique + path.extname(file.originalname));
    }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

async function deleteFileIfExists(filePath) {
    if (!filePath || !filePath.startsWith('/uploads/')) return;
    try {
        // УВАГА: На Render ця функція працюватиме лише до першого перезапуску сервера!
        await fs.unlink(path.join(__dirname, filePath));
    } catch (e) {
        // Файл не існує
    }
}

// ============================================================
// ФУНКЦІЇ ДЛЯ MONGO DB (Заміна readData/writeData)

async function getDoc(Model, query = {}) {
    if (!MONGODB_URI) return []; // Fallback, якщо DB не підключено
    const docs = await Model.find(query).sort({ createdAt: -1 });
    return docs.map(doc => doc.toObject({ getters: true }));
}

async function getConfigValue(key) {
    if (!MONGODB_URI) return {};
    const doc = await Config.findOne({ key });
    return doc ? doc.value : {};
}

async function setConfigValue(key, value) {
    if (!MONGODB_URI) return;
    await Config.findOneAndUpdate(
        { key },
        { $set: { value } },
        { upsert: true, new: true }
    );
}


// ============================================================
// РОБОТА З GOOGLE SHEETS (Без змін)

function fetchGoogleSheetCSV(url, redirectCount = 0) {
    // ... (Код функції fetchGoogleSheetCSV залишається без змін) ...
    return new Promise((resolve, reject) => {
        const MAX_REDIRECTS = 5;
        if (redirectCount >= MAX_REDIRECTS) {
            return reject(new Error('Перевищено максимальну кількість редиректів (5).'));
        }

        let requestUrl = url;
        
        if (redirectCount === 0 && url.includes('/d/')) {
            const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
            if (!match || !match[1]) {
                return reject(new Error('Невірний формат посилання на Google Sheets.'));
            }
            const sheetId = match[1];
            requestUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=0`;
        }
        
        const options = new URL(requestUrl);

        https.get(options, (res) => {
            const statusCode = res.statusCode;

            if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
                const newUrl = res.headers.location;
                fetchGoogleSheetCSV(newUrl, redirectCount + 1)
                    .then(resolve)
                    .catch(reject);
                return;
            }
            
            if (statusCode !== 200) {
                return reject(new Error(`Запит не вдався. Код: ${statusCode}. Перевірте, чи відкритий доступ ("Будь-хто з посиланням може переглядати") до Google Таблиці.`));
            }

            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                if (data.startsWith('<!DOCTYPE html>')) {
                    return reject(new Error('Google повернув HTML-сторінку замість CSV. Можливо, це помилка доступу.'));
                }
                resolve(data);
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}

// ============================================================
// ЕНДПОІНТИ API (Використовують MongoDB)

// 🔸 Учасники гуртка
app.get('/api/members', async (_, res) => {
    try {
        const config = await getConfigValue('sheets-url');
        
        if (!config || !config.url) {
            return res.json([]); 
        }

        const csvData = await fetchGoogleSheetCSV(config.url);
        
        const lines = csvData.split('\n').filter(line => line.trim());
        const membersData = [];
        
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            const cols = line.match(/(?:\"([^\"]*)\"|([^,]*))/g)?.filter(Boolean).map(col => col.trim().replace(/^"|"$/g, ''));
            
            if (cols?.length >= 2 && cols[0] && cols[1]) {
                membersData.push({
                    name: cols[0],
                    rank: cols[1]
                });
            }
        }

        res.json(membersData);

    } catch (error) {
        console.error('Помилка отримання даних з Google Sheets:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 🔸 Google Sheets Configuration
app.get('/api/sheets-config', async (_, res) => {
    res.json(await getConfigValue('sheets-url')); 
});

app.post('/api/sheets-config', async (req, res) => {
    const { url, password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Невірний пароль' });
    if (!url.includes('docs.google.com/spreadsheets')) return res.status(400).json({ error: 'Невірний формат посилання Google Sheets' });
    
    try {
        await fetchGoogleSheetCSV(url); 
    } catch (e) {
        return res.status(400).json({ error: `Не вдалося підключитися. Перевірте посилання та доступ: ${e.message}` });
    }

    await setConfigValue('sheets-url', { url });
    res.json({ success: true });
});

// 🔸 Новини
app.get('/api/news', async (_, res) => {
    res.json(await getDoc(News));
});

app.post('/api/news', upload.single('image'), async (req, res) => {
    const { title, description, password } = req.body;
    if (password !== ADMIN_PASSWORD) {
        if (req.file) await deleteFileIfExists(`/uploads/${req.file.filename}`);
        return res.status(401).json({ error: 'Невірний пароль' });
    }
    
    const newPost = await News.create({
        title,
        description,
        date: new Date().toLocaleDateString('uk-UA'),
        image: req.file ? `/uploads/${req.file.filename}` : null
    });
    // Тут ми не видаляємо файл, але пам'ятайте, що на Render він не збережеться після перезапуску.
    res.json({ success: true, post: newPost });
});
app.delete('/api/news/:id', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Невірний пароль' });
    
    const postToDelete = await News.findByIdAndDelete(req.params.id);
    if (postToDelete && postToDelete.image) {
        await deleteFileIfExists(postToDelete.image);
    }
    res.json({ success: true });
});

// 🔸 Домашнє завдання
app.get('/api/homework', async (_, res) => {
    res.json(await getDoc(Homework));
});
app.post('/api/homework', upload.single('image'), async (req, res) => {
    const { title, password } = req.body;
    if (password !== ADMIN_PASSWORD) {
        if (req.file) await deleteFileIfExists(`/uploads/${req.file.filename}`);
        return res.status(401).json({ error: 'Невірний пароль' });
    }
    if (!req.file) return res.status(400).json({ error: 'Потрібно завантажити зображення' });

    const newHomework = await Homework.create({
        title,
        image: `/uploads/${req.file.filename}`
    });
    res.json({ success: true, homework: newHomework });
});
app.delete('/api/homework/:id', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Невірний пароль' });
    
    const hwToDelete = await Homework.findByIdAndDelete(req.params.id);
    if (hwToDelete && hwToDelete.image) {
        await deleteFileIfExists(hwToDelete.image);
    }
    res.json({ success: true });
});

// 🔸 Турніри
app.get('/api/tournaments', async (_, res) => {
    res.json(await getConfigValue('tournaments'));
});
app.post('/api/tournaments', async (req, res) => {
    const { currentTitle, currentLink, lastWeekResults, password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Невірний пароль' });
    const data = {
        current: currentTitle && currentLink ? { title: currentTitle, link: currentLink } : null,
        lastWeek: lastWeekResults || null
    };
    await setConfigValue('tournaments', data);
    res.json({ success: true });
});

// 🔸 Події
app.get('/api/events', async (_, res) => {
    res.json(await getDoc(Event));
});
app.post('/api/events', async (req, res) => {
    const { title, date, location, description, password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Невірний пароль' });
    
    const newEvent = await Event.create({ id: Date.now(), title, date, location, description });
    res.json({ success: true, event: newEvent });
});
app.delete('/api/events/:id', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Невірний пароль' });
    
    await Event.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

// ============================================================
// Обслуговування статичних файлів
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

createDirs().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Сервер запущено: http://localhost:${PORT}`);
    });
}).catch(console.error);