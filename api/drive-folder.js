// Vercel runs this file as a function. The work is in server/driveRelay.js
const { handle } = require('../server/driveRelay');

module.exports = (req, res) => handle(req, res, req.url);
