const http = require('http');
const mysql = require('mysql');
const url = require('url');
const querystring = require('querystring');
const dbConfig = require('./db_connect');

const PORT = 3000;

const queryPromise = (connection, sql, values) => {
    return new Promise((resolve, reject) => {
        connection.query(sql, values, (err, results) => {
            if (err) return reject(err);
            resolve(results);
        });
    });
};


function sendResponse(res, statusCode, data) {
    res.writeHead(statusCode, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(data));
}

async function handleSignIn(data, res, connection) {
    const { username, password } = data;

    if (!username || !password) {
        return sendResponse(res, 400, { status: 'error', message: 'Username and password are required.' });
    }

    try {

        const sqlCheck = 'SELECT * FROM users WHERE username = ?';
        const results = await queryPromise(connection, sqlCheck, [username]);
        
        if (results.length > 0) {

            if (results[0].password === password) {
                sendResponse(res, 200, { status: 'success', message: 'Sign-in successful.' });
            } else {
                sendResponse(res, 401, { status: 'error', message: 'Invalid username or password.' });
            }
        } else {

            const insertSql = 'INSERT INTO users (username, password) VALUES (?, ?)';
            const result = await queryPromise(connection, insertSql, [username, password]);
            
            sendResponse(res, 200, { 
                status: 'success', 
                message: 'New user created and signed in successfully.', 
                user_id: result.insertId 
            });
        }
    } catch (error) {
        console.error('Authentication/DB Error:', error);
        sendResponse(res, 500, { status: 'error', message: 'Server error during authentication/registration.' });
    }
}


async function handleBooking(data, res, connection) {

    const { user, movie, screening_time, seats_count, total, seats_indices } = data;
    

    if (!screening_time) {
        return sendResponse(res, 400, { status: 'error', message: 'Screening time is required for booking.' });
    }
    
    let seatIndicesArray;
    try {
        seatIndicesArray = JSON.parse(seats_indices);
    } catch (e) {
        return sendResponse(res, 400, { status: 'error', message: 'Invalid seats_indices format.' });
    }
    
    try {
        await queryPromise(connection, 'START TRANSACTION');

        // 1. INSERT into bookings table (UPDATED SQL)
        const sqlBooking = 'INSERT INTO bookings (user_name, movie_title, screening_time, seats_booked, total_amount, booking_date) VALUES (?, ?, ?, ?, ?, NOW())';
        const bookingResult = await queryPromise(connection, sqlBooking, [user, movie, screening_time, seats_count, total]);
        const lastBookingId = bookingResult.insertId;

        // 2. INSERT into occupied_seats table (UPDATED SQL)
        if (seatIndicesArray && seatIndicesArray.length > 0) {
           
            const seatValues = seatIndicesArray.map(index => [lastBookingId, movie, screening_time, parseInt(index)]);
            const sqlSeats = 'INSERT INTO occupied_seats (booking_id_fk, movie_title, screening_time, seat_index) VALUES ?';
            await queryPromise(connection, sqlSeats, [seatValues]);
        }

        await queryPromise(connection, 'COMMIT');
        sendResponse(res, 200, { status: 'success', message: 'Booking saved.', booking_id: lastBookingId });

    } catch (error) {
        await queryPromise(connection, 'ROLLBACK');
        console.error('Booking DB Error:', error);
        sendResponse(res, 500, { status: 'error', message:` Booking failed: ${error.message}` });
    }
}
async function handleCancellation(data, res, connection) {

    const { movie, user, time } = data; 
    
    if (!movie || !user || !time) {
        return sendResponse(res, 400, { status: 'error', message: 'Missing user, movie, or time details for cancellation.' });
    }

    try {
        await queryPromise(connection, 'START TRANSACTION');
 
        const sqlFind = 'SELECT id FROM bookings WHERE user_name = ? AND movie_title = ? AND screening_time = ? ORDER BY id DESC LIMIT 1';
        const findResult = await queryPromise(connection, sqlFind, [user, movie, time]);

        if (findResult.length === 0) {
            await queryPromise(connection, 'ROLLBACK');
            return sendResponse(res, 404, { status: 'error', message: 'No recent booking found to cancel with that movie and time.' });
        }

        const bookingIdToCancel = findResult[0].id;
        const sqlDeleteSeats = 'DELETE FROM occupied_seats WHERE booking_id_fk = ?';
        await queryPromise(connection, sqlDeleteSeats, [bookingIdToCancel]);

        const sqlDeleteBooking = 'DELETE FROM bookings WHERE id = ?';
        const bookingResult = await queryPromise(connection, sqlDeleteBooking, [bookingIdToCancel]);
        
        if (bookingResult.affectedRows === 0) {
             throw new Error("Booking record not found for deletion.");
        }

        await queryPromise(connection, 'COMMIT');
        sendResponse(res, 200, { status: 'success', message: 'Booking successfully cancelled.' });

    } catch (error) {
        await queryPromise(connection, 'ROLLBACK');
        console.error('Cancellation DB Error:', error);
        sendResponse(res, 500, { status: 'error', message: `Cancellation failed due to server error: ${error.message}` });
    }
}


const server = http.createServer(async (req, res) => {
    const reqUrl = url.parse(req.url, true);
    
    let connection;
    try {
       
        connection = mysql.createConnection(dbConfig);
        await connection.connect();
    } catch (e) {
        return sendResponse(res, 500, { status: 'error', message: 'Database connection failed.' });
    }
    
    if (req.method === 'POST' || req.method === 'DELETE' || req.method === 'OPTIONS') {
        
        if (req.method === 'OPTIONS') {
            sendResponse(res, 200, {});
            return connection.end();
        }

        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });

        req.on('end', async () => {
            const postData = querystring.parse(body);
            
            if (reqUrl.pathname === '/api/signin' && req.method === 'POST') {
                await handleSignIn(postData, res, connection);
            } else if (reqUrl.pathname === '/api/book' && req.method === 'POST') {
                await handleBooking(postData, res, connection);
            } else if (reqUrl.pathname === '/api/cancel' && req.method === 'DELETE') {
                await handleCancellation(postData, res, connection);
            } else {
                sendResponse(res, 404, { status: 'error', message: 'Endpoint Not Found' });
            }
            connection.end();
        });
    } else {
        sendResponse(res, 404, { status: 'error', message: 'Endpoint Not Found' });
        connection.end();
    }
});

server.listen(PORT, () => {
    console.log(`Node.js server running on http://localhost:${PORT}`);
    console.log(`Available Endpoints: /api/signin (Auto-Register), /api/book, /api/cancel`);
});