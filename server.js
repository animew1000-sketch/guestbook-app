require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'anime_social_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production', 
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: 24 * 60 * 60 * 1000 
    }
}));

app.use(express.static(path.join(__dirname, 'public')));

// --- AUTHENTICATION ROUTES ---

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
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Username or Email already exists.' });
        }
        res.status(500).json({ error: 'Database error during registration.' });
    }
});

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

        req.session.user = { id: user.id, username: user.username, email: user.email };
        res.json({ user: req.session.user });
    } catch (err) {
        res.status(500).json({ error: 'Database error during login.' });
    }
});

app.get('/api/me', (req, res) => {
    if (req.session && req.session.user) {
        res.json({ user: req.session.user });
    } else {
        res.status(401).json({ error: 'Not logged in' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ error: 'Failed to logout' });
        res.json({ message: 'Logged out successfully' });
    });
});

// --- FOLLOW / UNFOLLOW ROUTES ---

// Toggle follow/unfollow status for a target user
app.post('/api/follow/:targetId', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'You must be logged in to follow users.' });
    }

    const followerId = req.session.user.id;
    const followingId = req.params.targetId;

    if (Number(followerId) === Number(followingId)) {
        return res.status(400).json({ error: 'You cannot follow yourself.' });
    }

    try {
        const existing = await db.query(
            'SELECT * FROM follows WHERE follower_id = ? AND following_id = ?',
            [followerId, followingId]
        );

        if (existing && existing.length > 0) {
            // Unfollow if already following
            await db.query(
                'DELETE FROM follows WHERE follower_id = ? AND following_id = ?',
                [followerId, followingId]
            );
            return res.json({ following: false, message: 'Unfollowed user successfully.' });
        } else {
            // Follow user
            await db.query(
                'INSERT INTO follows (follower_id, following_id) VALUES (?, ?)',
                [followerId, followingId]
            );
            return res.json({ following: true, message: 'Followed user successfully.' });
        }
    } catch (err) {
        console.error('Follow Error:', err.message);
        res.status(500).json({ error: 'Database error handling follow state.' });
    }
});

// Get list of user IDs that current user is following
app.get('/api/following', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.json([]);
    }

    try {
        const rows = await db.query('SELECT following_id FROM follows WHERE follower_id = ?', [req.session.user.id]);
        const followingIds = rows.map(r => r.following_id);
        res.json(followingIds);
    } catch (err) {
        res.status(500).json({ error: 'Database error fetching follows.' });
    }
});

// --- MESSAGES / FEED ROUTES ---

app.get('/api/messages', async (req, res) => {
    const feedType = req.query.feed || 'public';
    const currentUserId = (req.session && req.session.user) ? req.session.user.id : null;

    try {
        if (feedType === 'following' && currentUserId) {
            // Fetch messages posted by followed users
            const query = `
                SELECT messages.* FROM messages
                INNER JOIN follows ON messages.user_id = follows.following_id
                WHERE follows.follower_id = ?
                ORDER BY messages.id DESC
            `;
            const rows = await db.query(query, [currentUserId]);
            return res.json(rows);
        }

        // Public feed: return all messages
        const rows = await db.query('SELECT * FROM messages ORDER BY id DESC');
        res.json(rows);
    } catch (err) {
        console.error('Fetch Messages Error:', err.message);
        res.status(500).json({ error: 'Failed to fetch messages.' });
    }
});

app.post('/api/messages', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'You must log in or create an account to post.' });
    }

    const { message, image_url } = req.body;
    if (!message) {
        return res.status(400).json({ error: 'Post content is required.' });
    }

    const userId = req.session.user.id;
    const authorName = req.session.user.username;

    try {
        await db.query(
            'INSERT INTO messages (user_id, name, message, image_url) VALUES (?, ?, ?, ?)',
            [userId, authorName, message, image_url || null]
        );
        res.json({ message: 'Post created successfully!' });
    } catch (err) {
        console.error('Create Message Error:', err.message);
        res.status(500).json({ error: 'Failed to create post.' });
    }
});

app.delete('/api/messages/:id', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'You must be logged in to delete posts.' });
    }

    const postId = req.params.id;
    const userId = req.session.user.id;

    try {
        const posts = await db.query('SELECT * FROM messages WHERE id = ?', [postId]);
        if (!posts || posts.length === 0) {
            return res.status(404).json({ error: 'Post not found.' });
        }

        const post = posts[0];
        if (!post.user_id || Number(post.user_id) !== Number(userId)) {
            return res.status(403).json({ error: 'You can only delete your own posts.' });
        }

        await db.query('DELETE FROM messages WHERE id = ?', [postId]);
        res.json({ message: 'Post deleted successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Database error during deletion.' });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

db.getDb()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
        });
    })
    .catch(err => {
        console.error('Failed to initialize database connection:', err.message);
    });