#!/usr/bin/env node

/**
 * Renders the motion showreel to video using Puppeteer + FFmpeg
 *
 * This captures each frame at exactly 60fps, then encodes to H.264 video.
 * Audio is synthesized in-browser and captured via virtual audio routing,
 * or you can add a separate music track in post.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 60;
const DURATION = 15; // seconds
const TOTAL_FRAMES = FPS * DURATION; // 900 frames

const OUTPUT_DIR = path.join(__dirname, 'frames');
const OUTPUT_VIDEO = path.join(__dirname, 'splitsy-showreel.mp4');

async function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function cleanFrames() {
  if (fs.existsSync(OUTPUT_DIR)) {
    console.log('🧹 Cleaning previous frames...');
    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  }
  await ensureDir(OUTPUT_DIR);
}

async function captureFrames() {
  console.log('🎬 Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/usr/bin/chromium-browser',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
      `--window-size=${WIDTH},${HEIGHT}`
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT });

  // Load the showreel script directly
  const jsPath = path.join(__dirname, 'showreel.js');
  const jsContent = fs.readFileSync(jsPath, 'utf-8');

  // Create minimal HTML
  const minimalHtml = `
<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin: 0; padding: 0; }
    body { background: #000; }
    canvas { display: block; }
  </style>
</head>
<body>
  <canvas id="canvas" width="${WIDTH}" height="${HEIGHT}"></canvas>
  <script>${jsContent}</script>
</body>
</html>
  `;

  await page.setContent(minimalHtml, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  // Wait for font to load
  await page.waitForFunction(() => document.fonts.check('300 80px ClashDisplay'));

  console.log('📸 Capturing frames...');

  // Inject render control
  await page.evaluate(() => {
    window.captureFrame = async (frameNum) => {
      const canvas = document.getElementById('canvas');
      if (!canvas) throw new Error('Canvas not found');

      // Render specific frame
      if (typeof window.render === 'function') {
        window.render(frameNum);
      }

      return canvas.toDataURL('image/png');
    };
  });

  const progressBar = (current, total) => {
    const percentage = Math.round((current / total) * 100);
    const filled = Math.round((current / total) * 40);
    const empty = 40 - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percentage}%`;
  };

  for (let frame = 0; frame < TOTAL_FRAMES; frame++) {
    const dataUrl = await page.evaluate((f) => window.captureFrame(f), frame);
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const framePath = path.join(OUTPUT_DIR, `frame_${String(frame).padStart(5, '0')}.png`);
    fs.writeFileSync(framePath, buffer);

    if (frame % 30 === 0 || frame === TOTAL_FRAMES - 1) {
      process.stdout.write(`\r${progressBar(frame + 1, TOTAL_FRAMES)} (${frame + 1}/${TOTAL_FRAMES} frames)`);
    }
  }

  console.log('\n✅ Frame capture complete!');
  await browser.close();
}

async function encodeVideo() {
  console.log('🎞️  Encoding video with FFmpeg...');

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y', // Overwrite output
      '-framerate', String(FPS),
      '-i', path.join(OUTPUT_DIR, 'frame_%05d.png'),
      '-c:v', 'libx264',
      '-preset', 'slow', // Better quality
      '-crf', '18', // High quality (0-51, lower is better)
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', // Web optimization
      '-t', String(DURATION),
      OUTPUT_VIDEO
    ]);

    ffmpeg.stdout.on('data', (data) => {
      process.stdout.write(data.toString());
    });

    ffmpeg.stderr.on('data', (data) => {
      // FFmpeg outputs progress to stderr
      process.stderr.write(data.toString());
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        console.log('\n✅ Video encoded successfully!');
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(err);
    });
  });
}

async function addAudioTrack() {
  console.log('\n💡 To add audio:');
  console.log('1. Export synthesized audio from browser during playback');
  console.log('2. Or add background music with:');
  console.log('   ffmpeg -i splitsy-showreel.mp4 -i music.mp3 -c:v copy -c:a aac -shortest splitsy-showreel-final.mp4');
  console.log('3. Or use the Web Audio API capture during frame rendering (advanced)');
}

async function cleanup() {
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    readline.question('\n🗑️  Delete frame files? (y/N) ', (answer) => {
      readline.close();
      if (answer.toLowerCase() === 'y') {
        console.log('🧹 Cleaning up frames...');
        fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
        console.log('✅ Cleanup complete!');
      } else {
        console.log('📁 Frames kept in:', OUTPUT_DIR);
      }
      resolve();
    });
  });
}

async function main() {
  console.log('🎨 Splitsy Motion Showreel Renderer\n');
  console.log(`📐 Resolution: ${WIDTH}x${HEIGHT}`);
  console.log(`🎞️  Frame rate: ${FPS} fps`);
  console.log(`⏱️  Duration: ${DURATION} seconds (${TOTAL_FRAMES} frames)\n`);

  try {
    // Check for ffmpeg
    try {
      const ffmpegCheck = spawn('ffmpeg', ['-version']);
      await new Promise((resolve, reject) => {
        ffmpegCheck.on('close', (code) => code === 0 ? resolve() : reject());
        ffmpegCheck.on('error', reject);
      });
    } catch (err) {
      console.error('❌ FFmpeg not found. Please install it:');
      console.error('   Ubuntu/Debian: sudo apt install ffmpeg');
      console.error('   macOS: brew install ffmpeg');
      console.error('   Windows: https://ffmpeg.org/download.html');
      process.exit(1);
    }

    await cleanFrames();
    await captureFrames();
    await encodeVideo();
    await addAudioTrack();

    console.log('\n🎉 Render complete!');
    console.log(`📹 Output: ${OUTPUT_VIDEO}`);

    const stats = fs.statSync(OUTPUT_VIDEO);
    console.log(`📦 File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    await cleanup();

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { captureFrames, encodeVideo };
