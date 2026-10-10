const express = require('express');
const { serveStoredFile } = require('../utils/fileStorage');

const router = express.Router();

router.get('/file', (req, res, next) => {
  Promise.resolve(serveStoredFile(req, res)).catch(next);
});

module.exports = router;
