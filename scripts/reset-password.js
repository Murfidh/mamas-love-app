'use strict';
// Recover access: node scripts/reset-password.js <username> <new-password> [role]
// Creates the user if it does not exist (role defaults to admin).
const { getUser, createUser, updateUser } = require('../lib/db');
const [username, password, role = 'admin'] = process.argv.slice(2);
if (!username || !password || password.length < 8) { console.error('Usage: node scripts/reset-password.js <username> <new-password (8+ chars)> [admin|staff|viewer]'); process.exit(1); }
if (getUser(username)) { updateUser(username, { password }); console.log(`Password reset for ${username}.`); }
else { createUser({ username, name: username, role, password }); console.log(`Created ${role} user ${username}.`); }
