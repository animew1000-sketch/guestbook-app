require('dotenv').config();
const mysql = require('mysql2/promise');
const path = require('path');

// Create connection pools once on startup
const xamppPool = mysql.createPool({
    host: process.env.XAMPP_HOST || 'localhost',
    user: process.env.XAMPP_USER || 'root',
    password: process.env.XAMPP_PASSWORD || '',
    database: process.env.XAMPP_DB || 'guestbook_db',
    port: Number(process.env.XAMPP_PORT || 3306),
    waitForConnections: true,
    connectionLimit: 10
});

const cleverPool = mysql.createPool({
    host: process.env.CLEVER_HOST || process.env.MYSQL_ADDON_HOST,
    user: process.env.CLEVER_USER || process.env.MYSQL_ADDON_USER,
    password: process.env.CLEVER_PASSWORD || process.env.MYSQL_ADDON_PASSWORD,
    database: process.env.CLEVER_DB || process.env.MYSQL_ADDON_DB,
    port: Number(process.env.CLEVER_PORT || process.env.MYSQL_ADDON_PORT || 3306),
    waitForConnections: true,
    connectionLimit: 10
});

// Select active pool dynamically based on request host
function getPool(req) {
    const host = req && req.headers ? req.headers.host : '';
    
    // Automatically use XAMPP when loaded via localhost or 127.0.0.1
    if (host.includes('localhost') || host.includes('127.0.0.1')) {
        return { pool: xamppPool, engine: 'xampp' };
    }
    
    // Default to Clever Cloud for live production traffic
    return { pool: cleverPool, engine: 'clevercloud' };
}

async function query(sql, params = [], req = null) {
    const { pool } = getPool(req);
    const [rows] = await pool.query(sql, params);
    return rows;
}

module.exports = { query, getPool };