const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;

// Safe import for CloudinaryStorage across different package versions
const multerCloudinary = require('multer-storage-cloudinary');
const CloudinaryStorage = multerCloudinary.CloudinaryStorage || multerCloudinary;

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Configure PostgreSQL Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Create table in PostgreSQL on startup
pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        name TEXT,
        message TEXT,
        image_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`).catch(err => console.error('Error creating database table:', err));

// 2. Configure Cloudinary Storage for Multer
cloudinary.config({
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

// 4. API Endpoint: Get all messages
app.get('/api/messages', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM messages ORDER BY id DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. API Endpoint: Post a new message with Cloudinary image upload
app.post('/api/messages', upload.single('image'), async (req, res) => {
    const { name, message } = req.body;
    const imageUrl = req.file ? req.file.path : null; // Cloudinary returns an HTTPS URL

    try {
        const result = await pool.query(
            'INSERT INTO messages (name, message, image_url) VALUES ($1, $2, $3) RETURNING *',
            [name, message, imageUrl]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. Catch-all route to serve index.html
app.get('/*path', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});