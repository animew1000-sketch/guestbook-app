require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// --- MIDDLEWARE ---
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Express Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'anime_social_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Serve static frontend files from /public
app.use(express.static(path.join(__dirname, 'public')));

// --- AUTHENTICATION ROUTES ---

// 1. Register User
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({ error: 'All fields are required.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.query(
            'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
            [username, email, hashedPassword]
        );
        res.json({ message: 'User registered successfully!' });
    } catch (err) {
        console.error('Registration Error:', err.message);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Username or Email already exists.' });
        }
        res.status(500).json({ error: 'Database error during registration.' });
    }
});

// 2. Login User
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required.' });
    }

    try {
        const users = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        
        if (!users || users.length === 0) {
            return res.status(400).json({ error: 'Invalid email or password.' });
        }

        const user = users[0];
        const match = await bcrypt.compare(password, user.password_hash);

        if (!match) {
            return res.status(400).json({ error: 'Invalid email or password.' });
        }

        // Save session
        req.session.user = {
            id: user.id,
            username: user.username,
            email: user.email
        };

        res.json({ user: req.session.user });
    } catch (err) {
        console.error('Login Error:', err.message);
        res.status(500).json({ error: 'Database error during login.' });
    }
});

// 3. Get Current User Session
app.get('/api/me', (req, res) => {
    if (req.session && req.session.user) {
        res.json({ user: req.session.user });
    } else {
        res.status(401).json({ error: 'Not logged in' });
    }
});

// 4. Logout User
app.post('/api/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ error: 'Failed to logout' });
        res.json({ message: 'Logged out successfully' });
    });
});

// --- MESSAGES / FEED ROUTES ---

// Get Messages
app.get('/api/messages', async (req, res) => {
    try {
        const rows = await db.query('SELECT * FROM messages ORDER BY id DESC');
        res.json(rows);
    } catch (err) {
        console.error('Fetch Messages Error:', err.message);
        res.status(500).json({ error: 'Failed to fetch messages.' });
    }
});

// Create Message / Submit Post
app.post('/api/messages', async (req, res) => {
    const { name, message, image_url, user_id } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Post content is required.' });
    }

    try {
        await db.query(
            'INSERT INTO messages (user_id, name, message, image_url) VALUES (?, ?, ?, ?)',
            [user_id || null, name || 'Anonymous', message, image_url || null]
        );
        res.json({ message: 'Post created successfully!' });
    } catch (err) {
        console.error('Create Message Error:', err.message);
        res.status(500).json({ error: 'Failed to create post.' });
    }
});

// Fallback to index.html for root requests
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize database connection and start server
db.getDb()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
        });
    })
    .catch(err => {
        console.error('Failed to initialize database connection:', err.message);
    });