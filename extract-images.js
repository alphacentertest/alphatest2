const ExcelJS = require('exceljs');
const fs = require('fs').promises;
const path = require('path');

async function extractImages() {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(__dirname, 'questions.xlsx'));
    const imagesDir = path.join(__dirname, 'public', 'images');
    await fs.mkdir(imagesDir, { recursive: true });

    for (let i = 1; i <= 10; i++) {
      const pictureSheet = workbook.getWorksheet(`Picture ${i}`);
      if (pictureSheet) {
        const images = pictureSheet.getImages();
        if (images.length > 0) {
          for (const imageRef of images) {
            const image = workbook.model.media.find(m => m.index === imageRef.imageId);
            if (image && image.buffer) {
              const imagePath = path.join(imagesDir, `picture${i}.${image.extension || 'png'}`);
              await fs.writeFile(imagePath, Buffer.from(image.buffer));
              console.log(`Saved image: ${imagePath}`);
            } else {
              console.log(`No valid image buffer for Picture ${i}`);
            }
          }
        } else {
          console.log(`No images found in Picture ${i}`);
        }
      }
    }
    console.log('Image extraction completed');
  } catch (error) {
    console.error('Error extracting images:', error.stack);
    process.exit(1);
  }
}

extractImages();