const fs = require('fs');
const pdfParse = require('pdf-parse');

async function extractTextFromPdf(filePath) {
  const buffer = Buffer.isBuffer(filePath) ? filePath : fs.readFileSync(filePath);
  const parsed = await pdfParse(buffer);
  return parsed.text || '';
}

module.exports = {
  extractTextFromPdf,
};