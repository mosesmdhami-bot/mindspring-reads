
require('dotenv').config();

const Database = require('better-sqlite3');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

const DB_FILE = path.resolve(
  ROOT,
  process.env.DATABASE_FILE || './data/mindspring.sqlite'
);

const db = new Database(DB_FILE);

async function main() {
  const books = db.prepare(`
    SELECT id, title, manuscript_path, content
    FROM books
    WHERE published = 1
    ORDER BY id DESC
  `).all();

  const matches = books.filter(book =>
    book.title.trim().toLowerCase() ===
    'introduction to philosophy'.toLowerCase()
  );

  if (!matches.length) {
    console.log('Book not found in the database.');
    return;
  }

  for (const book of matches) {
    console.log('\nBook:', book.title);
    console.log('ID:', book.id);
    console.log('PDF:', book.manuscript_path || 'No manuscript path');

    if (!book.manuscript_path ||
        !fs.existsSync(book.manuscript_path)) {
      console.log('ERROR: Original manuscript file is missing.');
      continue;
    }

    if (path.extname(book.manuscript_path).toLowerCase() !== '.pdf') {
      console.log('This manuscript is not a PDF.');
      continue;
    }

    try {
      const buffer = fs.readFileSync(book.manuscript_path);
      const result = await pdfParse(buffer);
      const content = String(result.text || '').trim();

      if (!content) {
        console.log(
          'No selectable text found. The PDF may be scanned and require OCR.'
        );
        continue;
      }

      db.prepare(`
        UPDATE books
        SET content = ?
        WHERE id = ?
      `).run(content.slice(0, 2_000_000), book.id);

      console.log('SUCCESS: Extracted text and updated the existing book.');
      console.log('Extracted characters:', content.length);
    } catch (error) {
      console.error('Could not extract PDF:', error.message);
    }
  }
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.close());
