require('dotenv').config();
const mysql = require('mysql2/promise');

const engine = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true'
    ? 'clevercloud' 
    : (process.env.DB_ENGINE || 'xampp');

let pool;

async function getDb() {
    if (pool) return { pool, engine };

    if (engine === 'xampp') {
        pool = mysql.createPool({
            host: process.env.XAMPP_HOST || 'localhost',
            user: process.env.XAMPP_USER || 'root',
            password: process.env.XAMPP_PASSWORD || '',
            database: process.env.XAMPP_DB || 'guestbook_db',
            port: Number(process.env.XAMPP_PORT || 3306),
            waitForConnections: true,
            connectionLimit: 10
        });
        console.log('Active Engine: LOCAL XAMPP MySQL');
    } else {
        pool = mysql.createPool({
            host: process.env.CLEVER_HOST || 'bymmkmabroi7c8ov2kno-mysql.services.clever-cloud.com',
            user: process.env.CLEVER_USER || 'u9tj6sqtupyf3gfp',
            password: process.env.CLEVER_PASSWORD || '1oULiXFIJNPOIgNCkZXE' ,
            database: process.env.CLEVER_DB || 'bymmkmabroi7c8ov2kno',
            port: Number(process.env.CLEVER_PORT || 3306),
            waitForConnections: true,
            connectionLimit: 10
        });
        console.log('Active Engine: CLEVER CLOUD MySQL');
    }

    return { pool, engine };
}

async function query(sql, params = []) {
    const { pool } = await getDb();
    const [rows] = await pool.query(sql, params);
    return rows;
}

// Ensure both getDb and query are exported
module.exports = { getDb, query };