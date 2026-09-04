require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const upload = multer({ storage: multer.memoryStorage() });
const app = express();

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Create required database tables on startup
async function initTables() {
    try {
        const { engine } = await db.getDb();
        if (engine === 'sqlite') {
            await db.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    username TEXT UNIQUE NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INT,
                    name TEXT,
                    message TEXT,
                    image_url TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `);
        } else {
            await db.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    email VARCHAR(255) UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    username VARCHAR(255) UNIQUE NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `);
            await db.query(`
                CREATE TABLE IF NOT EXISTS messages (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT,
                    name TEXT,
                    message TEXT,
                    image_url LONGTEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `);
            
            // Automatically upgrade image_url column size on MySQL (Clever Cloud / XAMPP)
            await db.query(`ALTER TABLE messages MODIFY image_url LONGTEXT;`);
        }
    } catch (err) {
        console.error('Table Init Notice:', err.message);
    }
}

// Auth Routes
app.post('/api/auth/register', async (req, res) => {
    const { email, password, username } = req.body;
    if (!email || !password || !username) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.query(
            'INSERT INTO users (email, password_hash, username) VALUES (?, ?, ?)',
            [email, hashedPassword, username]
        );
        res.status(201).json({ success: true, message: 'User registered successfully' });
    } catch (err) {
        res.status(400).json({ error: 'Email or username already exists' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const users = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        const user = users[0];

        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '1d' });
        res.json({
            token,
            user: { id: user.id, email: user.email, username: user.username }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Messages Routes
app.get('/api/messages', async (req, res) => {
    try {
        const messages = await db.query('SELECT * FROM messages ORDER BY created_at DESC', [], req);
        res.json(messages);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/messages', upload.single('image'), async (req, res) => {
    const userId = req.body.userId || req.body.user_id || null;
    const name = req.body.name || 'Anonymous';
    const message = req.body.message;
    let imageUrl = req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` : null;

    try {
        const result = await db.query(
            'INSERT INTO messages (user_id, name, message, image_url) VALUES (?, ?, ?, ?)',
            [userId, name, message, imageUrl],
            req
        );
        res.status(201).json({ success: true, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/messages/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM messages WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await initTables();
    console.log(`Server running on http://localhost:${PORT}`);
});