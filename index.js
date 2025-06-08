const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { URL } = require('url');

const PORT = 3000;

// Database configuration
const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: '0000',
    database: 'todolist',
};

// Create database connection pool
const pool = mysql.createPool(dbConfig);

// Retrieve all items from the database
async function getItems() {
    try {
        const [rows] = await pool.query('SELECT id, text FROM items ORDER BY id');
        return rows;
    } catch (error) {
        console.error('Error retrieving items:', error);
        throw error;
    }
}

// Add a new item to the database
async function addItem(text) {
    try {
        const [result] = await pool.query('INSERT INTO items (text) VALUES (?)', [text]);
        return result.insertId;
    } catch (error) {
        console.error('Error adding item:', error);
        throw error;
    }
}

// Delete an item from the database
async function deleteItem(id) {
    try {
        await pool.query('DELETE FROM items WHERE id = ?', [id]);
        // Reset auto-increment and renumber items
        await pool.query('SET @count = 0');
        await pool.query('UPDATE items SET items.id = @count:= @count + 1');
        await pool.query('ALTER TABLE items AUTO_INCREMENT = 1');
    } catch (error) {
        console.error('Error deleting item:', error);
        throw error;
    }
}

// Generate HTML rows for the todo list with sequential numbers
async function generateListRows() {
    const items = await getItems();
    return items.map((item, index) => `
        <tr>
            <td>${index + 1}</td>
            <td>${item.text}</td>
            <td><button class="delete-btn" onclick="deleteItem(${item.id})">Delete</button></td>
        </tr>
    `).join('');
}

// Handle HTTP requests
async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    try {
        if (url.pathname === '/' && req.method === 'GET') {
            // Serve the HTML page
            const html = await fs.promises.readFile(path.join(__dirname, 'index.html'), 'utf8');
            const rows = await generateListRows();
            const renderedHtml = html.replace('{{rows}}', rows);
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(renderedHtml);
        } else if (url.pathname === '/add' && req.method === 'POST') {
            // Handle adding new item
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            
            req.on('end', async () => {
                try {
                    const { text } = JSON.parse(body);
                    if (!text || typeof text !== 'string') {
                        throw new Error('Invalid input');
                    }
                    
                    await addItem(text);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (error) {
                    console.error(error);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Invalid input' }));
                }
            });
        } else if (url.pathname.startsWith('/delete/') && req.method === 'DELETE') {
            // Handle deleting item
            const id = parseInt(url.pathname.split('/')[2]);
            if (isNaN(id)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid ID' }));
                return;
            }
            
            try {
                await deleteItem(id);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (error) {
                console.error(error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Failed to delete item' }));
            }
        } else {
            // Not found
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    } catch (error) {
        console.error(error);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
    }
}

// Create and start the server
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
});

// Handle process termination
process.on('SIGINT', async () => {
    console.log('\nClosing database pool and shutting down server...');
    await pool.end();
    server.close(() => {
        console.log('Server has been stopped');
        process.exit(0);
    });
});
