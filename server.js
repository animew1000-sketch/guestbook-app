require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const tf = require('@tensorflow/tfjs');
const nsfw = require('nsfwjs');
const sharp = require('sharp');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 10000;

app.set('trust proxy', 1);

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

app.use(session({
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
}));

app.use((req, res, next) => {
    if (req.session && req.session.user) {
        req.session.touch();
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Lazy load model ONLY when an image is posted to prevent boot OOM crashes
let nsfwModel = null;
async function getOrLoadNsfwModel() {
    if (!nsfwModel) {
        console.log('Loading NSFW Model into memory...');
        nsfwModel = await nsfw.load('MobileNetV2');
    }
    return nsfwModel;
}

async function detectExplicitContent(base64Image) {
    if (!base64Image) return false;

    try {
        const model = await getOrLoadNsfwModel();
        if (!model) return false;

        const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');
        const imageBuffer = Buffer.from(base64Data, 'base64');
        
        const { data, info } = await sharp(imageBuffer)
            .resize({ width: 128, height: 128, fit: 'cover' })
            .raw()
            .toBuffer({ resolveWithObject: true });

        const predictions = await tf.tidy(() => {
            const imageTensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, info.channels], 'int32');
            const rgbTensor = info.channels === 4 ? imageTensor.slice([0, 0, 0], [-1, -1, 3]) : imageTensor;
            return model.classify(rgbTensor);
        });

        const scores = {};
        predictions.forEach(pred => {
            scores[pred.className] = pred.probability;
        });

        const hentaiScore = scores['Hentai'] || 0;
        const pornScore = scores['Porn'] || 0;
        const sexyScore = scores['Sexy'] || 0;
        const totalExplicitScore = hentaiScore + pornScore + sexyScore;

        return (pornScore > 0.25 || hentaiScore > 0.20 || sexyScore > 0.45 || totalExplicitScore > 0.35);
    } catch (err) {
        console.error('NSFW Scanning Error:', err.message);
        return false;
    }
}

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

// --- MESSAGES & FEEDS ---

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
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch messages.' });
    }
});

app.post('/api/messages', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'You must log in to post.' });
    }

    if (req.session.user.is_minor) {
        req.body.is_18plus = false;
    }

    const { message, image_url, is_18plus } = req.body;
    if (!message) {
        return res.status(400).json({ error: 'Post content is required.' });
    }

    let detected18Plus = Boolean(is_18plus);
    if (image_url) {
        try {
            const autoDetected = await detectExplicitContent(image_url);
            if (autoDetected) {
                detected18Plus = true;
            }
        } catch (scanErr) {
            console.error('NSFW Scan Warning:', scanErr.message);
        }
    }

    if (detected18Plus && req.session.user.is_minor) {
        return res.status(403).json({ error: 'Explicit content detected. Minors cannot post 18+ content.' });
    }

    if (detected18Plus && !req.session.user.age_verified) {
        return res.status(403).json({ error: 'Explicit content detected. Please verify your age with a birthdate to proceed.' });
    }

    const userId = req.session.user.id;
    const authorName = req.session.user.username;

    try {
        await db.query(
            'INSERT INTO messages (user_id, name, message, image_url, is_18plus) VALUES (?, ?, ?, ?, ?)',
            [userId, authorName, message, image_url || null, detected18Plus]
        );
        res.json({ message: 'Post created successfully!', is_18plus: detected18Plus });
    } catch (err) {
        console.error('Database Error During Message Insert:', err);
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