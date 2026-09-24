require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { Server } = require('socket.io');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 10000;

app.set('trust proxy', 1);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const sessionMiddleware = session({
    name: 'anime_social_sid',
    secret: process.env.SESSION_SECRET || 'anime_social_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production', 
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 
    }
});

app.use(sessionMiddleware);

app.use((req, res, next) => {
    if (req.session && req.session.user) {
        req.session.touch();
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e6
});

io.use((socket, next) => {
    if (socket.request) {
        sessionMiddleware(socket.request, socket.request.res || {}, next);
    } else {
        next();
    }
});

const onlineUsers = new Map();

io.on('connection', (socket) => {
    let sessionUser = (socket.request && socket.request.session) ? socket.request.session.user : null;

    const registerUserSocket = (userId) => {
        if (!userId) return;
        const roomId = `user_${userId}`;
        socket.join(roomId);
        onlineUsers.set(Number(userId), socket.id);
    };

    if (sessionUser) {
        registerUserSocket(sessionUser.id);
    }

    socket.on('identify_user', (userId) => {
        registerUserSocket(userId);
    });

    socket.on('send_direct_message', async (data) => {
        const senderId = sessionUser ? sessionUser.id : data.sender_id;
        const { receiver_id, message, media_url, media_type, is_18plus } = data;
        
        if (!receiver_id || (!message && !media_url) || !senderId) return;

        try {
            const result = await db.query(
                'INSERT INTO direct_messages (sender_id, receiver_id, message, media_url, media_type, is_18plus) VALUES (?, ?, ?, ?, ?, ?)',
                [senderId, receiver_id, message || '', media_url || null, media_type || 'image', is_18plus ? 1 : 0]
            );

            const payload = {
                id: result.insertId,
                sender_id: Number(senderId),
                sender_username: sessionUser ? sessionUser.username : 'User',
                receiver_id: Number(receiver_id),
                message,
                media_url,
                media_type,
                is_18plus,
                created_at: new Date()
            };

            // Emit to recipient's private socket room
            io.to(`user_${receiver_id}`).emit('receive_direct_message', payload);
            io.to(`user_${receiver_id}`).emit('dm_notification', {
                sender_id: Number(senderId),
                sender_username: sessionUser ? sessionUser.username : 'User',
                message: message || 'Sent a media attachment'
            });

            // Confirm back to sender
            socket.emit('message_sent_confirm', payload);
        } catch (err) {
            console.error('Failed to process socket DM:', err);
        }
    });

    socket.on('disconnect', () => {
        if (sessionUser) {
            onlineUsers.delete(Number(sessionUser.id));
        }
    });
});

function calculateAge(birthdateStr) {
    const today = new Date();
    const birthDate = new Date(birthdateStr);
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
        age--;
    }
    return age;
}

function buildAvatarUrl(customUrl, style, seed) {
    if (customUrl) return customUrl;
    const selectedStyle = style || 'bottts';
    const selectedSeed = seed || 'default';
    return `https://api.dicebear.com/7.x/${selectedStyle}/svg?seed=${encodeURIComponent(selectedSeed)}`;
}

// --- AUTHENTICATION ROUTES ---

app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'All fields are required.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.query(
            'INSERT INTO users (username, email, password_hash, avatar_style, avatar_seed) VALUES (?, ?, ?, ?, ?)',
            [username, email, hashedPassword, 'bottts', username]
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

        let isMinor = Boolean(user.is_minor);
        let ageVerified = Boolean(user.age_verified);

        if (user.birthdate) {
            const age = calculateAge(user.birthdate);
            isMinor = age < 18;
            ageVerified = !isMinor;
            await db.query('UPDATE users SET is_minor = ?, age_verified = ? WHERE id = ?', [isMinor, ageVerified, user.id]);
        }

        const avatarStyle = user.avatar_style || 'bottts';
        const avatarSeed = user.avatar_seed || user.username;
        const customAvatarUrl = user.custom_avatar_url || null;

        req.session.user = { 
            id: user.id, 
            username: user.username, 
            email: user.email,
            birthdate: user.birthdate,
            age_verified: ageVerified,
            is_minor: isMinor,
            avatar_style: avatarStyle,
            avatar_seed: avatarSeed,
            custom_avatar_url: customAvatarUrl,
            avatar_url: buildAvatarUrl(customAvatarUrl, avatarStyle, avatarSeed)
        };
        
        req.session.save(err => {
            if (err) return res.status(500).json({ error: 'Session save error' });
            res.json({ user: req.session.user });
        });
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
        res.clearCookie('anime_social_sid');
        res.json({ message: 'Logged out successfully' });
    });
});

app.post('/api/avatar', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'You must log in to update profile picture.' });
    }

    const { avatar_style, avatar_seed, custom_avatar_url } = req.body;
    const style = avatar_style || 'bottts';
    const seed = avatar_seed || req.session.user.username;
    const customUrl = custom_avatar_url || null;

    try {
        await db.query(
            'UPDATE users SET avatar_style = ?, avatar_seed = ?, custom_avatar_url = ? WHERE id = ?',
            [style, seed, customUrl, req.session.user.id]
        );

        req.session.user.avatar_style = style;
        req.session.user.avatar_seed = seed;
        req.session.user.custom_avatar_url = customUrl;
        req.session.user.avatar_url = buildAvatarUrl(customUrl, style, seed);

        req.session.save(err => {
            if (err) return res.status(500).json({ error: 'Session save error' });
            res.json({ message: 'Profile picture updated!', avatar_url: req.session.user.avatar_url });
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update profile picture.' });
    }
});

app.post('/api/verify-birthdate', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'You must be logged in.' });
    }

    const { birthdate } = req.body;
    if (!birthdate) {
        return res.status(400).json({ error: 'Birthdate is required.' });
    }

    const age = calculateAge(birthdate);
    const isMinor = age < 18;
    const ageVerified = !isMinor;
    const userId = req.session.user.id;

    try {
        await db.query(
            'UPDATE users SET birthdate = ?, is_minor = ?, age_verified = ? WHERE id = ?',
            [birthdate, isMinor, ageVerified, userId]
        );

        req.session.user.birthdate = birthdate;
        req.session.user.is_minor = isMinor;
        req.session.user.age_verified = ageVerified;

        req.session.save(err => {
            if (err) return res.status(500).json({ error: 'Session save error' });

            if (isMinor) {
                return res.json({ 
                    is_minor: true, 
                    age_verified: false, 
                    message: `Access denied. You are ${age} years old. 18+ content is locked until your 18th birthday.` 
                });
            }

            res.json({ 
                is_minor: false, 
                age_verified: true, 
                message: 'Birthdate verified! 18+ content access granted.' 
            });
        });
    } catch (err) {
        res.status(500).json({ error: 'Database error storing birthdate.' });
    }
});

// --- REST DM & FOLLOW ROUTES ---

app.get('/api/dms/:userId', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const currentUserId = req.session.user.id;
    const otherUserId = req.params.userId;

    try {
        const rows = await db.query(
            `SELECT * FROM direct_messages 
             WHERE (sender_id = ? AND receiver_id = ?) 
                OR (sender_id = ? AND receiver_id = ?) 
             ORDER BY id ASC LIMIT 50`,
            [currentUserId, otherUserId, otherUserId, currentUserId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Database error loading DM history.' });
    }
});

app.get('/api/following', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.json([]);
    }
    try {
        const rows = await db.query('SELECT following_id FROM follows WHERE follower_id = ?', [req.session.user.id]);
        const followingIds = rows.map(r => Number(r.following_id));
        res.json(followingIds);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch following list.' });
    }
});

app.post('/api/follow/:id', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'You must log in to follow users.' });
    }

    const followerId = req.session.user.id;
    const followingId = req.params.id;

    if (Number(followerId) === Number(followingId)) {
        return res.status(400).json({ error: 'You cannot follow yourself.' });
    }

    try {
        const existing = await db.query(
            'SELECT * FROM follows WHERE follower_id = ? AND following_id = ?',
            [followerId, followingId]
        );

        if (existing && existing.length > 0) {
            await db.query(
                'DELETE FROM follows WHERE follower_id = ? AND following_id = ?',
                [followerId, followingId]
            );
            return res.json({ message: 'Unfollowed user successfully.', following: false });
        } else {
            await db.query(
                'INSERT INTO follows (follower_id, following_id) VALUES (?, ?)',
                [followerId, followingId]
            );
            return res.json({ message: 'Followed user successfully.', following: true });
        }
    } catch (err) {
        res.status(500).json({ error: 'Database error toggling follow status.' });
    }
});

// --- MESSAGES & REAL-TIME BROADCASTS ---

app.get('/api/messages', async (req, res) => {
    const feedType = req.query.feed || 'public';
    let show18Plus = req.query.show18plus === 'true';
    const currentUserId = (req.session && req.session.user) ? req.session.user.id : null;

    if (req.session && req.session.user && req.session.user.is_minor) {
        show18Plus = false;
    }

    try {
        let query = '';
        let params = [];

        if (feedType === 'following' && currentUserId) {
            query = `
                SELECT messages.*, users.avatar_style, users.avatar_seed, users.custom_avatar_url 
                FROM messages
                INNER JOIN follows ON messages.user_id = follows.following_id
                LEFT JOIN users ON messages.user_id = users.id
                WHERE follows.follower_id = ?
            `;
            params.push(currentUserId);

            if (!show18Plus) {
                query += ' AND (messages.is_18plus IS FALSE OR messages.is_18plus IS NULL)';
            }
            query += ' ORDER BY messages.id DESC';
        } else {
            query = `
                SELECT messages.*, users.avatar_style, users.avatar_seed, users.custom_avatar_url 
                FROM messages 
                LEFT JOIN users ON messages.user_id = users.id 
                WHERE 1=1
            `;
            if (!show18Plus) {
                query += ' AND (messages.is_18plus IS FALSE OR messages.is_18plus IS NULL)';
            }
            query += ' ORDER BY messages.id DESC';
        }

        const rows = await db.query(query, params);

        const rowsWithAvatars = rows.map(r => ({
            ...r,
            avatar_url: buildAvatarUrl(r.custom_avatar_url, r.avatar_style, r.avatar_seed || r.name)
        }));

        res.json(rowsWithAvatars);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch messages.' });
    }
});

app.post('/api/messages', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'You must log in to post.' });
    }

    const { message, image_url, is_18plus } = req.body;
    if (!message) {
        return res.status(400).json({ error: 'Post content is required.' });
    }

    let detected18Plus = Boolean(is_18plus);

    if (req.session.user.is_minor && detected18Plus) {
        return res.status(403).json({ error: 'Accounts under 18 are restricted from submitting mature 18+ content.' });
    }

    const userId = req.session.user.id;
    const authorName = req.session.user.username;

    try {
        const result = await db.query(
            'INSERT INTO messages (user_id, name, message, image_url, is_18plus) VALUES (?, ?, ?, ?, ?)',
            [userId, authorName, message, image_url || null, detected18Plus]
        );

        const postPayload = {
            id: result.insertId,
            user_id: userId,
            name: authorName,
            message,
            image_url: image_url || null,
            is_18plus: detected18Plus,
            created_at: new Date(),
            avatar_url: req.session.user.avatar_url
        };

        // Broadcast post to all connected clients real-time
        io.emit('new_public_post', postPayload);

        res.json({ message: 'Post created successfully!', post: postPayload });
    } catch (err) {
        res.status(500).json({ error: `Failed to save post: ${err.message}` });
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

        // Broadcast post deletion to all connected clients real-time
        io.emit('post_deleted', { id: Number(postId) });

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
        server.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
        });
    })
    .catch(err => {
        console.error('Failed to initialize database connection:', err.message);
    });