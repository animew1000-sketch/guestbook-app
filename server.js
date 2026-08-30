const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg');
const cloudinary = require('cloudinary');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Safe import for CloudinaryStorage across package versions
const multerCloudinary = require('multer-storage-cloudinary');
const CloudinaryStorage = multerCloudinary.CloudinaryStorage || multerCloudinary;

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your_fallback_secret_key';

// 1. Configure PostgreSQL Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Initialize Database Tables (Users, Follows, Messages)
async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                username VARCHAR(50) UNIQUE NOT NULL,
                avatar_url TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS follows (
                follower_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                following_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (follower_id, following_id)
            );

            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name TEXT,
                message TEXT,
                image_url TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
        `);
        console.log('Database tables initialized successfully');
    } catch (err) {
        console.error('Error creating database tables:', err);
    }
}
initDb();

// 2. Configure Cloudinary Storage for Multer
cloudinary.v2.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'guestbook_uploads',
        allowed_formats: ['jpg', 'png', 'jpeg', 'gif', 'webp']
    }
});
const upload = multer({ storage: storage });

// 3. Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Authentication Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ error: 'Access token required' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token' });
        req.user = user;
        next();
    });
};

// --- AUTHENTICATION ENDPOINTS ---

// Register New User Profile
app.post('/api/auth/register', async (req, res) => {
    const { email, password, username } = req.body;
    if (!email || !password || !username) {
        return res.status(400).json({ error: 'Email, password, and username are required' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (email, password_hash, username) VALUES ($1, $2, $3) RETURNING id, email, username',
            [email.toLowerCase(), hashedPassword, username.toLowerCase()]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(400).json({ error: 'Email or username already exists' });
    }
});

// Login User
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
        const user = rows[0];

        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.id, email: user.email, username: user.username } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- SOCIAL / FOLLOW ENDPOINTS ---

// Follow a User
app.post('/api/users/:id/follow', authenticateToken, async (req, res) => {
    const targetUserId = req.params.id;
    const currentUserId = req.user.id;

    if (parseInt(targetUserId) === currentUserId) {
        return res.status(400).json({ error: 'You cannot follow yourself' });
    }

    try {
        await pool.query(
            'INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [currentUserId, targetUserId]
        );
        res.json({ message: 'Successfully followed user' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Unfollow a User
app.delete('/api/users/:id/follow', authenticateToken, async (req, res) => {
    try {
        await pool.query(
            'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2',
            [req.user.id, req.params.id]
        );
        res.json({ message: 'Successfully unfollowed user' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- FEED & POST ENDPOINTS ---

// Get Public Feed (All Posts)
app.get('/api/messages', async (req, res) => {
    try {
        const query = `
            SELECT m.*, u.username, u.avatar_url 
            FROM messages m 
            LEFT JOIN users u ON m.user_id = u.id 
            ORDER BY m.id DESC
        `;
        const { rows } = await pool.query(query);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Following Feed (Posts from users you follow)
app.get('/api/feed', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT m.*, u.username, u.avatar_url 
            FROM messages m
            JOIN follows f ON m.user_id = f.following_id
            JOIN users u ON m.user_id = u.id
            WHERE f.follower_id = $1
            ORDER BY m.id DESC
        `;
        const { rows } = await pool.query(query, [req.user.id]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Post a Message with optional Cloudinary Image
app.post('/api/messages', upload.single('image'), async (req, res) => {
    const { name, message, userId } = req.body;
    const imageUrl = req.file ? (req.file.path || req.file.secure_url) : null;

    try {
        const result = await pool.query(
            'INSERT INTO messages (name, message, image_url, user_id) VALUES ($1, $2, $3, $4) RETURNING *',
            [name, message, imageUrl, userId || null]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Database insertion error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Delete a Message
app.delete('/api/messages/:id', async (req, res) => {
    const messageId = req.params.id;
    const { userId, name } = req.body;

    try {
        const { rows } = await pool.query('SELECT * FROM messages WHERE id = $1', [messageId]);
        if (rows.length === 0) return res.status(404).json({ error: 'Post not found' });

        const msg = rows[0];
        const isOwner = (userId && msg.user_id === parseInt(userId)) || (name && msg.name === name);

        if (!isOwner) {
            return res.status(403).json({ error: 'You do not have permission to delete this post' });
        }

        await pool.query('DELETE FROM messages WHERE id = $1', [messageId]);
        res.json({ message: 'Post deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Catch-all route to serve index.html
app.get('/*path', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});