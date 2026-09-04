require('dotenv').config();
const mysql = require('mysql2/promise');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

const engine = process.env.DB_ENGINE || 'clevercloud';

async function sync() {
    try {
        const sqliteDb = await open({ filename: path.join(__dirname, 'database.db'), driver: sqlite3.Database });
        
        const cleverPool = mysql.createPool({
            host: process.env.CLEVER_HOST, user: process.env.CLEVER_USER,
            password: process.env.CLEVER_PASSWORD, database: process.env.CLEVER_DB,
            port: Number(process.env.CLEVER_PORT || 3306)
        });

        let xamppPool;
        try {
            xamppPool = mysql.createPool({
                host: process.env.XAMPP_HOST || 'localhost', user: process.env.XAMPP_USER || 'root',
                password: process.env.XAMPP_PASSWORD || '', database: process.env.XAMPP_DB || 'guestbook_db',
                port: Number(process.env.XAMPP_PORT || 3306), connectTimeout: 500
            });
        } catch (e) {}

        // Determine source database
        let messages = [];
        if (engine === 'xampp' && xamppPool) {
            const [rows] = await xamppPool.query('SELECT * FROM messages');
            messages = rows;
        } else if (engine === 'sqlite') {
            messages = await sqliteDb.all('SELECT * FROM messages');
        } else {
            const [rows] = await cleverPool.query('SELECT * FROM messages');
            messages = rows;
        }

        // Mirror data to targets
        const ids = messages.map(m => m.id);
        const placeholders = ids.length ? ids.map(() => '?').join(',') : null;

        // Sync SQLite
        if (engine !== 'sqlite') {
            if (placeholders) await sqliteDb.run(`DELETE FROM messages WHERE id NOT IN (${placeholders})`, ids);
            else await sqliteDb.run('DELETE FROM messages');

            for (const m of messages) {
                await sqliteDb.run(
                    `INSERT INTO messages (id, user_id, name, message, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET message=excluded.message, image_url=excluded.image_url`,
                    [m.id, m.user_id, m.name, m.message, m.image_url, m.created_at]
                );
            }
        }

        // Sync Clever Cloud
        if (engine !== 'clevercloud') {
            if (placeholders) await cleverPool.query(`DELETE FROM messages WHERE id NOT IN (${placeholders})`, ids);
            else await cleverPool.query('DELETE FROM messages');

            for (const m of messages) {
                await cleverPool.query(
                    `INSERT INTO messages (id, user_id, name, message, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE message=VALUES(message), image_url=VALUES(image_url)`,
                    [m.id, m.user_id, m.name, m.message, m.image_url, m.created_at]
                );
            }
        }

        // Sync XAMPP
        if (engine !== 'xampp' && xamppPool) {
            try {
                if (placeholders) await xamppPool.query(`DELETE FROM messages WHERE id NOT IN (${placeholders})`, ids);
                else await xamppPool.query('DELETE FROM messages');

                for (const m of messages) {
                    await xamppPool.query(
                        `INSERT INTO messages (id, user_id, name, message, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE message=VALUES(message), image_url=VALUES(image_url)`,
                        [m.id, m.user_id, m.name, m.message, m.image_url, m.created_at]
                    );
                }
            } catch (xErr) {}
        }

        console.log(`[${new Date().toLocaleTimeString()}] Mode [${engine.toUpperCase()}]: Databases synced.`);

        await sqliteDb.close();
        await cleverPool.end();
        if (xamppPool) await xamppPool.end();
    } catch (err) {
        console.error('Sync Error:', err.message);
    }
}

setInterval(sync, 1000);
sync();