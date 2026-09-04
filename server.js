require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let dbPool;

async function initDb() {
    // Strictly connect to Clever Cloud MySQL
    dbPool = mysql.createPool({
        host: process.env.CLEVER_HOST || process.env.MYSQL_ADDON_HOST,
        user: process.env.CLEVER_USER || process.env.MYSQL_ADDON_USER,
        password: process.env.CLEVER_PASSWORD || process.env.MYSQL_ADDON_PASSWORD,
        database: process.env.CLEVER_DB || process.env.MYSQL_ADDON_DB,
        port: Number(process.env.CLEVER_PORT || process.env.MYSQL_ADDON_PORT || 3306),
        waitForConnections: true,
        connectionLimit: 10
    });

    await dbPool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email VARCHAR(255) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            username VARCHAR(255) UNIQUE NOT NULL,
            avatar_url TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await dbPool.query(`
        CREATE TABLE IF NOT EXISTS follows (
            follower_id INT,
            following_id INT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (follower_id, following_id)
        );
    `);
    await dbPool.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT,
            name TEXT,
            message TEXT,
            image_url LONGTEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log('App connected strictly to CLEVER CLOUD MySQL.');
}

async function executeQuery(sql, params = []) {
    const [results] = await dbPool.query(sql, params);
    return results;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/messages', async (req, res) => {
    try {
        const messages = await executeQuery('SELECT * FROM messages ORDER BY created_at DESC');
        res.json(messages);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/messages', upload.single('image'), async (req, res) => {
    const userId = req.body.userId || req.body.user_id || null;
    const name = req.body.name || 'Anonymous';
    const message = req.body.message;

    let imageUrl = null;
    if (req.file) {
        imageUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    }

    try {
        const result = await executeQuery(
            'INSERT INTO messages (user_id, name, message, image_url) VALUES (?, ?, ?, ?)',
            [userId, name, message, imageUrl]
        );
        res.status(201).json({ success: true, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/messages/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await executeQuery('DELETE FROM messages WHERE id = ?', [id]);
        res.json({ success: true, message: 'Message deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

async function startServer() {
    try {
        await initDb();
        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error('Failed to initialize database:', err.message);
        process.exit(1);
    }
}

startServer();