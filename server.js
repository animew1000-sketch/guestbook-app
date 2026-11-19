require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { Server } = require('socket.io');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 10000;

app.set('trust proxy', 1);

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

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

// Serve custom favicon.svg if present, otherwise serve a built-in SVG icon for every page
app.get(['/favicon.svg', '/favicon.ico'], (req, res) => {
    const customFavicon = path.join(__dirname, 'public', 'favicon.svg');
    if (fs.existsSync(customFavicon)) {
        return res.sendFile(customFavicon);
    }
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(`
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
            <defs>
                <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#818cf8"/>
                    <stop offset="100%" stop-color="#c084fc"/>
                </linearGradient>
            </defs>
            <rect width="64" height="64" rx="16" fill="#0f172a"/>
            <path d="M32 10 L38 26 L54 32 L38 38 L32 54 L26 38 L10 32 L26 26 Z" fill="url(#g)"/>
        </svg>
    `);
});

app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

io.use((socket, next) => {
    if (socket.request) {
        sessionMiddleware(socket.request, socket.request.res || {}, next);
    } else {
        next();
    }
});

const onlineUsers = new Map();
const watchRooms = new Map(); // roomCode -> { id, title, host, users: Set }

const GACHA_REWARDS = [
    { title: 'SSR Lucky Puller', badge: '👑' },
    { title: 'Sakura Shrine Blessings', badge: '🌸' },
    { title: 'Ramen Critic', badge: '🍜' },
    { title: 'Critical Hit Striker', badge: '⚔️' },
    { title: 'Midnight Otaku', badge: '👾' },
    { title: 'Golden Ticket Holder', badge: '🎫' },
    { title: 'Arcane Tactician', badge: '🔮' },
    { title: 'Turbo Drift Racer', badge: '⚡' }
];

function getTodayKey() {
    return new Date().toISOString().slice(0, 10);
}

function getWatchRoomList() {
    return Array.from(watchRooms.values()).map(r => ({
        id: r.id,
        title: r.title,
        host: r.host,
        count: r.users.size
    }));
}

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

    // --- LIVE TYPING INDICATORS ---
    socket.on('typing_start', (data) => {
        const senderId = sessionUser ? sessionUser.id : data.sender_id;
        const { receiver_id } = data;
        if (!receiver_id || !senderId) return;

        io.to(`user_${receiver_id}`).emit('user_typing_start', {
            sender_id: Number(senderId),
            sender_username: sessionUser ? sessionUser.username : 'User'
        });
    });

    socket.on('typing_stop', (data) => {
        const senderId = sessionUser ? sessionUser.id : data.sender_id;
        const { receiver_id } = data;
        if (!receiver_id || !senderId) return;

        io.to(`user_${receiver_id}`).emit('user_typing_stop', {
            sender_id: Number(senderId)
        });
    });

    // --- DIRECT MESSAGES WITH BLOCK CHECK (SUPPORTS IMAGE, GIF, VIDEO, AUDIO) ---
    socket.on('send_direct_message', async (data) => {
        const senderId = sessionUser ? sessionUser.id : data.sender_id;
        const { receiver_id, message, media_url, media_type, is_18plus } = data;

        if (!receiver_id || (!message && !media_url) || !senderId) return;

        try {
            const blocks = await db.query(
                'SELECT id FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)',
                [receiver_id, senderId, senderId, receiver_id]
            );

            if (blocks && blocks.length > 0) {
                return socket.emit('error_message', { error: 'Message cannot be delivered due to active user blocking.' });
            }

            const result = await db.query(
                'INSERT INTO direct_messages (sender_id, receiver_id, message, media_url, media_type, is_18plus) VALUES (?, ?, ?, ?, ?, ?)',
                [senderId, receiver_id, message || '', media_url || null, media_type || 'image', is_18plus ? 1 : 0]
            );

            const payload = {
                id: result.insertId,
                sender_id: Number(senderId),
                sender_username: sessionUser ? sessionUser.username : 'User',
                receiver_id: Number(receiver_id),
                message: message || '',
                media_url: media_url || null,
                media_type: media_type || 'image',
                is_18plus: Boolean(is_18plus),
                created_at: new Date()
            };

            io.to(`user_${receiver_id}`).emit('receive_direct_message', payload);
            io.to(`user_${receiver_id}`).emit('dm_notification', {
                sender_id: Number(senderId),
                sender_username: sessionUser ? sessionUser.username : 'User',
                message: message || (media_type === 'audio' ? 'Sent a voice clip' : 'Sent a media attachment')
            });

            socket.emit('message_sent_confirm', payload);
        } catch (err) {
            console.error('Failed to process socket DM:', err);
        }
    });

    // --- LIVE REACTION / WATCH ROOMS ---
    socket.on('get_watch_rooms', () => {
        socket.emit('watch_rooms_list', getWatchRoomList());
    });

    socket.on('create_watch_room', (data) => {
        const roomTitle = (data && data.title ? data.title.trim() : 'Anime Episode Watch Party').substring(0, 60);
        const roomId = 'watch_' + Date.now().toString(36);
        const hostName = sessionUser ? sessionUser.username : (data?.username || 'Guest');

        watchRooms.set(roomId, {
            id: roomId,
            title: roomTitle,
            host: hostName,
            users: new Set([socket.id])
        });

        socket.join(roomId);
        socket.emit('watch_room_joined', { id: roomId, title: roomTitle, host: hostName });
        io.emit('watch_rooms_list', getWatchRoomList());
    });

    socket.on('join_watch_room', (roomId) => {
        const room = watchRooms.get(roomId);
        if (!room) {
            return socket.emit('error_message', { error: 'Watch room no longer exists.' });
        }
        room.users.add(socket.id);
        socket.join(roomId);
        socket.emit('watch_room_joined', { id: room.id, title: room.title, host: room.host });
        io.to(roomId).emit('watch_room_system', {
            text: `@${sessionUser ? sessionUser.username : 'Someone'} joined the room.`
        });
        io.emit('watch_rooms_list', getWatchRoomList());
    });

    socket.on('leave_watch_room', (roomId) => {
        const room = watchRooms.get(roomId);
        if (room) {
            room.users.delete(socket.id);
            socket.leave(roomId);
            if (room.users.size === 0) {
                watchRooms.delete(roomId);
            }
        }
        io.emit('watch_rooms_list', getWatchRoomList());
    });

    socket.on('watch_room_chat', (data) => {
        if (!data || !data.roomId || !data.text) return;
        const room = watchRooms.get(data.roomId);
        if (!room) return;

        io.to(data.roomId).emit('watch_room_message', {
            username: sessionUser ? sessionUser.username : 'Guest',
            text: String(data.text).trim().substring(0, 240),
            created_at: new Date()
        });
    });

    socket.on('watch_room_emote', (data) => {
        if (!data || !data.roomId || !data.emote) return;
        io.to(data.roomId).emit('watch_room_reaction', {
            username: sessionUser ? sessionUser.username : 'Guest',
            emote: String(data.emote).substring(0, 8)
        });
    });

    socket.on('disconnect', () => {
        if (sessionUser) {
            onlineUsers.delete(Number(sessionUser.id));
        }
        let changed = false;
        for (const [roomId, room] of watchRooms.entries()) {
            if (room.users.has(socket.id)) {
                room.users.delete(socket.id);
                changed = true;
                if (room.users.size === 0) {
                    watchRooms.delete(roomId);
                }
            }
        }
        if (changed) {
            io.emit('watch_rooms_list', getWatchRoomList());
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

function formatUserSessionObj(user) {
    const todayKey = getTodayKey();
    const hasDailyReward = user.daily_gacha_date === todayKey && user.daily_gacha_title;
    const avatarStyle = user.avatar_style || 'bottts';
    const avatarSeed = user.avatar_seed || user.username;
    const customAvatarUrl = user.custom_avatar_url || null;

    return {
        id: user.id,
        username: user.username,
        email: user.email,
        birthdate: user.birthdate,
        age_verified: Boolean(user.age_verified),
        is_minor: Boolean(user.is_minor),
        avatar_style: avatarStyle,
        avatar_seed: avatarSeed,
        custom_avatar_url: customAvatarUrl,
        avatar_url: buildAvatarUrl(customAvatarUrl, avatarStyle, avatarSeed),
        title: hasDailyReward ? user.daily_gacha_title : (user.title || 'Novice Adventurer'),
        badge: hasDailyReward ? user.daily_gacha_badge : (user.badge || '⭐'),
        base_title: user.title || 'Novice Adventurer',
        base_badge: user.badge || '⭐',
        daily_gacha_claimed: Boolean(hasDailyReward),
        pinned_post_id: user.pinned_post_id ? Number(user.pinned_post_id) : null,
        device_id: user.device_id
    };
}

async function attachPollsAndQuotesToPosts(posts, currentUserId) {
    if (!Array.isArray(posts) || posts.length === 0) return [];

    const postIds = posts.map(p => Number(p.id)).filter(Boolean);
    const quotedIds = posts.map(p => Number(p.quoted_post_id)).filter(Boolean);

    // Fetch quoted posts
    const quotedMap = new Map();
    if (quotedIds.length > 0) {
        const qPlaceholders = quotedIds.map(() => '?').join(',');
        const qRows = await db.query(
            `SELECT messages.*, users.avatar_style, users.avatar_seed, users.custom_avatar_url, users.title, users.badge
             FROM messages
             LEFT JOIN users ON messages.user_id = users.id
             WHERE messages.id IN (${qPlaceholders})`,
            quotedIds
        );
        (Array.isArray(qRows) ? qRows : []).forEach(qr => {
            quotedMap.set(Number(qr.id), {
                id: Number(qr.id),
                user_id: qr.user_id ? Number(qr.user_id) : null,
                name: qr.name,
                message: qr.message,
                image_url: qr.image_url,
                is_18plus: Boolean(qr.is_18plus),
                is_spoiler: Boolean(qr.is_spoiler),
                created_at: qr.created_at,
                avatar_url: buildAvatarUrl(qr.custom_avatar_url, qr.avatar_style, qr.avatar_seed || qr.name),
                title: qr.title || 'Novice Adventurer',
                badge: qr.badge || '⭐'
            });
        });
    }

    // Fetch polls for posts
    const pollMap = new Map();
    if (postIds.length > 0) {
        const pPlaceholders = postIds.map(() => '?').join(',');
        const pollRows = await db.query(`SELECT * FROM polls WHERE post_id IN (${pPlaceholders})`, postIds);
        const pollList = Array.isArray(pollRows) ? pollRows : [];

        if (pollList.length > 0) {
            const pollIds = pollList.map(pl => Number(pl.id));
            const optPlaceholders = pollIds.map(() => '?').join(',');
            const optRows = await db.query(`SELECT * FROM poll_options WHERE poll_id IN (${optPlaceholders}) ORDER BY id ASC`, pollIds);
            const voteRows = await db.query(`SELECT poll_id, option_id, user_id FROM poll_votes WHERE poll_id IN (${optPlaceholders})`, pollIds);

            const optionsByPoll = new Map();
            (Array.isArray(optRows) ? optRows : []).forEach(opt => {
                const pid = Number(opt.poll_id);
                if (!optionsByPoll.has(pid)) optionsByPoll.set(pid, []);
                optionsByPoll.get(pid).push({
                    id: Number(opt.id),
                    text: opt.option_text,
                    votes: 0
                });
            });

            const userVotedOptionByPoll = new Map();
            (Array.isArray(voteRows) ? voteRows : []).forEach(v => {
                const pid = Number(v.poll_id);
                const oid = Number(v.option_id);
                const opts = optionsByPoll.get(pid) || [];
                const targetOpt = opts.find(o => o.id === oid);
                if (targetOpt) targetOpt.votes += 1;

                if (currentUserId && Number(v.user_id) === Number(currentUserId)) {
                    userVotedOptionByPoll.set(pid, oid);
                }
            });

            pollList.forEach(pl => {
                const pid = Number(pl.id);
                const opts = optionsByPoll.get(pid) || [];
                const totalVotes = opts.reduce((sum, o) => sum + o.votes, 0);
                pollMap.set(Number(pl.post_id), {
                    id: pid,
                    question: pl.question,
                    options: opts,
                    total_votes: totalVotes,
                    user_voted_option_id: userVotedOptionByPoll.get(pid) || null
                });
            });
        }
    }

    return posts.map(r => {
        const todayKey = getTodayKey();
        const activeDaily = r.daily_gacha_date === todayKey && r.daily_gacha_title;
        return {
            ...r,
            avatar_url: buildAvatarUrl(r.custom_avatar_url, r.avatar_style, r.avatar_seed || r.name),
            title: activeDaily ? r.daily_gacha_title : (r.title || 'Novice Adventurer'),
            badge: activeDaily ? r.daily_gacha_badge : (r.badge || '⭐'),
            is_spoiler: Boolean(r.is_spoiler),
            is_18plus: Boolean(r.is_18plus),
            quoted_post: r.quoted_post_id ? (quotedMap.get(Number(r.quoted_post_id)) || null) : null,
            poll: pollMap.get(Number(r.id)) || null
        };
    });
}

const PROFANITY_LIST = ['badword1', 'badword2', 'hate speech', 'spamlink'];
const SPOILER_KEYWORDS = ['spoiler:', 'dies in chapter', 'ending leaked', 'final battle winner'];

function applyTextFilters(text) {
    if (!text) return { sanitizedText: '', autoSpoiler: false, isCensored: false };

    let sanitizedText = text;
    let autoSpoiler = false;
    let isCensored = false;

    PROFANITY_LIST.forEach(word => {
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        if (regex.test(sanitizedText)) {
            sanitizedText = sanitizedText.replace(regex, '****');
            isCensored = true;
        }
    });

    SPOILER_KEYWORDS.forEach(keyword => {
        if (sanitizedText.toLowerCase().includes(keyword.toLowerCase())) {
            autoSpoiler = true;
        }
    });

    return { sanitizedText, autoSpoiler, isCensored };
}

// --- AUTH & DEVICE LIMITS ---

app.post('/api/register', async (req, res) => {
    const { username, email, password, device_id } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'All fields are required.' });
    }

    try {
        if (device_id) {
            const existingAccounts = await db.query('SELECT id, username, email FROM users WHERE device_id = ?', [device_id]);
            if (existingAccounts && existingAccounts.length >= 2) {
                return res.status(403).json({
                    error: 'Device account limit exceeded. Maximum 2 accounts allowed per computer.',
                    device_limit_exceeded: true,
                    accounts: existingAccounts
                });
            }
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await db.query(
            'INSERT INTO users (username, email, password_hash, avatar_style, avatar_seed, title, badge, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [username, email, hashedPassword, 'bottts', username, 'Novice Adventurer', '⭐', device_id || null]
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
    const { email, password, device_id } = req.body;
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

        if (device_id && user.device_id !== device_id) {
            await db.query('UPDATE users SET device_id = ? WHERE id = ?', [device_id, user.id]);
            user.device_id = device_id;
        }

        if (device_id) {
            const connectedAccounts = await db.query('SELECT id, username, email FROM users WHERE device_id = ?', [device_id]);
            if (connectedAccounts && connectedAccounts.length > 2) {
                return res.status(403).json({
                    error: 'Device account limit exceeded. Delete extra accounts to log in.',
                    device_limit_exceeded: true,
                    accounts: connectedAccounts
                });
            }
        }

        let isMinor = Boolean(user.is_minor);
        let ageVerified = Boolean(user.age_verified);

        if (user.birthdate) {
            const age = calculateAge(user.birthdate);
            isMinor = age < 18;
            ageVerified = !isMinor;
            await db.query('UPDATE users SET is_minor = ?, age_verified = ? WHERE id = ?', [isMinor, ageVerified, user.id]);
            user.is_minor = isMinor;
            user.age_verified = ageVerified;
        }

        req.session.user = formatUserSessionObj(user);

        req.session.save(err => {
            if (err) return res.status(500).json({ error: 'Session save error' });
            res.json({ user: req.session.user });
        });
    } catch (err) {
        res.status(500).json({ error: 'Database error during login.' });
    }
});

app.get('/api/device-accounts', async (req, res) => {
    const deviceId = req.query.device_id;
    if (!deviceId) return res.status(400).json({ error: 'Device ID required.' });

    try {
        const accounts = await db.query('SELECT id, username, email FROM users WHERE device_id = ?', [deviceId]);
        res.json({ accounts, count: accounts.length });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch device accounts.' });
    }
});

app.post('/api/delete-device-account', async (req, res) => {
    const { target_user_id, password, device_id } = req.body;
    if (!target_user_id || !password || !device_id) {
        return res.status(400).json({ error: 'Target account ID, password, and device ID are required.' });
    }

    try {
        const users = await db.query('SELECT * FROM users WHERE id = ? AND device_id = ?', [target_user_id, device_id]);
        if (!users || users.length === 0) {
            return res.status(404).json({ error: 'Account not found on this device.' });
        }

        const user = users[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.status(401).json({ error: 'Incorrect password for account deletion.' });
        }

        await db.query('DELETE FROM direct_messages WHERE sender_id = ? OR receiver_id = ?', [target_user_id, target_user_id]);
        await db.query('DELETE FROM follows WHERE follower_id = ? OR following_id = ?', [target_user_id, target_user_id]);
        await db.query('DELETE FROM messages WHERE user_id = ?', [target_user_id]);
        await db.query('DELETE FROM reports WHERE reporter_id = ?', [target_user_id]);
        await db.query('DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?', [target_user_id, target_user_id]);
        await db.query('DELETE FROM users WHERE id = ?', [target_user_id]);

        const remainingAccounts = await db.query('SELECT id, username, email FROM users WHERE device_id = ?', [device_id]);

        res.json({
            message: `Account @${user.username} deleted successfully.`,
            remaining_count: remainingAccounts.length,
            accounts: remainingAccounts,
            can_proceed: remainingAccounts.length <= 2
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete account.' });
    }
});

app.get('/api/me', async (req, res) => {
    if (req.session && req.session.user) {
        const deviceId = req.session.user.device_id;
        if (deviceId) {
            const accounts = await db.query('SELECT id, username, email FROM users WHERE device_id = ?', [deviceId]);
            if (accounts.length > 2) {
                req.session.destroy();
                res.clearCookie('anime_social_sid');
                return res.status(403).json({
                    error: 'Device limit exceeded.',
                    device_limit_exceeded: true,
                    accounts
                });
            }
        }
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

// --- DAILY GACHA / LUCK PULL ---
app.post('/api/daily-gacha', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'You must log in to pull daily gacha.' });
    }

    const userId = Number(req.session.user.id);
    const todayKey = getTodayKey();

    try {
        const rows = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
        const user = Array.isArray(rows) ? rows[0] : null;
        if (!user) return res.status(404).json({ error: 'User not found.' });

        if (user.daily_gacha_date === todayKey && user.daily_gacha_title) {
            return res.status(400).json({
                error: `You already pulled today's gacha (${user.daily_gacha_badge} ${user.daily_gacha_title}). Come back tomorrow!`
            });
        }

        const reward = GACHA_REWARDS[Math.floor(Math.random() * GACHA_REWARDS.length)];

        await db.query(
            'UPDATE users SET daily_gacha_date = ?, daily_gacha_title = ?, daily_gacha_badge = ? WHERE id = ?',
            [todayKey, reward.title, reward.badge, userId]
        );

        user.daily_gacha_date = todayKey;
        user.daily_gacha_title = reward.title;
        user.daily_gacha_badge = reward.badge;
        req.session.user = formatUserSessionObj(user);

        req.session.save(err => {
            if (err) return res.status(500).json({ error: 'Session save error' });
            res.json({
                reward,
                user: req.session.user,
                message: `Daily Gacha Pull: ${reward.badge} ${reward.title}!`
            });
        });
    } catch (err) {
        console.error('Daily gacha error:', err);
        res.status(500).json({ error: 'Failed to perform daily gacha pull.' });
    }
});

// --- PROFILE UPDATE ---
app.post('/api/avatar', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'You must log in to update profile.' });
    }

    const { avatar_style, avatar_seed, custom_avatar_url, title, badge } = req.body;
    const style = avatar_style || 'bottts';
    const seed = avatar_seed || req.session.user.username;
    const customUrl = custom_avatar_url || null;
    const userTitle = (title && title.trim().length > 0) ? title.trim().substring(0, 40) : 'Novice Adventurer';
    const userBadge = badge || '⭐';

    try {
        await db.query(
            'UPDATE users SET avatar_style = ?, avatar_seed = ?, custom_avatar_url = ?, title = ?, badge = ? WHERE id = ?',
            [style, seed, customUrl, userTitle, userBadge, req.session.user.id]
        );

        const rows = await db.query('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
        const updatedUser = Array.isArray(rows) && rows[0] ? rows[0] : req.session.user;
        req.session.user = formatUserSessionObj(updatedUser);

        req.session.save(err => {
            if (err) return res.status(500).json({ error: 'Session save error' });
            res.json({
                message: 'Profile updated!',
                user: req.session.user,
                avatar_url: req.session.user.avatar_url,
                title: req.session.user.title,
                badge: req.session.user.badge
            });
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update profile.' });
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

// --- FOLLOW / UNFOLLOW SYSTEM ---

app.get('/api/following', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.json([]);
    }

    try {
        const rows = await db.query(
            'SELECT following_id FROM follows WHERE follower_id = ?',
            [Number(req.session.user.id)]
        );
        const list = Array.isArray(rows) ? rows : (rows.rows || []);
        res.json(list.map(r => Number(r.following_id)));
    } catch (err) {
        console.error('GET /api/following error:', err);
        res.status(500).json({ error: 'Failed to fetch following list.' });
    }
});

app.post('/api/follow/:target_id', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'You must log in to follow users.' });
    }

    const followerId = Number(req.session.user.id);
    const followingId = Number(req.params.target_id);

    if (!Number.isInteger(followingId) || followingId <= 0 || followerId === followingId) {
        return res.status(400).json({ error: 'Invalid target user.' });
    }

    try {
        const targetRows = await db.query('SELECT id FROM users WHERE id = ?', [followingId]);
        const targetUsers = Array.isArray(targetRows) ? targetRows : (targetRows.rows || []);
        if (targetUsers.length === 0) {
            return res.status(404).json({ error: 'Target user not found.' });
        }

        const existingRows = await db.query(
            'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?',
            [followerId, followingId]
        );
        const existing = Array.isArray(existingRows) ? existingRows : (existingRows.rows || []);

        if (existing.length > 0) {
            await db.query(
                'DELETE FROM follows WHERE follower_id = ? AND following_id = ?',
                [followerId, followingId]
            );
            return res.json({ following: false, following_id: followingId, message: 'Unfollowed user.' });
        } else {
            await db.query(
                'INSERT INTO follows (follower_id, following_id) VALUES (?, ?)',
                [followerId, followingId]
            );
            return res.json({ following: true, following_id: followingId, message: 'Following user.' });
        }
    } catch (err) {
        console.error('POST /api/follow/:target_id error:', err);
        res.status(500).json({ error: `Failed to update follow status: ${err.message}` });
    }
});

// --- PINNED POST & SAVED BOOKMARKS ---

app.post('/api/pin/:post_id', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'You must log in to pin posts.' });
    }

    const userId = Number(req.session.user.id);
    const postId = Number(req.params.post_id);

    try {
        const posts = await db.query('SELECT id, user_id FROM messages WHERE id = ?', [postId]);
        if (!Array.isArray(posts) || posts.length === 0) {
            return res.status(404).json({ error: 'Post not found.' });
        }
        if (Number(posts[0].user_id) !== userId) {
            return res.status(403).json({ error: 'You can only pin your own posts.' });
        }

        const currentPinned = req.session.user.pinned_post_id ? Number(req.session.user.pinned_post_id) : null;
        const nextPinned = currentPinned === postId ? null : postId;

        await db.query('UPDATE users SET pinned_post_id = ? WHERE id = ?', [nextPinned, userId]);
        req.session.user.pinned_post_id = nextPinned;

        req.session.save(err => {
            if (err) return res.status(500).json({ error: 'Session save error' });
            res.json({
                pinned_post_id: nextPinned,
                message: nextPinned ? 'Post pinned to your profile/feed!' : 'Post unpinned.'
            });
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to pin post.' });
    }
});

app.get('/api/saved-posts', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.json([]);
    }
    try {
        const rows = await db.query('SELECT post_id FROM saved_posts WHERE user_id = ?', [Number(req.session.user.id)]);
        res.json((Array.isArray(rows) ? rows : []).map(r => Number(r.post_id)));
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch saved posts.' });
    }
});

app.post('/api/save/:post_id', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'You must log in to bookmark posts.' });
    }

    const userId = Number(req.session.user.id);
    const postId = Number(req.params.post_id);

    try {
        const existing = await db.query('SELECT id FROM saved_posts WHERE user_id = ? AND post_id = ?', [userId, postId]);
        if (Array.isArray(existing) && existing.length > 0) {
            await db.query('DELETE FROM saved_posts WHERE user_id = ? AND post_id = ?', [userId, postId]);
            return res.json({ saved: false, post_id: postId, message: 'Removed from saved posts.' });
        } else {
            await db.query('INSERT INTO saved_posts (user_id, post_id) VALUES (?, ?)', [userId, postId]);
            return res.json({ saved: true, post_id: postId, message: 'Post bookmarked!' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Failed to update saved post.' });
    }
});

// --- POLL VOTING ---

app.post('/api/polls/:poll_id/vote', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'You must log in to vote in polls.' });
    }

    const pollId = Number(req.params.poll_id);
    const optionId = Number(req.body.option_id);
    const userId = Number(req.session.user.id);

    if (!pollId || !optionId) {
        return res.status(400).json({ error: 'Poll ID and Option ID required.' });
    }

    try {
        const opts = await db.query('SELECT id, post_id FROM poll_options WHERE id = ? AND poll_id = ?', [optionId, pollId]);
        if (!Array.isArray(opts) || opts.length === 0) {
            return res.status(404).json({ error: 'Poll option not found.' });
        }
        const postId = Number(opts[0].post_id);

        const existingVote = await db.query('SELECT id FROM poll_votes WHERE poll_id = ? AND user_id = ?', [pollId, userId]);
        if (Array.isArray(existingVote) && existingVote.length > 0) {
            await db.query('UPDATE poll_votes SET option_id = ? WHERE poll_id = ? AND user_id = ?', [optionId, pollId, userId]);
        } else {
            await db.query('INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES (?, ?, ?)', [pollId, optionId, userId]);
        }

        const allOpts = await db.query('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY id ASC', [pollId]);
        const allVotes = await db.query('SELECT option_id FROM poll_votes WHERE poll_id = ?', [pollId]);

        const counts = new Map();
        (Array.isArray(allVotes) ? allVotes : []).forEach(v => {
            const oid = Number(v.option_id);
            counts.set(oid, (counts.get(oid) || 0) + 1);
        });

        const formattedOptions = (Array.isArray(allOpts) ? allOpts : []).map(o => ({
            id: Number(o.id),
            text: o.option_text,
            votes: counts.get(Number(o.id)) || 0
        }));

        const pollUpdatePayload = {
            post_id: postId,
            poll: {
                id: pollId,
                options: formattedOptions,
                total_votes: (Array.isArray(allVotes) ? allVotes.length : 0)
            }
        };

        io.emit('poll_updated', pollUpdatePayload);
        res.json({ ...pollUpdatePayload, user_voted_option_id: optionId });
    } catch (err) {
        console.error('Poll vote error:', err);
        res.status(500).json({ error: 'Failed to record poll vote.' });
    }
});

// --- REPORTING & BLOCKING SYSTEM ---

app.post('/api/reports', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'You must log in to submit a report.' });
    }

    const { post_id, reason } = req.body;
    if (!post_id || !reason) {
        return res.status(400).json({ error: 'Post ID and reason are required.' });
    }

    try {
        await db.query(
            'INSERT INTO reports (reporter_id, post_id, reason) VALUES (?, ?, ?)',
            [req.session.user.id, post_id, reason]
        );
        res.json({ message: 'Report submitted successfully. Thank you for keeping the community safe.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to submit report.' });
    }
});

app.post('/api/block/:target_id', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'You must log in to block users.' });
    }

    const blockerId = req.session.user.id;
    const blockedId = req.params.target_id;

    if (Number(blockerId) === Number(blockedId)) {
        return res.status(400).json({ error: 'You cannot block yourself.' });
    }

    try {
        const existing = await db.query('SELECT id FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [blockerId, blockedId]);
        if (existing && existing.length > 0) {
            await db.query('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [blockerId, blockedId]);
            return res.json({ blocked: false, message: 'User unblocked successfully.' });
        } else {
            await db.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES (?, ?)', [blockerId, blockedId]);
            return res.json({ blocked: true, message: 'User blocked successfully.' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Failed to update block state.' });
    }
});

app.post('/api/unblock/:target_id', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'You must log in to unblock users.' });
    }

    const blockerId = req.session.user.id;
    const blockedId = req.params.target_id;

    try {
        await db.query('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [blockerId, blockedId]);
        res.json({ blocked: false, message: 'User unblocked successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to unblock user.' });
    }
});

app.get('/api/blocks', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.json([]);
    }

    try {
        const rows = await db.query(
            `SELECT users.id, users.username, users.email, users.avatar_style, users.avatar_seed, users.custom_avatar_url
             FROM blocks
             INNER JOIN users ON blocks.blocked_id = users.id
             WHERE blocks.blocker_id = ?`,
            [req.session.user.id]
        );

        const list = rows.map(r => ({
            id: Number(r.id),
            username: r.username,
            email: r.email,
            avatar_url: buildAvatarUrl(r.custom_avatar_url, r.avatar_style, r.avatar_seed || r.username)
        }));

        res.json(list);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch block list.' });
    }
});

// --- MESSAGES & POST CREATION (POLLS, QUOTES, SAVED, PINNED) ---

app.get('/api/messages', async (req, res) => {
    const feedType = req.query.feed || 'public';
    let show18Plus = req.query.show18plus === 'true';
    const currentUserId = (req.session && req.session.user) ? Number(req.session.user.id) : null;

    if (req.session && req.session.user && req.session.user.is_minor) {
        show18Plus = false;
    }

    try {
        let query = '';
        let params = [];

        if (feedType === 'saved' && currentUserId) {
            query = `
                SELECT messages.*, users.avatar_style, users.avatar_seed, users.custom_avatar_url, users.title, users.badge,
                       users.daily_gacha_date, users.daily_gacha_title, users.daily_gacha_badge, users.pinned_post_id
                FROM messages
                INNER JOIN saved_posts ON messages.id = saved_posts.post_id
                LEFT JOIN users ON messages.user_id = users.id
                WHERE saved_posts.user_id = ?
            `;
            params.push(currentUserId);
            if (!show18Plus) {
                query += ' AND (messages.is_18plus IS FALSE OR messages.is_18plus IS NULL)';
            }
            query += ' ORDER BY saved_posts.id DESC';
        } else if (feedType === 'following' && currentUserId) {
            query = `
                SELECT messages.*, users.avatar_style, users.avatar_seed, users.custom_avatar_url, users.title, users.badge,
                       users.daily_gacha_date, users.daily_gacha_title, users.daily_gacha_badge, users.pinned_post_id
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
                SELECT messages.*, users.avatar_style, users.avatar_seed, users.custom_avatar_url, users.title, users.badge,
                       users.daily_gacha_date, users.daily_gacha_title, users.daily_gacha_badge, users.pinned_post_id
                FROM messages
                LEFT JOIN users ON messages.user_id = users.id
                WHERE 1=1
            `;
            if (!show18Plus) {
                query += ' AND (messages.is_18plus IS FALSE OR messages.is_18plus IS NULL)';
            }
            query += ' ORDER BY messages.id DESC';
        }

        let rows = await db.query(query, params);
        rows = Array.isArray(rows) ? rows : [];

        if (currentUserId) {
            const blockedUserRows = await db.query('SELECT blocked_id FROM blocks WHERE blocker_id = ?', [currentUserId]);
            const blockedIds = (Array.isArray(blockedUserRows) ? blockedUserRows : []).map(b => Number(b.blocked_id));
            rows = rows.filter(r => !blockedIds.includes(Number(r.user_id)));
        }

        // Sort user's own pinned post to the top if present
        const userPinnedId = req.session?.user?.pinned_post_id ? Number(req.session.user.pinned_post_id) : null;
        if (userPinnedId) {
            rows.sort((a, b) => {
                const aPinned = Number(a.id) === userPinnedId ? 1 : 0;
                const bPinned = Number(b.id) === userPinnedId ? 1 : 0;
                return bPinned - aPinned;
            });
        }

        const enriched = await attachPollsAndQuotesToPosts(rows, currentUserId);
        res.json(enriched);
    } catch (err) {
        console.error('GET /api/messages error:', err);
        res.status(500).json({ error: 'Failed to fetch messages.' });
    }
});

app.post('/api/messages', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'You must log in to post.' });
    }

    const { message, image_url, is_18plus, is_spoiler, quoted_post_id, poll } = req.body;

    if ((!message || message.trim() === '') && !image_url && !quoted_post_id && (!poll || !poll.question)) {
        return res.status(400).json({ error: 'A post must contain text, an image, a quote, or a poll.' });
    }

    const filterResult = applyTextFilters(message);
    const finalMessage = filterResult.sanitizedText;
    let detectedSpoiler = Boolean(is_spoiler) || filterResult.autoSpoiler;
    let detected18Plus = Boolean(is_18plus);

    if (req.session.user.is_minor && detected18Plus) {
        return res.status(403).json({ error: 'Accounts under 18 are restricted from submitting mature 18+ content.' });
    }

    const userId = Number(req.session.user.id);
    const authorName = req.session.user.username;
    const quotedId = quoted_post_id ? Number(quoted_post_id) : null;

    try {
        const result = await db.query(
            'INSERT INTO messages (user_id, name, message, image_url, is_18plus, is_spoiler, quoted_post_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [userId, authorName, finalMessage, image_url || null, detected18Plus, detectedSpoiler, quotedId]
        );

        const newPostId = Number(result.insertId);

        // Create poll if provided
        if (poll && poll.question && Array.isArray(poll.options)) {
            const cleanOptions = poll.options.map(o => String(o).trim()).filter(Boolean).slice(0, 4);
            if (cleanOptions.length >= 2) {
                const pollRes = await db.query(
                    'INSERT INTO polls (post_id, question) VALUES (?, ?)',
                    [newPostId, String(poll.question).trim().substring(0, 255)]
                );
                const pollId = Number(pollRes.insertId);
                for (const optText of cleanOptions) {
                    await db.query(
                        'INSERT INTO poll_options (poll_id, option_text) VALUES (?, ?)',
                        [pollId, optText.substring(0, 120)]
                    );
                }
            }
        }

        const insertedRows = await db.query(
            `SELECT messages.*, users.avatar_style, users.avatar_seed, users.custom_avatar_url, users.title, users.badge,
                    users.daily_gacha_date, users.daily_gacha_title, users.daily_gacha_badge
             FROM messages
             LEFT JOIN users ON messages.user_id = users.id
             WHERE messages.id = ?`,
            [newPostId]
        );

        const enrichedList = await attachPollsAndQuotesToPosts(Array.isArray(insertedRows) ? insertedRows : [], userId);
        const postPayload = enrichedList[0] || {
            id: newPostId,
            user_id: userId,
            name: authorName,
            message: finalMessage,
            image_url: image_url || null,
            is_18plus: detected18Plus,
            is_spoiler: detectedSpoiler,
            quoted_post_id: quotedId,
            created_at: new Date(),
            avatar_url: req.session.user.avatar_url,
            title: req.session.user.title || 'Novice Adventurer',
            badge: req.session.user.badge || '⭐'
        };

        io.emit('new_public_post', postPayload);

        res.json({ message: 'Post created successfully!', post: postPayload });
    } catch (err) {
        console.error('POST /api/messages error:', err);
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