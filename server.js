require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const db = require('./db');

const upload = multer({ storage: multer.memoryStorage() });
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/messages', async (req, res) => {
    try {
        const messages = await db.query('SELECT * FROM messages ORDER BY created_at DESC');
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
            [userId, name, message, imageUrl]
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
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));