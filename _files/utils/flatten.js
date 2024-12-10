
const { S3 } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const util = require('util');
const execPromise = util.promisify(require('child_process').exec);

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB in bytes
const MAX_DIMENSION_ON_RESIZE = 1200; //in pixels
const SUPPORTED_FORMATS = {
    '.pdf': 'pdf',
    '.doc': 'word',
    '.docx': 'word',
    '.ppt': 'powerpoint',
    '.pptx': 'powerpoint',
    '.odp': 'powerpoint',
    '.odt': 'word',
    '.rtf': 'word',
    '.txt': 'word',
    '.xls': 'excel',
    '.xlsx': 'excel',
    '.csv': 'excel',
};

const spacesEndpoint = new S3({
  endpoint: process.env.DIGITALOCEAN_STORAGE_ENDPOINT,
  credentials: {
    accessKeyId: process.env.DIGITALOCEAN_STORAGE_ACCESS_KEY,
    secretAccessKey: process.env.DIGITALOCEAN_STORAGE_SECRET_KEY
  },
  region: process.env.DIGITALOCEAN_STORAGE_REGION
});

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function downloadFromSpace(key, localPath) {
  const response = await spacesEndpoint.getObject({
    Bucket: process.env.DIGITALOCEAN_STORAGE_BUCKET,
    Key: key
  });
  const buffer = await streamToBuffer(response.Body);
  fs.writeFileSync(localPath, buffer);
  // console.log({ localPath, buffer })
  return localPath;
}

async function uploadToSpace({ key, filepath, contentType }) {
  await spacesEndpoint.putObject({
    Bucket: process.env.DIGITALOCEAN_STORAGE_BUCKET,
    Key: key,
    Body: fs.readFileSync(filepath),
    ContentType: contentType,
    ACL: 'public-read'
  });
  return `${process.env.DIGITALOCEAN_STORAGE_CDN_ENDPOINT}/${key}`;
}

async function convertToPdf(inputPath, outputPath) {
  try {
    await execPromise('libreoffice --version');
  } catch (error) {
    throw new Error('LibreOffice is not installed. Please install it to convert non-PDF documents.');
  }
  
  try {
    const outDir = path.dirname(outputPath);
    await execPromise(`libreoffice --headless --convert-to pdf --outdir "${outDir}" "${inputPath}"`);
    const baseNamePdf = path.basename(inputPath, path.extname(inputPath)) + '.pdf';
    const convertedPdfPath = path.join(outDir, baseNamePdf);
    
    if (convertedPdfPath !== outputPath) {
      fs.renameSync(convertedPdfPath, outputPath);
    }
    
    return outputPath;
  } catch (error) {
    throw new Error(`Failed to convert document to PDF: ${error.message}`);
  }
}

function optimizeImage(inputPath, outputPath, maxSize = MAX_FILE_SIZE) {
  let metadata;
  try {
    metadata = sharp(inputPath).metadata();
  } catch (error) {
    return {
      success: false,
      error: `Failed to read image metadata: ${error.message}`
    };
  }
  
  const { width, height } = metadata;
  let currentWidth = width;
  let currentHeight = height;
  
  while (currentWidth > 100 && currentHeight > 100) {
    currentWidth = Math.floor(currentWidth * 0.8);
    currentHeight = Math.floor(currentHeight * 0.8);
    try {
      sharp(inputPath)
        .resize(currentWidth, currentHeight, {
          fit: 'contain',
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        })
        .toFormat('png')
        .toFile(outputPath)
      const stats = fs.statSync(outputPath);
      if (stats.size <= maxSize) {
        console.log(`Optimized image at ${currentWidth}x${currentHeight}`);
        return { success: true };
      }
    } catch (error) {
      console.error(`Failed attempt at ${currentWidth}x${currentHeight}:`, error);
    }
  }
  
  return {
    success: false,
    error: 'Unable to optimize image to target size with acceptable quality'
  };
}

async function scaleDimensions({ inputPath, maxDimension }) {
  const metadata = await sharp(inputFile).metadata()
  if (!metadata) { throw new Error('Could not read metadata from inputPath') }
  let { width, height } = metadata
  const scale = maxDimension / (width > height ? width : height)
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  }
}

async function resizeImage({ inputPath, outputPath, width, height }) {
  return await sharp(inputPath)
    .resize(width, height, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .toFormat('png')
    .toFile(outputPath)
}

async function convertPdfToImages(pdfPath, outputDir) {
  try {
    // Check if Ghostscript is installed
    await execPromise('gs --version');
  } catch (error) {
    throw new Error('Ghostscript is not installed. Please install it to convert PDFs to images.');
  }

  try {

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Convert PDF to PNG using Ghostscript
    const gsCommand = `gs -dQuiet -dSAFER -dBATCH -dNOPAUSE -dNOPROMPT -sDEVICE=png16m -dTextAlphaBits=4 -dGraphicsAlphaBits=4 -r200 -dFirstPage=1 -dLastPage=999999 -sOutputFile="${outputDir}/page-%d.png" "${pdfPath}"`;
    
    await execPromise(gsCommand);

    // Get all generated PNG files
    const files = fs.readdirSync(outputDir);
    const imageFiles = files
      .filter(f => f.startsWith('page-') && f.endsWith('.png'))
      .sort((a, b) => {
        const pageA = parseInt(a.match(/\\d+/)[0]);
        const pageB = parseInt(b.match(/\\d+/)[0]);
        return pageA - pageB;
      })
      .map(f => path.join(outputDir, f));

    for (const imagePath of imageFiles) {
      let stats = fs.statSync(imagePath);
      if (stats.size >= MAX_FILE_SIZE) {
        console.log(`Image too large, attempting to make smaller...`);
        
        const filename = path.basename(imagePath);
        const smallerPath = path.join(outputDir, filename);
        const newDimensions = await getNewDimensions({ 
          inputPath, 
          maxDimension: MAX_DIMENSION_ON_RESIZE 
        })
        resizeImage({ 
          inputPath: imagePath,
          outputPath: smallerPath,
          width: newDimensions.width,
          height: newDimensions.height,
        })
        stats = fs.statSync(imagePath);
        console.log(`Resized image to max of ${MAX_FILE_SIZE} bytes: ${stats.size <= MAX_FILE_SIZE}`)
        if (stats.size <= MAX_FILE_SIZE) {
          fs.rmSync(imagePath);
          fs.copyFileSync(smallerPath, imagePath);
          fs.rmSync(smallerPath);
        }
      }
    }
    return imageFiles;
  } catch (error) {
    throw new Error(`Failed to convert PDF to images: ${error.message}`);
  }
}

async function processDocument({ name, inputKey, outputBasename, outputFormat = 'png' }) {
  return await processDocumentAsMany({ name, inputKey, outputBasename, outputFormat })
}

async function processDocumentAsMany({ name, inputKey, outputBasename, outputFormat }) {

  const tempDir = path.join(process.cwd(), 'temp');
  fs.mkdirSync(tempDir, { recursive: true });

  const sourceExt = path.extname(inputKey).toLowerCase();
  if (!SUPPORTED_FORMATS[sourceExt]) {
    throw new Error(`Unsupported input format: ${sourceExt}. Supported formats are: ${Object.keys(SUPPORTED_FORMATS).join(', ')}`);
  }

  const tempSourcePath = path.join(tempDir, `source${sourceExt}`);
  const tempPdfPath = path.join(tempDir, 'converted.pdf');
  const tempImagePath = path.join(tempDir, `output.${outputFormat}`);

  try {
    await downloadFromSpace(inputKey, tempSourcePath);

    let pdfPath = tempSourcePath;
    if (sourceExt !== '.pdf') {
      pdfPath = await convertToPdf(tempSourcePath, tempPdfPath);
    }
    
    let flattenedPages = await convertPdfToImages(pdfPath, tempDir);
    
    if (!flattenedPages.length) {
      throw new Error('No images were generated from the PDF');
    }

    // Verify first file exists and can be processed
    if (!fs.existsSync(flattenedPages[0])) {
      throw new Error('Generated image files not found');
    }

    let pages = []
    for (let p in flattenedPages) {
      const tempImagePath = flattenedPages[p]
      const pageSize = fs.statSync(tempImagePath).size
      const pageNumber = String(parseInt(p)+1)
      const pageSuffix = pageNumber.padStart(4, '0')
      const pageBasename = `${outputBasename}-${pageSuffix}`
      const pageExtension = `.${outputFormat}`
      const pageFilename = `${pageBasename}${pageExtension}`
      const contentType = `image/${outputFormat.toLowerCase()}`
      const url = await uploadToSpace({
        key: pageFilename,
        filepath: tempImagePath,
        contentType,
      })
      pages.push({
        url,
        filename: pageFilename,
        extension: pageExtension,
        type: contentType,
        name: `${name} (Page ${pageNumber})`,
        description: `Page ${pageNumber} of ${flattenedPages.length}`,
        size: pageSize,
        uploaded_at: new Date().toISOString(),
      })

    }

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });

    return pages
  } catch (error) {
    console.log(error);
    fs.rmSync(tempDir, { recursive: true, force: true });
    return []
  }

}


// async function processDocumentAsOne(sourceKey, destKey, format = 'jpg', quality = 80) {
//   const tempDir = path.join(process.cwd(), 'temp');
//   fs.mkdirSync(tempDir, { recursive: true });

//   const sourceExt = path.extname(sourceKey).toLowerCase();
//   if (!SUPPORTED_FORMATS[sourceExt]) {
//     throw new Error(`Unsupported input format: ${sourceExt}. Supported formats are: ${Object.keys(SUPPORTED_FORMATS).join(', ')}`);
//   }

//   const tempSourcePath = path.join(tempDir, `source${sourceExt}`);
//   const tempPdfPath = path.join(tempDir, 'converted.pdf');
//   const tempImagePath = path.join(tempDir, `output.${format}`);

//   try {
//     await downloadFromSpace(sourceKey, tempSourcePath);

//     let pdfPath = tempSourcePath;
//     if (sourceExt !== '.pdf') {
//       pdfPath = await convertToPdf(tempSourcePath, tempPdfPath);
//     }
    
//     const imageFiles = await convertPdfToImages(pdfPath, tempDir);
    
//     if (!imageFiles.length) {
//       throw new Error('No images were generated from the PDF');
//     }

//     // Verify first file exists and can be processed
//     if (!fs.existsSync(imageFiles[0])) {
//       throw new Error('Generated image files not found');
//     }

//     // Get dimensions of first page
//     const firstImageMetadata = await sharp(imageFiles[0]).metadata();
//     if (!firstImageMetadata) {
//       throw new Error('Could not read metadata from first image');
//     }

//     let { width, height } = firstImageMetadata;
//     let percentScale = 800 / width
//     width = Math.round(width * percentScale)
//     height = Math.round(height * percentScale)

//     const resizedImages = [];

//     // Process each image sequentially instead of in parallel
//     for (let i = 0; i < imageFiles.length; i++) {
//       const originalFile = imageFiles[i];
//       const resizedPath = path.join(tempDir, `resized-${i}.png`);
      
//       try {
//         await sharp(originalFile)
//           .resize(width, height, {
//             fit: 'contain',
//             background: { r: 255, g: 255, b: 255, alpha: 1 }
//           })
//           .toFormat('png')
//           .toFile(resizedPath);

//         // Verify the resized file exists
//         if (fs.existsSync(resizedPath)) {
//           resizedImages.push(resizedPath);
//         } else {
//           throw new Error(`Failed to create resized image for page ${i + 1}`);
//         }
//       } catch (error) {
//         console.error(`Error processing page ${i + 1}:`, error);
//         throw error;
//       }
//     }

//     if (!resizedImages.length) {
//       throw new Error('No images were successfully processed');
//     }

//     const totalHeight = height * resizedImages.length;

//     // Create composite image
//     const composite = sharp({
//       create: {
//         width,
//         height: totalHeight,
//         channels: 4,
//         background: { r: 255, g: 255, b: 255, alpha: 1 }
//       }
//     });

//     // Add all images to composite
//     composite.composite(resizedImages.map((file, index) => ({
//       input: file,
//       top: index * height,
//       left: 0
//     })));

//     // Save final image
//     await composite
//       .toFormat(format.toLowerCase())
//       .toFile(tempImagePath);

//     let publicUrl = await uploadToSpace({
//       key: destKey, 
//       filepath: tempImagePath, 
//       contentType: `image/${format.toLowerCase()}`
//     });

//     publicUrl = process.env.DIGITALOCEAN_STORAGE_CDN_ENDPOINT + '/' + destKey;

//     // Cleanup
//     fs.rmSync(tempDir, { recursive: true, force: true });

//     return publicUrl;
//   } catch (error) {
//     console.error('Process document error:', error);
//     fs.rmSync(tempDir, { recursive: true, force: true });
//     throw error;
//   }
// }

function removeFilepath(filepath) {
  fs.rmSync(filepath, { recursive: true, force: true })
}

module.exports = { 
  processDocument, 
  downloadFromSpace, 
  uploadToSpace, 
  convertToPdf, 
  convertPdfToImages,
  removeFilepath,
  SUPPORTED_FORMATS,
};